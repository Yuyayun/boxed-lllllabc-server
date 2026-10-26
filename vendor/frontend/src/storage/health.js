const STORE_RULES = Object.freeze({
  chatMeta: (record) => hasChatKey(record),
  recentMessages: (record) => hasMessageIndex(record),
  pendingChanges: (record) => hasChatKey(record)
    && typeof record.id === "string"
    && record.id.length > 0
    && (record.messageIndex === null || isNonNegativeInteger(record.messageIndex)),
  fullMessages: (record) => hasMessageIndex(record),
  historicalChanges: (record) => hasMessageIndex(record),
});

export function inspectBackupCatalogData(data = {}) {
  const result = {};
  const healthIssues = [];
  for (const [storeName, validator] of Object.entries(STORE_RULES)) {
    const records = Array.isArray(data[storeName]) ? data[storeName] : [];
    const valid = [];
    let invalidCount = 0;
    for (const record of records) {
      if (isPlainRecord(record) && validator(record)) valid.push(record);
      else invalidCount += 1;
    }
    result[storeName] = valid;
    if (invalidCount) {
      healthIssues.push({ storeName, invalidCount, reason: "记录缺少必要身份或楼层信息。" });
    }
  }
  return { ...result, healthIssues };
}

export function filterValidStoreRecords(records, storeName) {
  const validator = STORE_RULES[storeName];
  if (!validator) return Array.isArray(records) ? records : [];
  return (Array.isArray(records) ? records : [])
    .filter((record) => isPlainRecord(record) && validator(record));
}

export function describeStorageFailure(error) {
  if (isQuotaExceededError(error)) {
    return {
      type: "quota",
      shortText: "本地空间不足，备份未写入",
      detail: "浏览器报告本地存储空间不足。本次备份没有写入成功，已有备份没有被自动删除。",
    };
  }
  return {
    type: "database",
    shortText: "本地备份数据库不可用",
    detail: error?.message || "浏览器本地备份数据库暂时无法读写。",
  };
}

export function isQuotaExceededError(error) {
  const name = String(error?.name || error?.errorName || "");
  const message = String(error?.message || error?.detail || "");
  return name === "QuotaExceededError" || /QuotaExceeded|quota.*exceed|空间不足|配额/i.test(message);
}

function hasChatKey(record) {
  return typeof record?.chatKey === "string" && record.chatKey.length > 0;
}

function hasMessageIndex(record) {
  return hasChatKey(record) && isNonNegativeInteger(record.messageIndex);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
