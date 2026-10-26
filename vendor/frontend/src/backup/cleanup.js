const CLEANUP_TYPES = ["recent", "full", "historical", "pending"];

const TYPE_LABELS = {
  recent: "最近楼层备份",
  full: "完整聊天备份",
  historical: "历史楼层改动备份",
  pending: "未保存变更",
};

export function createBackupCleanupPlans(chat) {
  return CLEANUP_TYPES.map((type) => createBackupCleanupPlan({ chat, type }));
}

export function createBackupCleanupPlan({ chat, type } = {}) {
  const safeChat = chat ?? {};
  const summary = safeChat[type] ?? emptySummary();
  const blockedReason = getCleanupBlockedReason({ chat: safeChat, type, summary });
  return {
    chatKey: String(safeChat.chatKey ?? ""),
    chatName: String(safeChat.displayName || "未命名聊天"),
    ownerName: String(safeChat.ownerName || ""),
    type,
    typeLabel: TYPE_LABELS[type] || "未知备份",
    count: Number(summary.count) || 0,
    rangeText: formatCleanupRange(summary),
    storageBytes: Math.max(0, Number(summary.storageBytes) || 0),
    expectedFingerprint: String(summary.fingerprint || fingerprintBackupRecords([])),
    blockedReason,
    canConfirm: !blockedReason,
    notice: "只删除扩展保存在当前浏览器中的这一类备份，不会删除或修改 SillyTavern 聊天文件，也不会更改备份开关。",
  };
}

export function validateBackupCleanupPlan({ plan, chat } = {}) {
  if (!plan?.chatKey || plan.chatKey !== chat?.chatKey) {
    return invalid("目标聊天已经变化，请关闭后重新预览。");
  }

  const current = createBackupCleanupPlan({ chat, type: plan.type });
  if (current.blockedReason) {
    return invalid(current.blockedReason);
  }
  if (current.expectedFingerprint !== plan.expectedFingerprint) {
    return invalid("这类备份在预览后发生了变化，请重新预览再清理。");
  }
  return { ok: true, reason: "" };
}

export function fingerprintBackupRecords(records = []) {
  const serialized = (Array.isArray(records) ? records : [])
    .map((record) => JSON.stringify(sortStable(record)) ?? "")
    .sort()
    .join("\n");
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${Array.isArray(records) ? records.length : 0}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildCleanupMetaPatch(type) {
  if (type === "recent") {
    return {
      lastBackupAt: null,
      recentCount: 0,
      recentFirstIndex: null,
      recentLastIndex: null,
      lastReason: "catalog-cleanup",
    };
  }
  if (type === "full") {
    return {
      fullBackupAt: null,
      fullBackupMessageCount: 0,
      fullBackupFirstIndex: null,
      fullBackupLastIndex: null,
      fullBackupLastReason: "catalog-cleanup",
      fullBackupState: "empty",
      fullBackupIncident: null,
      fullBackupPendingMessageCount: null,
    };
  }
  if (type === "historical") {
    return { historicalUpdatedAt: null };
  }
  return {};
}

export function isCleanupType(type) {
  return CLEANUP_TYPES.includes(type);
}

function getCleanupBlockedReason({ chat, type, summary }) {
  if (!CLEANUP_TYPES.includes(type)) {
    return "无法识别要清理的备份类型。";
  }
  if (!chat.chatKey) {
    return "缺少聊天身份，不能清理。";
  }
  if (!summary.count) {
    return `当前没有${TYPE_LABELS[type]}可清理。`;
  }
  if (type === "pending") {
    return "未保存变更可能包含尚未写入酒馆后端的内容，当前版本禁止直接清理。";
  }
  if (type === "full" && (chat.isFrozen || chat.isAwaitingConfirmation)) {
    return chat.isFrozen
      ? "完整聊天备份正处于冻结保护状态。请打开对应聊天，在“当前聊天备份”中确认当前内容无误后处理。"
      : "完整聊天备份正在等待后端确认，完成前不能清理。";
  }
  return "";
}

function formatCleanupRange(summary) {
  if (!summary.count) return "当前为空";
  if (!Number.isInteger(summary.firstIndex)) {
    return summary.hasStructural ? "包含结构变更" : "无楼层范围";
  }
  const range = summary.firstIndex === summary.lastIndex
    ? `第 ${summary.firstIndex} 层`
    : `第 ${summary.firstIndex}－${summary.lastIndex} 层`;
  return summary.hasStructural ? `${range} + 结构变更` : range;
}

function emptySummary() {
  return {
    count: 0,
    firstIndex: null,
    lastIndex: null,
    hasStructural: false,
    storageBytes: 0,
    fingerprint: fingerprintBackupRecords([]),
  };
}

function invalid(reason) {
  return { ok: false, reason };
}

function sortStable(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "bigint" ? String(value) : value;
  }
  return Object.keys(value).sort().reduce((result, key) => {
    const item = value[key];
    if (item !== undefined && typeof item !== "function") {
      result[key] = sortStable(item);
    }
    return result;
  }, {});
}
