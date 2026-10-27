import { INDEXES, STORES } from "../db/schema.js";
import { buildCleanupMetaPatch, fingerprintBackupRecords } from "../backup/cleanup.js";
import { buildBackupCatalog } from "../backup/catalog.js";
import { validateBatchCleanupPlan } from "../backup/batch-cleanup.js";
import { readCatalogByChat, CATALOG_STORES } from "./catalog-reader.js";
import {
  buildResolvedFullBackupMeta,
  FROZEN_FULL_BACKUP_ACTIONS,
} from "../backup/frozen-resolution.js";
import {
  mergeIdentityMeta,
  rekeyBackupRecord,
  selectExplicitRenameSource,
  selectIdentityReconciliationSource,
} from "../db/identity-reconciliation.js";
import { filterValidStoreRecords, inspectBackupCatalogData } from "../storage/health.js";


// Shared transaction rules; adapters supply the transaction and request drivers.
export function createBackupOperations({ runTransaction, requestToPromise, storageMode = "indexeddb", catalogDriver }) {
  async function replaceRecentSnapshot(db, { meta, messages }) {
    return runTransaction(db, [STORES.chatMeta, STORES.recentMessages], "readwrite", async (stores) => {
      const chatMetaStore = stores.get(STORES.chatMeta);
      const recentStore = stores.get(STORES.recentMessages);

      const previousMeta = await requestToPromise(chatMetaStore.get(meta.chatKey));
      await requestToPromise(chatMetaStore.put(mergeRecentSnapshotMeta(previousMeta, meta)));
      await deleteRecentMessagesForChat(recentStore, meta.chatKey);

      for (const message of messages) {
        await requestToPromise(recentStore.put({
          ...message,
          chatKey: meta.chatKey,
        }));
      }
    });
  }

  function mergeRecentSnapshotMeta(previousMeta, recentMeta) {
    return {
      ...(previousMeta ?? {}),
      ...(recentMeta ?? {}),
      chatKey: recentMeta?.chatKey ?? previousMeta?.chatKey,
    };
  }

  async function putChatMeta(db, meta) {
    return runTransaction(db, [STORES.chatMeta], "readwrite", async (stores) => {
      await requestToPromise(stores.get(STORES.chatMeta).put(meta));
    });
  }

  async function getRecentMessages(db, chatKey) {
    return runTransaction(db, [STORES.recentMessages], "readonly", async (stores) => {
      const store = stores.get(STORES.recentMessages);
      const index = store.index(INDEXES.recentByChat);
      const messages = await requestToPromise(index.getAll(chatKey));
      return filterValidStoreRecords(messages, "recentMessages").sort((a, b) => a.messageIndex - b.messageIndex);
    });
  }

  async function getFullMessages(db, chatKey) {
    return runTransaction(db, [STORES.fullMessages], "readonly", async (stores) => {
      const store = stores.get(STORES.fullMessages);
      const index = store.index(INDEXES.fullByChat);
      const messages = await requestToPromise(index.getAll(chatKey));
      return filterValidStoreRecords(messages, "fullMessages").sort((a, b) => a.messageIndex - b.messageIndex);
    });
  }

  async function getHistoricalChanges(db, chatKey) {
    return runTransaction(db, [STORES.historicalChanges], "readonly", async (stores) => {
      const store = stores.get(STORES.historicalChanges);
      const index = store.index(INDEXES.historicalByChat);
      const records = await requestToPromise(index.getAll(chatKey));
      return filterValidStoreRecords(records, "historicalChanges").sort((a, b) => a.messageIndex - b.messageIndex);
    });
  }

  async function putFullMessages(db, { chatKey, messages, meta }) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    return runTransaction(db, [STORES.chatMeta, STORES.fullMessages], "readwrite", async (stores) => {
      const messageStore = stores.get(STORES.fullMessages);
      for (const message of safeMessages) {
        await requestToPromise(messageStore.put({ ...message, chatKey }));
      }

      if (meta) {
        await requestToPromise(stores.get(STORES.chatMeta).put(meta));
      }
    });
  }

  async function putHistoricalChanges(db, records) {
    const safeRecords = Array.isArray(records) ? records : [];
    if (!safeRecords.length) {
      return;
    }

    return runTransaction(db, [STORES.historicalChanges], "readwrite", async (stores) => {
      const store = stores.get(STORES.historicalChanges);
      for (const record of safeRecords) {
        const key = [record.chatKey, record.messageIndex];
        const previous = await requestToPromise(store.get(key));
        await requestToPromise(store.put({
          ...record,
          firstCapturedAt: previous?.firstCapturedAt ?? record.firstCapturedAt,
        }));
      }
    });
  }

  async function replaceFullSnapshot(db, { chatKey, messages, meta }) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    return runTransaction(db, [STORES.chatMeta, STORES.fullMessages], "readwrite", async (stores) => {
      const messageStore = stores.get(STORES.fullMessages);
      await deleteMessagesForChat(messageStore, INDEXES.fullByChat, chatKey);
      for (const message of safeMessages) {
        await requestToPromise(messageStore.put({ ...message, chatKey }));
      }

      if (meta) {
        await requestToPromise(stores.get(STORES.chatMeta).put(meta));
      }
    });
  }

  async function getChatMeta(db, chatKey) {
    return runTransaction(db, [STORES.chatMeta], "readonly", async (stores) => {
      return requestToPromise(stores.get(STORES.chatMeta).get(chatKey));
    });
  }

  async function getBackupCatalogData(db) {
    const storeNames = [
      STORES.chatMeta,
      STORES.recentMessages,
      STORES.pendingChanges,
      STORES.fullMessages,
      STORES.historicalChanges,
    ];
    return runTransaction(db, storeNames, "readonly", readCatalogStores);
  }

  async function readCatalogStores(stores) {
    const [chatMeta, recentMessages, pendingChanges, fullMessages, historicalChanges] = await Promise.all([
      requestToPromise(stores.get(STORES.chatMeta).getAll()),
      requestToPromise(stores.get(STORES.recentMessages).getAll()),
      requestToPromise(stores.get(STORES.pendingChanges).getAll()),
      requestToPromise(stores.get(STORES.fullMessages).getAll()),
      requestToPromise(stores.get(STORES.historicalChanges).getAll()),
    ]);
    return inspectBackupCatalogData({ chatMeta, recentMessages, pendingChanges, fullMessages, historicalChanges });
  }

  const catalogInTransaction = stores => catalogDriver ? readCatalogByChat(stores, catalogDriver, requestToPromise)
    : readCatalogStores(stores).then(buildBackupCatalog);
  async function getBackupCatalog(db) {
    return runTransaction(db, CATALOG_STORES, "readonly", catalogInTransaction);
  }

  async function reconcileChatIdentity(db, identity) {
    if (!identity?.chatKey || !identity?.meta) {
      throw new Error("无法识别要接续的聊天备份。");
    }

    const storeNames = [
      STORES.snapshots,
      STORES.chatMeta,
      STORES.recentMessages,
      STORES.pendingChanges,
      STORES.fullMessages,
      STORES.historicalChanges,
    ];
    return runTransaction(db, storeNames, "readwrite", async (stores) => {
      const metaStore = stores.get(STORES.chatMeta);
      const metas = await requestToPromise(metaStore.getAll());
      const selection = selectIdentityReconciliationSource({ identity, metas });
      const targetKey = identity.chatKey;

      if (selection.status === "current") {
        const currentMeta = metas.find((meta) => meta.chatKey === targetKey);
        await requestToPromise(metaStore.put({
          ...mergeIdentityMeta(currentMeta, identity.meta),
          chatKey: targetKey,
        }));
        return selection;
      }

      if (selection.status !== "migrate") {
        if (selection.status === "new") {
          await requestToPromise(metaStore.put({
            ...mergeIdentityMeta(null, identity.meta),
            chatKey: targetKey,
          }));
        }
        return selection;
      }

      return migrateIdentityRecords({ stores, metas, identity, selection });
    });
  }

  async function migrateRenamedChatIdentity(db, rename) {
    if (!rename?.identity?.chatKey || !rename?.identity?.meta || !rename?.source?.chatId) {
      throw new Error("无法识别聊天改名事件中的旧、新身份。");
    }

    const storeNames = [
      STORES.snapshots,
      STORES.chatMeta,
      STORES.recentMessages,
      STORES.pendingChanges,
      STORES.fullMessages,
      STORES.historicalChanges,
    ];
    return runTransaction(db, storeNames, "readwrite", async (stores) => {
      const metas = await requestToPromise(stores.get(STORES.chatMeta).getAll());
      const selection = selectExplicitRenameSource({ rename, metas });
      if (selection.status !== "migrate") {
        return selection;
      }
      return migrateIdentityRecords({
        stores,
        metas,
        identity: rename.identity,
        selection,
      });
    });
  }

  async function migrateIdentityRecords({ stores, metas, identity, selection }) {
    const metaStore = stores.get(STORES.chatMeta);
    const sourceKey = selection.sourceKey;
    const targetKey = identity.chatKey;
    const allowTargetMerge = selection.reason === "explicit-rename";
    if (!allowTargetMerge && metas.some((meta) => meta.chatKey === targetKey && meta.chatKey !== sourceKey)) {
      return { status: "conflict", sourceKey, targetKey };
    }

    const configurations = [
      { type: "recent", store: STORES.recentMessages, index: INDEXES.recentByChat },
      { type: "pending", store: STORES.pendingChanges, index: INDEXES.pendingByChat },
      { type: "full", store: STORES.fullMessages, index: INDEXES.fullByChat },
      { type: "historical", store: STORES.historicalChanges, index: INDEXES.historicalByChat },
    ];
    const recordSets = await Promise.all(configurations.map(async (config) => {
      const store = stores.get(config.store);
      const index = store.index(config.index);
      const [sourceRecords, targetRecords] = await Promise.all([
        requestToPromise(index.getAll(sourceKey)),
        requestToPromise(index.getAll(targetKey)),
      ]);
      return { ...config, store, sourceRecords, targetRecords };
    }));

    if (!allowTargetMerge && recordSets.some(({ targetRecords }) => targetRecords.length > 0)) {
      return { status: "conflict", sourceKey, targetKey };
    }

    for (const { type, store, sourceRecords, targetRecords } of recordSets) {
      const migratedRecords = allowTargetMerge
        ? mergeRenamedBackupRecords({ type, sourceRecords, targetRecords, targetKey })
        : sourceRecords.map((record) => rekeyBackupRecord(record, targetKey, type));
      for (const record of migratedRecords) {
        await requestToPromise(store.put(record));
      }
      for (const record of sourceRecords) {
        await requestToPromise(store.delete(primaryKeyForRecord(record, type)));
      }
    }

    const sourceMeta = metas.find((meta) => meta.chatKey === sourceKey);
    // Snapshot IDs and immutable message rows stay unchanged during Rename.
    const snapshots = stores.get(STORES.snapshots);
    for (const header of await requestToPromise(snapshots.index("by_chat").getAll(sourceKey))) {
      await requestToPromise(snapshots.put({ ...header, chatKey: targetKey }));
    }
    const targetMeta = metas.find((meta) => meta.chatKey === targetKey);
    await requestToPromise(metaStore.put({
      ...mergeIdentityMeta(mergeIdentityMeta(sourceMeta, targetMeta), identity.meta),
      chatKey: targetKey,
    }));
    await requestToPromise(metaStore.delete(sourceKey));
    return { ...selection, targetKey };
  }

  function mergeRenamedBackupRecords({ type, sourceRecords, targetRecords, targetKey }) {
    const merged = new Map();
    for (const record of sourceRecords) {
      const migrated = rekeyBackupRecord(record, targetKey, type);
      merged.set(renameRecordKey(migrated, type), migrated);
    }
    for (const record of targetRecords) {
      const target = { ...record, chatKey: targetKey };
      const key = renameRecordKey(target, type);
      merged.set(key, mergeRenameRecord(merged.get(key), target, type));
    }
    return [...merged.values()];
  }

  function mergeRenameRecord(source, target, type) {
    if (!source) {
      return target;
    }
    const preferred = recordTimestamp(source) > recordTimestamp(target) ? source : target;
    if (type === "historical") {
      return {
        ...preferred,
        firstCapturedAt: earliestTimestamp(source.firstCapturedAt, target.firstCapturedAt),
      };
    }
    if (type === "pending") {
      return {
        ...preferred,
        createdAt: earliestTimestamp(source.createdAt, target.createdAt),
      };
    }
    return preferred;
  }

  function renameRecordKey(record, type) {
    return type === "pending" ? String(record?.id ?? "") : String(record?.messageIndex ?? "");
  }

  function recordTimestamp(record) {
    for (const value of [record?.updatedAt, record?.backedUpAt, record?.message?.backedUpAt, record?.createdAt]) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return 0;
  }

  function earliestTimestamp(...values) {
    const valid = values
      .map((value) => ({ value, timestamp: Date.parse(value) }))
      .filter((item) => item.value && Number.isFinite(item.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp);
    return valid[0]?.value ?? values.find(Boolean) ?? "";
  }

  async function deleteBackupTypeForChat(db, {
    chatKey,
    type,
    expectedFingerprint,
  } = {}) {
    const config = cleanupStoreConfig(type);
    if (!chatKey || !config) {
      throw new Error("无法识别要清理的聊天或备份类型。");
    }
    if (!expectedFingerprint) {
      throw new Error("缺少清理预览指纹，请重新预览。");
    }

    return runTransaction(db, [STORES.chatMeta, config.store], "readwrite", async (stores) => {
      return deleteBackupTypeInStores(stores, { chatKey, type, expectedFingerprint });
    });
  }

  async function deleteBackupTypeInStores(stores, { chatKey, type, expectedFingerprint }) {
    const config = cleanupStoreConfig(type);
    if (!config) throw new Error("无法识别要清理的聊天或备份类型。");
    const recordStore = stores.get(config.store);
    const index = recordStore.index(config.index);
    const records = await requestToPromise(index.getAll(chatKey));
    if (fingerprintBackupRecords(records) !== expectedFingerprint) {
      throw new Error("这类备份在预览后发生了变化，请重新预览再清理。");
    }

    const metaStore = stores.get(STORES.chatMeta);
    const meta = await requestToPromise(metaStore.get(chatKey));
    if (type === "full" && ["frozen", "awaiting-confirmation"].includes(meta?.fullBackupState)) {
      throw new Error(meta.fullBackupState === "frozen"
        ? "完整备份已暂停更新并保留，不能清理。"
        : "完整备份正在等待酒馆保存确认，不能清理。");
    }

    const keys = await requestToPromise(index.getAllKeys(chatKey));
    for (const key of keys) {
      await requestToPromise(recordStore.delete(key));
    }

    if (meta) {
      await requestToPromise(metaStore.put({
        ...meta,
        ...buildCleanupMetaPatch(type),
        chatKey,
      }));
    }
    return { deletedCount: keys.length, type, chatKey };
  }

  async function deleteBackupBatch(db, { plan, confirmed = false } = {}) {
    if (confirmed !== true) throw new Error("批量清理必须先预览并明确确认。");
    const storeNames = [STORES.chatMeta, STORES.recentMessages, STORES.fullMessages, STORES.historicalChanges, STORES.pendingChanges];
    return runTransaction(db, storeNames, "readwrite", async stores => {
      const catalog = await catalogInTransaction(stores);
      const fresh = validateBatchCleanupPlan({ plan, catalog, mode: storageMode });
      const items = [];
      for (const action of fresh.actions) {
        const result = await deleteBackupTypeInStores(stores, action);
        items.push({ chatKey: action.chatKey, chatName: action.chatName, type: action.type, typeLabel: action.typeLabel, status: "deleted", count: result.deletedCount });
      }
      const skipped = fresh.skipped.map(item => ({ chatKey: item.chatKey, chatName: item.chatName, type: item.type, typeLabel: item.typeLabel, status: "skipped", count: item.count, reason: item.blockedReason }));
      return { ok: true, committed: true, succeeded: items.length, skipped: skipped.length, failed: 0,
        deletedRecords: items.reduce((sum, item) => sum + item.count, 0), items: [...items, ...skipped] };
    });
  }

  async function resolveFrozenFullBackup(db, {
    chatKey,
    action,
    expectedFullFingerprint,
    expectedIncidentFingerprint,
    messages = [],
    identityMeta = {},
    now = new Date().toISOString(),
  } = {}) {
    if (!chatKey || !Object.values(FROZEN_FULL_BACKUP_ACTIONS).includes(action)) {
      throw new Error("无法识别要处理的冻结完整备份。");
    }
    if (!expectedFullFingerprint || !expectedIncidentFingerprint) {
      throw new Error("缺少冻结备份确认信息，请重新打开后再处理。");
    }

    const safeMessages = Array.isArray(messages) ? messages : [];
    if (action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent) {
      const hasInvalidIndex = safeMessages.some((message, index) => message?.messageIndex !== index);
      if (hasInvalidIndex) {
        throw new Error("当前聊天楼层不连续，不能采用为新的完整备份。");
      }
    }

    return runTransaction(db, [STORES.chatMeta, STORES.fullMessages], "readwrite", async (stores) => {
      const metaStore = stores.get(STORES.chatMeta);
      const fullStore = stores.get(STORES.fullMessages);
      const fullIndex = fullStore.index(INDEXES.fullByChat);
      const [currentMeta, currentRecords] = await Promise.all([
        requestToPromise(metaStore.get(chatKey)),
        requestToPromise(fullIndex.getAll(chatKey)),
      ]);

      if (currentMeta?.fullBackupState !== "frozen") {
        throw new Error("完整聊天备份状态已经变化，请刷新后重新检查。");
      }
      if (fingerprintBackupRecords(currentRecords) !== expectedFullFingerprint) {
        throw new Error("冻结的完整备份在确认期间发生了变化，请重新检查。");
      }
      if (fingerprintBackupRecords([currentMeta.fullBackupIncident ?? null]) !== expectedIncidentFingerprint) {
        throw new Error("冻结原因在确认期间发生了变化，请重新检查。");
      }

      const keys = await requestToPromise(fullIndex.getAllKeys(chatKey));
      for (const key of keys) {
        await requestToPromise(fullStore.delete(key));
      }

      if (action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent) {
        for (const message of safeMessages) {
          await requestToPromise(fullStore.put({ ...message, chatKey }));
        }
      }

      const nextMeta = buildResolvedFullBackupMeta({
        action,
        currentMeta,
        identityMeta: { ...identityMeta, chatKey },
        messages: safeMessages,
        now,
      });
      await requestToPromise(metaStore.put(nextMeta));
      return {
        action,
        chatKey,
        deletedCount: keys.length,
        savedCount: action === FROZEN_FULL_BACKUP_ACTIONS.adoptCurrent ? safeMessages.length : 0,
      };
    });
  }

  async function putPendingChanges(db, records) {
    const safeRecords = Array.isArray(records) ? records : [];
    if (!safeRecords.length) {
      return;
    }

    return runTransaction(db, [STORES.pendingChanges], "readwrite", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      for (const record of safeRecords) {
        await requestToPromise(store.put(record));
      }
    });
  }

  async function replacePendingChanges(db, { chatKey, records }) {
    const safeRecords = Array.isArray(records) ? records : [];
    return runTransaction(db, [STORES.pendingChanges], "readwrite", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      await deleteMessagesForChat(store, INDEXES.pendingByChat, chatKey);
      for (const record of safeRecords) {
        await requestToPromise(store.put(record));
      }
    });
  }

  async function getPendingChanges(db, chatKey) {
    return runTransaction(db, [STORES.pendingChanges], "readonly", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      const index = store.index(INDEXES.pendingByChat);
      const records = await requestToPromise(index.getAll(chatKey));
      return filterValidStoreRecords(records, "pendingChanges").sort(comparePendingRecords);
    });
  }

  async function deletePendingChanges(db, ids) {
    const safeIds = Array.isArray(ids) ? ids : [];
    if (!safeIds.length) {
      return;
    }

    return runTransaction(db, [STORES.pendingChanges], "readwrite", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      for (const id of safeIds) {
        await requestToPromise(store.delete(id));
      }
    });
  }

  async function deletePendingChangesIfUnchanged(db, expectedRecords, {
    shouldDelete = () => true,
  } = {}) {
    const safeRecords = Array.isArray(expectedRecords)
      ? expectedRecords.filter((record) => record?.id)
      : [];
    if (!safeRecords.length) {
      return [];
    }

    return runTransaction(db, [STORES.pendingChanges], "readwrite", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      const deletedIds = [];
      for (const expected of safeRecords) {
        const current = await requestToPromise(store.get(expected.id));
        if (!shouldDelete()
          || pendingDeletionFingerprint(current) !== pendingDeletionFingerprint(expected)) {
          continue;
        }
        await requestToPromise(store.delete(expected.id));
        deletedIds.push(expected.id);
      }
      return deletedIds;
    });
  }

  function pendingDeletionFingerprint(record) {
    if (!record?.id) {
      return "";
    }
    return JSON.stringify({
      id: record.id,
      chatKey: record.chatKey ?? "",
      messageIndex: Number.isInteger(record.messageIndex) ? record.messageIndex : null,
      kind: record.kind ?? "",
      hashVersion: record.hashVersion ?? "",
      canonicalHash: record.canonicalHash ?? "",
      canonicalChatHash: record.canonicalChatHash ?? "",
      chatLength: Number.isInteger(record.chatLength) ? record.chatLength : null,
      createdAt: record.createdAt ?? "",
      updatedAt: record.updatedAt ?? "",
      ...(record.snapshotSaveProof ? { snapshotSaveProof: record.snapshotSaveProof } : {}),
    });
  }

  async function updateChatMetaSummary(db, chatKey, patch) {
    return runTransaction(db, [STORES.chatMeta], "readwrite", async (stores) => {
      const store = stores.get(STORES.chatMeta);
      const current = await requestToPromise(store.get(chatKey));
      await requestToPromise(store.put({
        ...(current ?? { chatKey }),
        ...patch,
        chatKey,
      }));
    });
  }

  async function deleteRecentMessagesForChat(store, chatKey) {
    return deleteMessagesForChat(store, INDEXES.recentByChat, chatKey);
  }

  async function deleteMessagesForChat(store, indexName, chatKey) {
    const index = store.index(indexName);
    const keys = await requestToPromise(index.getAllKeys(chatKey));

    for (const key of keys) {
      await requestToPromise(store.delete(key));
    }
  }

  function comparePendingRecords(a, b) {
    if (a.messageIndex === null && b.messageIndex === null) {
      return String(a.id).localeCompare(String(b.id));
    }

    if (a.messageIndex === null) {
      return 1;
    }

    if (b.messageIndex === null) {
      return -1;
    }

    return a.messageIndex - b.messageIndex;
  }

  function cleanupStoreConfig(type) {
    if (type === "recent") {
      return { store: STORES.recentMessages, index: INDEXES.recentByChat };
    }
    if (type === "full") {
      return { store: STORES.fullMessages, index: INDEXES.fullByChat };
    }
    if (type === "historical") {
      return { store: STORES.historicalChanges, index: INDEXES.historicalByChat };
    }
    return null;
  }

  function primaryKeyForRecord(record, type) {
    if (type === "pending") {
      return record.id;
    }
    return [record.chatKey, record.messageIndex];
  }

  return Object.freeze({
    replaceRecentSnapshot,
    mergeRecentSnapshotMeta,
    putChatMeta,
    getRecentMessages,
    getFullMessages,
    getHistoricalChanges,
    putFullMessages,
    putHistoricalChanges,
    replaceFullSnapshot,
    getChatMeta,
    getBackupCatalogData,
    getBackupCatalog,
    reconcileChatIdentity,
    migrateRenamedChatIdentity,
    deleteBackupTypeForChat,
    deleteBackupBatch,
    resolveFrozenFullBackup,
    putPendingChanges,
    replacePendingChanges,
    getPendingChanges,
    deletePendingChanges,
    deletePendingChangesIfUnchanged,
    pendingDeletionFingerprint,
    updateChatMetaSummary,
  });
}
