import { idbRequest, runIdbTransaction } from '../db/idb-helpers.js';
import { markIndexedDbError } from '../db/idb-errors.js';

const NAME = "boxed-lllllabc-control";
const DEFAULT = Object.freeze({ active: "indexeddb", previous: null, lastTransfer: null, journal: null });
export function validateStorageControl(current) {
  if (!["indexeddb", "sqlite"].includes(current.active)) throw new Error("活动存储记录无效，不能自动选择数据库。");
  if (current.previous !== null && (!["indexeddb", "sqlite"].includes(current.previous) || current.previous === current.active) || current.lastTransfer !== null && (typeof current.lastTransfer !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(current.lastTransfer))) throw new Error("原存储位置的确认记录无效，请保留两个位置的备份。");
  const journal = current.journal;
  if (journal && (!/^[a-zA-Z0-9_-]{8,80}$/.test(journal.id) || !["switch", "clear"].includes(journal.kind)
      || ![undefined, 3].includes(journal.version)
      || !(journal.version === 3 ? ["working", "committing", "activated", "aborting"] : ["working", "activated"]).includes(journal.phase)
      || !["indexeddb", "sqlite"].includes(journal.from) || !["indexeddb", "sqlite"].includes(journal.to) || journal.from === journal.to
      || current.active !== (journal.phase === "activated" && journal.kind === "switch" ? journal.to : journal.from))) throw new Error("存储恢复记录无效，请保留两端数据。");
  return current;
}
export function createStorageControl({ indexedDB = globalThis.indexedDB, timeoutMs = 5000 } = {}) {
  async function open() {
    return new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(NAME, 2); } catch (error) { reject(markIndexedDbError(error)); return; }
      let blocked = false;
      const timer = setTimeout(() => { blocked = true; reject(Object.assign(new Error('本地存储位置记录长时间没有响应，请关闭其他酒馆页签后重试。'), { code: 'backup-control-unavailable' })); }, timeoutMs);
      request.onupgradeneeded = event => {
        if (blocked) { request.transaction.abort(); return; }
        const store = event.oldVersion === 0 ? request.result.createObjectStore("state") : request.transaction.objectStore("state");
        if (event.oldVersion === 0) store.put(structuredClone(DEFAULT), "current");
        else {
          // v1 never persisted its default IndexedDB selection until the first
          // switch. Preserve existing records, initialize only that legacy case.
          const read = store.get("current");
          read.onsuccess = () => { if (read.result === undefined) store.put(structuredClone(DEFAULT), "current"); };
        }
      };
      request.onerror = () => { clearTimeout(timer); reject(markIndexedDbError(request.error)); };
      request.onblocked = () => { blocked = true; clearTimeout(timer); reject(Object.assign(new Error("存储控制记录被其他页面阻塞，请关闭其他酒馆页签。"), { code: 'backup-control-unavailable' })); };
      request.onsuccess = () => { clearTimeout(timer); if (blocked) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    });
  }
  async function transaction(update) {
    const db = await open();
    try {
      return await runIdbTransaction(db, "state", update ? "readwrite" : "readonly", async tx => {
        const store = tx.objectStore("state");
        const current = await idbRequest(store.get('current'));
        if (current === undefined) throw new Error("存储控制记录缺失，未猜测当前使用位置，请保留两端数据。");
        validateStorageControl(current);
        const value = validateStorageControl(update ? update(current) : current);
        if (update) await idbRequest(store.put(value, "current"));
        return value;
      }, update ? { durability: "strict" } : undefined);
    } finally { db.close(); }
  }
  return { read: () => transaction(), update: (callback) => transaction(callback) };
}
