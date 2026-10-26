import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteRepository } from '../src/sqlite.js';
import { digestRow, readTransferManifest, emptyManifest } from '../vendor/frontend/src/storage/transfer-format.js';

function fixture(t) {
  const base=fs.realpathSync(os.tmpdir());const directory=fs.mkdtempSync(path.join(base,'boxed-transfer-test-'));const resources=[];
  t.after(()=>{for(const repo of resources)repo.close();assert.equal(path.dirname(fs.realpathSync(directory)),base);assert.ok(path.basename(directory).startsWith('boxed-transfer-test-'));fs.rmSync(directory,{recursive:true});});
  return {file:path.join(directory,'backup.sqlite'),directory,open(){const repo=new SqliteRepository(this.file);resources.push(repo);return repo;}};
}
async function staged(repo,id) {
  const rows=[{n:1,store:'chat_meta',key:'source',value:{chatKey:'source',fullBackupState:'frozen',date:new Date(0)}},{n:2,store:'full_messages',key:['source',0],value:{chatKey:'source',messageIndex:0,raw:{mes:'中文',swipes:['a','b'],swipe_id:1,extra:{optional:undefined}}}}];
  for(const row of rows)row.digest=await digestRow(row);
  await repo.transfer('prepare',{id,manifest:await readTransferManifest(async(after)=>after?[]:rows)});await repo.transfer('append',{id,rows});await repo.transfer('append',{id,rows});await repo.transfer('seal',{id});return rows;
}
test('SQLite 1→2 升级保留原记录并创建一致备份',async(t)=>{
  const f=fixture(t);let repo=f.open();await repo.execute('putChatMeta',[{chatKey:'kept',marker:'before'}]);repo.db.exec('DROP TABLE transfer_rows; PRAGMA user_version=1');repo.close();repo=f.open();
  assert.equal(repo.status().schema,2);assert.deepEqual(await repo.execute('getChatMeta',['kept']),{chatKey:'kept',marker:'before'});assert.ok(fs.readdirSync(f.directory).some(name=>name.includes('before-v2')));
});
test('提交途中 SQLite 真实触发器报错，目标删除和写入全部回滚；重试提交可再回滚',async(t)=>{
  const f=fixture(t);const repo=f.open();await repo.execute('putChatMeta',[{chatKey:'old',marker:'retained'}]);const id='failure-case-123';await staged(repo,id);
  await assert.rejects(repo.execute('putChatMeta',[{chatKey:'blocked'}]),/暂停/);
  repo.db.exec("CREATE TEMP TRIGGER fail_transfer BEFORE INSERT ON records WHEN NEW.chat_key='source' BEGIN SELECT RAISE(ABORT,'forced-transfer-failure'); END");
  await assert.rejects(repo.transfer('commit',{id}),/forced-transfer-failure/);
  assert.equal(repo.db.prepare('SELECT count(*) AS n FROM records').get().n,1);assert.equal(repo.db.prepare('SELECT chat_key FROM records').get().chat_key,'old');assert.equal((await repo.transfer('status',{id})).phase,'verified');
  repo.db.exec('DROP TRIGGER fail_transfer');await repo.transfer('commit',{id});await repo.transfer('check',{id,after:0});repo.close();
  const reopened=f.open();await reopened.transfer('rollback',{id});assert.deepEqual(await reopened.execute('getChatMeta',['old']),{chatKey:'old',marker:'retained'});assert.equal(await reopened.execute('getChatMeta',['source']),undefined);
});
test('源快照持久锁、分页和异常关联校验，空清单清空后读回验证',async(t)=>{
  const repo=fixture(t).open();await repo.execute('putChatMeta',[{chatKey:'source'}]);await repo.execute('putFullMessages',[{chatKey:'source',messages:Array.from({length:205},(_,i)=>({chatKey:'source',messageIndex:i,raw:{mes:'中'.repeat(6000)}}))}]);
  const id='source-case-123';await repo.transfer('source',{id});await assert.rejects(repo.execute('getChatMeta',['source']),/暂停/);
  const manifest=await repo.transfer('seal',{id});assert.equal(manifest.count,206);let after=0,pages=0;while(true){const rows=await repo.transfer('page',{id,after});if(!rows.length)break;assert.ok(rows.length<=100);after=rows.at(-1).n;pages++;}assert.ok(pages>=3);await repo.transfer('rollback',{id});
  await repo.execute('putFullMessages',[{chatKey:'orphan',messages:[{chatKey:'orphan',messageIndex:0}]}]);const orphan='orphan-case-123';await repo.transfer('source',{id:orphan});await assert.rejects(repo.transfer('seal',{id:orphan}),/关联元数据/);await repo.transfer('rollback',{id:orphan});
  const clear='clear-case-123';await repo.transfer('prepare',{id:clear,manifest:await emptyManifest()});await repo.transfer('seal',{id:clear});await repo.transfer('commit',{id:clear});assert.equal((await repo.transfer('check',{id:clear,after:0})).done,true);await repo.transfer('finish',{id:clear});assert.deepEqual(await repo.execute('getFullMessages',['source']),[]);
});
test('未知 SQLite 数据表拒绝采集或目标覆盖，不删除未知记录或遗留任务锁',async(t)=>{
  const repo=fixture(t).open();repo.db.exec("CREATE TABLE future_snapshots(value TEXT); INSERT INTO future_snapshots VALUES('retain')");
  await assert.rejects(repo.transfer('source',{id:'unknown-source-123'}),/未知数据库表/);
  await assert.rejects(repo.transfer('prepare',{id:'unknown-target-123',manifest:await emptyManifest()}),/未知数据库表/);
  assert.equal(repo.db.prepare('SELECT value FROM future_snapshots').get().value,'retain');assert.equal(repo.db.prepare("SELECT value FROM plugin_meta WHERE key='transfer-lock'").get(),undefined);
});
