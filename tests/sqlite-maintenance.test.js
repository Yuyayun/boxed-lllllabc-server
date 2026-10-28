import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteRepository} from '../src/sqlite.js';
import {SqliteWorker} from '../src/worker-client.js';
import {encodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';
function fixture(t){const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'boxed-maintenance-')),file=path.join(dir,'db.sqlite'),resources=[];t.after(()=>{for(const r of resources.reverse())try{r.close();}catch{}assert.equal(path.dirname(fs.realpathSync(dir)),root);fs.rmSync(dir,{recursive:true});});return {dir,file,track:r=>(resources.push(r),r),open(){return this.track(new SqliteRepository(file));}};}
function seed(f){const db=f.track(new DatabaseSync(f.file));db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE plugin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE records(store TEXT NOT NULL CHECK(store IN ('chat_meta','recent_messages','pending_changes','full_messages','historical_changes')),primary_key TEXT NOT NULL,chat_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(store,primary_key));CREATE INDEX by_chat ON records(store,chat_key,primary_key);PRAGMA application_id=1112496196;PRAGMA user_version=1");
  const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?)');db.exec('BEGIN');for(let i=0;i<231;i++){const key='chat-'+String(i).padStart(4,'0'),value={chatKey:key,text:'中文'.repeat(200),date:new Date(0),extra:undefined};insert.run('chat_meta',JSON.stringify(key),key,JSON.stringify(encodeStorageValue(value)));}db.exec("INSERT INTO plugin_meta VALUES('owner','default-user');INSERT INTO plugin_meta VALUES('revision','7');COMMIT");return db;
}
for(const stage of ['upgrade-backup','upgrade-copy-verified','upgrade-activated','upgrade-cleanup'])test(`真实旧约束/WAL 库在 ${stage} 中断后，原库或完整备份可恢复，重开能完成`,async t=>{
  const f=fixture(t),original=seed(f),before=original.prepare('SELECT * FROM records ORDER BY store,primary_key').all();let repo=f.open(),stopped=false;
  repo.reportProgress=(_metrics,current)=>{if(current===stage&&!stopped){stopped=true;throw new Error('fixture interruption');}};
  await assert.rejects(repo.initialize(),/fixture interruption/);assert.equal(stopped,true);
  const version=repo.db.prepare('PRAGMA user_version').get().user_version;
  if(version===1)assert.deepEqual(repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),before);
  else{const backup=fs.readdirSync(f.dir).find(x=>x.endsWith('.bak'));assert.ok(backup);const preserved=f.track(new DatabaseSync(path.join(f.dir,backup),{readOnly:true}));assert.deepEqual(preserved.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),before);}
  if(stage==='upgrade-copy-verified'){assert.throws(()=>original.exec("DELETE FROM records WHERE chat_key='chat-0000'"),/upgrade in progress/);assert.throws(()=>original.exec("UPDATE plugin_meta SET value='other' WHERE key='owner'"),/upgrade in progress/);}
  repo.close();repo=f.open();const progress=[];repo.reportProgress=(metrics,current)=>progress.push({metrics,current});await repo.initialize();assert.equal(repo.status().schema,4);assert.deepEqual(repo.db.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),before);assert.equal((await repo.execute('getChatMeta',['chat-0000'])).date.toISOString(),new Date(0).toISOString());assert.equal(repo.db.prepare("SELECT 1 FROM sqlite_master WHERE name='records_before_v3'").get(),undefined);assert.ok(progress.length>3);assert.equal(repo.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
test('已激活升级的备份丢失或变动时，不清理旧表也不开放读写',async t=>{
  const f=fixture(t);seed(f);let repo=f.open();repo.reportProgress=(_metrics,stage)=>{if(stage==='upgrade-activated')throw new Error('stop');};await assert.rejects(repo.initialize(),/stop/);repo.close();const backup=fs.readdirSync(f.dir).find(x=>x.endsWith('.bak')),db=f.track(new DatabaseSync(path.join(f.dir,backup)));db.exec("UPDATE records SET payload='changed' WHERE chat_key='chat-0000'");db.close();repo=f.open();await assert.rejects(repo.initialize(),/备份内容变化/);assert.equal(repo.db.prepare('SELECT count(*) AS n FROM records_before_v3').get().n,231);assert.throws(()=>repo.status(),/尚未开放/);
});
test('升级备份文件丢失时保留旧表与登记',async t=>{const f=fixture(t);seed(f);let repo=f.open();repo.reportProgress=(_m,stage)=>{if(stage==='upgrade-activated')throw new Error('stop');};await assert.rejects(repo.initialize(),/stop/);repo.close();const backup=fs.readdirSync(f.dir).find(x=>x.endsWith('.bak'));fs.renameSync(path.join(f.dir,backup),path.join(f.dir,backup+'.missing'));repo=f.open();await assert.rejects(repo.initialize(),/备份不可用/);assert.equal(repo.db.prepare('SELECT count(*) AS n FROM records_before_v3').get().n,231);});
test('启动改为有界逻辑检查，损坏载荷原样保留，检查有逐页真实反馈',async t=>{
  const f=fixture(t),repo=f.open();for(let i=0;i<205;i++)await repo.execute('putChatMeta',[{chatKey:String(i)}]);let pages=0;repo.reportProgress=(_m,stage)=>{if(stage==='startup-audit')pages++;};const prepare=repo.db.prepare.bind(repo.db);repo.db.prepare=sql=>{assert.doesNotMatch(sql,/PRAGMA quick_check|VACUUM INTO|INSERT INTO .* SELECT \*/i);return prepare(sql);};await repo.initialize();assert.ok(pages>=3);repo.db.prepare("UPDATE records SET payload='INVALID_JSON' WHERE chat_key='0'").run();await assert.rejects(repo.initialize());assert.equal(repo.db.prepare("SELECT payload FROM records WHERE chat_key='0'").get().payload,'INVALID_JSON');
});
test('旧库复制期间强制终止真实工作线程，重开后原内容完整且可完成升级',async t=>{
  const f=fixture(t),source=seed(f),before=source.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),worker=new SqliteWorker(f.file);
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Upgrade progress not observed')),10000);worker.worker.on('message',message=>{if(message.type==='progress'&&message.stage==='upgrade-copy-verified'){clearTimeout(timer);worker.fail(Object.assign(new Error('fixture forced exit'),{code:'outcome-unknown'}));worker.worker.terminate().then(resolve,reject);}});worker.worker.once('error',reject);});}finally{await worker.close();}
  const reopened=new SqliteWorker(f.file);try{const status=await reopened.call('_status',[],'default-user');assert.equal(status.counts.find(row=>row.store==='chat_meta').count,231);assert.deepEqual(source.prepare('SELECT * FROM records ORDER BY store,primary_key').all(),before);}finally{await reopened.close();}
});
test('启动解析错误不将载荷片段写入线程错误回执或日志事件',async t=>{const f=fixture(t),repo=f.open();await repo.execute('putChatMeta',[{chatKey:'keep'}]);repo.db.prepare("UPDATE records SET payload='PRIVATE_CHAT_BODY_INVALID_JSON'").run();repo.close();const worker=new SqliteWorker(f.file),events=[];worker.observe=event=>events.push(event);try{await assert.rejects(worker.call('_status',[],'default-user'),error=>{assert.doesNotMatch(error.message,/PRIVATE_CHAT_BODY/);return error.code==='database-unavailable';});assert.doesNotMatch(JSON.stringify(events),/PRIVATE_CHAT_BODY/);}finally{await worker.close();}});
