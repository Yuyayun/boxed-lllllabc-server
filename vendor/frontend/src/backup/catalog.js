import { fingerprintBackupRecords } from "./cleanup.js";

export function buildBackupCatalog({
  chatMeta = [],
  recentMessages = [],
  pendingChanges = [],
  fullMessages = [],
  historicalChanges = [],
  healthIssues = [],
} = {}) {
  const entries = new Map();
  const ensureEntry = (chatKey) => {
    const safeKey = String(chatKey ?? "");
    if (!safeKey) {
      return null;
    }
    if (!entries.has(safeKey)) {
      entries.set(safeKey, createEmptyEntry(safeKey));
    }
    return entries.get(safeKey);
  };

  for (const meta of safeArray(chatMeta)) {
    const entry = ensureEntry(meta?.chatKey);
    if (!entry) continue;
    entry.meta = meta;
    entry.storageBytes += estimateSerializedBytes(meta);
    collectUpdatedAt(entry, meta?.lastSeenAt, meta?.lastBackupAt, meta?.fullBackupAt,
      meta?.historicalUpdatedAt, meta?.lastBackendCheckedAt);
  }

  addRecords(entries, recentMessages, "recent", (record) => record?.backedUpAt);
  addRecords(entries, pendingChanges, "pending", (record) => record?.updatedAt);
  addRecords(entries, fullMessages, "full", (record) => record?.backedUpAt);
  addRecords(entries, historicalChanges, "historical", (record) => record?.updatedAt);

  const chats = [...entries.values()]
    .map(finishEntry)
    .filter((entry) => entry.recordCount > 0)
    .sort(compareEntries);
  return {
    chats,
    groups: groupCatalogChats(chats),
    chatCount: chats.length,
    recordCount: chats.reduce((sum, entry) => sum + entry.recordCount, 0),
    storageBytes: chats.reduce((sum, entry) => sum + entry.storageBytes, 0),
    pendingChatCount: chats.filter((entry) => entry.pending.count > 0).length,
    frozenChatCount: chats.filter((entry) => entry.isFrozen).length,
    invalidRecordCount: safeArray(healthIssues)
      .reduce((sum, issue) => sum + Math.max(0, Number(issue?.invalidCount) || 0), 0),
  };
}

export function groupCatalogChats(chats = []) {
  const groups = new Map();
  for (const chat of safeArray(chats)) {
    const ownerKey = String(chat?.ownerKey || "other");
    if (!groups.has(ownerKey)) {
      groups.set(ownerKey, {
        ownerKey,
        ownerName: visibleOwnerName(chat),
        ownerTypeLabel: chat?.ownerTypeLabel || "其他",
        chats: [],
        chatCount: 0,
        recordCount: 0,
        storageBytes: 0,
        pendingChatCount: 0,
        lastUpdatedAt: "",
      });
    }
    const group = groups.get(ownerKey);
    group.chats.push(chat);
    group.chatCount += 1;
    group.recordCount += Math.max(0, Number(chat?.recordCount) || 0);
    group.storageBytes += Math.max(0, Number(chat?.storageBytes) || 0);
    if (chat?.pending?.count > 0) group.pendingChatCount += 1;
    if (isNewer(chat?.lastUpdatedAt, group.lastUpdatedAt)) {
      group.lastUpdatedAt = chat.lastUpdatedAt;
    }
  }
  return [...groups.values()].sort(compareOwnerGroups);
}

export function estimateSerializedBytes(value) {
  let json;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return 0;
  }
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(json).byteLength;
  }
  let bytes = 0;
  for (const character of json) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function formatStorageSize(bytes) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;
  if (safeBytes < 1024 ** 2) return `${formatNumber(safeBytes / 1024)} KB`;
  if (safeBytes < 1024 ** 3) return `${formatNumber(safeBytes / 1024 ** 2)} MB`;
  return `${formatNumber(safeBytes / 1024 ** 3)} GB`;
}

function addRecords(entries, records, type, readUpdatedAt) {
  for (const record of safeArray(records)) {
    const chatKey = record?.chatKey;
    if (!chatKey) continue;
    if (!entries.has(String(chatKey))) {
      entries.set(String(chatKey), createEmptyEntry(String(chatKey)));
    }
    const entry = entries.get(String(chatKey));
    entry[type].records.push(record);
    entry.storageBytes += estimateSerializedBytes(record);
    collectUpdatedAt(entry, readUpdatedAt(record));
  }
}

