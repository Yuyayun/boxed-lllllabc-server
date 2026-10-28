import { DATA_STORES, TRANSFER_PAGE_BYTES, validateTransferRow, inspectTransferRow } from "./transfer-format.js";
import { sha256, stableText } from "./value-digest.js";

export const BATCH_RECORD_LIMIT = 100;
export const INITIAL_CURSOR = Object.freeze({ store: 0, after: null });
const fail = message => { throw Object.assign(new Error(message), { code: "transfer-conflict" }); };

export function pageBudget(options = {}) {
  const limit = options.limit ?? BATCH_RECORD_LIMIT;
  const bytes = options.bytes ?? TRANSFER_PAGE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BATCH_RECORD_LIMIT
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > TRANSFER_PAGE_BYTES) fail("迁移分页预算无效。");
  return { limit, bytes };
}

export function validateCursor(cursor) {
  if (!cursor || !Number.isSafeInteger(cursor.store) || cursor.store < 0 || cursor.store > DATA_STORES.length
      || !Object.hasOwn(cursor, "after")) fail("迁移分页位置无效。");
  return cursor;
}

export async function initialSummary() {
  return { version: 2, stores: [...DATA_STORES], counts: Object.fromEntries(DATA_STORES.map(name => [name, 0])), count: 0, bytes: 0, digest: await sha256("") };
}

export function same(left, right) { return stableText(left) === stableText(right); }
export const batchKey = (id, index) => `batch:${id}:${String(index).padStart(12, "0")}`;
export const recordKey = async (id, row) => `record:${id}:${await sha256(stableText([row.store, row.key]))}`;
export const snapshotCountKey = (id, snapshotId) => `snapshot-count:${id}:${snapshotId}`;
export const rowRef = row => ({ n: row.n, store: row.store, key: row.key, digest: row.digest });

export async function batchPacket(id, index, inputRows) {
  if (!Number.isSafeInteger(index) || index < 1 || !Array.isArray(inputRows) || !inputRows.length || inputRows.length > BATCH_RECORD_LIMIT) fail("迁移批次无效。");
  // Isolate the input before the first await; a caller cannot change records
  // after their hash was checked and before the transaction writes them.
  const rows = structuredClone(inputRows);
  let bytes = 0, previous = rows[0].n - 1, store = -1;
  for (const row of rows) {
    let inspected;
    try { inspected = inspectTransferRow(row); } catch (cause) { fail(cause.message); }
    bytes += inspected.bytes;
    if (row.n !== previous + 1 || DATA_STORES.indexOf(row.store) < store) fail("批次序号或仓库顺序不连续。");
    const digest = await sha256(inspected.text);
    if (row.digest && digest !== row.digest) fail("迁移批次内容摘要不一致。");
    row.digest = digest; previous = row.n; store = DATA_STORES.indexOf(row.store);
  }
  // One pre-existing record may exceed the soft page budget, but never the
  // existing 8 MiB per-record limit enforced by validateTransferRow.
  if (rows.length > 1 && bytes > TRANSFER_PAGE_BYTES) fail("迁移批次超过字节上限。");
  const refs = rows.map(rowRef);
  return { id, index, first: rows[0].n, last: rows.at(-1).n, bytes,
    fingerprint: await sha256(stableText([id, index, refs])), rows };
}

export async function advanceSummary(summary, rows, validatedBytes) {
  const next = structuredClone(summary);
  if (validatedBytes !== undefined && (!Number.isSafeInteger(validatedBytes) || validatedBytes < 0)) fail("批次字节统计无效。");
  for (const row of rows) {
    if (row.n !== next.count + 1) fail("迁移累计序号不连续。");
    next.count++; next.counts[row.store]++;
    if (validatedBytes === undefined) next.bytes += validateTransferRow(row);
    next.digest = await sha256(next.digest + row.digest);
  }
  if (validatedBytes !== undefined) next.bytes += validatedBytes;
  return next;
}
