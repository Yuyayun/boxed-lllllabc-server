export function batchData() {
  const chatMeta = [
    { chatKey: "character:a.png:one", chatType: "character", characterAvatar: "a.png", characterName: "角色甲", chatDisplayName: "聊天一", fullBackupState: "active" },
    { chatKey: "character:a.png:two", chatType: "character", characterAvatar: "a.png", characterName: "角色甲", chatDisplayName: "聊天二", fullBackupState: "frozen", fullBackupIncident: { reason: "test" } },
    { chatKey: "group:7:three", chatType: "group", groupId: "7", groupName: "测试群", chatDisplayName: "聊天三", fullBackupState: "awaiting-confirmation" },
  ];
  const recentMessages = [], fullMessages = [], historicalChanges = [], pendingChanges = [];
  for (const { chatKey } of chatMeta) {
    const record = { chatKey, messageIndex: 0, raw: { mes: "保留原文", swipes: ["甲", "乙"], swipe_id: 1 }, backedUpAt: "2026-10-26T00:00:00Z" };
    recentMessages.push(record, { ...record, messageIndex: 1 }); fullMessages.push(record);
    historicalChanges.push({ ...record, updatedAt: "2026-10-26T00:00:00Z" });
    pendingChanges.push({ id: `${chatKey}:0`, chatKey, messageIndex: 0, canonicalHash: "pending", raw: { mes: "尚未保存" } });
  }
  return { chatMeta, recentMessages, fullMessages, historicalChanges, pendingChanges };
}
export async function seedBatchData(session, data = batchData()) {
  for (const meta of data.chatMeta) {
    await session.replaceRecentSnapshot({ meta, messages: data.recentMessages.filter(row => row.chatKey === meta.chatKey) });
    await session.replaceFullSnapshot({ chatKey: meta.chatKey, meta, messages: data.fullMessages.filter(row => row.chatKey === meta.chatKey) });
    // The real writer preserves the protection fields supplied in meta.
    await session.updateChatMetaSummary(meta.chatKey, meta);
  }
  await session.putHistoricalChanges(data.historicalChanges); await session.putPendingChanges(data.pendingChanges);
}
