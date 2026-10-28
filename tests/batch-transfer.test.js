import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRepository } from '../src/sqlite.js';
import { batchPacket, batchKey } from '../vendor/frontend/src/storage/transfer-batch-format.js';
import { encodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { captureSnapshot } from '../vendor/frontend/src/snapshots/model.js';
import { snapshotBatches } from '../vendor/frontend/src/snapshots/service.js';

const args={id:'batch-test-123',from:'sqlite',to:'indexeddb'};
const encode=value=>JSON.stringify(encodeStorageValue(value));
function fixture(t) {
  const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'boxed-batches-')),repos=[];
  t.after(()=>{for(const repo of repos)repo.close();assert.equal(path.dirname(fs.realpathSync(dir)),root);assert.ok(path.basename(dir).startsWith('boxed-batches-'));fs.rmSync(dir,{recursive:true});});
  return {open(name){const repo=new SqliteRepository(path.join(dir,name+'.sqlite'));repos.push(repo);return repo;}};
}
const raw=repo=>repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all();
const receipt=(repo,key)=>JSON.parse(repo.db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key).value);
async function seed(repo,count=7) {
  await repo.execute('putChatMeta',[{chatKey:'source',fullBackupState:'frozen',date:new Date(0),optional:undefined}]);
  await repo.execute('putFullMessages',[{chatKey:'source',messages:Array.from({length:count},(_,i)=>({chatKey:'source',messageIndex:i,raw:{mes:'正文-'+i+'中'.repeat(80),swipes:['a','b']}}))}]);
}
async function start(source,target) {
  await source.batchTransfer.begin({...args,role:'source'});
  await target.batchTransfer.begin({...args,role:'target'});
  while((await target.batchTransfer.prepareStep(args.id,{limit:2,bytes:700})).phase==='preparing') {}
}
async function move(source,target,{after=0}={}) {
  while(true) {
    const packet=await source.batchTransfer.sourceNext(args.id,after,{limit:2,bytes:700});
    if(packet.done)return packet.summary;
    assert.ok(packet.rows.length<=2);
    await target.batchTransfer.append(args.id,packet);
    assert.equal((await target.batchTransfer.status(args.id)).verifiedBatch,after);
    const verified=await target.batchTransfer.verifyBatch(args.id,packet.index);
    assert.equal(verified.verified,packet.last);after=packet.index;
  }
}
async function seal(target,summary) {
  await target.batchTransfer.startSeal(args.id,summary);
  let steps=0,state;
  do { state=await target.batchTransfer.sealStep(args.id,{limit:2,bytes:700});assert.ok(++steps<100); } while(state.phase==='checking');
  assert.equal(state.phase,'verified');return steps;
}

test('真实数据库清点、清理、搬运、读回及最终验收全部分批，回执重开可读，轻量提交不再搬正文',async t=>{
  const f=fixture(t);let source=f.open('source'),target=f.open('target');await seed(source,12);
  await target.execute('putChatMeta',[{chatKey:'old-target',keep:true}]);
  const beforeSource=raw(source),beforeTarget=raw(target);
  for(let i=0;i<5;i++)target.db.prepare('INSERT INTO records_next VALUES(?,?,?,?)').run('chat_meta',JSON.stringify('stale-'+i),'stale-'+i,encode({chatKey:'stale-'+i}));
  await source.batchTransfer.begin({...args,role:'source'});await target.batchTransfer.begin({...args,role:'target'});
  let previous=0,steps=0,state;
  do {state=await target.batchTransfer.prepareStep(args.id,{limit:2,bytes:700});assert.ok(state.cleaned-previous<=2);previous=state.cleaned;steps++;}while(state.phase==='preparing');
  assert.ok(steps>=3);assert.deepEqual(raw(target),beforeTarget);
  const first=await source.batchTransfer.sourceNext(args.id,0,{limit:2,bytes:700});
  await Promise.all([target.batchTransfer.append(args.id,first),target.batchTransfer.append(args.id,first)]);
  assert.equal((await target.batchTransfer.status(args.id)).verified,0);
  source.close();target.close();source=f.open('source');target=f.open('target');
  const retry=await source.batchTransfer.sourceNext(args.id,0);assert.deepEqual(retry,first);
  await target.batchTransfer.append(args.id,retry);await target.batchTransfer.verifyBatch(args.id,1);
  const count=(await target.batchTransfer.status(args.id)).verified;
  await target.batchTransfer.verifyBatch(args.id,1);assert.equal((await target.batchTransfer.status(args.id)).verified,count);
  const summary=await move(source,target,{after:1});assert.ok(await seal(target,summary)>1);
  assert.deepEqual(raw(source),beforeSource);assert.deepEqual(raw(target),beforeTarget);
  assert.equal(source.db.prepare('SELECT count(*) n FROM transfer_rows').get().n,0);
  for(const table of ['records','records_next'])for(const action of ['INSERT','UPDATE','DELETE'])target.db.exec(`CREATE TEMP TRIGGER no_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'commit-copies-payload');END`);
  target.changeDataset('commit',args.id,summary);assert.equal(target.activeDataset(),1);
  assert.equal(receipt(target,'transfer:'+args.id).verified,13);
});

