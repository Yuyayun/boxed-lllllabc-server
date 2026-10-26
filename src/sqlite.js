import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createBackupOperations } from '../vendor/frontend/src/storage/operations.js';
import { STORAGE_OPERATIONS, encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { failure } from './errors.js';
import { installTransfer } from './transfer.js';

const STORES = ['chat_meta', 'recent_messages', 'pending_changes', 'full_messages', 'historical_changes'];
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
      if (version < 0 || version > 2 || (appId && appId !== APP_ID) || (tables.length && appId !== APP_ID) || (version && appId !== APP_ID)) throw failure('database-unavailable', 'SQLite 不属于兼容的箱装数据库，未覆盖原文件。');
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
        if (version < 2) {
          // VACUUM INTO takes a consistent SQLite backup, including live WAL.
          if (tables.length) this.db.prepare('VACUUM INTO ?').run(`${file}.before-v2-${Date.now()}.bak`);
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
              CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL CHECK(store IN ('chat_meta','recent_messages','pending_changes','full_messages','historical_changes')), primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(store,primary_key)) STRICT;
              CREATE INDEX IF NOT EXISTS by_chat ON records(store,chat_key,primary_key);
              CREATE TABLE IF NOT EXISTS transfer_rows (id TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, store TEXT NOT NULL, primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,kind,n), UNIQUE(id,kind,store,primary_key)) STRICT;
              PRAGMA application_id=${APP_ID}; PRAGMA user_version=2;`);
            this.db.exec('COMMIT');
          } catch (error) { this.rollback(error); }
        }
      } else if (version !== 2) throw failure('database-unavailable', '只读数据库需要先升级，未执行升级。');
      this.operations = createBackupOperations({ runTransaction: this.transaction.bind(this), requestToPromise: (value) => value });
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
    const counts = this.db.prepare('SELECT store,count(*) AS count,sum(length(CAST(payload AS BLOB))) AS bytes FROM records GROUP BY store').all();
    const bytes = ['','-wal','-shm'].reduce((sum, suffix) => sum + (fs.existsSync(this.file + suffix) ? fs.statSync(this.file + suffix).size : 0), 0);
    let availableBytes = null;
    try { const space = fs.statfsSync(this.file); availableBytes = space.bavail * space.bsize; }
    catch { /* Some hosts cannot report filesystem capacity; write failures still abort. */ }
    return { readable: true, writable: true, schema: 2, bytes, counts, transfer: 1, availableBytes };
  }
  store(name, budget) {
    if (!STORES.includes(name)) throw failure('invalid-request', '无效记录类型。', 400);
    const read = (sql, params = [], keys = false) => {
      const result = [];
      this.readStatements ??= new Map();
      if (!this.readStatements.has(sql)) this.readStatements.set(sql, this.db.prepare(sql));
      for (const row of this.readStatements.get(sql).iterate(...params)) {
        budget.bytes += Buffer.byteLength(keys ? row.primary_key : row.payload);
        if (++budget.rows > MAX_ROWS || budget.bytes > MAX_BYTES) throw failure('too-large', '本次读取超过限额，请分批操作。', 413);
        result.push(keys ? JSON.parse(row.primary_key) : decodeStorageValue(JSON.parse(row.payload)));
      }
      return result;
    };
    return {
      get: (key) => read('SELECT payload FROM records WHERE store=? AND primary_key=?', [name, JSON.stringify(key)])[0],
      getAll: () => read('SELECT payload FROM records WHERE store=? ORDER BY primary_key', [name]),
      put: (record) => {
        if (!record || typeof record.chatKey !== 'string' || !record.chatKey || record.chatKey.length > 4096) throw failure('invalid-request', '记录缺少有效聊天身份。', 400);
        let key = record.chatKey;
        if (name === 'pending_changes') {
          if (typeof record.id !== 'string' || !record.id || !(record.messageIndex === null || (Number.isSafeInteger(record.messageIndex) && record.messageIndex >= 0))) throw failure('invalid-request', 'pending 记录无效。', 400);
          key = record.id;
        } else if (name !== 'chat_meta') {
          if (!Number.isSafeInteger(record.messageIndex) || record.messageIndex < 0) throw failure('invalid-request', '记录楼层无效。', 400);
          key = [record.chatKey, record.messageIndex];
        }
        const payload = JSON.stringify(encodeStorageValue(record));
        if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw failure('too-large', '单条备份超过 8 MiB，未写入。', 413);
        this.db.prepare('INSERT INTO records(store,primary_key,chat_key,payload) VALUES(?,?,?,?) ON CONFLICT(store,primary_key) DO UPDATE SET chat_key=excluded.chat_key,payload=excluded.payload').run(name, JSON.stringify(key), record.chatKey, payload);
        return key;
      },
      delete: (key) => this.db.prepare('DELETE FROM records WHERE store=? AND primary_key=?').run(name, JSON.stringify(key)),
      index: (indexName) => {
        if (indexName !== 'by_chat') throw failure('invalid-request', '索引无效。', 400);
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
    try {
      if (operation === 'deletePendingChangesIfUnchanged') args = [args[0], { shouldDelete: () => !cancel || !Atomics.load(cancel, 0) }];
      return await this.operations[operation](null, ...args);
    } finally { this.cancel = null; }
  }
  close() {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
