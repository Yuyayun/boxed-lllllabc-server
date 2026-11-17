import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/sqlite.js';

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
