import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRepository } from '../src/sqlite.js';
import { captureSnapshot } from '../vendor/frontend/src/snapshots/model.js';
import { readSnapshot, snapshotBatches } from '../vendor/frontend/src/snapshots/service.js';

function fixture(t) {
  const root=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(root,'boxed-dataset-test-')),repos=[];
  t.after(()=>{for(const repo of repos)repo.close();assert.equal(path.dirname(fs.realpathSync(directory)),root);assert.ok(path.basename(directory).startsWith('boxed-dataset-test-'));fs.rmSync(directory,{recursive:true});});
  return {directory,file:path.join(directory,'db.sqlite'),open(){const repo=new SqliteRepository(this.file);repos.push(repo);return repo;}};
}
const put=(repo,key,value)=>repo.db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
const get=(repo,key)=>JSON.parse(repo.db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key).value);
const manifest={count:2,bytes:200,digest:'fixture-verified'};
function register(repo,id='dataset-test-123') {
  put(repo,'transfer-lock',id);
  const state={version:3,id,role:'target',phase:'verified',dataset:1,previousDataset:0,baseRevision:get(repo,'revision'),manifest};
  put(repo,'transfer:'+id,state);return id;
}
async function seed(repo) {
  await repo.execute('putChatMeta',[{chatKey:'same',marker:'old'}]);
  await repo.execute('putFullMessages',[{chatKey:'same',messages:[{chatKey:'same',messageIndex:0,raw:{mes:'old'}}]}]);
  put(repo,'active-dataset',1);
  await repo.execute('putChatMeta',[{chatKey:'same',marker:'new'}]);
  await repo.execute('putFullMessages',[{chatKey:'same',messages:[{chatKey:'same',messageIndex:0,raw:{mes:'new',date:new Date(0),missing:undefined}}]}]);
  put(repo,'active-dataset',0);
}
function forbidPayloadWrites(repo) {
  for(const table of ['records','records_next'])for(const action of ['INSERT','UPDATE','DELETE'])repo.db.exec(`CREATE TEMP TRIGGER no_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'payload-write-during-activation');END`);
}

test('schema 3→4 只增加空数据区，原记录字节及原索引保留',async t=>{
  const f=fixture(t);let repo=f.open();await repo.execute('putChatMeta',[{chatKey:'old',raw:{date:new Date(0),missing:undefined}}]);
  const before=repo.db.prepare('SELECT * FROM records').all();
  repo.db.exec('DROP TABLE records_next;PRAGMA user_version=3');repo.close();
  repo=f.open();assert.equal(repo.status().schema,4);assert.deepEqual(repo.db.prepare('SELECT * FROM records').all(),before);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM records_next').get().n,0);
  assert.equal(repo.activeDataset(),0);
});

test('真实 SQLite 启用、重复提交、重开及回退只修改元数据，不复制或删除正文',async t=>{
  const f=fixture(t);let repo=f.open();await seed(repo);
  // Populate statement caches against the legacy area before switching.
  assert.equal((await repo.execute('getChatMeta',['same'])).marker,'old');
  const id=register(repo);forbidPayloadWrites(repo);
  assert.equal(repo.changeDataset('commit',id,manifest).phase,'committed');
  assert.equal(repo.activeDataset(),1);
  assert.equal(repo.changeDataset('commit',id,manifest).phase,'committed');
  await assert.rejects(repo.execute('getChatMeta',['same']),/暂停/);
  repo.close();repo=f.open();forbidPayloadWrites(repo);
  assert.equal(repo.activeDataset(),1);assert.equal(get(repo,'transfer:'+id).phase,'committed');
  assert.equal(repo.changeDataset('rollback',id).phase,'rolling-back');
  assert.equal(repo.activeDataset(),0);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM records').get().n,2);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM records_next').get().n,2);
});

