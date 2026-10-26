import { encodeStorageValue } from "./protocol.js";

export const DATA_STORES = Object.freeze(["chat_meta", "recent_messages", "pending_changes", "full_messages", "historical_changes"]);
export const TRANSFER_PAGE_BYTES = 2 * 1024 * 1024;
export const TRANSFER_RECORD_BYTES = 8 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
export function transferId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) fail("切换任务标识无效。");
  return id;
}
function stable(node) {
  if (!Array.isArray(node)) return node;
  if (["object", "null-object"].includes(node[0])) return [node[0], node[1].map(([key, value]) => [key, stable(value)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)];
  return node.map(stable);
}
export function recordText(row) {
  return JSON.stringify(stable(encodeStorageValue([row.store, row.key, row.value])));
}
export function validateTransferRow(row) {
  if (!DATA_STORES.includes(row?.store) || !Number.isSafeInteger(row.n) || row.n < 1) fail("包含未知数据仓库或无效序号，已停止切换。");
  const value = row.value;
  if (!value || typeof value.chatKey !== "string" || !value.chatKey) fail("发现缺少聊天身份的原始记录，未丢弃记录，已停止切换。");
  const key = row.store === "chat_meta" ? value.chatKey : row.store === "pending_changes" ? value.id : [value.chatKey, value.messageIndex];
  if (row.store !== "chat_meta" && !(row.store === "pending_changes" && value.messageIndex === null) && (!Number.isSafeInteger(value.messageIndex) || value.messageIndex < 0)) fail("发现楼层无效的原始记录，已停止切换。");
  if (row.store === "pending_changes" && (typeof value.id !== "string" || !value.id)) fail("pending 主键无效，已停止切换。");
  if (JSON.stringify(encodeStorageValue(key)) !== JSON.stringify(encodeStorageValue(row.key))) fail("原始记录的主键与内容不一致，已停止切换。");
  const bytes = new TextEncoder().encode(recordText(row)).byteLength;
  if (bytes > TRANSFER_RECORD_BYTES) fail("单条原始记录超过 8 MiB，未丢弃记录，已停止切换。");
  return bytes;
}
export async function sha256(text) {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function digestRow(row) { validateTransferRow(row); return sha256(recordText(row)); }
export async function readTransferManifest(page) {
  const counts = Object.fromEntries(DATA_STORES.map((name) => [name, 0]));
  const metaKeys = new Set();
  const references = new Set();
  let count = 0, bytes = 0, digest = await sha256("");
  while (true) {
    const rows = await page(count);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.n !== count + 1) fail("分页记录序号不连续，已停止切换。");
      bytes += validateTransferRow(row);
      const hash = await digestRow(row);
      if (row.digest && row.digest !== hash) fail("记录逐项摘要不一致，已停止切换。");
      digest = await sha256(digest + hash);
      counts[row.store] += 1;
      count += 1;
      (row.store === "chat_meta" ? metaKeys : references).add(row.value.chatKey);
    }
  }
  for (const key of references) if (!metaKeys.has(key)) fail("发现缺少关联元数据的原始记录，已保留全部数据并停止切换。");
  return { version: 1, stores: [...DATA_STORES], counts, count, bytes, digest };
}
export function sameManifest(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
export async function emptyManifest() { return readTransferManifest(async () => []); }
