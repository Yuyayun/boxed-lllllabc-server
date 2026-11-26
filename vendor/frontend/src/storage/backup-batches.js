import { encodeStorageValue } from './protocol.js';
import { fullWriteGuard, sameBackupVersion, isBackupVersionConflict } from './backup-versions.js';

export const BACKUP_STORES = Object.freeze(['recent_messages', 'full_messages', 'historical_changes', 'pending_changes']);
export const BACKUP_BUDGET = Object.freeze({ rows: 50, bytes: 1024 * 1024, nodes: 50000 });
export const backupFailure = (message, code = 'backup-conflict') => Object.assign(new Error(message), { code });
export function measureBackupValue(value) {
  const encoded = encodeStorageValue(value);
  const count = item => item[0] === 'array' ? 1 + item[1].reduce((sum, child) => sum + (child[0] === 'hole' ? 0 : count(child)), 0)
    : ['object','null-object'].includes(item[0]) ? 1 + item[1].reduce((sum, entry) => sum + count(entry[1]), 0) : 1;
  return { bytes: new TextEncoder().encode(JSON.stringify(encoded)).byteLength, nodes: count(encoded) };
}
export function* iterateBackupBatches(rows, mapRow = value => value) {
  let batch = [], bytes = 1024, nodes = 100, index = 0;
  for (const input of rows) {
    const row = mapRow(input, index++);
    const size = measureBackupValue(row);
    // A single record still has to fit the existing wire/storage guards.
    if (size.bytes > 8 * 1024 * 1024 - 4096 || size.nodes > 198000) throw backupFailure('单条备份超过 8 MiB 或结构安全上限，已有备份已保留。', 'backup-limit');
    if (batch.length && (batch.length >= BACKUP_BUDGET.rows || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) {
      yield batch; batch = []; bytes = 1024; nodes = 100;
    }
    batch.push(row); bytes += size.bytes; nodes += size.nodes;
  }
  if (batch.length) yield batch;
}
export const backupBatches = rows => [...iterateBackupBatches(rows)];
export function checkBackupBatch(rows) {
  if (!Array.isArray(rows) || !rows.length || backupBatches(rows).length !== 1) throw backupFailure('备份批次超过预算。', 'backup-limit');
}
export function boundedRecordSize(row) { const size = measureBackupValue(row); return { ...size, fits: size.bytes <= 8 * 1024 * 1024 - 4096 && size.nodes <= 198000 }; }

export function backupVersionOptions(summary, store, writing = false) {
  return { revision: summary.revision, ...(summary.scopes?.[store] ? { scope: summary.scopes[store], ...(writing && store === 'full_messages' ? { fullGuard: fullWriteGuard(summary.meta) } : {}) } : {}) };
}
function unchangedBackup(summary, latest, stores) {
  return stores.every(store => summary.counts[store] === latest.counts[store]
    && (summary.scopes?.[store] && latest.scopes?.[store] ? sameBackupVersion(summary.scopes[store], latest.scopes[store]) : summary.revision === latest.revision));
}
export async function readBackupRecords(session, chatKey, store, { hashesOnly = false, summary, retries = 2 } = {}) {
  if (!session.capabilities?.boundedBackup) {
    const old = { full_messages: 'getFullMessages', recent_messages: 'getRecentMessages', historical_changes: 'getHistoricalChanges', pending_changes: 'getPendingChanges' }[store];
    return session[old](chatKey);
  }
  let state = summary ?? await session.getBackupSummary(chatKey);
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = []; let after = null;
      do {
        const page = await session.getBackupPage({ chatKey, store, after, ...backupVersionOptions(state, store), hashesOnly });
        rows.push(...page.rows); after = page.after;
      } while (after !== null);
      const latest = await session.getBackupSummary(chatKey);
      if (!unchangedBackup(state, latest, [store]) || rows.length !== state.counts[store]) throw backupFailure('备份正在变化，请稍后重新读取。', 'backup-version-changed');
      return rows.sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
    } catch (error) {
      if (attempt >= retries || ![ 'backup-version-changed', 'backup-conflict' ].includes(error?.code)) throw error;
      const fresh = await session.getBackupSummary(chatKey);
      // Old servers use backup-conflict for damaged records too. Retry only
      // when a new summary demonstrates that a version actually changed.
      if (!isBackupVersionConflict(error) && unchangedBackup(state, fresh, [store])) throw error;
      state = fresh;
    }
  }
}