test('活动区中的正常读写、缓存、目录和快照都使用新数据区，旧区不变',async t=>{
  const repo=fixture(t).open();await seed(repo);
  const old=repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all();
  assert.equal((await repo.execute('getFullMessages',['same']))[0].raw.mes,'old');
  const id=register(repo);repo.changeDataset('commit',id,manifest);
  // Simulate the future coordinator completing activation, then unlocking.
  put(repo,'transfer:'+id,{...get(repo,'transfer:'+id),phase:'finished'});
  repo.db.prepare("DELETE FROM plugin_meta WHERE key='transfer-lock'").run();
  assert.equal((await repo.execute('getChatMeta',['same'])).marker,'new');
  const row=(await repo.execute('getFullMessages',['same']))[0];assert.equal(row.raw.mes,'new');assert.ok(row.raw.date instanceof Date);assert.ok(Object.hasOwn(row.raw,'missing'));
  await repo.execute('putChatMeta',[{chatKey:'only-new'}]);
  const catalog=await repo.execute('getBackupCatalogData',[]);assert.ok(catalog.chatMeta.some(row=>row.chatKey==='only-new'));
  const source={ok:true,identity:{chatKey:'same',meta:{chatKey:'same'}},chat:[{mes:'snapshot',extra:{date:new Date(0)}}],context:{chatMetadata:{variable:1}}};
  const snapshot=await captureSnapshot(source,{name:'new-area'});
  await repo.execute('beginSnapshot',[{header:snapshot.header,identityMeta:source.identity.meta}]);
  for(const messages of snapshotBatches(snapshot.messages))await repo.execute('appendSnapshotMessages',[{id:snapshot.header.id,messages}]);
  await repo.execute('publishSnapshot',[{id:snapshot.header.id}]);
  const port=Object.fromEntries(['getSnapshotHeader','getSnapshotMessages'].map(name=>[name,(...args)=>repo.execute(name,args)]));
  assert.deepEqual((await readSnapshot(port,snapshot.header.id)).chat,source.chat);
  assert.deepEqual(repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),old);
  await assert.rejects(repo.transfer('source',{id:'legacy-operation-123'}),/新版分批/);
  const reverse='reverse-dataset-123';
  put(repo,'transfer-lock',reverse);
  put(repo,'transfer:'+reverse,{version:3,id:reverse,role:'target',phase:'verified',dataset:0,previousDataset:1,baseRevision:get(repo,'revision'),manifest});
  repo.changeDataset('commit',reverse,manifest);
  assert.equal(repo.activeDataset(),0);
  repo.db.prepare("DELETE FROM plugin_meta WHERE key='transfer-lock'").run();
  assert.equal((await repo.execute('getChatMeta',['same'])).marker,'old');
});

test('错误清单、无锁、修订变化和损坏标记拒绝启用，回退不覆盖提交后的写入',async t=>{
  const repo=fixture(t).open();await seed(repo);const id=register(repo);
  assert.throws(()=>repo.changeDataset('commit',id,{...manifest,digest:'bad'}));
  assert.equal(repo.activeDataset(),0);
  put(repo,'transfer-lock','another-task');assert.throws(()=>repo.changeDataset('commit',id,manifest),/持久数据锁/);
  put(repo,'transfer-lock',id);repo.changeDataset('commit',id,manifest);
  put(repo,'revision',get(repo,'revision')+1);
  assert.throws(()=>repo.changeDataset('rollback',id),/不能自动回退/);assert.equal(repo.activeDataset(),1);
  repo.db.prepare("DELETE FROM plugin_meta WHERE key='transfer-lock'").run();
  put(repo,'active-dataset','1');await assert.rejects(repo.execute('getChatMeta',['same']),/标记无效/);
});

test('活动标记写入后回执写入失败，真实 SQLite 事务回滚全部元数据',async t=>{
  const repo=fixture(t).open();await seed(repo);const id=register(repo),revision=get(repo,'revision');
  repo.db.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE UPDATE ON plugin_meta WHEN NEW.key='transfer:${id}' BEGIN SELECT RAISE(ABORT,'forced-receipt-failure');END`);
  assert.throws(()=>repo.changeDataset('commit',id,manifest),/forced-receipt-failure/);
  assert.equal(repo.activeDataset(),0);assert.equal(get(repo,'revision'),revision);assert.equal(get(repo,'transfer:'+id).phase,'verified');
  repo.db.exec('DROP TRIGGER fail_receipt');repo.changeDataset('commit',id,manifest);assert.equal(repo.activeDataset(),1);
});
