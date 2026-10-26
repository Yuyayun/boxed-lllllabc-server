export const CANONICAL_HASH_VERSION = 2;

export function canonicalizeMessage(message, messageIndex, backedUpAt = new Date().toISOString()) {
  const swipes = extractSwipes(message);
  const currentSwipe = getCurrentSwipeIndex(message, swipes);
  const text = getMessageText(message, swipes, currentSwipe);
  const warnings = [];

  if (!Array.isArray(message?.swipes)) {
    warnings.push("swipes_missing");
  }

  if (swipes.length === 0) {
    warnings.push("empty_message");
  }

  return {
    messageIndex,
    messageId: firstDefined(message?.id, message?.mesid, message?.extra?.id, `${messageIndex}`),
    role: inferRole(message),
    name: firstDefined(message?.name, ""),
    isUser: Boolean(message?.is_user),
    isSystem: Boolean(message?.is_system),
    sendDate: firstDefined(message?.send_date, message?.sendDate, message?.extra?.send_date, ""),
    text,
    swipes,
    swipeIndex: currentSwipe,
    normalized: {
      warnings,
      swipeCount: swipes.length,
      hasAllKnownSwipes: Array.isArray(message?.swipes),
      sourceKeys: Object.keys(message ?? {}).sort(),
    },
    raw: structuredCloneSafe(message),
    hashVersion: CANONICAL_HASH_VERSION,
    canonicalHash: hashCanonicalMessage(message),
    backedUpAt,
  };
}

export function canonicalizeRecentMessages(messages, limit, backedUpAt = new Date().toISOString()) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 1);
  const start = Math.max(0, safeMessages.length - safeLimit);

  return safeMessages
    .slice(start)
    .map((message, offset) => canonicalizeMessage(message, start + offset, backedUpAt));
}

export function extractSwipes(message) {
  if (!message || typeof message !== "object") {
    return [];
  }

  if (Array.isArray(message.swipes) && message.swipes.length > 0) {
    return message.swipes.map((swipe, index) => normalizeSwipe(swipe, index));
  }

  const text = firstDefined(message.mes, message.text, message.content, "");
  return text === "" ? [] : [normalizeSwipe(text, 0)];
}

export function canonicalizeComparableMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const comparable = {};
  const persistentKeys = [
    "mes",
    "swipes",
    "swipe_info",
    "swipe_id",
    "reasoning",
    "reasoning_details",
    "extra",
    "name",
    "is_user",
    "is_system",
    "send_date",
    "gen_started",
    "gen_finished",
    "force_avatar",
    "avatar",
  ];

  for (const key of persistentKeys) {
    if (message[key] !== undefined) {
      comparable[key] = structuredCloneSafe(message[key]);
    }
  }

  return sortDeep(comparable);
}

export function hashCanonicalMessage(message) {
  const comparable = canonicalizeComparableMessage(message);
  return hashString(stableStringify(comparable));
}

export function hashCanonicalChat(messages) {
  const comparable = (Array.isArray(messages) ? messages : [])
    .map((message) => canonicalizeComparableMessage(message));
  return hashString(stableStringify(comparable));
}

export function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

export function stripChatHeader(chatMessages) {
  const messages = Array.isArray(chatMessages) ? chatMessages : [];
  if (!messages.length) {
    return [];
  }

  const first = messages[0];
  if (first && typeof first === "object" && first.chat_metadata) {
    return messages.slice(1);
  }

  return messages;
}

function normalizeSwipe(swipe, index) {
  if (swipe && typeof swipe === "object") {
    return {
      index,
      text: String(firstDefined(swipe.mes, swipe.text, swipe.content, "")),
      raw: structuredCloneSafe(swipe),
    };
  }

  return {
    index,
    text: String(firstDefined(swipe, "")),
    raw: swipe,
  };
}

function getCurrentSwipeIndex(message, swipes) {
  const swipeId = Number.parseInt(firstDefined(message?.swipe_id, message?.swipeId, 0), 10);
  if (Number.isInteger(swipeId) && swipeId >= 0 && swipeId < swipes.length) {
    return swipeId;
  }

  return 0;
}

function getMessageText(message, swipes, swipeIndex) {
  const directText = firstDefined(message?.mes, message?.text, message?.content);
  if (directText !== undefined) {
    return String(directText);
  }

  return swipes[swipeIndex]?.text ?? "";
}

function inferRole(message) {
  if (message?.is_system) {
    return "system";
  }

  if (message?.is_user) {
    return "user";
  }

  return "character";
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }

  return JSON.parse(JSON.stringify(value));
}

function sortDeep(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortDeep(value[key]);
      return result;
    }, {});
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
