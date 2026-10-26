export function selectIdentityReconciliationSource({ identity, metas = [] } = {}) {
  const targetKey = String(identity?.chatKey ?? "");
  if (!targetKey) {
    return { status: "invalid" };
  }

  const safeMetas = Array.isArray(metas) ? metas.filter((meta) => meta?.chatKey) : [];
  if (safeMetas.some((meta) => meta.chatKey === targetKey)) {
    return { status: "current", sourceKey: targetKey };
  }

  const candidates = safeMetas.filter((meta) => (
    meta.chatKey !== targetKey
    && sameChatType(meta, identity.meta)
    && sameOwner(meta, identity.meta)
  ));
  const legacyKeys = new Set(Array.isArray(identity.legacyChatKeys) ? identity.legacyChatKeys : []);
  const legacyMatches = candidates.filter((meta) => legacyKeys.has(meta.chatKey));
  if (legacyMatches.length === 1) {
    return { status: "migrate", sourceKey: legacyMatches[0].chatKey, reason: "legacy-key" };
  }
  if (legacyMatches.length > 1) {
    return { status: "ambiguous", reason: "legacy-key" };
  }

  return { status: "new" };
}

export function selectExplicitRenameSource({ rename, metas = [] } = {}) {
  const identity = rename?.identity;
  const targetKey = String(identity?.chatKey ?? "");
  const sourceChatId = normalizeChatMarker(rename?.source?.chatId);
  if (!targetKey || !sourceChatId || !identity?.meta) {
    return { status: "invalid" };
  }

  const safeMetas = Array.isArray(metas) ? metas.filter((meta) => meta?.chatKey) : [];
  const targetExists = safeMetas.some((meta) => meta.chatKey === targetKey);
  const sourceMatches = safeMetas.filter((meta) => (
    meta.chatKey !== targetKey
    && sameChatType(meta, identity.meta)
    && sameOwner(meta, identity.meta)
    && normalizeChatMarker(firstNonEmpty(meta?.chatId, meta?.chatFile)) === sourceChatId
  ));

  if (sourceMatches.length === 1) {
    return {
      status: "migrate",
      sourceKey: sourceMatches[0].chatKey,
      reason: "explicit-rename",
      mergeTarget: targetExists,
    };
  }
  if (sourceMatches.length > 1) {
    return { status: "ambiguous", reason: "explicit-rename" };
  }
  if (targetExists) {
    return { status: "current", sourceKey: targetKey };
  }
  return { status: "source-missing", reason: "explicit-rename" };
}

export function mergeIdentityMeta(previous, identityMeta) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(identityMeta ?? {})) {
    if (value !== "" && value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

export function rekeyBackupRecord(record, targetKey, type) {
  const next = {
    ...record,
    chatKey: targetKey,
  };
  if (type === "pending") {
    const suffix = record.snapshotSaveProof ? "snapshot-restore" : record?.messageIndex === null ? "structural" : record?.messageIndex;
    next.id = `${targetKey}:${suffix}`;
  }
  return next;
}

function sameChatType(left, right) {
  const leftType = String(left?.chatType ?? "");
  const rightType = String(right?.chatType ?? "");
  return !leftType || !rightType || leftType === rightType;
}

function sameOwner(left, right) {
  if (right?.chatType === "group") {
    return sameNonEmptyValue(left?.groupId, right?.groupId);
  }
  return sameNonEmptyValue(left?.characterAvatar, right?.characterAvatar);
}

function sameNonEmptyValue(left, right) {
  const normalizedLeft = String(left ?? "");
  const normalizedRight = String(right ?? "");
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? "") !== "") ?? "";
}

function normalizeChatMarker(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.jsonl$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[:|]/g, "_");
}
