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
export function createStorageControl({ indexedDB = globalThis.indexedDB } = {}) {
  async function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 2);
      let blocked = false;
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
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error("存储控制记录被其他页面阻塞，请关闭其他酒馆页签。")); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
  }
  async function transaction(update) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("state", update ? "readwrite" : "readonly", update ? { durability: "strict" } : undefined);
        const store = tx.objectStore("state");
        let value;
        const read = store.get("current");
        read.onsuccess = () => {
          try {
            if (read.result === undefined) throw new Error("存储控制记录缺失，未猜测当前使用位置，请保留两端数据。");
            const current = read.result;
            validateStorageControl(current);
            value = validateStorageControl(update ? update(current) : current);
            if (update) store.put(value, "current");
          } catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => resolve(value);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("存储控制记录未写入。"));
      });
    } finally { db.close(); }
  }
  return { read: () => transaction(), update: (callback) => transaction(callback) };
}
