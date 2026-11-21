// Shared test cases for real IndexedDB and SQLite adapters. No production data.
const stores = ['recent_messages', 'full_messages', 'historical_changes', 'pending_changes'];
const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (actual, expected, message = '结果不一致') => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} / ${JSON.stringify(expected)}`);
const reject = async (operation, code) => {
  try { await operation(); } catch (error) { if (code) same(error.code, code, '错误代码'); return; }
  throw new Error('应当拒绝过期凭据或失败写入');
};

export function backupVersionCases(api) {
  const { readBackupRecords, readBackupBundle, backupVersionOptions, createBatchCleanupPlan } = api;
  const cases = [];
  const add = (name, run) => cases.push({ name, run });
  const fixture = async (s, { length = 95, onlyRecent = false } = {}) => {
    const id = crypto.randomUUID(), key = `character:version-test.png:${id}`;
    const identity = { ok: true, chatKey: key, meta: { chatKey: key, chatId: id, chatType: 'character', characterAvatar: 'version-test.png' } };
    const row = (messageIndex, text = `正文 ${messageIndex}`) => ({ chatKey: key, messageIndex, raw: { mes: text, is_user: true }, canonicalHash: `${messageIndex}:${text}` });
    const rows = Array.from({ length }, (_, i) => row(i));
    await s.replaceRecentSnapshot({ meta: identity.meta, messages: rows });
    if (!onlyRecent) {
      await s.replaceFullSnapshot({ chatKey: key, messages: rows, meta: { ...identity.meta, fullBackupState: 'frozen', fullBackupMessageCount: length } });
      await s.putHistoricalChanges([{ ...row(26), message: row(26) }]);
      await s.putPendingChanges([{ id: `${key}:26`, chatKey: key, messageIndex: 26, canonicalHash: 'pending' }]);
    }
    const summary = () => s.getBackupSummary(key);
    const delta = (before, after) => stores.map(store => after.scopes[store].revision - before.scopes[store].revision);
    const checkDelta = async (before, expected) => same(delta(before, await summary()), expected, '正文版本增量');
    const body = () => readBackupRecords(s, key, 'full_messages');
    const wrapped = hook => ({ ...s, async getBackupPage(options) { await hook(options); return s.getBackupPage(options); } });
    return { s, key, identity, row, rows, summary, delta, checkDelta, body, wrapped };
  };

  add('current/new 身份核对和独立 meta 更新不改变正文版本', async s => {
    const f = await fixture(s), before = await f.summary(), body = await f.body();
    for (let i = 0; i < 4; i++) same((await s.reconcileChatIdentity(f.identity)).status, 'current');
    const nextKey = f.key + '-new';
    same((await s.reconcileChatIdentity({ ...f.identity, chatKey: nextKey, meta: { ...f.identity.meta, chatKey: nextKey, chatId: 'new' } })).status, 'new');
    await s.updateChatMetaSummary(f.key, { lastBackendStatus: 'saved' });
    await f.checkDelta(before, [0, 0, 0, 0]); same(await f.body(), body);
    assert((await f.summary()).revision > before.revision, '保留兼容的全局 revision');
  });

  add('无实际迁移的改名与身份歧义不改变正文版本', async s => {
    const f = await fixture(s), before = await f.summary();
    for (const targetExists of [true, false]) {
      const target = targetExists ? f.identity : { ...f.identity, chatKey: f.key + '-absent', meta: { ...f.identity.meta, chatId: 'absent' } };
      same((await s.migrateRenamedChatIdentity({ source: { chatId: 'missing' }, identity: target })).status, targetExists ? 'current' : 'source-missing');
    }
    const legacy = [f.key + '-legacy-a', f.key + '-legacy-b'];
    for (const chatKey of legacy) await s.putChatMeta({ ...f.identity.meta, chatKey });
    same((await s.reconcileChatIdentity({ ...f.identity, chatKey: f.key + '-ambiguous', legacyChatKeys: legacy })).status, 'ambiguous');
    await f.checkDelta(before, [0, 0, 0, 0]);
  });

  add('身份迁移发现目标已有正文时不写入也不改变版本', async s => {
    const f = await fixture(s), targetKey = f.key + '-conflict';
    await s.putFullMessages({ chatKey: targetKey, messages: [f.row(0)] });
    const before = await f.summary();
    same((await s.reconcileChatIdentity({ ...f.identity, chatKey: targetKey, legacyChatKeys: [f.key] })).status, 'conflict');
    await f.checkDelta(before, [0, 0, 0, 0]); same((await f.body()).length, 95);
  });

  for (const explicit of [true, false]) add(`${explicit ? '明确改名' : '旧身份迁移'}只移动 recent 时仅增加 recent 版本`, async s => {
    const f = await fixture(s, { onlyRecent: true }), before = await f.summary(), targetKey = f.key + '-moved';
    const target = { ...f.identity, chatKey: targetKey, legacyChatKeys: [f.key], meta: { ...f.identity.meta, chatKey: targetKey, chatId: 'moved' } };
    const result = explicit ? await s.migrateRenamedChatIdentity({ source: { chatId: f.identity.meta.chatId }, identity: target }) : await s.reconcileChatIdentity(target);
    same(result.status, 'migrate'); await f.checkDelta(before, [1, 0, 0, 0]);
    same((await s.getBackupSummary(targetKey)).counts.recent_messages, 95);
    await reject(() => s.getBackupPage({ chatKey: f.key, store: 'recent_messages', ...backupVersionOptions(before, 'recent_messages') }), 'backup-version-changed');
  });

  add('真正迁移四类记录各增一次且旧身份读取失效', async s => {
    const f = await fixture(s), before = await f.summary(), targetKey = f.key + '-all';
    const target = { ...f.identity, chatKey: targetKey, meta: { ...f.identity.meta, chatKey: targetKey, chatId: 'moved' } };
    same((await s.migrateRenamedChatIdentity({ source: { chatId: f.identity.meta.chatId }, identity: target })).status, 'migrate');
    await f.checkDelta(before, [1, 1, 1, 1]);
    for (const store of stores) {
      same((await f.summary()).counts[store], 0);
      const rows = await readBackupRecords(s, targetKey, store);
      assert(rows.length > 0 && rows.every(row => row.chatKey === targetKey), '迁移后记录必须属于新身份');
      await reject(() => s.getBackupPage({ chatKey: f.key, store, ...backupVersionOptions(before, store) }), 'backup-version-changed');
    }
  });

  for (const [store, length] of [['full_messages', 95], ['full_messages', 1001], ['recent_messages', 95]]) add(`${length} 层 ${store} 分页期间每页核对身份仍一次读完`, async s => {
    const f = await fixture(s, { length }), before = await f.summary(); let pages = 0;
    const wrapped = f.wrapped(async options => { if (options.store === store) { pages++; await s.reconcileChatIdentity(f.identity); } });
    const rows = await readBackupRecords(wrapped, f.key, store);
    same(rows.length, length); same(rows[26].raw.mes, '正文 26'); same(pages, Math.ceil(length / 50));
    await f.checkDelta(before, [0, 0, 0, 0]); same((await f.summary()).meta.fullBackupState, 'frozen');
  });

  add('空 full 写入和未删除的 pending 核销不改变正文版本', async s => {
    const f = await fixture(s), before = await f.summary(), full = await f.body(), pending = await s.getPendingChanges(f.key);
    await s.putFullMessages({ chatKey: f.key, messages: [], meta: { lastBackendStatus: 'checking' } });
    same(await s.deletePendingChangesIfUnchanged([{ ...pending[0], canonicalHash: 'stale' }]), []);
    await f.checkDelta(before, [0, 0, 0, 0]); same(await f.body(), full); same(await s.getPendingChanges(f.key), pending);
    same(await s.deletePendingChangesIfUnchanged(pending), [pending[0].id]);
    await f.checkDelta(before, [0, 0, 0, 1]);
    const cleared = await f.summary(); same(await s.deletePendingChangesIfUnchanged(pending), []);
    await f.checkDelta(cleared, [0, 0, 0, 0]);
  });

  add('旧批量清理仅删除 recent，保护的 full 和 pending 版本不动', async s => {
    const f = await fixture(s), before = await f.summary();
    const plan = createBatchCleanupPlan({ catalog: await s.getBackupCatalog(), selection: { range: 'cross-selected', chatKeys: [f.key], types: ['recent'] }, mode: s.testMode });
    assert(plan.canConfirm, plan.blockedReason);
    same((await s.deleteBackupBatch({ plan, confirmed: true })).deletedRecords, 95);
    await f.checkDelta(before, [1, 0, 0, 0]); same((await f.summary()).counts.full_messages, 95); same((await f.summary()).counts.pending_changes, 1);
  });

  add('游标清空确实删除时增加版本，重复清空空集合不增加', async s => {
    const f = await fixture(s), before = await f.summary();
    await s.replaceFullSnapshot({ chatKey: f.key, messages: [], meta: { chatKey: f.key } });
    await f.checkDelta(before, [0, 1, 0, 0]); same((await f.summary()).counts.full_messages, 0);
    const empty = await f.summary();
    await s.replaceFullSnapshot({ chatKey: f.key, messages: [], meta: { chatKey: f.key } });
    await f.checkDelta(empty, [0, 0, 0, 0]);
  });

  add('正文中途失败时回滚正文和版本', async s => {
    const f = await fixture(s), before = await f.summary(), body = await f.body();
    await reject(() => s.putFullMessages({ chatKey: f.key, messages: [f.row(0, '不应提交'), { ...f.row(1), raw: { invalid() {} } }] }));
    await f.checkDelta(before, [0, 0, 0, 0]); same(await f.body(), body);
  });

  add('真实正文变更拦截旧页，重新读取获得同一个新版本', async s => {
    const f = await fixture(s), before = await f.summary();
    const first = await s.getBackupPage({ chatKey: f.key, store: 'full_messages', ...backupVersionOptions(before, 'full_messages') });
    await s.putFullMessages({ chatKey: f.key, messages: [f.row(26, '新正文')] });
    await f.checkDelta(before, [0, 1, 0, 0]);
    await reject(() => s.getBackupPage({ chatKey: f.key, store: 'full_messages', after: first.after, ...backupVersionOptions(before, 'full_messages') }), 'backup-version-changed');
    same((await f.body())[26].raw.mes, '新正文');
  });

  add('持续真实正文变化仍只尝试三轮', async s => {
    const f = await fixture(s); let attempts = 0;
    const wrapped = f.wrapped(async options => {
      if (options.store === 'full_messages') await s.putFullMessages({ chatKey: f.key, messages: [f.row(26, `变化 ${++attempts}`)] });
    });
    await reject(() => readBackupRecords(wrapped, f.key, 'full_messages'), 'backup-version-changed'); same(attempts, 3);
    same((await f.body()).length, 95);
  });

  add('full + pending 稳定时 recent 更新不阻止完整预览数据读取', async s => {
    const f = await fixture(s); let recentChanges = 0;
    const wrapped = f.wrapped(async options => {
      if (options.store === 'full_messages') await s.replaceRecentSnapshot({ meta: f.identity.meta, messages: [f.row(94, `最近更新 ${++recentChanges}`)] });
    });
    const { records } = await readBackupBundle(wrapped, f.key, ['full_messages', 'pending_changes']);
    same(records.full_messages.length, 95); same(records.full_messages[26].raw.mes, '正文 26'); same(recentChanges, 2);
  });

  add('pending 读取不受无关 full 状态变化影响，但 full 组合保留状态保护', async s => {
    const f = await fixture(s); let changes = 0;
    const wrapped = f.wrapped(async () => { await s.updateChatMetaSummary(f.key, { fullBackupState: ++changes % 2 ? 'active' : 'frozen' }); });
    same((await readBackupBundle(wrapped, f.key, ['pending_changes'])).records.pending_changes.length, 1);
    let changed = false;
    const full = f.wrapped(async () => { if (!changed) { changed = true; await s.updateChatMetaSummary(f.key, { fullBackupState: 'frozen' }); } });
    await reject(() => readBackupBundle(full, f.key, ['full_messages'], { retries: 0 }), 'backup-version-changed');
    const summary = await f.summary();
    await s.updateChatMetaSummary(f.key, { fullBackupState: 'frozen', fullBackupIncident: { marker: 'changed' } });
    await reject(() => s.applyBackupPatch({ chatKey: f.key, store: 'full_messages', rows: [f.row(0)], ...backupVersionOptions(summary, 'full_messages', true) }), 'backup-version-changed');
  });

  add('空暂存提交与重试不推进正文版本，清空非空副本推进一次', async s => {
    const f = await fixture(s, { onlyRecent: true });
    const commitEmpty = async () => {
      const summary = await f.summary();
      const job = await s.beginBackupWrite({ chatKey: f.key, store: 'full_messages', count: 0, replace: true, ...backupVersionOptions(summary, 'full_messages', true) });
      same((await s.commitBackupWrite({ id: job.id })).state, 'committed');
      same((await s.commitBackupWrite({ id: job.id })).state, 'committed');
    };
    const empty = await f.summary(); await commitEmpty(); await f.checkDelta(empty, [0, 0, 0, 0]);
    await s.putFullMessages({ chatKey: f.key, messages: [f.row(0)] });
    const populated = await f.summary(); await commitEmpty(); await f.checkDelta(populated, [0, 1, 0, 0]);
  });

  add('分批暂存和撤销不改正文，正式提交增加一次', async s => {
    const f = await fixture(s), before = await f.summary();
    const job = await s.beginBackupWrite({ chatKey: f.key, store: 'full_messages', count: 2, replace: true, ...backupVersionOptions(before, 'full_messages', true) });
    await s.appendBackupWrite({ id: job.id, start: 0, rows: [f.row(0, '提交正文'), f.row(1)] });
    await f.checkDelta(before, [0, 0, 0, 0]);
    await s.commitBackupWrite({ id: job.id }); await f.checkDelta(before, [0, 1, 0, 0]);
    await s.commitBackupWrite({ id: job.id }); await f.checkDelta(before, [0, 1, 0, 0]);
    const current = await f.summary();
    const aborted = await s.beginBackupWrite({ chatKey: f.key, store: 'full_messages', count: 1, ...backupVersionOptions(current, 'full_messages', true) });
    await s.appendBackupWrite({ id: aborted.id, start: 0, rows: [f.row(0)] }); await s.abortBackupWrite({ id: aborted.id });
    await f.checkDelta(current, [0, 0, 0, 0]);
  });

  add('新版删除空集合不增加版本，跨聊天批量删除同类仅增加一次', async s => {
    const f = await fixture(s, { onlyRecent: true }), other = await fixture(s, { onlyRecent: true }), before = await f.summary();
    await s.deleteBackupV2({ chatKey: f.key, store: 'historical_changes', revision: before.revision });
    await f.checkDelta(before, [0, 0, 0, 0]);
    const current = await f.summary();
    const result = await s.deleteBackupBatchV2({ selection: { range: 'cross-selected', chatKeys: [f.key, other.key], types: ['recent'] }, revision: current.revision, mode: s.testMode, confirmed: true });
    same(result.deletedRecords, 190); await f.checkDelta(current, [1, 0, 0, 0]);
  });
  return cases;
}
