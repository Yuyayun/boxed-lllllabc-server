import { createBackupCleanupPlan } from "./cleanup.js";

export const BATCH_CLEANUP_RANGES = Object.freeze(["all", "owner", "owner-selected", "cross-selected"]);
export const BATCH_CLEANUP_TYPES = Object.freeze(["recent", "full", "historical", "pending"]);

function normalizeSelection(selection = {}) {
  const { range, ownerKey = "", chatKeys = [], types = ["recent", "full", "historical"] } = selection;
  if (!BATCH_CLEANUP_RANGES.includes(range) || typeof ownerKey !== "string"
    || !Array.isArray(chatKeys) || chatKeys.some(key => typeof key !== "string" || !key)
    || !Array.isArray(types) || !types.length || types.some(type => !BATCH_CLEANUP_TYPES.includes(type))) {
    throw new Error("批量清理选择无效，请重新选择范围与普通备份类型。");
  }
  if (["owner", "owner-selected"].includes(range) && !ownerKey) throw new Error("请先选择角色或群聊。");
  if (range.endsWith("selected") && !chatKeys.length) throw new Error("请先勾选要清理的聊天。");
  return { range, ownerKey: range.startsWith("owner") ? ownerKey : "",
    chatKeys: range.endsWith("selected") ? [...new Set(chatKeys)].sort() : [],
    types: BATCH_CLEANUP_TYPES.filter(type => types.includes(type)) };
}
function chooseChats(catalog, selection) {
  const chats = catalog.chats ?? [];
  let chosen = chats;
  if (selection.range.startsWith("owner")) chosen = chosen.filter(chat => chat.ownerKey === selection.ownerKey);
  if (selection.range.endsWith("selected")) {
    const keys = new Set(selection.chatKeys);
    chosen = chosen.filter(chat => keys.has(chat.chatKey));
    if (chosen.length !== keys.size) throw new Error("批量清理目标聊天或所属角色已经变化，请重新预览。");
  }
  return [...chosen].sort((a, b) => a.chatKey < b.chatKey ? -1 : a.chatKey > b.chatKey ? 1 : 0);
}
export function createBatchCleanupPlan({ catalog = {}, selection, mode } = {}) {
  if (!["indexeddb", "sqlite"].includes(mode)) throw new Error("无法确认当前备份位置，未建立清理计划。");
  const selected = normalizeSelection(selection), chats = chooseChats(catalog, selected);
  const actions = [], skipped = [];
  for (const chat of chats) {
    for (const type of BATCH_CLEANUP_TYPES) {
      if (!selected.types.includes(type) && type !== "pending") continue;
      const plan = createBackupCleanupPlan({ chat, type });
      if (!plan.count) continue;
      (plan.canConfirm ? actions : skipped).push(plan);
    }
  }
  const guards = chats.map(chat => ({ chatKey: chat.chatKey, ownerKey: chat.ownerKey,
    metaFingerprint: chat.cleanupMetaFingerprint,
    isFrozen: Boolean(chat.isFrozen), isAwaitingConfirmation: Boolean(chat.isAwaitingConfirmation),
    records: BATCH_CLEANUP_TYPES.map(type => ({ type, count: chat[type].count, fingerprint: chat[type].fingerprint })) }));
  const blockedReason = catalog.invalidRecordCount ? `存在 ${catalog.invalidRecordCount} 条异常普通备份记录，不能确认完整清理范围，请先检查。`
    : !chats.length ? "当前范围没有普通备份聊天。" : !actions.length ? "当前范围没有规则允许清理的记录；受保护内容仍会保留。" : "";
  return { version: 1, mode, selection: selected, guards, actions, skipped, chatCount: chats.length,
    recordCount: actions.reduce((sum, plan) => sum + plan.count, 0),
    storageBytes: actions.reduce((sum, plan) => sum + plan.storageBytes, 0),
    protectedRecords: skipped.reduce((sum, plan) => sum + plan.count, 0),
    blockedReason, canConfirm: !blockedReason };
}
export function validateBatchCleanupPlan({ plan, catalog, mode }) {
  if (!plan || plan.version !== 1 || plan.mode !== mode || !Array.isArray(plan.guards) || !Array.isArray(plan.actions)) throw staleError("批量清理计划或当前备份位置已变化，请重新预览。");
  let fresh;
  try { fresh = createBatchCleanupPlan({ catalog, selection: plan.selection, mode }); }
  catch (error) { throw staleError(error.message); }
  const actionKeys = actions => actions.map(({ chatKey, type, expectedFingerprint }) => ({ chatKey, type, expectedFingerprint }));
  if (!fresh.canConfirm || JSON.stringify(fresh.guards) !== JSON.stringify(plan.guards)
    || JSON.stringify(actionKeys(fresh.actions)) !== JSON.stringify(actionKeys(plan.actions))) {
    throw staleError(fresh.blockedReason || "批量清理范围、数据或保护状态在预览后变化，请重新预览。");
  }
  return fresh;
}
function staleError(message) { return Object.assign(new Error(message), { code: "stale-cleanup-plan", status: 409 }); }
