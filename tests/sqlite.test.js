import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRepository } from '../src/sqlite.js';
import { SqliteWorker } from '../src/worker-client.js';
import { fingerprintBackupRecords } from '../vendor/frontend/src/backup/cleanup.js';

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, 'boxed-server-test-'));
  const resources = [];
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close();
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('boxed-server-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { directory, file: path.join(directory, 'backup.sqlite'), track: (resource) => { resources.push(resource); return resource; } };
}
const message = (index = 0) => ({ chatKey: 'character:test.png:chat', messageIndex: index, raw: { mes: `中文 ${index}`, swipes: ['甲','乙'], swipe_id: 1, date: new Date('2026-10-26T00:00:00Z'), extra: { empty: null, missing: undefined } } });

test('真实落盘、关闭和重开，保留复合键、Date、swipe、null 和 undefined', async (t) => {
  const { file, track } = fixture(t);
  let repo = track(new SqliteRepository(file));
  const key = message().chatKey;
  await repo.execute('replaceRecentSnapshot', [{ meta: { chatKey: key }, messages: [message(),message(1)] }]);
  await repo.execute('replaceFullSnapshot', [{ chatKey: key, messages: [message()], meta: { chatKey: key, fullBackupState: 'active' } }]);
  await repo.execute('putHistoricalChanges', [[{ ...message(), firstCapturedAt: 'first' }]]);
  await repo.execute('putPendingChanges', [[{ id: `${key}:0`, chatKey: key, messageIndex: 0, canonicalHash: 'a' }]]);
  repo.owner('default-user');
  repo.close();
  repo = track(new SqliteRepository(file));
  try {
    assert.deepEqual(await repo.execute('getRecentMessages',[key]), [message(),message(1)]);
    assert.equal((await repo.execute('getFullMessages',[key])).length, 1);
    assert.equal((await repo.execute('getHistoricalChanges',[key])).length, 1);
    assert.equal((await repo.execute('getPendingChanges',[key])).length, 1);
    assert.equal(repo.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(repo.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.ok(repo.status().bytes > 0);
    assert.throws(() => repo.owner('another-user'), /归属不符/);
  } finally { repo.close(); }
});

test('事务第二条记录写入失败时回滚前面的写入及元数据', async (t) => {
  const { file, track } = fixture(t); const repo = track(new SqliteRepository(file));
  const key = message().chatKey;
  await repo.execute('replaceFullSnapshot', [{ chatKey: key, messages: [message()], meta: { chatKey: key, marker: 'original' } }]);
  await assert.rejects(repo.execute('replaceFullSnapshot', [{ chatKey: key, messages: [{...message(),raw:{ mes:'不应提交' }}, {...message(1),raw:{bad:()=>{}}}], meta:{chatKey:key,marker:'bad'} }]), /无法无损/);
  assert.deepEqual(await repo.execute('getFullMessages',[key]), [message()]);
  assert.equal((await repo.execute('getChatMeta',[key])).marker, 'original');
});

test('pending 指纹与共享取消标记保护、普通清理保护规则不放宽', async (t) => {
  const { file, track } = fixture(t); const repo = track(new SqliteRepository(file));
  const key = message().chatKey;
  const pending = { id: `${key}:0`, chatKey: key, messageIndex: 0, canonicalHash: 'a' };
  await repo.execute('putPendingChanges',[[pending]]);
  await repo.execute('putPendingChanges',[[{ ...pending, canonicalHash:'b' }]]);
  assert.deepEqual(await repo.execute('deletePendingChangesIfUnchanged',[[pending]]),[]);
  const cancel = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(cancel,0,1);
  await assert.rejects(repo.execute('deletePendingChangesIfUnchanged',[[{...pending,canonicalHash:'b'}]],cancel), /取消/);
  assert.equal((await repo.execute('getPendingChanges',[key])).length,1);
  await repo.execute('replaceFullSnapshot',[{chatKey:key,messages:[message()],meta:{chatKey:key,fullBackupState:'frozen'}}]);
  const fingerprint = fingerprintBackupRecords([{...message(),chatKey:key}]);
  await assert.rejects(repo.execute('deleteBackupTypeForChat',[{chatKey:key,type:'full',expectedFingerprint:fingerprint}]), /冻结/);
  await repo.execute('updateChatMetaSummary',[key,{fullBackupState:'awaiting-confirmation'}]);
  await assert.rejects(repo.execute('deleteBackupTypeForChat',[{chatKey:key,type:'full',expectedFingerprint:fingerprint}]), /等待后端确认/);
  await assert.rejects(repo.execute('deleteBackupTypeForChat',[{chatKey:key,type:'pending',expectedFingerprint:fingerprint}]), /无法识别/);
  await assert.rejects(repo.execute('deletePendingChanges',[[pending.id]]), /不支持/);
});

test('旧版共享 UUID 不合并分支，Rename 接续四类记录', async (t) => {
  const { file, track } = fixture(t); const repo = track(new SqliteRepository(file));
  const key = message().chatKey;
  const meta = { chatKey:key,chatType:'character',characterAvatar:'test.png',chatId:'chat',chatIntegrity:'same' };
  await repo.execute('replaceRecentSnapshot',[{meta,messages:[message()]}]);
  await repo.execute('putFullMessages',[{chatKey:key,messages:[message()],meta}]);
  await repo.execute('putHistoricalChanges',[[message()]]);
  await repo.execute('putPendingChanges',[[{id:`${key}:0`,chatKey:key,messageIndex:0}]]);
  const branch = {ok:true,chatKey:'character:test.png:branch',meta:{...meta,chatKey:'character:test.png:branch',chatId:'branch'}};
  assert.equal((await repo.execute('reconcileChatIdentity',[branch])).status,'new');
  assert.deepEqual(await repo.execute('getRecentMessages',[branch.chatKey]),[]);
  const targetKey='character:test.png:renamed';
  const rename={ok:true,source:{chatId:'chat'},identity:{ok:true,chatKey:targetKey,meta:{...meta,chatKey:targetKey,chatId:'renamed'}}};
  assert.equal((await repo.execute('migrateRenamedChatIdentity',[rename])).status,'migrate');
  for(const operation of ['getRecentMessages','getFullMessages','getHistoricalChanges','getPendingChanges']) {
    assert.equal((await repo.execute(operation,[targetKey])).length,1);
    assert.deepEqual(await repo.execute(operation,[key]),[]);
  }
});

test('已知旧 schema 升级前保留一致备份，未知/未来数据库拒绝覆盖', async (t) => {
  const { file, directory, track }=fixture(t); let repo=track(new SqliteRepository(file));
  await repo.execute('putChatMeta',[{chatKey:'retained'}]);
  repo.db.exec('PRAGMA user_version=0'); repo.close();
  repo=track(new SqliteRepository(file));
  assert.ok(fs.readdirSync(directory).some((name)=>name.endsWith('.bak')));
  assert.deepEqual(await repo.execute('getChatMeta',['retained']),{chatKey:'retained'});
  repo.db.exec('PRAGMA user_version=99'); repo.close();
  assert.throws(()=>new SqliteRepository(file),/兼容/);
  const unknown=path.join(directory,'unknown.sqlite'); const db=new DatabaseSync(unknown); db.exec('CREATE TABLE native_chat(value TEXT); INSERT INTO native_chat VALUES(\'keep\')'); db.close();
  assert.throws(()=>new SqliteRepository(unknown),/兼容/);
  const read=new DatabaseSync(unknown); assert.equal(read.prepare('SELECT value FROM native_chat').get().value,'keep'); read.close();
});

test('只读、损坏、锁占用、满盘均失败且已有数据保留', async (t) => {
  const {file,directory,track}=fixture(t); let repo=track(new SqliteRepository(file));
  await repo.execute('putChatMeta',[{chatKey:'kept',marker:'original'}]); repo.close();
  repo=track(new SqliteRepository(file,{readOnly:true}));
  await assert.rejects(repo.execute('putChatMeta',[{chatKey:'bad'}]),/readonly|read-only/i); repo.close();
  const locker=new DatabaseSync(file); locker.exec('BEGIN IMMEDIATE');
  repo=track(new SqliteRepository(file,{busyMs:10}));
  await assert.rejects(repo.execute('putChatMeta',[{chatKey:'locked'}]),/locked|busy/i);
  locker.exec('ROLLBACK'); locker.close();
  repo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pages=repo.db.prepare('PRAGMA page_count').get().page_count;
  repo.db.exec(`PRAGMA max_page_count=${pages}`);
  await assert.rejects(repo.execute('putChatMeta',[{chatKey:'full',content:'x'.repeat(500000)}]),/full/i);
  assert.deepEqual(await repo.execute('getChatMeta',['kept']),{chatKey:'kept',marker:'original'}); repo.close();
  const corrupt=path.join(directory,'corrupt.sqlite'); fs.writeFileSync(corrupt,'NOT A SQLITE DATABASE');
  assert.throws(()=>new SqliteRepository(corrupt)); assert.equal(fs.readFileSync(corrupt,'utf8'),'NOT A SQLITE DATABASE');
});

test('工作线程真实读写、队列拒绝、取消及关闭重开', async (t) => {
  const {file,track}=fixture(t); let worker=track(new SqliteWorker(file,{maxQueued:1}));
  const first=worker.call('putChatMeta',[{chatKey:'worker',date:new Date(0)}],'default-user');
  await assert.rejects(worker.call('_status',[],'default-user'),/队列已满/); await first;
  const abort=new AbortController(); abort.abort();
  await assert.rejects(worker.call('putChatMeta',[{chatKey:'cancelled'}],'default-user',{signal:abort.signal}),/取消/);
  await worker.close(); worker=track(new SqliteWorker(file));
  try { assert.deepEqual(await worker.call('getChatMeta',['worker'],'default-user'),{chatKey:'worker',date:new Date(0)}); assert.equal(await worker.call('getChatMeta',['cancelled'],'default-user'),undefined); }
  finally { await worker.close(); }
});
