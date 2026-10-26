import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { SqliteRepository } from '../src/sqlite.js';
import { batchData, seedBatchData } from './batch-fixture.js';
import { buildBackupCatalog } from '../vendor/frontend/src/backup/catalog.js';
import { createBatchCleanupPlan } from '../vendor/frontend/src/backup/batch-cleanup.js';
import { captureSnapshot } from '../vendor/frontend/src/snapshots/model.js';
import { readSnapshot } from '../vendor/frontend/src/snapshots/service.js';
import { encodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
function fixture(t) {
  const base=fs.realpathSync(os.tmpdir()), directory=fs.mkdtempSync(path.join(base,'boxed-batch-test-'));
  const repo=new SqliteRepository(path.join(directory,'backup.sqlite'));
  t.after(()=>{repo.close();assert.equal(path.dirname(fs.realpathSync(directory)),base);assert.ok(path.basename(directory).startsWith('boxed-batch-test-'));fs.rmSync(directory,{recursive:true});});
  const session=new Proxy({}, {get:(_target,name)=>(...args)=>repo.execute(name,args)});
  return {repo,session};
}
const preview=async(session,selection={range:'all'})=>createBatchCleanupPlan({catalog:buildBackupCatalog(await session.getBackupCatalogData()),selection,mode:'sqlite'});
const rows=repo=>repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all();
for(const range of ['all','owner','owner-selected','cross-selected'])test(`SQLite ${range} 原子删除仅命中所选普通备份，保留所有保护和快照`,async t=>{
  const {repo,session}=fixture(t),data=batchData(),key=data.chatMeta[0].chatKey;await seedBatchData(session,data);
  const snapshot=await captureSnapshot({ok:true,identity:{chatKey:key},context:{chatMetadata:{variables:{retained:true}}},chat:[{mes:'不可改变的快照',swipes:['a','b'],swipe_id:1}]},{name:'保留快照'});
  await session.beginSnapshot({header:snapshot.header,identityMeta:{chatKey:key}});await session.appendSnapshotMessages({id:snapshot.header.id,messages:snapshot.messages});await session.publishSnapshot({id:snapshot.header.id});
  const saved=await readSnapshot(session,snapshot.header.id);
  const selection={range,ownerKey:'character:a.png',chatKeys:range==='cross-selected'?[key,data.chatMeta[2].chatKey]:[key]};
  const plan=await preview(session,selection),result=await session.deleteBackupBatch({plan,confirmed:true});
  const expected={all:[7,5,10],owner:[5,3,7],'owner-selected':[3,1,4],'cross-selected':[5,3,7]}[range];
  assert.deepEqual([result.succeeded,result.skipped,result.deletedRecords],expected);assert.equal(result.failed,0);
  for(const meta of data.chatMeta){assert.equal((await session.getPendingChanges(meta.chatKey)).length,1);if(meta.fullBackupState!=='active')assert.equal((await session.getFullMessages(meta.chatKey)).length,1);}
  assert.deepEqual(await readSnapshot(session,snapshot.header.id),saved);
  assert.equal((await session.getChatMeta(key)).recentCount,0);
  if(range==='owner'||range==='owner-selected')assert.equal((await session.getRecentMessages(data.chatMeta[2].chatKey)).length,2);
  if(range==='owner-selected')assert.equal((await session.getRecentMessages(data.chatMeta[1].chatKey)).length,2);
});
for(const change of ['new-chat','data','pending','frozen','awaiting','unfrozen','owner','metadata','missing'])test(`SQLite 事务内发现 ${change} 变化时零删除`,async t=>{
  const {repo,session}=fixture(t),data=batchData(),key=data.chatMeta[0].chatKey;await seedBatchData(session,data);const plan=await preview(session);
  if(change==='new-chat')await session.replaceRecentSnapshot({meta:{chatKey:'new-chat'},messages:[{chatKey:'new-chat',messageIndex:0,raw:{mes:'new'}}]});
  if(change==='data')await session.replaceRecentSnapshot({meta:data.chatMeta[0],messages:[{chatKey:key,messageIndex:0,raw:{mes:'changed'}}]});
  if(change==='pending')await session.putPendingChanges([{...data.pendingChanges[0],canonicalHash:'changed'}]);
  if(change==='frozen'||change==='awaiting')await session.updateChatMetaSummary(key,{fullBackupState:change==='frozen'?'frozen':'awaiting-confirmation'});
  if(change==='unfrozen')await session.updateChatMetaSummary(data.chatMeta[1].chatKey,{fullBackupState:'active'});
  if(change==='owner')await session.updateChatMetaSummary(key,{characterAvatar:'moved.png'});
  if(change==='metadata')await session.updateChatMetaSummary(key,{chatDisplayName:'rename'});
  if(change==='missing')repo.db.prepare('DELETE FROM records WHERE chat_key=?').run(key);
  const before=rows(repo);await assert.rejects(session.deleteBackupBatch({plan,confirmed:true}),{code:'stale-cleanup-plan'});assert.deepEqual(rows(repo),before);
});
test('SQLite 删除中途 SQL 触发器故障回滚之前的删除和元数据；未确认/错端拒绝',async t=>{
  const {repo,session}=fixture(t);await seedBatchData(session);const plan=await preview(session),before=rows(repo);
  await assert.rejects(session.deleteBackupBatch({plan}),/明确确认/);
  await assert.rejects(session.deleteBackupBatch({plan:{...plan,mode:'indexeddb'},confirmed:true}),{code:'stale-cleanup-plan'});
  repo.db.exec("CREATE TEMP TRIGGER fail_batch BEFORE DELETE ON records WHEN OLD.store='historical_changes' BEGIN SELECT RAISE(ABORT,'forced-batch-delete'); END");
  await assert.rejects(session.deleteBackupBatch({plan,confirmed:true}),/forced-batch-delete/);assert.deepEqual(rows(repo),before);
  repo.db.exec('DROP TRIGGER fail_batch');assert.equal((await session.deleteBackupBatch({plan,confirmed:true})).deletedRecords,10);
});
test('SQLite 全局读取超过现有限额明确拒绝批量清理，不截断或部分删除',async t=>{
  const {repo,session}=fixture(t);await seedBatchData(session);const plan=await preview(session);
  const insert=repo.db.prepare('INSERT INTO records(store,primary_key,chat_key,payload) VALUES(?,?,?,?)');repo.db.exec('BEGIN');
  for(let i=0;i<25001;i++){const row={chatKey:'large',messageIndex:i,raw:{mes:'limit test'}};insert.run('recent_messages',JSON.stringify(['large',i]),'large',JSON.stringify(encodeStorageValue(row)));}
  repo.db.exec('COMMIT');const before=repo.db.prepare('SELECT count(*) AS n FROM records').get().n;
  await assert.rejects(session.deleteBackupBatch({plan,confirmed:true}),{code:'too-large'});assert.equal(repo.db.prepare('SELECT count(*) AS n FROM records').get().n,before);
});
