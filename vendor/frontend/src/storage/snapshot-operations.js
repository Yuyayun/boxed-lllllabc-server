import { STORES } from "../db/schema.js";
import { verifySnapshotHeader, verifySnapshotMessage, validateSnapshotHeader, snapshotSummary } from "../snapshots/model.js";

export function createSnapshotOperations({ runTransaction, requestToPromise: request }) {
  const readHeader = (db, id) => runTransaction(db, [STORES.snapshots], "readonly", stores => request(stores.get(STORES.snapshots).get(id)));
  return Object.freeze({
    async beginSnapshot(db, { header, identityMeta }) {
      await verifySnapshotHeader(header);
      if (header.state !== "draft" || header.written !== 0 || identityMeta?.chatKey !== header.chatKey) throw new Error("聊天快照创建参数无效。");
      return runTransaction(db, [STORES.snapshots, STORES.chatMeta], "readwrite", async stores => {
        const store = stores.get(STORES.snapshots);
        if (await request(store.get(header.id))) throw new Error("聊天快照标识已存在，未覆盖原快照。");
        const metas = stores.get(STORES.chatMeta), previous = await request(metas.get(header.chatKey));
        await request(metas.put({ ...identityMeta, ...previous, chatKey: header.chatKey }));
        await request(store.put(header)); return snapshotSummary(header);
      });
    },
    async appendSnapshotMessages(db, { id, messages }) {
      const expected = await readHeader(db, id);
      await verifySnapshotHeader(expected);
      if (expected.state !== "draft" || !Array.isArray(messages) || !messages.length || messages.length > 100) throw new Error("聊天快照暂存批次无效。");
      for (const row of messages) await verifySnapshotMessage(row, expected);
      return runTransaction(db, [STORES.snapshots, STORES.snapshotMessages], "readwrite", async stores => {
        const headers = stores.get(STORES.snapshots), header = await request(headers.get(id));
        if (!header || header.state !== "draft" || header.contentHash !== expected.contentHash) throw new Error("聊天快照暂存状态已经变化。");
        for (const row of messages) {
          if (row.messageIndex !== header.written) throw new Error("聊天快照楼层不连续，未覆盖已写入内容。");
          await request(stores.get(STORES.snapshotMessages).put(row)); header.written++;
        }
        await request(headers.put(header)); return { written: header.written };
      });
    },
    async publishSnapshot(db, { id }) {
      return runTransaction(db, [STORES.snapshots, STORES.snapshotMessages], "readwrite", async stores => {
        const headers = stores.get(STORES.snapshots), header = await request(headers.get(id));
        if (!header || header.state !== "draft" || header.written !== header.messageCount) throw new Error("聊天快照未完整写入，不能报告创建成功。");
        const keys = await request(stores.get(STORES.snapshotMessages).index("by_snapshot").getAllKeys(id));
        keys.sort((left, right) => left[1] - right[1]);
        if (keys.length !== header.messageCount || keys.some((key, index) => key[0] !== id || key[1] !== index)) throw new Error("聊天快照楼层索引不完整。");
        header.state = "ready"; await request(headers.put(header)); return snapshotSummary(header);
      });
    },
    getSnapshotHeader: readHeader,
    async getSnapshotMessages(db, { id, after = -1 }) {
      if (!Number.isSafeInteger(after) || after < -1) throw new Error("聊天快照分页参数无效。");
      return runTransaction(db, [STORES.snapshotMessages], "readonly", stores => stores.get(STORES.snapshotMessages).page({ snapshotId: id, after }));
    },
    async listSnapshots(db, { after = "", includeDrafts = false } = {}) {
      return runTransaction(db, [STORES.snapshots, STORES.chatMeta], "readonly", async stores => {
        const rows = await stores.get(STORES.snapshots).page({ after });
        const items = [];
        for (const row of rows.filter(row => row.state === "ready" || includeDrafts && row.state === "draft")) items.push({ ...snapshotSummary(row), meta: await request(stores.get(STORES.chatMeta).get(row.chatKey)) });
        return { items, after: rows.at(-1)?.id ?? null };
      });
    },
    async renameSnapshot(db, { id, name, expectedName }) {
      if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("快照名称须为 1–200 字。");
      return runTransaction(db, [STORES.snapshots], "readwrite", async stores => {
        const store = stores.get(STORES.snapshots), header = await request(store.get(id));
        if (!header || header.state !== "ready" || header.name !== expectedName) throw new Error("聊天快照已变化，请刷新后重命名。");
        header.name = name.trim(); validateSnapshotHeader(header); await request(store.put(header)); return snapshotSummary(header);
      });
    },
    async deleteSnapshot(db, { id, expectedHash, draftOnly = false }) {
      return runTransaction(db, [STORES.snapshots, STORES.snapshotMessages], "readwrite", async stores => {
        const headers = stores.get(STORES.snapshots), header = await request(headers.get(id));
        if (!header) return { deleted: false };
        if (draftOnly && header.state !== "draft") return { deleted: false };
        if (header.contentHash !== expectedHash) throw new Error("聊天快照已变化，请重新确认删除。");
        const rows = stores.get(STORES.snapshotMessages), keys = await request(rows.index("by_snapshot").getAllKeys(id));
        for (const key of keys) await request(rows.delete(key));
        await request(headers.delete(id)); return { deleted: true };
      });
    },
  });
}
