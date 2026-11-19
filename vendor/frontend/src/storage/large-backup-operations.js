import { BACKUP_STORES, checkBackupBatch, backupFailure } from './backup-batches.js';
import { createBatchCleanupPlan } from '../backup/batch-cleanup.js';
import { buildCleanupMetaPatch } from '../backup/cleanup.js';
import { summarizeBackupCatalog } from '../backup/catalog.js';
import { stableText } from './value-digest.js';
import { backupVersionKey, BACKUP_EPOCH_KEY, fullWriteGuard, sameBackupVersion } from './backup-versions.js';

export const LARGE_BACKUP_OPERATIONS = Object.freeze(['getBackupSummary', 'getBackupPage', 'getBackupCatalogPage', 'beginBackupWrite', 'appendBackupWrite', 'commitBackupWrite', 'abortBackupWrite', 'getBackupWriteStatus', 'deleteBackupV2', 'applyBackupPatch', 'deleteBackupBatchV2', 'cleanupBackupWrites']);
const assert = (value, text) => { if (!value) throw backupFailure(text); };
const validStore = store => assert(BACKUP_STORES.includes(store), '备份类型无效。');
const jobKey = id => { assert(typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id), '备份任务标识无效。'); return 'backup-write:' + id; };
const relevantMeta = (store, meta = {}) => Object.fromEntries(Object.entries(meta).filter(([key]) => store === 'full_messages' ? key.startsWith('fullBackup') : store === 'recent_messages' ? ['lastSeenAt','lastBackupAt','messageCount','recentCount','recentFirstIndex','recentLastIndex','lastReason'].includes(key) : store === 'historical_changes' ? ['historicalCount','historicalUpdatedAt'].includes(key) : key.startsWith('pending')));
export function createLargeBackupOperations(driver) {
  const transaction = (mode, callback) => driver.transaction(mode, async tx => { await tx.checkLock(); return callback(tx); });
  const scope = async (tx, store) => ({ area: await tx.area(), epoch: await tx.metaGet(BACKUP_EPOCH_KEY) ?? 0, revision: await tx.metaGet(backupVersionKey(store)) ?? 0 });
  const versionFailure = () => { throw backupFailure('正式备份在操作期间发生变化，已有数据已保留。', 'backup-version-changed'); };
  const revisionMatches = async (tx, expected) => { if (expected !== await tx.revision()) versionFailure(); };
  const matches = async (tx, options, writing = false) => {
    if (options.scope) {
      if (!sameBackupVersion(options.scope, await scope(tx, options.store))) versionFailure();
      if (writing && options.store === 'full_messages' && options.fullGuard !== fullWriteGuard(await tx.get('chat_meta', options.chatKey))) versionFailure();
    } else await revisionMatches(tx, options.revision);
  };
  const bumpStore = async (tx, store) => tx.metaPut(backupVersionKey(store), (await tx.metaGet(backupVersionKey(store)) ?? 0) + 1);
  return {
    cleanupBackupWrites: () => transaction('readwrite', async tx => {
      for (const job of await tx.jobs()) {
        const age = Date.now() - Date.parse(job.updatedAt ?? job.createdAt);
        const changed = job.scope ? !sameBackupVersion(job.scope, await scope(tx, job.store)) : job.revision !== await tx.revision();
        if (job.state === 'draft' && (changed || job.area !== await tx.area() || age > 15 * 60 * 1000) || job.state === 'committed' && age > 24 * 60 * 60 * 1000) {
          await tx.stageDelete(job.id, 100);
          if (!await tx.stageCount(job.id)) await tx.metaDelete(jobKey(job.id));
        }
      }
      return true;
    }),
    applyBackupPatch: options => transaction('readwrite', async tx => {
      const { chatKey, store, rows, meta } = options; validStore(store); checkBackupBatch(rows); await matches(tx, options, true);
      for (const row of rows) {
        assert(!row.chatKey || row.chatKey === chatKey, '备份记录归属不一致。');
        const value = { ...row, chatKey };
        if (store === 'historical_changes') value.firstCapturedAt = (await tx.get(store, [chatKey, row.messageIndex]))?.firstCapturedAt ?? row.firstCapturedAt;
        await tx.put(store, value);
      }
      const previous = await tx.get('chat_meta', chatKey) ?? { chatKey };
      const counts = await tx.counts(chatKey);
      await tx.put('chat_meta', { ...previous, ...(store === 'full_messages' ? { fullBackupChatHash: null } : {}), ...relevantMeta(store, meta), ...(store === 'historical_changes' ? { historicalCount: counts.historical_changes, historicalUpdatedAt: new Date().toISOString() } : {}), chatKey });
      await bumpStore(tx, store); await tx.bumpRevision(); return { state: 'committed', committedRevision: await tx.revision() };
    }),
    getBackupSummary: chatKey => transaction('readonly', async tx => ({ meta: await tx.get('chat_meta', chatKey), counts: await tx.counts(chatKey), revision: await tx.revision(), scopes: Object.fromEntries(await Promise.all(BACKUP_STORES.map(async store => [store, await scope(tx, store)]))) })),
    getBackupPage: options => transaction('readonly', async tx => {
      const { chatKey, store, after = null, revision, hashesOnly = false } = options; validStore(store); await matches(tx, options);
      const page = await tx.page(store, chatKey, after, hashesOnly);
      return { ...page, revision };
    }),
    getBackupCatalogPage: (options = {}) => transaction('readonly', async tx => ({ ...await tx.catalog(options.after ?? null), revision: await tx.revision() })),
    beginBackupWrite: options => transaction('readwrite', async tx => {
      const { chatKey, store, count, revision, replace = true, meta } = options; validStore(store);
      assert(typeof chatKey === 'string' && chatKey && Number.isSafeInteger(count) && count >= 0, '备份暂存参数无效。');
      await matches(tx, options, true);
      const id = globalThis.crypto.randomUUID(), job = { id, chatKey, store, count, replace, revision, scope: options.scope, fullGuard: options.fullGuard, area: await tx.area(), written: 0, state: 'draft', meta: relevantMeta(store, meta), createdAt: new Date().toISOString() };
      await tx.metaPut(jobKey(id), job); return job;
    }),
    appendBackupWrite: options => transaction('readwrite', async tx => {
      const { id, start, rows } = options; checkBackupBatch(rows);
      const job = await tx.metaGet(jobKey(id)); assert(job?.state === 'draft', '备份暂存任务不存在或已经结束。');
      assert(Number.isSafeInteger(start) && start >= 0 && start <= job.written && start + rows.length <= job.count, '备份批次不连续。');
      for (let i = 0; i < rows.length; i++) {
        const value = { ...rows[i], chatKey: job.chatKey };
        assert(!rows[i].chatKey || rows[i].chatKey === job.chatKey, '备份记录归属不一致。');
        assert(job.store === 'pending_changes' ? typeof value.id === 'string' && value.id : Number.isSafeInteger(value.messageIndex) && value.messageIndex >= 0, '备份楼层无效。');
        if (job.store === 'full_messages' && job.replace) assert(value.messageIndex === start + i, '完整备份楼层不连续。');
        const old = await tx.stageGet(id, start + i);
        if (start < job.written) assert(old && stableText(old) === stableText(value), '重复备份批次内容已经变化。');
        else await tx.stagePut(job, start + i, value);
      }
      job.written = Math.max(job.written, start + rows.length); job.updatedAt = new Date().toISOString(); await tx.metaPut(jobKey(id), job); return { written: job.written };
    }),
    commitBackupWrite: ({ id }) => transaction('readwrite', async tx => {
      const job = await tx.metaGet(jobKey(id)); assert(job, '备份暂存任务不存在。');
      if (job.state === 'committed') return job;
      assert(job.state === 'draft' && job.written === job.count && await tx.stageCount(id) === job.count, '备份暂存尚未完整，不能提交。');
      await matches(tx, job, true); assert(await tx.area() === job.area, '备份位置发生变化，暂存未提交。');
      if (job.replace) await tx.deleteChat(job.store, job.chatKey);
      let count = 0;
      await tx.eachStage(id, async value => { if (job.store === 'full_messages' && job.replace) assert(value.messageIndex === count, '完整备份楼层不连续。');
        if (job.store === 'historical_changes') value.firstCapturedAt = (await tx.get(job.store, [job.chatKey, value.messageIndex]))?.firstCapturedAt ?? value.firstCapturedAt;
        await tx.put(job.store, value); count++; });
      assert(count === job.count, '备份暂存内容不完整。');
      const meta = await tx.get('chat_meta', job.chatKey) ?? { chatKey: job.chatKey };
      const counts = await tx.counts(job.chatKey);
      await tx.put('chat_meta', { ...meta, ...(job.store === 'full_messages' ? { fullBackupChatHash: null } : {}), ...job.meta, ...(job.store === 'historical_changes' ? { historicalCount: counts.historical_changes, historicalUpdatedAt: new Date().toISOString() } : {}), chatKey: job.chatKey });
      await bumpStore(tx, job.store); await tx.bumpRevision(); job.state = 'committed'; job.committedAt = new Date().toISOString(); job.committedRevision = await tx.revision();
      await tx.metaPut(jobKey(id), job); await tx.stageDelete(id); return job;
    }),
    getBackupWriteStatus: id => transaction('readonly', tx => tx.metaGet(jobKey(id))),
    abortBackupWrite: ({ id }) => transaction('readwrite', async tx => {
      const key = jobKey(id), job = await tx.metaGet(key);
      if (job?.state === 'committed') return job;
      await tx.stageDelete(id); await tx.metaDelete(key); return { state: 'aborted' };
    }),
    deleteBackupV2: ({ chatKey, store, revision }) => transaction('readwrite', async tx => {
      validStore(store); assert(store !== 'pending_changes', '未保存变更不能普通清理。'); await revisionMatches(tx, revision);
      const meta = await tx.get('chat_meta', chatKey);
      assert(store !== 'full_messages' || !['frozen','awaiting-confirmation'].includes(meta?.fullBackupState), '完整备份受到保护，不能清理。');
      const counts = await tx.counts(chatKey); await tx.deleteChat(store, chatKey);
      const type = { full_messages: 'full', recent_messages: 'recent', historical_changes: 'historical' }[store];
      if (meta) await tx.put('chat_meta', { ...meta, ...buildCleanupMetaPatch(type) });
      await bumpStore(tx, store); await tx.bumpRevision(); return { deletedCount: counts[store], chatKey };
    }),
    deleteBackupBatchV2: ({ selection, revision, mode, confirmed }) => transaction('readwrite', async tx => {
      assert(confirmed === true && mode === driver.mode, '批量清理必须确认当前备份位置。'); await revisionMatches(tx, revision);
      const chats = []; let after = null;
      do { const page = await tx.catalog(after); chats.push(...page.items); after = page.after; } while (after !== null);
      const catalog = summarizeBackupCatalog(chats, chats.filter(chat => chat.error).length);
      const plan = createBatchCleanupPlan({ catalog, selection, mode }); assert(plan.canConfirm, plan.blockedReason);
      const stores = { full: 'full_messages', recent: 'recent_messages', historical: 'historical_changes' };
      for (const action of plan.actions) {
        await tx.deleteChat(stores[action.type], action.chatKey);
        await bumpStore(tx, stores[action.type]);
        const meta = await tx.get('chat_meta', action.chatKey);
        if (meta) await tx.put('chat_meta', { ...meta, ...buildCleanupMetaPatch(action.type) });
      }
      await tx.bumpRevision();
      return { ok: true, committed: true, succeeded: plan.actions.length, skipped: plan.skipped.length, failed: 0, deletedRecords: plan.recordCount,
        items: [...plan.actions.slice(0, 50).map(item => ({ ...item, status: 'deleted' })), ...plan.skipped.slice(0, 50).map(item => ({ ...item, status: 'skipped', reason: item.blockedReason }))] };
    }),
  };
}