test('实际读回发现篡改或丢失时不确认批次，重复写入不修补或覆盖被修改的数据',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target');await seed(source);await start(source,target);
  const packet=await source.batchTransfer.sourceNext(args.id,0,{limit:1});await target.batchTransfer.append(args.id,packet);
  target.db.prepare('UPDATE records_next SET payload=?').run(encode({...packet.rows[0].value,corrupt:true}));
  await assert.rejects(target.batchTransfer.verifyBatch(args.id,1),/摘要/);
  assert.equal((await target.batchTransfer.status(args.id)).verified,0);
  await assert.rejects(target.batchTransfer.append(args.id,packet),/再次变化/);
  target.db.prepare('UPDATE records_next SET payload=?').run(encode(packet.rows[0].value));
  await target.batchTransfer.verifyBatch(args.id,1);
  target.db.exec('DELETE FROM records_next');
  await assert.rejects(target.batchTransfer.verifyBatch(args.id,1));
  assert.equal((await target.batchTransfer.status(args.id)).verified,1);
  target.db.prepare('INSERT INTO records_next VALUES(?,?,?,?)').run('chat_meta',JSON.stringify(packet.rows[0].key),'source',encode(packet.rows[0].value));
  // Final sealing never accepts that previously acknowledged but missing row.
  const summary=await move(source,target,{after:1});
  target.db.prepare("DELETE FROM records_next WHERE store='full_messages' AND primary_key=?").run(JSON.stringify(['source',0]));
  await target.batchTransfer.startSeal(args.id,summary);
  await assert.rejects(async()=>{while((await target.batchTransfer.sealStep(args.id,{limit:2})).phase==='checking'){};},/缺少关联|缺失/);
});

test('乱序、跨任务、重复主键与未验货时继续写入均拒绝，已写入不等于已核验',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target');await seed(source);await start(source,target);
  const first=await source.batchTransfer.sourceNext(args.id,0,{limit:1}),second=await source.batchTransfer.sourceNext(args.id,1,{limit:1});
  await assert.rejects(target.batchTransfer.append(args.id,second),/乱序/);
  await assert.rejects(target.batchTransfer.append('another-task-123',first),/不属于/);
  await target.batchTransfer.append(args.id,first);await assert.rejects(target.batchTransfer.append(args.id,second),/验货/);
  await target.batchTransfer.verifyBatch(args.id,1);
  const duplicate=await batchPacket(args.id,2,[{...first.rows[0],n:2}]);
  await assert.rejects(target.batchTransfer.append(args.id,duplicate),/主键重复/);
  assert.equal((await target.batchTransfer.status(args.id)).verified,1);
});

test('来源批次内容变化及持久修订变化禁止续读；跨任务锁与遗失登记不会被覆盖',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target');await seed(source);await start(source,target);
  await assert.rejects(source.execute('putChatMeta',[{chatKey:'blocked'}]),/暂停/);
  await source.batchTransfer.sourceNext(args.id,0,{limit:1});
  source.db.prepare("UPDATE records SET payload=? WHERE store='chat_meta'").run(encode({chatKey:'source',changed:true}));
  await assert.rejects(source.batchTransfer.sourceNext(args.id,0),/摘要|变化/);
  await assert.rejects(source.batchTransfer.begin({...args,id:'different-task-123',role:'source'}),/另有/);
  source.db.prepare("UPDATE plugin_meta SET value='99' WHERE key='revision'").run();
  await assert.rejects(source.batchTransfer.sourceNext(args.id,1),/正式数据已变化/);
  target.db.prepare("DELETE FROM plugin_meta WHERE key=?").run('transfer:'+args.id);
  await assert.rejects(target.batchTransfer.begin({...args,role:'target'}),/缺少登记簿/);
});

