// Keep all cursor continuations in the observed promise chain. A request or
// callback failure aborts its owning transaction before it can auto-commit.
import { markIndexedDbError, idbBoundary } from './idb-errors.js';
const transactions = new WeakMap();
export const IDB_IDLE_TIMEOUT_MS = 120000;

function failure(message, code, name = 'Error') {
  return markIndexedDbError(Object.assign(new Error(message), { name, code }));
}

function transactionOf(source) {
  return source?.transaction ?? source?.objectStore?.transaction;
}

function rejectRequest(source, error, reject) {
  transactions.get(transactionOf(source))?.fail(error);
  reject(error);
}

export function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      try { resolve(request.result); }
      catch (error) { rejectRequest(request.source, markIndexedDbError(error), reject); }
    };
    request.onerror = () => rejectRequest(request.source, markIndexedDbError(request.error ?? failure('本地备份读取失败。', 'backup-request-failed')), reject);
  });
}

export function iterateCursor(source, range, callback, { keyOnly = false, direction = 'next' } = {}) {
  return new Promise((resolve, reject) => {
    const fail = error => rejectRequest(source, error, reject);
    let read;
    try { read = keyOnly ? source.openKeyCursor(range, direction) : source.openCursor(range, direction); }
    catch (error) { fail(markIndexedDbError(error)); return; }
    read.onerror = () => fail(markIndexedDbError(read.error ?? failure('本地备份游标读取失败。', 'backup-request-failed')));
    read.onsuccess = () => {
      try {
        const raw = idbBoundary(read).result, cursor = raw && idbBoundary(raw);
        if (!cursor) { resolve(); return; }
        Promise.resolve(callback(cursor)).then(next => {
          if (next === false) resolve();
          else if (next !== 'jumped') cursor.continue();
        }).catch(fail);
      } catch (error) { fail(error); }
    };
  });
}

// Re-open strictly above each index key: O(distinct chats), without decoding
// message values, scanning duplicate floors or using unique cursor directions.
export function distinctIndexKeys(source, range, limit = Infinity) {
  return new Promise((resolve, reject) => {
    const keys = [], fail = error => rejectRequest(source, error, reject);
    function next(query) {
      let read;
      try { read = source.openKeyCursor(query, 'next'); }
      catch (error) { fail(markIndexedDbError(error)); return; }
      read.onerror = () => fail(markIndexedDbError(read.error ?? failure('本地备份目录读取失败。', 'backup-request-failed')));
      read.onsuccess = () => {
        try {
          const raw = idbBoundary(read).result, cursor = raw && idbBoundary(raw);
          if (!cursor) { resolve(keys); return; }
          const key = cursor.key;
          keys.push(key);
          if (keys.length >= limit || (range?.upper !== undefined && indexedDB.cmp(key, range.upper) >= 0)) { resolve(keys); return; }
          next(range?.upper === undefined ? IDBKeyRange.lowerBound(key, true)
            : IDBKeyRange.bound(key, range.upper, true, range.upperOpen));
        } catch (error) { fail(error); }
      };
    }
    if (limit <= 0) resolve(keys); else next(range);
  });
}

function withOutcome(error, outcome) {
  try { error.backupTransactionOutcome = outcome; return error; }
  catch { return Object.assign(new Error(error?.message || '本地备份事务失败。', { cause: error }), { name: error?.name || 'Error', backupTransactionOutcome: outcome }); }
}

export function runIdbTransaction(db, names, mode, callback, options, {
  idleTimeoutMs = IDB_IDLE_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(names, mode, options); } catch (error) { reject(markIndexedDbError(error)); return; }
    let result, callbackDone = false, originalError, settled = false, abortRequested = false, timer, abortTimer;
    const finish = (outcome, error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer); clearTimer(abortTimer);
      transactions.delete(tx);
      db.removeEventListener?.('close', closed);
      tx.removeEventListener?.('success', touch, true);
      if (error) reject(withOutcome(error, outcome)); else resolve(result);
    };
    const fail = error => {
      if (settled) return;
      originalError ??= error && typeof error === 'object' ? error : new Error(String(error));
      if (abortRequested) return;
      abortRequested = true;
      try { tx.abort(); }
      catch { finish('unknown', originalError); }
      if (!settled) { abortTimer = setTimer(() => finish('unknown', originalError), 5000); abortTimer?.unref?.(); }
    };
    const closed = () => finish('unknown', originalError ?? failure('本地备份连接意外关闭，操作结果需要重新核对。', 'backup-connection-closed', 'UnknownError'));
    function touch() {
      clearTimer(timer);
      timer = setTimer(() => {
        fail(failure('本地备份长时间没有响应，操作结果需要重新核对。', 'backup-operation-timeout', 'TimeoutError'));
      }, idleTimeoutMs);
      timer?.unref?.();
    }
    transactions.set(tx, { fail });
    db.addEventListener?.('close', closed);
    tx.addEventListener?.('success', touch, true);
    tx.oncomplete = () => {
      if (!callbackDone || originalError) finish('committed', originalError ?? failure('本地备份事务提前结束，操作未完整执行，结果待核对。', 'outcome-unknown'));
      else finish('committed');
    };
    tx.onerror = event => { const error = tx.error ?? event?.target?.error; if (error) originalError ??= markIndexedDbError(error); };
    tx.onabort = () => finish('aborted', originalError ?? tx.error ?? failure('本地备份事务已中止，原数据已保留。', 'backup-transaction-aborted', 'AbortError'));
    touch();
    try {
      Promise.resolve(callback(idbBoundary(tx))).then(value => { result = value; callbackDone = true; }).catch(fail);
    } catch (error) { fail(error); }
  });
}
