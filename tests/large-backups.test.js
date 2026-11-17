import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/sqlite.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const use = async callback => { const repo = new SqliteRepository(':memory:'); try { return await callback(repo); } finally { repo.close(); } };
const row = (messageIndex, text = 'body') => ({ messageIndex, raw: { mes: text }, canonicalHash: String(messageIndex) });
const call = (repo, method, ...args) => repo.execute(method, args);

test('分批完整替换在提交前保留旧备份；提交和重试仅完整生效一次', () => use(async repo => {
  await call(repo, 'putFullMessages', { chatKey: 'chat', messages: [row(0, 'old')], meta: { chatKey: 'chat' } });
  const summary = await call(repo, 'getBackupSummary', 'chat');
  const job = await call(repo, 'beginBackupWrite', { chatKey: 'chat', store: 'full_messages', count: 3, revision: summary.revision, meta: { fullBackupMessageCount: 3 } });
  await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows: [row(0), row(1)] });
  assert.equal((await call(repo, 'getFullMessages', 'chat'))[0].raw.mes, 'old');
  await assert.rejects(call(repo, 'commitBackupWrite', { id: job.id }), /完整/);
  await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows: [row(0), row(1)] });
  await call(repo, 'appendBackupWrite', { id: job.id, start: 2, rows: [row(2)] });
  assert.equal((await call(repo, 'commitBackupWrite', { id: job.id })).state, 'committed');
  assert.equal((await call(repo, 'commitBackupWrite', { id: job.id })).state, 'committed');
  assert.equal((await call(repo, 'getFullMessages', 'chat')).length, 3);
}));

test('正式来源变化后旧暂存不得覆盖；分页不拼接两个正式版本', () => use(async repo => {
  await call(repo, 'putFullMessages', { chatKey: 'chat', messages: [row(0)] });
  const summary = await call(repo, 'getBackupSummary', 'chat');
  const job = await call(repo, 'beginBackupWrite', { chatKey: 'chat', store: 'full_messages', count: 1, revision: summary.revision });
  await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows: [row(0, 'staged')] });
  await call(repo, 'putFullMessages', { chatKey: 'chat', messages: [row(0, 'newer')] });
  await assert.rejects(call(repo, 'commitBackupWrite', { id: job.id }), /变化/);
  await assert.rejects(call(repo, 'getBackupPage', { chatKey: 'chat', store: 'full_messages', revision: summary.revision }), /变化/);
  assert.equal((await call(repo, 'getFullMessages', 'chat'))[0].raw.mes, 'newer');
}));

