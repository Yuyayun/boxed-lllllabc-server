import { BACKUP_STORES, checkBackupBatch, backupFailure } from './backup-batches.js';

export const LARGE_BACKUP_OPERATIONS = Object.freeze(['getBackupSummary', 'getBackupPage', 'getBackupCatalogPage', 'beginBackupWrite', 'appendBackupWrite', 'commitBackupWrite', 'abortBackupWrite', 'getBackupWriteStatus', 'deleteBackupV2', 'applyBackupPatch']);
const assert = (value, text) => { if (!value) throw backupFailure(text); };
const validStore = store => assert(BACKUP_STORES.includes(store), '备份类型无效。');
const jobKey = id => { assert(typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id), '备份任务标识无效。'); return 'backup-write:' + id; };
const relevantMeta = (store, meta = {}) => Object.fromEntries(Object.entries(meta).filter(([key]) => store === 'full_messages' ? key.startsWith('fullBackup') : store === 'recent_messages' ? ['lastSeenAt','lastBackupAt','messageCount','recentCount','recentFirstIndex','recentLastIndex','lastReason'].includes(key) : store === 'historical_changes' ? ['historicalCount','historicalUpdatedAt'].includes(key) : key.startsWith('pending')));
export function createLargeBackupOperations(driver) {
  const transaction = (mode, callback) => driver.transaction(mode, async tx => { await tx.checkLock(); return callback(tx); });
  const revisionMatches = async (tx, expected) => assert(expected === await tx.revision(), '正式备份在操作期间发生变化，已有数据已保留。');
  return {
    applyBackupPatch: options => transaction('readwrite', async tx => {
      const { chatKey, store, rows, meta, revision } = options; validStore(store); checkBackupBatch(rows); await revisionMatches(tx, revision);
      for (const row of rows) {
        assert(!row.chatKey || row.chatKey === chatKey, '备份记录归属不一致。');
        const value = { ...row, chatKey };
        if (store === 'historical_changes') value.firstCapturedAt = (await tx.get(store, [chatKey, row.messageIndex]))?.firstCapturedAt ?? row.firstCapturedAt;
        await tx.put(store, value);
      }
      const previous = await tx.get('chat_meta', chatKey) ?? { chatKey };
      const counts = await tx.counts(chatKey);
      await tx.put('chat_meta', { ...previous, ...relevantMeta(store, meta), ...(store === 'historical_changes' ? { historicalCount: counts.historical_changes, historicalUpdatedAt: new Date().toISOString() } : {}), chatKey });
      await tx.bumpRevision(); return { state: 'committed' };
    }),
    getBackupSummary: chatKey => transaction('readonly', async tx => ({ meta: await tx.get('chat_meta', chatKey), counts: await tx.counts(chatKey), revision: await tx.revision() })),
    getBackupPage: options => transaction('readonly', async tx => {
      const { chatKey, store, after = null, revision, hashesOnly = false } = options; validStore(store); await revisionMatches(tx, revision);
      const page = await tx.page(store, chatKey, after, hashesOnly);
      return { ...page, revision };
    }),
    getBackupCatalogPage: (options = {}) => transaction('readonly', tx => tx.catalog(options.after ?? null)),
    beginBackupWrite: options => transaction('readwrite', async tx => {
      const { chatKey, store, count, revision, replace = true, meta } = options; validStore(store);
      assert(typeof chatKey === 'string' && chatKey && Number.isSafeInteger(count) && count >= 0, '备份暂存参数无效。');
      await revisionMatches(tx, revision);
      const id = globalThis.crypto.randomUUID(), job = { id, chatKey, store, count, replace, revision, area: await tx.area(), written: 0, state: 'draft', meta: relevantMeta(store, meta), createdAt: new Date().toISOString() };
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
        if (start < job.written) assert(old && JSON.stringify(old) === JSON.stringify(value), '重复备份批次内容已经变化。');
        else await tx.stagePut(job, start + i, value);
      }
      job.written = Math.max(job.written, start + rows.length); await tx.metaPut(jobKey(id), job); return { written: job.written };
    }),
    commitBackupWrite: ({ id }) => transaction('readwrite', async tx => {
      const job = await tx.metaGet(jobKey(id)); assert(job, '备份暂存任务不存在。');
      if (job.state === 'committed') return job;
      assert(job.state === 'draft' && job.written === job.count && await tx.stageCount(id) === job.count, '备份暂存尚未完整，不能提交。');
      await revisionMatches(tx, job.revision); assert(await tx.area() === job.area, '备份位置发生变化，暂存未提交。');
      if (job.replace) await tx.deleteChat(job.store, job.chatKey);
      let count = 0;
      await tx.eachStage(id, async value => { if (job.store === 'full_messages' && job.replace) assert(value.messageIndex === count, '完整备份楼层不连续。'); await tx.put(job.store, value); count++; });
      assert(count === job.count, '备份暂存内容不完整。');
      const meta = await tx.get('chat_meta', job.chatKey) ?? { chatKey: job.chatKey };
      const counts = await tx.counts(job.chatKey);
      await tx.put('chat_meta', { ...meta, ...job.meta, ...(job.store === 'historical_changes' ? { historicalCount: counts.historical_changes, historicalUpdatedAt: new Date().toISOString() } : {}), chatKey: job.chatKey });
      await tx.bumpRevision(); job.state = 'committed'; job.committedAt = new Date().toISOString();
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
      const counts = await tx.counts(chatKey); await tx.deleteChat(store, chatKey); await tx.bumpRevision(); return { deletedCount: counts[store], chatKey };
    }),
  };
}
