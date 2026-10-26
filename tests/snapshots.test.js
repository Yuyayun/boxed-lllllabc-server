import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import { SqliteRepository } from '../src/sqlite.js';
import { captureSnapshot } from '../vendor/frontend/src/snapshots/model.js';
import { readSnapshot, snapshotBatches } from '../vendor/frontend/src/snapshots/service.js';
import { fingerprintBackupRecords } from '../vendor/frontend/src/backup/cleanup.js';

function fixture(t) {
  const base=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(base,'boxed-snapshot-test-')),repos=[];
  t.after(()=>{repos.forEach(repo=>repo.close());assert.equal(path.dirname(fs.realpathSync(directory)),base);assert.ok(path.basename(directory).startsWith('boxed-snapshot-test-'));fs.rmSync(directory,{recursive:true});});
  return {directory,open(name='backup'){const repo=new SqliteRepository(path.join(directory,`${name}.sqlite`));repos.push(repo);return repo;}};
}
function port(repo) { return Object.fromEntries(['getSnapshotHeader','getSnapshotMessages'].map(method=>[method,(...args)=>repo.execute(method,args)])); }
const current=(name='original',count=2,size=30)=>({ok:true,identity:{chatKey:`character:test.png:${name}`,meta:{chatType:'character',characterAvatar:'test.png',chatId:name,chatIntegrity:'shared-uuid'}},chat:Array.from({length:count},(_,i)=>({mes:`${name}-${i}:`+'中'.repeat(size),swipes:['a','b'],swipe_id:1,extra:{date:new Date(0),unset:undefined,nullValue:null}})),context:{chatMetadata:{integrity:'shared-uuid',variables:{score:3}}}});
async function write(repo,source) {
  const snapshot=await captureSnapshot(source,{name:'人工快照'});await repo.execute('beginSnapshot',[{header:snapshot.header,identityMeta:{...source.identity.meta,chatKey:source.identity.chatKey}}]);
  for(const messages of snapshotBatches(snapshot.messages))await repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages}]);
  await repo.execute('publishSnapshot',[{id:snapshot.header.id}]);return snapshot;
}
test('SQLite 分批创建、关闭重开及正文/Date/swipe/undefined 校验；名称更新不改变内容',async t=>{
  const f=fixture(t);let repo=f.open();const source=current('original',160,25000),snapshot=await write(repo,source);repo.close();repo=f.open();
  const saved=await readSnapshot(port(repo),snapshot.header.id);assert.deepEqual(saved.chat,source.chat);assert.equal(saved.header.messageCount,160);
  await repo.execute('renameSnapshot',[{id:snapshot.header.id,name:'新名称',expectedName:'人工快照'}]);const renamed=await readSnapshot(port(repo),snapshot.header.id);assert.equal(renamed.header.name,'新名称');assert.equal(renamed.header.contentHash,snapshot.header.contentHash);assert.deepEqual(renamed.chat,saved.chat);
  await assert.rejects(repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages:[snapshot.messages[0]]}]),/暂存批次/);
});
test('创建途中真实事务失败不发布快照；坏摘要、缺层和元数据损坏禁止恢复',async t=>{
  const repo=fixture(t).open(),source=current(),snapshot=await captureSnapshot(source);
  await repo.execute('beginSnapshot',[{header:snapshot.header,identityMeta:{chatKey:source.identity.chatKey}}]);
  await assert.rejects(repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages:[{...snapshot.messages[0],raw:{mes:'tampered'}}]}]),/校验失败/);
  await assert.rejects(repo.execute('publishSnapshot',[{id:snapshot.header.id}]),/未完整/);assert.deepEqual((await repo.execute('listSnapshots',[{}])).items,[]);
  const drafts=await repo.execute('listSnapshots',[{includeDrafts:true}]);assert.equal(drafts.items.length,1);assert.equal(drafts.items[0].state,'draft');assert.equal(drafts.items[0].written,0);
  repo.db.exec("CREATE TEMP TRIGGER fail_snapshot BEFORE INSERT ON records WHEN NEW.store='snapshot_messages' BEGIN SELECT RAISE(ABORT,'forced-snapshot-failure'); END");
  await assert.rejects(repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages:snapshot.messages}]),/forced-snapshot-failure/);assert.equal((await repo.execute('getSnapshotHeader',[snapshot.header.id])).written,0);
  repo.db.exec('DROP TRIGGER fail_snapshot');await repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages:snapshot.messages}]);await repo.execute('publishSnapshot',[{id:snapshot.header.id}]);
  repo.db.prepare("DELETE FROM records WHERE store='snapshot_messages' AND primary_key=?").run(JSON.stringify([snapshot.header.id,0]));await assert.rejects(readSnapshot(port(repo),snapshot.header.id),/缺失|不完整/);
});
test('普通清理不涉及快照；Rename 接续头信息但正文不变，相同 UUID Branch 独立',async t=>{
  const repo=fixture(t).open(),source=current(),snapshot=await write(repo,source),key=source.identity.chatKey;
  const messages=[{chatKey:key,messageIndex:0,raw:{mes:'ordinary'}}];await repo.execute('replaceRecentSnapshot',[{meta:{...source.identity.meta,chatKey:key},messages}]);
  await repo.execute('deleteBackupTypeForChat',[{chatKey:key,type:'recent',expectedFingerprint:fingerprintBackupRecords(messages)}]);assert.deepEqual((await readSnapshot(port(repo),snapshot.header.id)).chat,source.chat);
  const branch=current('branch').identity;await repo.execute('reconcileChatIdentity',[branch]);assert.equal((await repo.execute('listSnapshots',[{}])).items.some(item=>item.chatKey===branch.chatKey),false);
  const target=current('renamed').identity;await repo.execute('migrateRenamedChatIdentity',[{ok:true,source:{chatId:'original'},identity:target}]);const renamed=await readSnapshot(port(repo),snapshot.header.id);assert.equal(renamed.header.chatKey,target.chatKey);assert.equal(renamed.header.contentHash,snapshot.header.contentHash);assert.deepEqual(renamed.chat,source.chat);
  await assert.rejects(repo.execute('deleteSnapshot',[{id:snapshot.header.id,expectedHash:'wrong'}]),/已变化/);await repo.execute('deleteSnapshot',[{id:snapshot.header.id,expectedHash:snapshot.header.contentHash}]);assert.equal(await repo.execute('getSnapshotHeader',[snapshot.header.id]),undefined);assert.equal((await repo.execute('getSnapshotMessages',[{id:snapshot.header.id}])).length,0);
});
test('SQLite schema 2→3 保留旧普通记录、创建备份，并能使用新增快照模型',async t=>{
  const f=fixture(t);let repo=f.open();await repo.execute('putChatMeta',[{chatKey:'kept',marker:'old'}]);repo.db.exec('PRAGMA user_version=2');repo.close();repo=f.open();assert.equal(repo.status().schema,3);assert.equal((await repo.execute('getChatMeta',['kept'])).marker,'old');assert.ok(fs.readdirSync(f.directory).some(name=>name.includes('before-v3')));await write(repo,current());
});
test('完整迁移包含快照，目标事务失败保持原快照，回滚及重试后源快照仍保留',async t=>{
  const f=fixture(t),source=f.open('source'),target=f.open('target'),from=await write(source,current('from')),old=await write(target,current('old'));
  const id='snapshot-transfer-123';await source.transfer('source',{id});const manifest=await source.transfer('seal',{id});assert.equal(manifest.counts.snapshots,1);assert.equal(manifest.counts.snapshot_messages,2);await target.transfer('prepare',{id,manifest});
  let after=0;while(true){const rows=await source.transfer('page',{id,after});if(!rows.length)break;await target.transfer('append',{id,rows});after=rows.at(-1).n;}await target.transfer('seal',{id});
  target.db.exec("CREATE TEMP TRIGGER fail_snapshot_commit BEFORE INSERT ON records WHEN NEW.store='snapshot_messages' BEGIN SELECT RAISE(ABORT,'forced-transfer-failure'); END");await assert.rejects(target.transfer('commit',{id}),/forced-transfer-failure/);assert.equal(target.db.prepare("SELECT count(*) AS n FROM records WHERE store='snapshots'").get().n,1);
  target.db.exec('DROP TRIGGER fail_snapshot_commit');await target.transfer('commit',{id});await target.transfer('rollback',{id});assert.equal((await readSnapshot(port(target),old.header.id)).header.name,'人工快照');
  await source.transfer('rollback',{id});assert.equal((await readSnapshot(port(source),from.header.id)).chat.length,2);
});
test('快照恢复保护独立于普通结构记录，证明变化时拒绝旧响应删除，Rename 后两条仍分离',async t=>{
  const repo=fixture(t).open(),source=current(),key=source.identity.chatKey;
  await repo.execute('putChatMeta',[{...source.identity.meta,chatKey:key}]);
  const record={id:key+':snapshot-restore',chatKey:key,messageIndex:null,kind:'restore',canonicalChatHash:'same',snapshotSaveProof:{format:1,metadataHash:'a'.repeat(64)}};
  await repo.execute('putPendingChanges',[[{id:key+':structural',chatKey:key,messageIndex:null,kind:'structural_change'},record]]);
  await repo.execute('putPendingChanges',[[{...record,snapshotSaveProof:{format:1,metadataHash:'b'.repeat(64)}}]]);
  assert.deepEqual(await repo.execute('deletePendingChangesIfUnchanged',[[record]]),[]);
  const target=current('renamed').identity;await repo.execute('migrateRenamedChatIdentity',[{ok:true,source:{chatId:'original'},identity:target}]);
  const pending=await repo.execute('getPendingChanges',[target.chatKey]);assert.equal(pending.length,2);assert.equal(new Set(pending.map(row=>row.id)).size,2);assert.equal(pending.find(row=>row.snapshotSaveProof).snapshotSaveProof.metadataHash,'b'.repeat(64));
});
