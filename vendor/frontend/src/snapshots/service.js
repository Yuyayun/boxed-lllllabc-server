import { verifySnapshotHeader, verifySnapshotMessage } from "./model.js";
import { stableText } from "../storage/value-digest.js";

export async function readSnapshot(session, id) {
  const header = await session.getSnapshotHeader(id);
  await verifySnapshotHeader(header);
  if (header.state !== "ready") throw new Error("聊天快照尚未完整提交，不能预览或恢复。");
  const chat = []; let after = -1;
  while (true) {
    const rows = await session.getSnapshotMessages({ id, after });
    if (!rows.length) break;
    for (const row of rows) {
      if (row.messageIndex !== chat.length) throw new Error("聊天快照楼层缺失或顺序异常，禁止恢复。");
      await verifySnapshotMessage(row, header); chat.push(structuredClone(row.raw));
    }
    after = rows.at(-1).messageIndex;
  }
  if (chat.length !== header.messageCount) throw new Error("聊天快照内容不完整，禁止恢复。");
  const latest = await session.getSnapshotHeader(id);
  if (latest?.state !== "ready" || latest.contentHash !== header.contentHash || latest.chatKey !== header.chatKey) throw new Error("聊天快照归属或内容已变化，请重新预览。");
  return { header: latest, chat };
}

export function snapshotBatches(messages) {
  const batches = []; let batch = [], bytes = 0;
  for (const row of messages) {
    const size = new TextEncoder().encode(stableText(row)).byteLength;
    if (size > 8 * 1024 * 1024) throw new Error("单条快照楼层超过 8 MiB，未报告创建成功。");
    if (batch.length && (batch.length >= 50 || bytes + size > 2 * 1024 * 1024)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(row); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