export async function readBackupBundle(session, chatKey, stores, { summary, retries = 2 } = {}) {
  let state = summary ?? await session.getBackupSummary(chatKey);
  for (let attempt = 0; ; attempt++) {
    try {
      const records = {};
      for (const store of stores) records[store] = await readBackupRecords(session, chatKey, store, { summary: state, retries: 0 });
      const latest = await session.getBackupSummary(chatKey);
      if (!unchangedBackup(state, latest, stores) || (stores.includes('full_messages') && fullWriteGuard(state.meta) !== fullWriteGuard(latest.meta))) throw backupFailure('备份正在变化，请稍后重试。', 'backup-version-changed');
      return { records, summary: latest };
    } catch (error) {
      if (attempt >= retries || !['backup-version-changed', 'backup-conflict'].includes(error?.code)) throw error;
      const fresh = await session.getBackupSummary(chatKey);
      if (!isBackupVersionConflict(error) && unchangedBackup(state, fresh, stores)) throw error;
      state = fresh;
    }
  }
}

export async function writeBackupRecords(session, { chatKey, store, rows, meta = {}, replace = false, summary, sourceUnchanged = () => true, validateSource = sourceUnchanged, mapRow }) {
  if(store==='pending_changes'&&rows.some(row=>row.pendingFormat)&&session.capabilities&&!session.capabilities.pendingJournal)throw backupFailure('服务器备份插件需要更新到支持新版未保存记录的版本，原记录已保留。','backup-upgrade-required');
  if (session.capabilities?.boundedBackup && session.cleanupBackupWrites) await session.cleanupBackupWrites();
  const iterator = iterateBackupBatches(rows, mapRow), first = iterator.next(), second = iterator.next();
  function* batches() { if (!first.done) yield first.value; if (!second.done) yield second.value; yield* iterator; }
  if (!session.capabilities?.boundedBackup) {
    if (!second.done) throw backupFailure('服务器备份插件需要更新，才能分批处理此聊天。', 'backup-upgrade-required');
    if (!sourceUnchanged() || !validateSource()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    const values = first.value ?? [];
    if (store === 'full_messages') return session[replace ? 'replaceFullSnapshot' : 'putFullMessages']({ chatKey, messages: values, meta: { ...meta, chatKey } });
    if (store === 'recent_messages') return session.replaceRecentSnapshot({ meta: { ...meta, chatKey }, messages: values });
    if (store === 'pending_changes' && replace) return session.replacePendingChanges({ chatKey, records: values });
    return session[store === 'pending_changes' ? 'putPendingChanges' : 'putHistoricalChanges'](values);
  }
  const state = summary ?? await session.getBackupSummary(chatKey);
  const proofHash=store==='full_messages'?meta.fullBackupNativeHash:store==='recent_messages'?meta.recentNativeHash:null;
  const nativeProof=proofHash?{format:1,hash:proofHash}:undefined;
  if (!replace && second.done && !first.done) {
    if (!sourceUnchanged() || !validateSource()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    try { return await session.applyBackupPatch({ chatKey, store, rows: first.value, meta, nativeProof,...backupVersionOptions(state, store, true) }); }
    catch (error) { if (error.backupTransactionOutcome !== 'aborted' && (error instanceof TypeError || ['UnknownError','AbortError','TimeoutError'].includes(error.name) || ['unknown','committed'].includes(error.backupTransactionOutcome))) throw Object.assign(backupFailure('本次备份更新结果待核对，请先重新检查，不要重复提交。', 'outcome-unknown'), { cause: error, backupTransactionOutcome: error.backupTransactionOutcome }); throw error; }
  }
  const job = await session.beginBackupWrite({ chatKey, store, count: rows.length, ...backupVersionOptions(state, store, true), replace, meta,nativeProof });
  let committing = false;
  try {
    let start = 0;
    for (const batch of batches()) {
      if (!sourceUnchanged()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
      await session.appendBackupWrite({ id: job.id, start, rows: batch }); start += batch.length;
    }
    if (!sourceUnchanged() || !validateSource()) throw backupFailure('来源聊天已经变化，已有备份已保留。', 'backup-source-changed');
    committing = true;
    try { return await session.commitBackupWrite({ id: job.id }); }
    catch (error) {
      const receipt = await session.getBackupWriteStatus(job.id).catch(() => null);
      if (receipt?.state === 'committed') return receipt;
      if (!receipt || (error.backupTransactionOutcome !== 'aborted' && (['outcome-unknown', 'cancelled'].includes(error.code) || ['UnknownError','AbortError', 'TimeoutError'].includes(error.name) || ['unknown','committed'].includes(error.backupTransactionOutcome)))) throw Object.assign(backupFailure('本次备份更新结果待核对，请先重新检查，不要重复提交。', 'outcome-unknown'), { cause: error, backupTransactionOutcome: error.backupTransactionOutcome });
      committing = false; throw error;
    }
  } catch (error) {
    if (!committing) await session.abortBackupWrite({ id: job.id }).catch(() => {});
    throw error;
  }
}
