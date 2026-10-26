export const DB_NAME = "boxed-lllllabc";
export const DB_VERSION = 5;

export const STORES = {
  chatMeta: "chat_meta",
  recentMessages: "recent_messages",
  pendingChanges: "pending_changes",
  fullMessages: "full_messages",
  historicalChanges: "historical_changes",
};

export const INDEXES = {
  recentByChat: "by_chat",
  pendingByChat: "by_chat",
  fullByChat: "by_chat",
  historicalByChat: "by_chat",
};