test('验货回执写入故障会回滚计数，重试不重复累计；额外目标记录不能通过最终验收',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target');await seed(source,1);await start(source,target);
  const packet=await source.batchTransfer.sourceNext(args.id,0,{limit:1});await target.batchTransfer.append(args.id,packet);
  target.db.exec(`CREATE TEMP TRIGGER fail_checkpoint BEFORE UPDATE ON plugin_meta WHEN NEW.key='transfer:${args.id}' AND json_extract(NEW.value,'$.verifiedBatch')=1 BEGIN SELECT RAISE(ABORT,'checkpoint-failed');END`);
  await assert.rejects(target.batchTransfer.verifyBatch(args.id,1),/checkpoint-failed/);
  assert.equal((await target.batchTransfer.status(args.id)).verified,0);assert.equal(receipt(target,batchKey(args.id,1)).phase,'written');
  target.db.exec('DROP TRIGGER fail_checkpoint');await target.batchTransfer.verifyBatch(args.id,1);
  const summary=await move(source,target,{after:1});
  target.db.prepare('INSERT INTO records_next VALUES(?,?,?,?)').run('chat_meta',JSON.stringify('unexpected'),'unexpected',encode({chatKey:'unexpected'}));
  await target.batchTransfer.startSeal(args.id,summary);
  await assert.rejects(async()=>{while((await target.batchTransfer.sealStep(args.id,{limit:2})).phase==='checking'){};},/额外记录/);
});

test('完整快照和未保存变更可逐批验收，缺楼层、坏关联与孤儿普通记录不会转正',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target');await seed(source,1);
  await source.execute('putPendingChanges',[[{id:'pending-123',chatKey:'source',messageIndex:null,kind:'structure',raw:{keep:true}}]]);
  const snapshot=await captureSnapshot({ok:true,identity:{chatKey:'source'},chat:[{mes:'a'},{mes:'b'},{mes:'c'}],context:{chatMetadata:{}}},{name:'fixture'});
  await source.execute('beginSnapshot',[{header:snapshot.header,identityMeta:{chatKey:'source'}}]);
  for(const messages of snapshotBatches(snapshot.messages))await source.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages}]);
  await source.execute('publishSnapshot',[{id:snapshot.header.id}]);
  await start(source,target);const summary=await move(source,target);await seal(target,summary);
  assert.equal(summary.counts.pending_changes,1);assert.equal(summary.counts.snapshot_messages,3);

  const brokenSource=f.open('broken-source'),brokenTarget=f.open('broken-target');await seed(brokenSource,0);
  const header={...snapshot.header,written:3,state:'ready'};
  brokenSource.db.prepare('INSERT INTO records VALUES(?,?,?,?)').run('snapshots',JSON.stringify(header.id),'source',encode(header));
  await start(brokenSource,brokenTarget);const brokenSummary=await move(brokenSource,brokenTarget);
  await brokenTarget.batchTransfer.startSeal(args.id,brokenSummary);
  await assert.rejects(async()=>{while((await brokenTarget.batchTransfer.sealStep(args.id,{limit:2})).phase==='checking'){};},/楼层数量/);
  const orphanSource=f.open('orphan-source'),orphanTarget=f.open('orphan-target');
  await orphanSource.execute('putFullMessages',[{chatKey:'missing-meta',messages:[{chatKey:'missing-meta',messageIndex:0,raw:{mes:'orphan'}}]}]);
  await start(orphanSource,orphanTarget);
  await assert.rejects(move(orphanSource,orphanTarget),/关联聊天/);
});

test('未知表和损坏批次登记不会放宽保护或触发无界读回',async t=>{
  const f=fixture(t),repo=f.open('unknown');
  repo.db.exec('CREATE TABLE unknown_payload(value TEXT)');
  await assert.rejects(repo.batchTransfer.begin({...args,role:'target'}),/未知数据库表/);
  assert.equal(repo.db.prepare("SELECT value FROM plugin_meta WHERE key='transfer-lock'").get(),undefined);
  const source=f.open('source'),target=f.open('target');await seed(source);await start(source,target);
  const packet=await source.batchTransfer.sourceNext(args.id,0,{limit:1});await target.batchTransfer.append(args.id,packet);
  const key=batchKey(args.id,1),old=receipt(target,key);
  target.db.prepare('UPDATE plugin_meta SET value=? WHERE key=?').run(JSON.stringify({...old,refs:Array(101).fill(old.refs[0])}),key);
  await assert.rejects(target.batchTransfer.verifyBatch(args.id,1),/登记损坏|限额/);
  assert.equal((await target.batchTransfer.status(args.id)).verified,0);
});

test('损坏登记把目标指回原正式区时，准备清理拒绝执行且旧数据不变',async t=>{
  const target=fixture(t).open('target');await seed(target,2);const before=raw(target);
  await target.batchTransfer.begin({...args,role:'target'});
  const key='transfer:'+args.id,state=receipt(target,key);
  target.db.prepare('UPDATE plugin_meta SET value=? WHERE key=?').run(JSON.stringify({...state,dataset:state.previousDataset}),key);
  await assert.rejects(target.batchTransfer.prepareStep(args.id),/数据区或阶段/);
  assert.deepEqual(raw(target),before);
});
