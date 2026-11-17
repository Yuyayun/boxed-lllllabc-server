import { encodeStorageValue } from './protocol.js';

export const BACKUP_STORES = Object.freeze(['recent_messages', 'full_messages', 'historical_changes', 'pending_changes']);
export const BACKUP_BUDGET = Object.freeze({ rows: 50, bytes: 1024 * 1024, nodes: 50000 });
export const backupFailure = (message, code = 'backup-conflict') => Object.assign(new Error(message), { code });
export function measureBackupValue(value) {
  const encoded = encodeStorageValue(value);
  const count = item => !Array.isArray(item) ? 0 : 1 + item.reduce((sum, child) => sum + count(child), 0);
  return { bytes: new TextEncoder().encode(JSON.stringify(encoded)).byteLength, nodes: count(encoded) };
}
export function backupBatches(rows) {
  const result = []; let batch = [], bytes = 1024, nodes = 100;
  for (const row of rows) {
    const size = measureBackupValue(row);
    // A single record still has to fit the existing wire/storage guards.
    if (size.bytes > 8 * 1024 * 1024 - 4096 || size.nodes > 180000) throw backupFailure('单条备份超过安全上限，已有备份已保留。', 'backup-limit');
    if (batch.length && (batch.length >= BACKUP_BUDGET.rows || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) {
      result.push(batch); batch = []; bytes = 1024; nodes = 100;
    }
    batch.push(row); bytes += size.bytes; nodes += size.nodes;
  }
  if (batch.length) result.push(batch);
  return result;
}
export function checkBackupBatch(rows) {
  if (!Array.isArray(rows) || !rows.length || backupBatches(rows).length !== 1) throw backupFailure('备份批次超过预算。', 'backup-limit');
}
export function boundedRecordSize(row) { const size = measureBackupValue(row); return { ...size, fits: size.bytes <= 8 * 1024 * 1024 - 4096 && size.nodes <= 180000 }; }

export async function readBackupRecords(session, chatKey, store, { hashesOnly = false, summary } = {}) {
  if (!session.capabilities?.boundedBackup) {
    const old = { full_messages: 'getFullMessages', recent_messages: 'getRecentMessages', historical_changes: 'getHistoricalChanges', pending_changes: 'getPendingChanges' }[store];
    return session[old](chatKey);
  }
  const state = summary ?? await session.getBackupSummary(chatKey);
  const rows = []; let after = null;
  do {
    const page = await session.getBackupPage({ chatKey, store, after, revision: state.revision, hashesOnly });
    rows.push(...page.rows); after = page.after;
  } while (after !== null);
  const latest = await session.getBackupSummary(chatKey);
  if (latest.revision !== state.revision || rows.length !== state.counts[store]) throw backupFailure('备份在读取期间发生变化，请重新读取。');
  return rows.sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
}

export async function writeBackupRecords(session, { chatKey, store, rows, meta = {}, replace = false, summary, sourceUnchanged = () => true }) {
  const batches = backupBatches(rows);
  if (!session.capabilities?.boundedBackup) {
    if (batches.length > 1) throw backupFailure('服务器备份插件需要更新，才能分批处理此聊天。', 'backup-upgrade-required');
    if (!sourceUnchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    if (store === 'full_messages') return session[replace ? 'replaceFullSnapshot' : 'putFullMessages']({ chatKey, messages: rows, meta });
    if (store === 'recent_messages') return session.replaceRecentSnapshot({ meta: { ...meta, chatKey }, messages: rows });
    if (store === 'pending_changes' && replace) return session.replacePendingChanges({ chatKey, records: rows });
    return session[store === 'pending_changes' ? 'putPendingChanges' : 'putHistoricalChanges'](rows);
  }
  const state = summary ?? await session.getBackupSummary(chatKey);
  if (!replace && batches.length <= 1 && rows.length) {
    if (!sourceUnchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    return session.applyBackupPatch({ chatKey, store, rows, meta, revision: state.revision });
  }
  const job = await session.beginBackupWrite({ chatKey, store, count: rows.length, revision: state.revision, replace, meta });
  let committing = false;
  try {
    let start = 0;
    for (const batch of batches) {
      if (!sourceUnchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
      await session.appendBackupWrite({ id: job.id, start, rows: batch }); start += batch.length;
    }
    if (!sourceUnchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    committing = true;
    try { return await session.commitBackupWrite({ id: job.id }); }
    catch (error) {
      const receipt = await session.getBackupWriteStatus(job.id).catch(() => null);
      if (receipt?.state === 'committed') return receipt;
      if (!receipt || ['outcome-unknown', 'cancelled'].includes(error.code) || ['AbortError', 'TimeoutError'].includes(error.name)) throw backupFailure('本次备份提交结果待核对，已有正式备份不会成为半份。', 'outcome-unknown');
      committing = false; throw error;
    }
  } catch (error) {
    if (!committing) await session.abortBackupWrite({ id: job.id }).catch(() => {});
    throw error;
  }
}
