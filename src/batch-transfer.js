import { createBatchTransfer } from '../vendor/frontend/src/storage/batch-transfer.js';
import { ACTIVE_DATASET_KEY, datasetId } from '../vendor/frontend/src/storage/dataset-layout.js';
import { DATA_STORES, recordText } from '../vendor/frontend/src/storage/transfer-format.js';
import { validateCursor } from '../vendor/frontend/src/storage/transfer-batch-format.js';
import { encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import {createLegacyRecovery} from '../vendor/frontend/src/storage/legacy-recovery.js';

const table = dataset => datasetId(dataset) === 0 ? 'records' : 'records_next';
const encode = value => JSON.stringify(encodeStorageValue(value));
const decode = value => decodeStorageValue(JSON.parse(value));

export function createSqliteBatchTransfer(repository) {
  const db = repository.db, statements = new Map();
  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  let tail = Promise.resolve();
  const driver = {
    transaction(mode, callback) {
      const run = tail.then(async () => {
        repository.checkCancelled();
        db.exec(mode === 'readwrite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
          const get = key => {
            const row = statement('SELECT value FROM plugin_meta WHERE key=?').get(key);
            return row ? JSON.parse(row.value) : undefined;
          };
          const put = (key, value) => statement('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
          const port = {
            validateLayout() {
              const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
              if (tables.some(({name}) => !['records', 'records_next', 'plugin_meta', 'transfer_rows'].includes(name))) throw new Error('发现未知数据库表，未修改原数据。');
            },
            metaGet: get, metaPut: put,
            metaDelete: key => statement('DELETE FROM plugin_meta WHERE key=?').run(key),
            metaKeys: (prefix, after = '', limit = 100) => statement('SELECT key FROM plugin_meta WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?').all(prefix, prefix+'\uffff', after, limit).map(row=>row.key),
            active: () => get(ACTIVE_DATASET_KEY), revision: () => get('revision') ?? 0,
            activePut: value => put(ACTIVE_DATASET_KEY, value), revisionPut: value => put('revision', value),
            lockGet: () => get('transfer-lock'), lockPut: id => put('transfer-lock', id),
            lockDelete: () => statement("DELETE FROM plugin_meta WHERE key='transfer-lock'").run(),
            taskGet: id => get('transfer:' + id), taskPut: state => put('transfer:' + state.id, state),
            legacyRow(id,kind,n){const row=statement('SELECT * FROM transfer_rows WHERE id=? AND kind=? AND n=?').get(id,kind,n);return row?{n:row.n,store:row.store,key:JSON.parse(row.primary_key),value:decode(row.payload)}:null;},
            legacyKeys:(id,limit)=>statement('SELECT kind,n FROM transfer_rows WHERE id=? ORDER BY kind,n LIMIT ?').all(id,limit),
            legacyDelete:(id,key)=>statement('DELETE FROM transfer_rows WHERE id=? AND kind=? AND n=?').run(id,key.kind,key.n),
            legacyPage(id,kind,after,budget){const rows=[];let bytes=0;for(const item of statement('SELECT * FROM transfer_rows WHERE id=? AND kind=? AND n>? ORDER BY n LIMIT ?').iterate(id,kind,after,budget.limit)){const row={n:item.n,store:item.store,key:JSON.parse(item.primary_key),value:decode(item.payload)},size=Buffer.byteLength(recordText(row));if(rows.length&&bytes+size>budget.bytes)break;rows.push(row);bytes+=size;}return rows;},
            get(dataset, name, key) {
              const row = statement(`SELECT payload FROM ${table(dataset)} WHERE store=? AND primary_key=?`).get(name, JSON.stringify(key));
              return row ? decode(row.payload) : undefined;
            },
            has: (dataset, name, key) => !!statement(`SELECT 1 FROM ${table(dataset)} WHERE store=? AND primary_key=?`).get(name, JSON.stringify(key)),
            add: (dataset, name, key, value) => statement(`INSERT INTO ${table(dataset)}(store,primary_key,chat_key,payload) VALUES(?,?,?,?)`).run(name, JSON.stringify(key), name === 'snapshot_messages' ? value.snapshotId : value.chatKey, encode(value)),
            remove: (dataset, name, key) => statement(`DELETE FROM ${table(dataset)} WHERE store=? AND primary_key=?`).run(name, JSON.stringify(key)),
            page(dataset, input, budget) {
              validateCursor(input);
              const rows = []; let bytes = 0, cursor = structuredClone(input);
              for (let i = input.store; i < DATA_STORES.length; i++) {
                const name = DATA_STORES[i], after = i === input.store ? input.after : null;
                const sql = `SELECT primary_key,payload FROM ${table(dataset)} WHERE store=? AND primary_key>? ORDER BY primary_key LIMIT ?`;
                // Keep the owning statement reachable throughout Node 22 iteration.
                const read = statement(sql);
                for (const item of read.iterate(name, after ?? '', budget.limit + 1)) {
                  repository.checkCancelled();
                  const row = { store: name, key: JSON.parse(item.primary_key), value: decode(item.payload) };
                  const size = Buffer.byteLength(recordText(row));
                  if (rows.length && (rows.length >= budget.limit || bytes + size > budget.bytes)) return { rows, cursor, done: false };
                  rows.push(row); bytes += size; cursor = { store: i, after: item.primary_key };
                }
                cursor = { store: i + 1, after: null };
              }
              return { rows, cursor, done: true };
            },
          };
          const result = await callback(port);
          repository.checkCancelled(); db.exec('COMMIT');
          repository.reportProgress?.({count:result?.cleanupPhase?result.cleaned:result?.checkSummary?.count??result?.summary?.count,verified:result?.kind==='clear'?undefined:result?.verified,batch:result?.verifiedBatch});return result;
        } catch (error) { repository.rollback(error); }
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  return Object.freeze({...createBatchTransfer({driver}),legacyRecovery:createLegacyRecovery({driver,onProgress:r=>repository.reportProgress?.({count:r?.stage==='clear'?r.cleared:r?.stage==='cleanup'?r.removed:r?.stage==='count-active'?r.countSummary.count:r?.summary?.count,verified:['verify','verify-active','count-active'].includes(r?.stage)?r.summary.count:undefined},'legacy-'+r?.stage)})});
}
