export const STORAGE_PROTOCOL = 6;
export const BATCH_TRANSFER_VERSION = 3;
export const BATCH_TRANSFER_METHODS = Object.freeze({
  begin: [1, 1], status: [1, 1], inspect: [1, 1], prepareStep: [1, 2], sourceNext: [1, 3], append: [2, 2],
  verifyBatch: [2, 2], startSeal: [2, 3], sealStep: [1, 2], startSourceCheck: [1, 1],
  sourceCheckStep: [1, 2], commit: [2, 2], activate: [1, 1], beginAbort: [1, 1], finishStep: [1, 2], release: [1, 1],
});
export function validateBatchCall(action, args, mode) {
  const bounds = Object.hasOwn(BATCH_TRANSFER_METHODS, action) && BATCH_TRANSFER_METHODS[action];
  if (!bounds || !Array.isArray(args) || args.length < bounds[0] || args.length > bounds[1]) throw new Error("分批迁移方法或参数数量无效。");
  const id = action === "begin" ? args[0]?.id : args[0];
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("分批迁移任务标识无效。");
  if (action === "begin") {
    const job = args[0];
    if (!job || Array.isArray(job) || Object.keys(job).some(key => !["id", "role", "from", "to", "kind"].includes(key))
        || !["source", "target"].includes(job.role) || mode && (job.role === "source" ? job.from : job.to) !== mode) throw new Error("分批迁移方向与当前存储端不符。");
  }
  const optionIndex = ["prepareStep", "sealStep", "sourceCheckStep", "finishStep"].includes(action) ? 1 : action === "sourceNext" ? 2 : -1;
  const options = args[optionIndex];
  if (optionIndex >= 0 && options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["limit", "bytes"].includes(key)))) throw new Error("分批迁移分页参数无效。");
  if (action === "startSeal" && args[2] !== undefined && typeof args[2] !== "boolean") throw new Error("验收重启参数无效。");
  return args;
}
export const STORAGE_OPERATIONS = Object.freeze([
  "getChatMeta", "putChatMeta", "updateChatMetaSummary", "getRecentMessages",
  "replaceRecentSnapshot", "getFullMessages", "putFullMessages", "replaceFullSnapshot",
  "getHistoricalChanges", "putHistoricalChanges", "getPendingChanges", "putPendingChanges",
  "replacePendingChanges", "deletePendingChangesIfUnchanged", "getBackupCatalogData",
  "reconcileChatIdentity", "migrateRenamedChatIdentity", "deleteBackupTypeForChat", "resolveFrozenFullBackup",
  "deleteBackupBatch",
  "getBackupCatalog",
  "beginSnapshot", "appendSnapshotMessages", "publishSnapshot", "getSnapshotHeader", "getSnapshotMessages", "listSnapshots", "renameSnapshot", "deleteSnapshot",
]);

// A tagged tree avoids collisions with user fields and preserves the record
// values JSON would otherwise silently change. Unsupported values fail closed.
export function encodeStorageValue(value) {
  const seen = new Set();
  let nodes = 0;
  function encode(item, depth = 0) {
    if (++nodes > 200000 || depth > 100) throw new Error("记录结构超过安全上限。");
    if (item === null) return ["null"];
    if (item === undefined) return ["undefined"];
    if (typeof item === "string" || typeof item === "boolean") return [typeof item, item];
    if (typeof item === "number") return ["number", Object.is(item, -0) ? "-0" : String(item)];
    if (typeof item === "bigint") return ["bigint", String(item)];
    if (typeof item !== "object") throw new Error("记录包含无法无损保存的值。");
    if (item instanceof Date) return ["date", String(item.getTime())];
    if (seen.has(item)) throw new Error("记录包含循环引用，未执行写入。");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("记录包含不支持的对象类型。");
    seen.add(item);
    const result = Array.isArray(item)
      ? ["array", Array.from({ length: item.length }, (_, index) => index in item ? encode(item[index], depth + 1) : ["hole"])]
      : [Object.getPrototypeOf(item) === null ? "null-object" : "object", Object.keys(item).map((key) => [key, encode(item[key], depth + 1)])];
    seen.delete(item);
    return result;
  }
  return encode(value);
}

export function decodeStorageValue(value) {
  let nodes = 0;
  function decode(item, depth = 0) {
    if (++nodes > 200000 || depth > 100 || !Array.isArray(item)) throw new Error("存储协议数据无效。");
    const [tag, payload] = item;
    if (tag === "null" && item.length === 1) return null;
    if (tag === "undefined" && item.length === 1) return undefined;
    if (tag === "string" && typeof payload === "string") return payload;
    if (tag === "boolean" && typeof payload === "boolean") return payload;
    if (tag === "number" && typeof payload === "string" && (payload === "NaN" || String(Number(payload)) === payload || payload === "-0")) return Number(payload);
    if (tag === "bigint" && typeof payload === "string" && /^-?\d+$/.test(payload)) return BigInt(payload);
    if (tag === "date" && typeof payload === "string" && (payload === "NaN" || String(Number(payload)) === payload)) return new Date(Number(payload));
    if (tag === "array" && Array.isArray(payload)) {
      const result = new Array(payload.length);
      payload.forEach((child, index) => {
        if (!(Array.isArray(child) && child.length === 1 && child[0] === "hole")) result[index] = decode(child, depth + 1);
      });
      return result;
    }
    if (["object", "null-object"].includes(tag) && Array.isArray(payload)) {
      const result = tag === "null-object" ? Object.create(null) : {};
      for (const entry of payload) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || Object.hasOwn(result, entry[0])) throw new Error("存储记录字段无效。");
        Object.defineProperty(result, entry[0], { value: decode(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    throw new Error("存储协议数据无效。");
  }
  return decode(value);
}
