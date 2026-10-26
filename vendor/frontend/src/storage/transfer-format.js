import { encodeStorageValue } from "./protocol.js";
import { stableText, sha256 } from "./value-digest.js";
import { verifySnapshotHeader, verifySnapshotMessage } from "../snapshots/model.js";
export { sha256 } from "./value-digest.js";

export const DATA_STORES = Object.freeze(["chat_meta", "recent_messages", "pending_changes", "full_messages", "historical_changes", "snapshots", "snapshot_messages"]);
export const TRANSFER_PAGE_BYTES = 2 * 1024 * 1024;
export const TRANSFER_RECORD_BYTES = 8 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
export function transferId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) fail("切换任务标识无效。");
  return id;
}
export function recordText(row) {
  return stableText([row.store, row.key, row.value]);
}
export function validateTransferRow(row) {
  if (!DATA_STORES.includes(row?.store) || !Number.isSafeInteger(row.n) || row.n < 1) fail("包含未知数据仓库或无效序号，已停止切换。");
  const value = row.value;
  if (!value || row.store !== "snapshot_messages" && (typeof value.chatKey !== "string" || !value.chatKey)) fail("发现缺少聊天身份的原始记录，未丢弃记录，已停止切换。");
  const key = row.store === "chat_meta" ? value.chatKey : ["pending_changes", "snapshots"].includes(row.store) ? value.id : row.store === "snapshot_messages" ? [value.snapshotId, value.messageIndex] : [value.chatKey, value.messageIndex];
  if (!["chat_meta", "snapshots"].includes(row.store) && !(row.store === "pending_changes" && value.messageIndex === null) && (!Number.isSafeInteger(value.messageIndex) || value.messageIndex < 0)) fail("发现楼层无效的原始记录，已停止切换。");
  if (row.store === "pending_changes" && (typeof value.id !== "string" || !value.id)) fail("pending 主键无效，已停止切换。");
  if (JSON.stringify(encodeStorageValue(key)) !== JSON.stringify(encodeStorageValue(row.key))) fail("原始记录的主键与内容不一致，已停止切换。");
  const bytes = new TextEncoder().encode(recordText(row)).byteLength;
  if (bytes > TRANSFER_RECORD_BYTES) fail("单条原始记录超过 8 MiB，未丢弃记录，已停止切换。");
  return bytes;
}
export async function digestRow(row) { validateTransferRow(row); return sha256(recordText(row)); }
export async function readTransferManifest(page) {
  const counts = Object.fromEntries(DATA_STORES.map((name) => [name, 0]));
  const metaKeys = new Set();
  const references = new Set();
  const snapshots = new Map();
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
      if (row.store === "snapshots") snapshots.set(row.value.id, { header: await verifySnapshotHeader(row.value), count: 0 });
      if (row.store === "snapshot_messages") {
        const snapshot = snapshots.get(row.value.snapshotId);
        if (!snapshot) fail("聊天快照缺少关联存档信息，已停止切换。");
        await verifySnapshotMessage(row.value, snapshot.header); snapshot.count++;
      } else (row.store === "chat_meta" ? metaKeys : references).add(row.value.chatKey);
    }
  }
  for (const key of references) if (!metaKeys.has(key)) fail("发现缺少关联元数据的原始记录，已保留全部数据并停止切换。");
  for (const { header, count: rows } of snapshots.values()) if (rows !== header.written) fail("聊天快照记录数量不完整，已停止切换。");
  return { version: 2, stores: [...DATA_STORES], counts, count, bytes, digest };
}
export function sameManifest(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
export async function emptyManifest() { return readTransferManifest(async () => []); }
