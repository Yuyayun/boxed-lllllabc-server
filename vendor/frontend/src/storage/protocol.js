export const STORAGE_PROTOCOL = 2;
export const STORAGE_OPERATIONS = Object.freeze([
  "getChatMeta", "putChatMeta", "updateChatMetaSummary", "getRecentMessages",
  "replaceRecentSnapshot", "getFullMessages", "putFullMessages", "replaceFullSnapshot",
  "getHistoricalChanges", "putHistoricalChanges", "getPendingChanges", "putPendingChanges",
  "replacePendingChanges", "deletePendingChangesIfUnchanged", "getBackupCatalogData",
  "reconcileChatIdentity", "migrateRenamedChatIdentity", "deleteBackupTypeForChat", "resolveFrozenFullBackup",
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