test('大聊天分页和目录不受整包读取行数限制', () => use(async repo => {
  await call(repo, 'putFullMessages', { chatKey: 'large', messages: Array.from({ length: 25001 }, (_, i) => row(i)) });
  const summary = await call(repo, 'getBackupSummary', 'large');
  assert.equal(summary.counts.full_messages, 25001);
  let after = null, count = 0;
  do { const page = await call(repo, 'getBackupPage', { chatKey: 'large', store: 'full_messages', after, revision: summary.revision }); count += page.rows.length; after = page.after; } while (after !== null);
  assert.equal(count, 25001);
  const catalog = await call(repo, 'getBackupCatalogPage', {});
  assert.equal(catalog.items[0].full.count, 25001);
  assert.equal(JSON.stringify(catalog).includes('"raw"'), false);
}));
test('超过 128 MiB 的单聊天可以读取摘要和所有正文页', () => use(async repo => {
  await call(repo, 'putFullMessages', { chatKey: 'huge', messages: Array.from({ length: 129 }, (_, index) => row(index, 'x'.repeat(1024 * 1024))) });
  await assert.rejects(call(repo, 'getFullMessages', 'huge'), { code: 'too-large' });
  const summary = await call(repo, 'getBackupSummary', 'huge');
  let count = 0, after = null;
  do { const page = await call(repo, 'getBackupPage', { chatKey: 'huge', store: 'full_messages', after, revision: summary.revision }); count += page.rows.length; after = page.after; } while (after !== null);
  assert.equal(count, 129); assert.equal((await call(repo, 'getBackupCatalogPage', {})).items[0].full.count, 129);
}));
test('新清理接口原子复核版本，保留冻结完整备份和 pending', () => use(async repo => {
  await call(repo, 'putFullMessages', { chatKey: 'chat', messages: [row(0)], meta: { chatKey: 'chat', fullBackupState: 'frozen' } });
  await call(repo, 'putPendingChanges', [{ chatKey: 'chat', id: 'chat:0', messageIndex: 0 }]);
  const summary = await call(repo, 'getBackupSummary', 'chat');
  await assert.rejects(call(repo, 'deleteBackupV2', { chatKey: 'chat', store: 'full_messages', revision: summary.revision }), /保护/);
  await assert.rejects(call(repo, 'deleteBackupV2', { chatKey: 'chat', store: 'pending_changes', revision: summary.revision }), /未保存/);
  assert.equal((await call(repo, 'getFullMessages', 'chat')).length, 1);
}));
test('后端重开后半份暂存仍不可发布，旧完整备份及 schema 保持不变', async () => {
  const base = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(base, 'boxed-large-restart-')), file = path.join(directory, 'backup.sqlite');
  let repo = new SqliteRepository(file);
  try {
    await call(repo, 'putFullMessages', { chatKey: 'chat', messages: [row(0, 'old')] });
    const summary = await call(repo, 'getBackupSummary', 'chat');
    const job = await call(repo, 'beginBackupWrite', { chatKey: 'chat', store: 'full_messages', count: 100, revision: summary.revision });
    await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows: Array.from({ length: 40 }, (_, index) => row(index)) });
    repo.close(); repo = new SqliteRepository(file); await repo.initialize();
    assert.equal((await call(repo, 'getFullMessages', 'chat'))[0].raw.mes, 'old');
    await assert.rejects(call(repo, 'commitBackupWrite', { id: job.id }), /完整/);
    assert.equal(repo.db.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { repo.close(); const resolved = fs.realpathSync(directory); assert.equal(path.dirname(resolved), base); assert(path.basename(resolved).startsWith('boxed-large-restart-')); fs.rmSync(resolved, { recursive: true }); }
});
test('超大聊天改名在数据库内逐批接续，不受 32 MiB 整包预算影响', () => use(async repo => {
  const key = 'character:a.png:old', target = 'character:a.png:new';
  await call(repo, 'putFullMessages', { chatKey: key, meta: { chatKey: key, chatType: 'character', characterAvatar: 'a.png', chatId: 'old' }, messages: Array.from({ length: 40 }, (_, index) => row(index, 'x'.repeat(1024 * 1024))) });
  const result = await call(repo, 'migrateRenamedChatIdentity', { source: { chatId: 'old', sourceKey: key }, identity: { chatKey: target, meta: { chatKey: target, chatType: 'character', characterAvatar: 'a.png', chatId: 'new' } } });
  assert.equal(result.status, 'migrate');
  assert.equal((await call(repo, 'getBackupSummary', target)).counts.full_messages, 40);
  assert.equal((await call(repo, 'getBackupSummary', key)).counts.full_messages, 0);
}));
test('重复批次保留 Date、undefined 与 BigInt；失效暂存按批清理', () => use(async repo => {
  const summary = await call(repo, 'getBackupSummary', 'chat');
  const job = await call(repo, 'beginBackupWrite', { chatKey: 'chat', store: 'full_messages', count: 1, revision: summary.revision });
  const rows = [{ ...row(0), raw: { mes: 'x', date: new Date(0), missing: undefined, number: 123n } }];
  await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows });
  await call(repo, 'appendBackupWrite', { id: job.id, start: 0, rows });
  await call(repo, 'putChatMeta', { chatKey: 'other' });
  await call(repo, 'cleanupBackupWrites');
  assert.equal(await call(repo, 'getBackupWriteStatus', job.id), undefined);
}));
test('单聊天元数据或索引异常不拖垮其他目录项，正文读取异常按聊天分类', () => use(async repo => {
  for (const chatKey of ['bad-meta', 'bad-index', 'good']) await call(repo, 'putFullMessages', { chatKey, meta: { chatKey }, messages: [row(0)] });
  repo.db.prepare("UPDATE records SET payload='invalid-json' WHERE store='chat_meta' AND chat_key='bad-meta'").run();
  repo.db.prepare("UPDATE records SET primary_key='invalid-json' WHERE store='full_messages' AND chat_key='bad-index'").run();
  const catalog = await call(repo, 'getBackupCatalogPage', {});
  assert.equal(catalog.items.length, 3); assert.equal(catalog.items.find(item => item.chatKey === 'good').full.count, 1);
  assert(catalog.items.find(item => item.chatKey === 'bad-meta').error); assert(catalog.items.find(item => item.chatKey === 'bad-index').error);
  const summary = await call(repo, 'getBackupSummary', 'good');
  repo.db.prepare("UPDATE records SET payload='invalid-json' WHERE store='full_messages' AND chat_key='good'").run();
  await assert.rejects(call(repo, 'getBackupPage', { chatKey: 'good', store: 'full_messages', revision: summary.revision }), { code: 'backup-conflict' });
}));
