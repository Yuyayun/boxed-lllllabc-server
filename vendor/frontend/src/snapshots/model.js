import { digestValue, stableText } from "../storage/value-digest.js";

export const SNAPSHOT_FORMAT = 1;
const HASH = /^[a-f0-9]{64}$/;
export function validateSnapshotHeader(header) {
  if (!header || header.format !== SNAPSHOT_FORMAT || typeof header.id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(header.id)
    || typeof header.chatKey !== "string" || !header.chatKey || typeof header.name !== "string" || !header.name.trim() || header.name.length > 200
    || !Number.isFinite(Date.parse(header.createdAt)) || !["draft", "ready"].includes(header.state)
    || !Number.isSafeInteger(header.messageCount) || header.messageCount < 1
    || !Number.isSafeInteger(header.contentBytes) || header.contentBytes < 0
    || !Number.isSafeInteger(header.written) || header.written < 0 || header.written > header.messageCount
    || header.state === "ready" && header.written !== header.messageCount
    || !Array.isArray(header.hashes) || header.hashes.length !== header.messageCount || header.hashes.some(hash => !HASH.test(hash))
    || !header.metadata || typeof header.metadata !== "object" || Array.isArray(header.metadata) || !HASH.test(header.contentHash)) {
    throw new Error("聊天快照记录格式无效，禁止恢复。");
  }
  if (new TextEncoder().encode(stableText(header)).byteLength > 8 * 1024 * 1024) throw new Error("聊天快照元数据超过 8 MiB，未执行写入。");
}
export async function verifySnapshotHeader(header) {
  validateSnapshotHeader(header);
  if (header.contentHash !== await digestValue([header.format, header.metadata, header.hashes, header.contentBytes])) throw new Error("聊天快照元数据或内容清单校验失败，禁止恢复。");
  return header;
}
export async function verifySnapshotMessage(row, header) {
  if (!row || row.snapshotId !== header.id || !Number.isSafeInteger(row.messageIndex) || row.messageIndex < 0 || row.messageIndex >= header.messageCount
    || !row.raw || typeof row.raw !== "object" || Array.isArray(row.raw)
    || row.digest !== header.hashes[row.messageIndex] || row.digest !== await digestValue(row.raw)) throw new Error("聊天快照楼层内容校验失败，禁止恢复。");
  if (new TextEncoder().encode(stableText(row)).byteLength > 8 * 1024 * 1024) throw new Error("单条快照楼层超过 8 MiB，未执行写入。");
}
export function snapshotSummary(header) {
  const { id, chatKey, name, createdAt, messageCount, written, state, contentHash, contentBytes } = header;
  return { id, chatKey, name, createdAt, messageCount, written, state, contentHash, contentBytes };
}
export async function captureSnapshot(current, { name, id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!current?.ok || !current.identity?.chatKey || !Array.isArray(current.chat) || !current.chat.length) throw new Error("请先打开可识别的聊天，再创建快照。");
  let chat, metadata;
  try { chat = structuredClone(current.chat); metadata = structuredClone(current.context?.chatMetadata ?? {}); }
  catch (error) { throw new Error("当前聊天包含无法无损保存的字段，未创建快照。", { cause: error }); }
  const hashes = [];
  for (const message of chat) hashes.push(await digestValue(message));
  const contentBytes = chat.reduce((sum, message) => sum + new TextEncoder().encode(stableText(message)).byteLength, new TextEncoder().encode(stableText(metadata)).byteLength);
  const header = { id, format: SNAPSHOT_FORMAT, chatKey: current.identity.chatKey,
    name: String(name ?? "").trim() || new Date(now).toLocaleString(), createdAt: now,
    messageCount: chat.length, contentBytes, written: 0, state: "draft", metadata, hashes,
    contentHash: await digestValue([SNAPSHOT_FORMAT, metadata, hashes, contentBytes]) };
  await verifySnapshotHeader(header);
  return { header, messages: chat.map((raw, messageIndex) => ({ snapshotId: id, messageIndex, raw, digest: hashes[messageIndex] })) };
}
export async function currentSnapshotFingerprint(current) {
  return digestValue([current?.identity?.chatKey, current?.chat, current?.context?.chatMetadata ?? {}]);
}
export const sameSnapshotContent = (left, right) => stableText(left) === stableText(right);
