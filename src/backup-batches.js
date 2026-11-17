import { encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { createLargeBackupOperations } from '../vendor/frontend/src/storage/large-backup-operations.js';
import { BACKUP_STORES, BACKUP_BUDGET, boundedRecordSize, backupFailure } from '../vendor/frontend/src/storage/backup-batches.js';
import { storedChatSummary } from '../vendor/frontend/src/storage/backup-catalog-summary.js';

const encode = value => JSON.stringify(encodeStorageValue(value));
const decode = value => decodeStorageValue(JSON.parse(value));
export function createSqliteBackupBatches(repo) {
  const db = repo.db;
  const driver = {
    mode: 'sqlite',
    async transaction(mode, callback) {
      repo.checkCancelled(); db.exec(mode === 'readwrite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const table = repo.activeDataset() === 0 ? 'records' : 'records_next';
        const getMeta = key => { const row = db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; };
        const stats = chatKey => {
          const result = {};
          for (const row of db.prepare(`SELECT store,count(*) AS count,sum(length(CAST(payload AS BLOB))) AS bytes,min(CASE WHEN store NOT IN ('chat_meta','pending_changes') THEN CAST(json_extract(primary_key,'$[1]') AS INTEGER) END) AS firstIndex,max(CASE WHEN store NOT IN ('chat_meta','pending_changes') THEN CAST(json_extract(primary_key,'$[1]') AS INTEGER) END) AS lastIndex FROM ${table} WHERE chat_key=? AND store IN ('chat_meta','recent_messages','full_messages','historical_changes','pending_changes') GROUP BY store`).iterate(chatKey)) result[row.store] = row;
          return result;
        };
        const port = {
          checkLock() { if (getMeta('transfer-lock')) throw backupFailure('正在切换备份位置，请稍后重试。'); },
          area: () => repo.activeDataset(), revision: () => Number(getMeta('revision') ?? 0),
          bumpRevision: () => db.prepare("INSERT INTO plugin_meta VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run(),
          metaGet: getMeta,
          metaPut: (key, value) => db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)),
          metaDelete: key => db.prepare('DELETE FROM plugin_meta WHERE key=?').run(key),
          get: (store, key) => { const row = db.prepare(`SELECT payload FROM ${table} WHERE store=? AND primary_key=?`).get(store, JSON.stringify(key)); return row ? decode(row.payload) : undefined; },
          put: (store, value) => repo.store(store, { rows: 0, bytes: 0 }).put(value),
          counts: chatKey => { const rows = stats(chatKey); return Object.fromEntries(BACKUP_STORES.map(store => [store, rows[store]?.count ?? 0])); },
          deleteChat: (store, chatKey) => db.prepare(`DELETE FROM ${table} WHERE store=? AND chat_key=?`).run(store, chatKey),
          page(store, chatKey, after, hashesOnly) {
            const rows = []; let bytes = 1024, nodes = 100, cursor = null, more = false;
            for (const item of db.prepare(`SELECT primary_key,payload FROM ${table} WHERE store=? AND chat_key=? AND primary_key>? ORDER BY primary_key LIMIT ?`).iterate(store, chatKey, after ?? '', BACKUP_BUDGET.rows + 1)) {
              const record = decode(item.payload), value = hashesOnly ? { messageIndex: record.messageIndex, canonicalHash: record.canonicalHash, hashVersion: record.hashVersion } : record;
              const size = boundedRecordSize(value);
              if (!size.fits) throw backupFailure('单条备份超过安全上限。', 'backup-limit');
              if (rows.length && (rows.length >= BACKUP_BUDGET.rows || bytes + size.bytes > BACKUP_BUDGET.bytes || nodes + size.nodes > BACKUP_BUDGET.nodes)) { more = true; break; }
              rows.push(value); bytes += size.bytes; nodes += size.nodes; cursor = item.primary_key;
            }
            return { rows, after: more ? cursor : null };
          },
          stageGet: (id, n) => { const row = db.prepare("SELECT payload FROM transfer_rows WHERE id=? AND kind='backup-v1' AND n=?").get(id, n); return row && decode(row.payload); },
          stagePut(job, n, value) {
            const key = job.store === 'pending_changes' ? value.id : [job.chatKey, value.messageIndex];
            db.prepare("INSERT INTO transfer_rows VALUES(?,'backup-v1',?,?,?,?,?)").run(job.id, n, job.store, JSON.stringify(key), job.chatKey, encode(value));
          },
          stageCount: id => db.prepare("SELECT count(*) AS n FROM transfer_rows WHERE id=? AND kind='backup-v1'").get(id).n,
          stageDelete: id => db.prepare("DELETE FROM transfer_rows WHERE id=? AND kind='backup-v1'").run(id),
          async eachStage(id, callback) {
            for (const row of db.prepare("SELECT payload FROM transfer_rows WHERE id=? AND kind='backup-v1' ORDER BY n").iterate(id)) { repo.checkCancelled(); await callback(decode(row.payload)); }
          },
          catalog(after) {
            const items = [], keys = db.prepare(`SELECT DISTINCT chat_key FROM ${table} WHERE store IN ('chat_meta','recent_messages','full_messages','historical_changes','pending_changes') AND chat_key>? ORDER BY chat_key LIMIT 21`).all(after ?? '');
            for (const { chat_key: key } of keys.slice(0, 20)) {
              let meta, error;
              try { meta = port.get('chat_meta', key); } catch { error = '聊天信息异常，正文未读取。'; }
              const entry = storedChatSummary(key, meta, stats(key), port.revision());
              if (entry) items.push({ ...entry, ...(error ? { error } : {}) });
            }
            return { items, after: keys.length > 20 ? keys[19].chat_key : null };
          },
        };
        const result = await callback(port); repo.checkCancelled(); db.exec('COMMIT'); return result;
      } catch (error) { repo.rollback(error); }
    },
  };
  return createLargeBackupOperations(driver);
}
