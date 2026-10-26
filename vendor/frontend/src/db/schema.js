export const DB_NAME = "boxed-lllllabc";
export const DB_VERSION = 7;

export const TRANSFER_STORES = Object.freeze({ meta: "__boxed_transfer_meta", rows: "__boxed_transfer_rows" });

export const STORES = {
  chatMeta: "chat_meta",
  recentMessages: "recent_messages",
  pendingChanges: "pending_changes",
  fullMessages: "full_messages",
  historicalChanges: "historical_changes",
  snapshots: "snapshots",
  snapshotMessages: "snapshot_messages",
};

export const INDEXES = {
  recentByChat: "by_chat",
  pendingByChat: "by_chat",
  fullByChat: "by_chat",
  historicalByChat: "by_chat",
};