function createEmptyEntry(chatKey) {
  return {
    chatKey,
    meta: null,
    recent: { records: [] },
    pending: { records: [] },
    full: { records: [] },
    historical: { records: [] },
    storageBytes: 0,
    lastUpdatedAt: "",
  };
}

function finishEntry(entry) {
  const meta = entry.meta ?? {};
  const recent = summarizeRecords(entry.recent.records);
  const pending = summarizeRecords(entry.pending.records, true);
  const full = summarizeRecords(entry.full.records);
  const historical = summarizeRecords(entry.historical.records);
  const recordCount = recent.count + pending.count + full.count + historical.count;
  const owner = ownerIdentity(meta);
  return {
    chatKey: entry.chatKey,
    displayName: visibleChatName(meta),
    ownerName: String(meta.groupName || meta.characterName || "").trim(),
    ownerKey: owner.key,
    cleanupMetaFingerprint: fingerprintBackupRecords(entry.meta ? [entry.meta] : []),
    ownerTypeLabel: owner.typeLabel,
    typeLabel: meta.chatType === "group" ? "群聊" : meta.chatType === "character" ? "角色聊天" : "聊天",
    lastUpdatedAt: entry.lastUpdatedAt,
    storageBytes: entry.storageBytes,
    recordCount,
    recent,
    pending,
    full,
    historical,
    isFrozen: meta.fullBackupState === "frozen",
    isAwaitingConfirmation: meta.fullBackupState === "awaiting-confirmation",
  };
}

function ownerIdentity(meta) {
  if (meta.chatType === "group") {
    const marker = String(meta.groupId || meta.groupName || "").trim();
    return { key: marker ? `group:${marker}` : "group:unknown", typeLabel: "群聊" };
  }
  if (meta.chatType === "character") {
    const marker = String(meta.characterAvatar || meta.characterName || "").trim();
    return { key: marker ? `character:${marker}` : "character:unknown", typeLabel: "角色" };
  }
  return { key: "other", typeLabel: "其他" };
}

function visibleOwnerName(chat) {
  const name = String(chat?.ownerName || "").trim();
  if (name) return name;
  if (chat?.ownerTypeLabel === "群聊") return "未命名群聊";
  if (chat?.ownerTypeLabel === "角色") return "未识别角色";
  return "其他聊天";
}

function summarizeRecords(records, allowStructural = false) {
  const indexes = records
    .map((record) => record?.messageIndex)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  return {
    count: records.length,
    firstIndex: indexes[0] ?? null,
    lastIndex: indexes.at(-1) ?? null,
    hasStructural: allowStructural && records.some((record) => !Number.isInteger(record?.messageIndex)),
    storageBytes: records.reduce((sum, record) => sum + estimateSerializedBytes(record), 0),
    fingerprint: fingerprintBackupRecords(records),
  };
}

function visibleChatName(meta) {
  const name = meta.chatDisplayName || meta.chatFile || meta.chatId;
  if (!name) return "未命名聊天";
  return String(name).replace(/\.jsonl$/i, "").trim() || "未命名聊天";
}

function collectUpdatedAt(entry, ...values) {
  for (const value of values) {
    const time = new Date(value ?? "").getTime();
    if (!Number.isFinite(time)) continue;
    if (!entry.lastUpdatedAt || time > new Date(entry.lastUpdatedAt).getTime()) {
      entry.lastUpdatedAt = new Date(time).toISOString();
    }
  }
}

function compareEntries(a, b) {
  const timeDifference = new Date(b.lastUpdatedAt || 0).getTime() - new Date(a.lastUpdatedAt || 0).getTime();
  return timeDifference || a.displayName.localeCompare(b.displayName, "zh-CN");
}

function compareOwnerGroups(a, b) {
  const timeDifference = new Date(b.lastUpdatedAt || 0).getTime() - new Date(a.lastUpdatedAt || 0).getTime();
  return timeDifference || a.ownerName.localeCompare(b.ownerName, "zh-CN");
}

function isNewer(candidate, current) {
  const candidateTime = new Date(candidate || 0).getTime();
  const currentTime = new Date(current || 0).getTime();
  return Number.isFinite(candidateTime) && candidateTime > currentTime;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
