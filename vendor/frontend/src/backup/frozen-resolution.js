import { hashCanonicalChat } from "./canonicalize.js";
import { buildCleanupMetaPatch, fingerprintBackupRecords } from "./cleanup.js";

export const FROZEN_FULL_BACKUP_ACTIONS = {
  adoptCurrent: "adopt-current",
  deleteFrozen: "delete-frozen",
};

export function createFrozenFullBackupResolutionPlan({
  current,
  meta,
  fullMessages = [],
} = {}) {
  if (!current?.ok || !current.identity?.chatKey) {
    return invalid(current?.reason || "无法识别当前聊天，不能处理冻结状态。");
  }
  if (meta?.fullBackupState !== "frozen") {
    return invalid("完整聊天备份已不再处于冻结状态，请刷新后重新检查。");
  }

  const messages = Array.isArray(fullMessages) ? fullMessages : [];
  if (!messages.length) {
    return invalid("冻结的完整备份已经不存在，请刷新后重新检查。");
  }

  const currentChat = Array.isArray(current.chat) ? current.chat : [];
  const chatName = visibleChatName(meta, current.identity.meta);
  return {
    ok: true,
    reason: "",
    plan: {
      chatKey: current.identity.chatKey,
      chatName,
      backupCount: messages.length,
      backupRange: formatRange(messages),
      currentCount: currentChat.length,
      currentRange: formatCurrentRange(currentChat.length),
      detectedAt: meta.fullBackupIncident?.detectedAt ?? null,
      incidentText: describeIncident(meta.fullBackupIncident),
      expectedFullFingerprint: fingerprintBackupRecords(messages),
      expectedIncidentFingerprint: fingerprintBackupRecords([meta.fullBackupIncident ?? null]),
      expectedCurrentChatHash: hashCanonicalChat(currentChat),
    },
  };
}

export function validateFrozenFullBackupResolution({
  plan,
  action,
  current,
  meta,
  fullMessages = [],
} = {}) {
  if (!Object.values(FROZEN_FULL_BACKUP_ACTIONS).includes(action)) {
    return invalid("无法识别要执行的冻结备份处理方式。");
  }
  if (!plan?.chatKey || !current?.ok || current.identity?.chatKey !== plan.chatKey) {
    return invalid("当前聊天已经变化，请关闭后在对应聊天中重新确认。");
  }
  if (hashCanonicalChat(current.chat) !== plan.expectedCurrentChatHash) {
    return invalid("当前聊天内容在确认期间发生了变化，请重新检查后再处理。");
  }
  if (meta?.fullBackupState !== "frozen") {
    return invalid("完整聊天备份状态已经变化，请刷新后重新检查。");
  }
  if (fingerprintBackupRecords(fullMessages) !== plan.expectedFullFingerprint) {
    return invalid("冻结的完整备份在确认期间发生了变化，请重新检查。");
  }
  if (fingerprintBackupRecords([meta.fullBackupIncident ?? null]) !== plan.expectedIncidentFingerprint) {
    return invalid("冻结原因在确认期间发生了变化，请重新检查。");
  }
  return { ok: true, reason: "" };
}

export function buildResolvedFullBackupMeta({
  action,
  currentMeta,
  identityMeta,
  messages = [],
  now = new Date().toISOString(),
} = {}) {
  const base = {
    ...(currentMeta ?? {}),
    ...(identityMeta ?? {}),
    chatKey: identityMeta?.chatKey ?? currentMeta?.chatKey,
  };

  if (action === FROZEN_FULL_BACKUP_ACTIONS.deleteFrozen) {
    return {
      ...base,
      ...buildCleanupMetaPatch("full"),
      fullBackupLastReason: "user-confirmed-frozen-delete",
    };
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  return {
    ...base,
    fullBackupAt: now,
    fullBackupMessageCount: safeMessages.length,
    fullBackupFirstIndex: safeMessages[0]?.messageIndex ?? null,
    fullBackupLastIndex: safeMessages.at(-1)?.messageIndex ?? null,
    fullBackupLastReason: "user-confirmed-current-chat",
    fullBackupState: "active",
    fullBackupIncident: null,
    fullBackupPendingMessageCount: null,
  };
}

function describeIncident(incident = {}) {
  if (incident?.kind === "unexpected-shorter-chat") {
    return "扩展曾检测到当前聊天在没有明确删除事件的情况下比完整备份更短。";
  }
  if (incident?.kind === "unexpected-message-change") {
    return "扩展曾检测到已有楼层内容发生了尚未确认的变化。";
  }
  return "扩展曾检测到可能影响完整备份安全的异常变化。";
}

function visibleChatName(meta = {}, identityMeta = {}) {
  const value = meta.chatDisplayName
    || meta.chatFile
    || meta.chatId
    || identityMeta.chatDisplayName
    || identityMeta.chatFile
    || identityMeta.chatId;
  return String(value || "当前聊天").replace(/\.jsonl$/i, "").trim() || "当前聊天";
}

function formatRange(messages) {
  const indexes = messages.map((message) => message?.messageIndex).filter(Number.isInteger);
  if (!indexes.length) {
    return `${messages.length} 条记录`;
  }
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  return first === last ? `第 ${first} 层` : `第 ${first}－${last} 层`;
}

function formatCurrentRange(count) {
  if (!count) {
    return "当前为空";
  }
  return count === 1 ? "第 0 层" : `第 0－${count - 1} 层`;
}

function invalid(reason) {
  return { ok: false, reason, plan: null };
}
