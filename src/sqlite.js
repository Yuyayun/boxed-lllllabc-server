import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createBackupOperations } from '../vendor/frontend/src/storage/operations.js';
import { STORAGE_OPERATIONS, encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { failure } from './errors.js';
import { installTransfer } from './transfer.js';
import { datasetId, ACTIVE_DATASET_KEY, commitDataset, rollbackDataset } from '../vendor/frontend/src/storage/dataset-layout.js';
import { transferId } from '../vendor/frontend/src/storage/transfer-format.js';
import { createSnapshotOperations } from '../vendor/frontend/src/storage/snapshot-operations.js';
import { DATA_STORES } from '../vendor/frontend/src/storage/transfer-format.js';

const STORES = DATA_STORES;
const APP_ID = 0x424f5844;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 25000;

export class SqliteRepository {
  constructor(file, { readOnly = false, busyMs = 1000 } = {}) {
    this.file = file;
    this.db = new DatabaseSync(file, { readOnly, allowExtension: false });
    try {
      this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(5000, busyMs))}`);
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw failure('database-unavailable', 'SQLite 完整性检查失败，旧库已保留。');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const appId = this.db.prepare('PRAGMA application_id').get().application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (version < 0 || version > 4 || (appId && appId !== APP_ID) || (tables.length && appId !== APP_ID) || (version && appId !== APP_ID)) throw failure('database-unavailable', 'SQLite 不属于兼容的箱装数据库，未覆盖原文件。');
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
        if (version < 3) {
          // VACUUM INTO takes a consistent SQLite backup, including live WAL.
          if (tables.length) this.db.prepare('VACUUM INTO ?').run(`${file}.before-v3-${Date.now()}.bak`);
          this.db.exec('BEGIN IMMEDIATE');
          try {
            if (tables.some(row => row.name === 'records')) {
              this.db.exec(`CREATE TABLE records_v3 (store TEXT NOT NULL CHECK(store IN (${STORES.map(name=>`'${name}'`).join(',')})), primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(store,primary_key)) STRICT;
                INSERT INTO records_v3 SELECT * FROM records; DROP TABLE records; ALTER TABLE records_v3 RENAME TO records;`);
            }
            this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
              CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL CHECK(store IN (${STORES.map(name=>`'${name}'`).join(',')})), primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(store,primary_key)) STRICT;
              CREATE INDEX IF NOT EXISTS by_chat ON records(store,chat_key,primary_key);
              CREATE INDEX IF NOT EXISTS snapshot_page ON records(store,chat_key,CAST(json_extract(primary_key,'$[1]') AS INTEGER)) WHERE store='snapshot_messages';
              CREATE TABLE IF NOT EXISTS transfer_rows (id TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, store TEXT NOT NULL, primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,kind,n), UNIQUE(id,kind,store,primary_key)) STRICT;
              PRAGMA application_id=${APP_ID}; PRAGMA user_version=3;`);
            this.db.exec('COMMIT');
          } catch (error) { this.rollback(error); }
        }
        if (version < 4) {
          this.db.exec('BEGIN IMMEDIATE');
          try { this.db.exec(`CREATE TABLE IF NOT EXISTS records_next (store TEXT NOT NULL CHECK(store IN (${STORES.map(name=>`'${name}'`).join(',')})), primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(store,primary_key)) STRICT;
          CREATE INDEX IF NOT EXISTS next_by_chat ON records_next(store,chat_key,primary_key);
          CREATE INDEX IF NOT EXISTS next_snapshot_page ON records_next(store,chat_key,CAST(json_extract(primary_key,'$[1]') AS INTEGER)) WHERE store='snapshot_messages';
          PRAGMA user_version=4;`); this.db.exec('COMMIT'); }
          catch (error) { this.rollback(error); }
        }
      } else if (version !== 4) throw failure('database-unavailable', '只读数据库需要先升级，未执行升级。');
      this.operations = createBackupOperations({ runTransaction: this.transaction.bind(this), requestToPromise: (value) => value, storageMode: 'sqlite', catalogDriver: {
        keys: store => store.chatKeys(), count: store => store.count(), check: () => this.checkCancelled(),
      } });
      this.snapshotOperations = createSnapshotOperations({ runTransaction: this.transaction.bind(this), requestToPromise: (value) => value });
      installTransfer(this);
    } catch (error) { this.db.close(); throw error; }
  }
  owner(handle) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare("SELECT value FROM plugin_meta WHERE key='owner'").get()?.value;
      if (owner && owner !== handle) throw failure('owner-mismatch', '当前账户与数据库归属不符，已保留原数据库。', 403);
      this.db.prepare("INSERT INTO plugin_meta(key,value) VALUES('owner',?) ON CONFLICT(key) DO NOTHING").run(handle);
      this.db.exec('COMMIT');
    } catch (error) { this.rollback(error); }
  }
  status() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO plugin_meta(key,value) VALUES('probe','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    } finally { this.db.exec('ROLLBACK'); }
    const counts = this.prepare('SELECT store,count(*) AS count,sum(length(CAST(payload AS BLOB))) AS bytes FROM records GROUP BY store').all();
    const bytes = ['','-wal','-shm'].reduce((sum, suffix) => sum + (fs.existsSync(this.file + suffix) ? fs.statSync(this.file + suffix).size : 0), 0);
    let availableBytes = null;
    try { const space = fs.statfsSync(this.file); availableBytes = space.bavail * space.bsize; }
    catch { /* Some hosts cannot report filesystem capacity; write failures still abort. */ }
    return { readable: true, writable: true, schema: 4, bytes, counts, transfer: 2, snapshots: 1, availableBytes };
  }
  activeDataset() {
    const row = this.db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(ACTIVE_DATASET_KEY);
    return datasetId(row ? JSON.parse(row.value) : undefined);
  }
  prepare(sql) {
    // Only fixed application SQL reaches this helper; never accept SQL or table
    // names from the client. Keep prepared-statement cache keys area-specific.
    return this.db.prepare(sql.replace(/\brecords\b/g, this.activeDataset() === 0 ? 'records' : 'records_next'));
  }
  changeDataset(action, id, manifest) {
    transferId(id);
    if (!['commit','rollback'].includes(action)) throw new Error('数据区操作无效。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const read = key => { const row=this.db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key);return row?JSON.parse(row.value):null; };
      const put = (key,value) => this.db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
      if(read('transfer-lock')!==id)throw new Error('任务未持有持久数据锁。');
      const state=read('transfer:'+id),active=this.activeDataset(),revision=read('revision')??0;
      if(state?.id!==id)throw new Error('目标任务身份与登记簿不一致。');
      const result=action==='commit'?commitDataset(state,{active,revision,expectedManifest:manifest}):rollbackDataset(state,{active,revision});
      if(action==='commit'&&state.phase!=='committed'||action==='rollback'&&state.phase==='committed') {
        put(ACTIVE_DATASET_KEY,action==='commit'?result.dataset:result.previousDataset);put('revision',revision+1);
      }
      put('transfer:'+id,result);this.checkCancelled();this.db.exec('COMMIT');return result;
    }catch(error){this.rollback(error);}
  }
  store(name, budget) {
    if (!STORES.includes(name)) throw failure('invalid-request', '无效记录类型。', 400);
    const read = (sql, params = [], keys = false) => {
      sql=sql.replace(/\brecords\b/g,this.activeDataset()===0?'records':'records_next');
      const activeBudget=this.bulkCatalog ? {rows:0,bytes:0} : budget;
      const result = [];
      this.readStatements ??= new Map();
      if (!this.readStatements.has(sql)) this.readStatements.set(sql, this.prepare(sql));
      for (const row of this.readStatements.get(sql).iterate(...params)) {
        activeBudget.bytes += Buffer.byteLength(keys ? row.primary_key : row.payload);
        if (++activeBudget.rows > MAX_ROWS || activeBudget.bytes > (this.bulkCatalog?128*1024*1024:MAX_BYTES)) throw failure('too-large', '本次读取超过限额，请分批操作。', 413);
        result.push(keys ? JSON.parse(row.primary_key) : decodeStorageValue(JSON.parse(row.payload)));
      }
      return result;
    };
    return {
      count: () => this.prepare('SELECT count(*) AS n FROM records WHERE store=?').get(name).n,
      chatKeys: () => {
        const keys=[];
        for(const row of this.prepare('SELECT DISTINCT chat_key FROM records WHERE store=? ORDER BY chat_key').iterate(name)) {
          if(keys.length>=MAX_ROWS)throw failure('too-large','目录聊天数超过读取限额，未执行清理。',413);
          keys.push(row.chat_key);
        }
        return keys;
      },
      get: (key) => read('SELECT payload FROM records WHERE store=? AND primary_key=?', [name, JSON.stringify(key)])[0],
      getAll: () => read('SELECT payload FROM records WHERE store=? ORDER BY primary_key', [name]),
      page: ({ snapshotId, after, limit = 50 }) => {
        let sql = snapshotId
          ? "SELECT payload FROM records WHERE store='snapshot_messages' AND chat_key=? AND CAST(json_extract(primary_key,'$[1]') AS INTEGER)>? ORDER BY CAST(json_extract(primary_key,'$[1]') AS INTEGER) LIMIT ?"
          : 'SELECT payload FROM records WHERE store=? AND primary_key>? ORDER BY primary_key LIMIT ?';
        sql=sql.replace(/\brecords\b/g,this.activeDataset()===0?'records':'records_next');
        this.readStatements ??= new Map();
        if (!this.readStatements.has(sql)) this.readStatements.set(sql,this.prepare(sql));
        const rows=[]; let bytes=0;
        const params=snapshotId?[snapshotId,after,limit]:[name,JSON.stringify(after),limit];
        for(const row of this.readStatements.get(sql).iterate(...params)) {
          const size=Buffer.byteLength(row.payload);if(rows.length&&bytes+size>2*1024*1024)break;
          rows.push(decodeStorageValue(JSON.parse(row.payload)));bytes+=size;
        }
        return rows;
      },
      put: (record) => {
        const storageKey=name==='snapshot_messages'?record?.snapshotId:record?.chatKey;
        if (!record || typeof storageKey !== 'string' || !storageKey || storageKey.length > 4096) throw failure('invalid-request', '记录缺少有效聊天身份。', 400);
        let key = storageKey;
        if (name === 'snapshots') key=record.id;
        else if (name === 'pending_changes') {
          if (typeof record.id !== 'string' || !record.id || !(record.messageIndex === null || (Number.isSafeInteger(record.messageIndex) && record.messageIndex >= 0))) throw failure('invalid-request', 'pending 记录无效。', 400);
          key = record.id;
        } else if (name !== 'chat_meta') {
          if (!Number.isSafeInteger(record.messageIndex) || record.messageIndex < 0) throw failure('invalid-request', '记录楼层无效。', 400);
          key = [storageKey, record.messageIndex];
        }
        const payload = JSON.stringify(encodeStorageValue(record));
        if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw failure('too-large', '单条备份超过 8 MiB，未写入。', 413);
        this.prepare('INSERT INTO records(store,primary_key,chat_key,payload) VALUES(?,?,?,?) ON CONFLICT(store,primary_key) DO UPDATE SET chat_key=excluded.chat_key,payload=excluded.payload').run(name, JSON.stringify(key), storageKey, payload);
        return key;
      },
      delete: (key) => this.prepare('DELETE FROM records WHERE store=? AND primary_key=?').run(name, JSON.stringify(key)),
      index: (indexName) => {
        if (indexName !== 'by_chat' && !(name==='snapshot_messages'&&indexName==='by_snapshot')) throw failure('invalid-request', '索引无效。', 400);
        return {
          getAll: (key) => read('SELECT payload FROM records WHERE store=? AND chat_key=? ORDER BY primary_key', [name, key]),
          getAllKeys: (key) => read('SELECT primary_key FROM records WHERE store=? AND chat_key=? ORDER BY primary_key', [name, key], true),
        };
      },
    };
  }
  async transaction(_db, names, mode, callback) {
    this.checkCancelled();
    this.db.exec(mode === 'readwrite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      if (this.db.prepare("SELECT value FROM plugin_meta WHERE key='transfer-lock'").get()) throw failure('transfer-locked', '存在未完成的切换任务，备份读写已暂停。', 409);
      const budget = { rows: 0, bytes: 0 };
      const result = await callback(new Map(names.map((name) => [name, this.store(name, budget)])));
      this.checkCancelled();
      if (mode === 'readwrite') this.db.prepare("INSERT INTO plugin_meta VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.rollback(error); }
  }
  rollback(error) {
    try { this.db.exec('ROLLBACK'); }
    catch (rollbackError) {
      // SQLITE_FULL may already have rolled back the transaction itself.
      if (!/no transaction is active/.test(rollbackError.message)) throw new AggregateError([error, rollbackError], 'SQLite 操作及回滚均失败。');
    }
    throw error;
  }
  checkCancelled() {
    if (this.cancel && Atomics.load(this.cancel, 0)) throw failure('cancelled', '请求已取消，事务未提交。', 409);
  }
  async execute(operation, args, cancel) {
    if (!STORAGE_OPERATIONS.includes(operation) || !Array.isArray(args)) throw failure('invalid-request', '不支持的箱装操作。', 400);
    this.cancel = cancel;
    this.bulkCatalog = ['getBackupCatalog','deleteBackupBatch'].includes(operation);
    try {
      if (operation === 'deletePendingChangesIfUnchanged') args = [args[0], { shouldDelete: () => !cancel || !Atomics.load(cancel, 0) }];
      return await (this.snapshotOperations[operation] ?? this.operations[operation])(null, ...args);
    } finally { this.cancel = null; this.bulkCatalog = false; }
  }
  close() {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
