import { DATA_STORES, recordText, transferId } from "./transfer-format.js";
import { datasetId } from "./dataset-layout.js";
import { verifySnapshotHeader, verifySnapshotMessage } from "../snapshots/model.js";
import { INITIAL_CURSOR, pageBudget, initialSummary, same, batchKey, recordKey, snapshotCountKey, rowRef, batchPacket, advanceSummary } from "./transfer-batch-format.js";

const fail = message => { throw new Error(message); };
const number = value => Number.isSafeInteger(value) && value >= 0;
const countsEqual = (left, right) => DATA_STORES.every(name => left[name] === right[name]);
function batchReceipt(value, index, target = false) {
  if (!value || value.index !== index || !Array.isArray(value.refs) || !value.refs.length || value.refs.length > 100
      || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || target && !["written", "verified"].includes(value.phase)) fail("持久批次登记损坏或超过限额。");
  return value;
}

// The driver supplies only bounded reads and database transactions. Hashing and
// snapshot verification happen outside IDB transactions; before recording a
// checkpoint, we re-read the bounded rows in the write transaction.
export function createBatchTransfer({ driver, now = () => new Date().toISOString() }) {
  async function locked(tx, id, role) {
    await tx.validateLayout();
    const state = await tx.taskGet(id);
    if (await tx.lockGet() !== id || !state || state.id !== id || state.version !== 3 || role && state.role !== role) fail("任务登记或持久数据锁不匹配。");
    datasetId(state.dataset); datasetId(state.previousDataset);
    if (!["source", "target"].includes(state.role)
        || state.role === "source" && (state.dataset !== state.previousDataset || !["capturing", "captured"].includes(state.phase))
        || state.role === "target" && (state.dataset === state.previousDataset || !["preparing", "staging", "checking", "verified"].includes(state.phase))) fail("任务数据区或阶段登记无效，未修改数据。");
    if (![state.baseRevision, state.batches, state.verifiedBatch, state.writtenBatch, state.verified, state.summary?.count, state.summary?.bytes].every(number)
        || !state.summary?.counts || !DATA_STORES.every(name => number(state.summary.counts[name]))
        || DATA_STORES.reduce((sum, name) => sum + state.summary.counts[name], 0) !== state.summary.count
        || !/^[a-f0-9]{64}$/.test(state.summary.digest)
        || state.role === "target" && (state.verified !== state.summary.count || state.writtenBatch < state.verifiedBatch || state.writtenBatch > state.verifiedBatch + 1)) fail("任务进度登记损坏，不能继续。");
    const active = datasetId(await tx.active());
    if (active !== (state.role === "source" ? state.dataset : state.previousDataset)
        || await tx.revision() !== state.baseRevision) fail("迁移期间正式数据已变化，不能继续旧任务。");
    return state;
  }
  async function unchanged(tx, state) {
    const current = await locked(tx, state.id, state.role);
    if (!same(current, state)) fail("任务检查点已变化，请重新读取登记簿。");
    return current;
  }
  async function requireRows(tx, dataset, rows) {
    for (const row of rows) {
      const value = await tx.get(dataset, row.store, row.key);
      if (value === undefined || recordText({ ...row, value }) !== recordText(row)) fail("读回后记录再次变化，未登记本批完成。");
    }
  }
  const save = async (tx, state, changes) => {
    const next = { ...state, ...changes, updatedAt: now() };
    await tx.taskPut(next); return next;
  };
  async function begin({ id, role, from, to }) {
    transferId(id);
    if (!["source", "target"].includes(role) || !["indexeddb", "sqlite"].includes(from)
        || !["indexeddb", "sqlite"].includes(to) || from === to) fail("迁移任务方向无效。");
    const summary = await initialSummary();
    return driver.transaction("readwrite", async tx => {
      await tx.validateLayout();
      const lock = await tx.lockGet(), old = await tx.taskGet(id);
      if (lock && lock !== id) fail("另有未完成任务，不能覆盖原登记簿。");
      if (old) {
        if (!lock || old.version !== 3 || old.role !== role || old.from !== from || old.to !== to) fail("已有任务身份或版本不一致。");
        return locked(tx, id, role);
      }
      // A lock without its receipt is ambiguous, even if its ID matches.
      if (lock) fail("持久锁缺少登记簿，不能猜测原任务结果。");
      const active = datasetId(await tx.active()), revision = await tx.revision();
      if (!number(revision)) fail("来源修订记录无效。");
      const state = { version: 3, id, role, from, to, dataset: role === "source" ? active : 1 - active,
        previousDataset: active, baseRevision: revision, phase: role === "source" ? "capturing" : "preparing",
        summary, batches: 0, verifiedBatch: 0, writtenBatch: 0, verified: 0,
        cursor: { ...INITIAL_CURSOR }, lastStore: -1, createdAt: now(), updatedAt: now() };
      await tx.lockPut(id); await tx.taskPut(state); return state;
    });
  }
  async function status(id) {
    transferId(id);
    return driver.transaction("readonly", tx => tx.taskGet(id));
  }
  async function prepareStep(id, options) {
    transferId(id); const budget = pageBudget(options);
    return driver.transaction("readwrite", async tx => {
      const state = await locked(tx, id, "target");
      if (state.phase === "staging") return state;
      if (state.phase !== "preparing") fail("目标不在准备阶段。");
      const page = await tx.page(state.dataset, state.cursor, budget);
      for (const row of page.rows) await tx.remove(state.dataset, row.store, row.key);
      return save(tx, state, { cursor: page.done ? { ...INITIAL_CURSOR } : page.cursor,
        phase: page.done ? "staging" : "preparing", cleaned: (state.cleaned ?? 0) + page.rows.length });
    });
  }
  async function sourceNext(id, after = 0, options) {
    transferId(id); if (!number(after)) fail("来源批次游标无效。");
    const budget = pageBudget(options);
    const input = await driver.transaction("readonly", async tx => {
      const state = await locked(tx, id, "source");
      if (!["capturing", "captured"].includes(state.phase) || after > state.batches) fail("来源批次位置不连续。");
      if (after < state.batches) {
        const receipt = batchReceipt(await tx.metaGet(batchKey(id, after + 1)), after + 1);
        const rows = [];
        for (const ref of receipt.refs) rows.push({ ...ref, value: await tx.get(state.dataset, ref.store, ref.key) });
        return { state, receipt, rows };
      }
      if (state.phase === "captured") return { state, done: true };
      return { state, page: await tx.page(state.dataset, state.cursor, budget) };
    });
    if (input.done) return { done: true, summary: input.state.summary, batches: input.state.batches };
    const rows = input.rows ?? input.page.rows.map((row, offset) => ({ ...row, n: input.state.summary.count + offset + 1 }));
    if (input.receipt) {
      const packet = await batchPacket(id, after + 1, rows);
      if (packet.fingerprint !== input.receipt.fingerprint) fail("来源已变化，旧批次不能重发。");
      return packet;
    }
    if (!rows.length) return driver.transaction("readwrite", async tx => {
      await unchanged(tx, input.state);
      const state = await save(tx, input.state, { phase: "captured", cursor: input.page.cursor });
      return { done: true, summary: state.summary, batches: state.batches };
    });
    const packet = await batchPacket(id, after + 1, rows), summary = await advanceSummary(input.state.summary, packet.rows, packet.bytes);
    await driver.transaction("readwrite", async tx => {
      await unchanged(tx, input.state); await requireRows(tx, input.state.dataset, rows);
      await tx.metaPut(batchKey(id, packet.index), { index: packet.index, fingerprint: packet.fingerprint, refs: packet.rows.map(rowRef) });
      await save(tx, input.state, { summary, batches: packet.index, cursor: input.page.cursor,
        phase: input.page.done ? "captured" : "capturing", progressAt: now() });
    });
    return packet;
  }
  async function append(id, incoming) {
    transferId(id);
    if (incoming?.id !== id) fail("批次不属于当前迁移任务。");
    const packet = await batchPacket(id, incoming.index, incoming.rows);
    if (packet.fingerprint !== incoming.fingerprint) fail("批次身份或内容摘要不一致。");
    const keys = await Promise.all(packet.rows.map(row => recordKey(id, row)));
    return driver.transaction("readwrite", async tx => {
      const state = await locked(tx, id, "target"), key = batchKey(id, packet.index);
      const old = await tx.metaGet(key);
      if (old) {
        batchReceipt(old, packet.index, true);
        if (old.fingerprint !== packet.fingerprint) fail("重复批次的内容不同，未覆盖目标。");
        // A retry rechecks what is actually stored, even after acknowledgement.
        await requireRows(tx, state.dataset, packet.rows); return old;
      }
      if (state.phase !== "staging" || state.writtenBatch !== state.verifiedBatch
          || packet.index !== state.verifiedBatch + 1 || packet.first !== state.summary.count + 1
          || DATA_STORES.indexOf(packet.rows[0].store) < state.lastStore) fail("批次乱序或上一批尚未验货。");
      for (let i = 0; i < packet.rows.length; i++) {
        const row = packet.rows[i];
        if (await tx.has(state.dataset, row.store, row.key) || await tx.metaGet(keys[i])) fail("跨批次主键重复，未覆盖原记录。");
        await tx.add(state.dataset, row.store, row.key, row.value);
        await tx.metaPut(keys[i], rowRef(row));
      }
      const receipt = { index: packet.index, fingerprint: packet.fingerprint, refs: packet.rows.map(rowRef), phase: "written" };
      await tx.metaPut(key, receipt);
      await save(tx, state, { writtenBatch: packet.index });
      return receipt;
    });
  }
  async function relations(id, dataset, rows, final = false) {
    // Keep at most one associated snapshot header, instead of retaining all
    // headers for a page containing messages from many large snapshots.
    let lastHeader;
    for (const row of rows) {
      if (row.store === "snapshot_messages") {
        if (lastHeader?.id !== row.value.snapshotId) lastHeader = await driver.transaction("readonly", tx => tx.get(dataset, "snapshots", row.value.snapshotId));
        if (!lastHeader) fail("快照缺少关联头信息。");
        if (row.value.messageIndex >= lastHeader.written) fail("快照楼层超出已登记的写入范围。");
        await verifySnapshotMessage(row.value, lastHeader);
      } else {
        if (!await driver.transaction("readonly", tx => tx.has(dataset, "chat_meta", row.value.chatKey))) fail("记录缺少关联聊天元数据。");
        if (row.store === "snapshots") {
          await verifySnapshotHeader(row.value);
          if (final) {
            const count = await driver.transaction("readonly", tx => tx.metaGet(snapshotCountKey(id, row.value.id)));
            if ((count ?? 0) !== row.value.written) fail("快照楼层数量与头信息不一致。");
          }
        }
      }
    }
  }
  async function verifyBatch(id, index) {
    transferId(id); if (!Number.isSafeInteger(index) || index < 1) fail("验货批次无效。");
    const input = await driver.transaction("readonly", async tx => {
      const state = await locked(tx, id, "target"), receipt = batchReceipt(await tx.metaGet(batchKey(id, index)), index, true);
      if (!["staging", "checking", "verified"].includes(state.phase)) fail("阶段不允许验货。");
      const rows = [];
      for (const ref of receipt.refs) rows.push({ ...ref, value: await tx.get(state.dataset, ref.store, ref.key) });
      return { state, receipt, rows };
    });
    const packet = await batchPacket(id, index, input.rows);
    if (packet.fingerprint !== input.receipt.fingerprint) fail("目标实际读回与来源批次不一致。");
    await relations(id, input.state.dataset, packet.rows);
    if (input.receipt.phase === "verified") return { index, verified: input.state.verified, repeated: true };
    if (index !== input.state.verifiedBatch + 1 || input.state.writtenBatch !== index) fail("批次验货顺序不连续。");
    const summary = await advanceSummary(input.state.summary, packet.rows, packet.bytes);
    return driver.transaction("readwrite", async tx => {
      await unchanged(tx, input.state); await requireRows(tx, input.state.dataset, packet.rows);
      const current = await tx.metaGet(batchKey(id, index));
      if (!same(current, input.receipt)) fail("验货回执已经变化。");
      for (const row of packet.rows) if (row.store === "snapshot_messages") {
        const key = snapshotCountKey(id, row.value.snapshotId), count = await tx.metaGet(key) ?? 0;
        await tx.metaPut(key, count + 1);
      }
      await tx.metaPut(batchKey(id, index), { ...current, phase: "verified" });
      await save(tx, input.state, { summary, verified: summary.count, verifiedBatch: index, lastStore: DATA_STORES.indexOf(packet.rows.at(-1).store), progressAt: now() });
      return { index, verified: summary.count };
    });
  }
  async function startSeal(id, expected) {
    transferId(id); const manifest = structuredClone(expected);
    return driver.transaction("readwrite", async tx => {
      const state = await locked(tx, id, "target");
      if (["checking", "verified"].includes(state.phase)) {
        if (!same(state.expected, manifest)) fail("最终验收清单已变化。");return state;
      }
      if (state.phase !== "staging" || state.writtenBatch !== state.verifiedBatch || !same(state.summary, manifest)) fail("来源清单或逐批验货尚未完成。");
      return save(tx, state, { phase: "checking", expected: manifest, scanCursor: { ...INITIAL_CURSOR }, scanCounts: Object.fromEntries(DATA_STORES.map(name => [name, 0])) });
    });
  }
  async function sealStep(id, options) {
    transferId(id); const budget = pageBudget(options);
    const input = await driver.transaction("readonly", async tx => {
      const state = await locked(tx, id, "target");
      if (state.phase === "verified") return { state, done: true };
      if (state.phase !== "checking") fail("目标不在最终验收阶段。");
      return { state, page: await tx.page(state.dataset, state.scanCursor, budget) };
    });
    if (input.done) return input.state;
    const rows = [], counts = { ...input.state.scanCounts };
    for (const value of input.page.rows) {
      const key = await recordKey(id, value), ref = await driver.transaction("readonly", tx => tx.metaGet(key));
      if (!ref || !same([ref.store, ref.key], [value.store, value.key])) fail("目标出现未登记的额外记录。");
      const row = { ...value, n: ref.n, digest: ref.digest };
      const checked = await batchPacket(id, 1, [row]);
      if (checked.rows[0].digest !== ref.digest) fail("最终读回摘要不一致。");
      counts[row.store]++; rows.push(row);
    }
    await relations(id, input.state.dataset, rows, true);
    if (input.page.done && !countsEqual(counts, input.state.summary.counts)) fail("目标记录缺失或各类型数量不一致。");
    return driver.transaction("readwrite", async tx => {
      await unchanged(tx, input.state); await requireRows(tx, input.state.dataset, rows);
      return save(tx, input.state, { scanCursor: input.page.cursor, scanCounts: counts,
        phase: input.page.done ? "verified" : "checking", ...(input.page.done ? { manifest: input.state.expected } : {}), progressAt: now() });
    });
  }
  return Object.freeze({ begin, status, prepareStep, sourceNext, append, verifyBatch, startSeal, sealStep });
}
