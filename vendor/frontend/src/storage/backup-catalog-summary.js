import { buildBackupCatalog } from '../backup/catalog.js';

export function storedChatSummary(chatKey, meta, stats, revision) {
  const fields = { recent_messages: 'recentMessages', full_messages: 'fullMessages', historical_changes: 'historicalChanges', pending_changes: 'pendingChanges' };
  const data = { chatMeta: [{ ...meta, chatKey }] };
  for (const [store, field] of Object.entries(fields)) data[field] = stats[store]?.count ? [{ chatKey, messageIndex: stats[store].firstIndex, backedUpAt: meta?.lastBackupAt, updatedAt: meta?.historicalUpdatedAt }] : [];
  const entry = buildBackupCatalog(data).chats[0];
  if (!entry) return null;
  const types = { recent_messages: 'recent', full_messages: 'full', historical_changes: 'historical', pending_changes: 'pending' };
  entry.recordCount = 0; entry.storageBytes = stats.chat_meta?.bytes ?? 0;
  for (const [store, type] of Object.entries(types)) {
    const stat = stats[store] ?? { count: 0, bytes: 0, firstIndex: null, lastIndex: null };
    entry[type] = { count: stat.count, firstIndex: stat.firstIndex, lastIndex: stat.lastIndex, hasStructural: stat.structural ?? false, storageBytes: stat.bytes, fingerprint: `v2:${revision}` };
    entry.recordCount += stat.count; entry.storageBytes += stat.bytes;
  }
  entry.cleanupMetaFingerprint = `v2:${revision}`; entry.revision = revision;
  return entry;
}
