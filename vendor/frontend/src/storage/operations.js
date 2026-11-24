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
import { pendingRecordFingerprint, isJournalRecord } from '../backup/pending-journal.js';
import { nativeMessageHash } from '../backup/native-content.js';


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
      recentNativeHash: recentMeta?.recentNativeHash ?? null,
      ...(Object.hasOwn(previousMeta ?? {}, 'fullBackupChatHash') || Object.hasOwn(recentMeta ?? {}, 'fullBackupChatHash') ? { fullBackupChatHash: previousMeta?.fullBackupChatHash ?? null } : {}),
      chatKey: recentMeta?.chatKey ?? previousMeta?.chatKey,
    };
  }

  async function putChatMeta(db, meta) {
    return runTransaction(db, [STORES.chatMeta], "readwrite", async (stores) => {
      await requestToPromise(stores.get(STORES.chatMeta).put({ ...meta, ...(Object.hasOwn(meta, 'fullBackupChatHash') ? { fullBackupChatHash: null } : {}),...(Object.hasOwn(meta,'fullBackupNativeHash')?{fullBackupNativeHash:null}:{}) }));
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

      const previousMeta = await requestToPromise(stores.get(STORES.chatMeta).get(chatKey));
      if (meta || previousMeta) await requestToPromise(stores.get(STORES.chatMeta).put({ ...previousMeta, ...meta, fullBackupChatHash: null,fullBackupNativeHash:null, chatKey }));
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

      const previousMeta = await requestToPromise(stores.get(STORES.chatMeta).get(chatKey));
      if (meta || previousMeta) await requestToPromise(stores.get(STORES.chatMeta).put({ ...previousMeta, ...meta, fullBackupChatHash: null,fullBackupNativeHash:null, chatKey }));
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
    if (stores.get(STORES.fullMessages).eachForChat) {
      if (!allowTargetMerge) {
        for (const config of configurations) if (await stores.get(config.store).countForChat(targetKey)) return { status: 'conflict', sourceKey, targetKey };
      }
      for (const config of configurations) {
        const store = stores.get(config.store);
        const pendingRekey=config.type==='pending'?createPendingRekeyer(targetKey,id=>requestToPromise((store.getForMutation??store.get).call(store,id))):null;
        await store.eachForChat(sourceKey, async record => {
          const migrated = pendingRekey?await pendingRekey(record):rekeyBackupRecord(record, targetKey, config.type);
          const previous = allowTargetMerge ? await store.getForMutation(primaryKeyForRecord(migrated, config.type)) : undefined;
          const next = previous ? mergeRenamedBackupRecords({ type: config.type, sourceRecords: [record], targetRecords: [previous], targetKey })[0] : migrated;
          await requestToPromise(store.put(next)); await requestToPromise(store.delete(primaryKeyForRecord(record, config.type)));
        });
      }
    } else {
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
      const pendingRekey=type==='pending'?createPendingRekeyer(targetKey,id=>sourceRecords.find(row=>row.id===id)??targetRecords.find(row=>row.id===id)):null;
      const prepared=[];
      for(const record of sourceRecords)prepared.push(pendingRekey?await pendingRekey(record):record);
      const migratedRecords = allowTargetMerge
        ? mergeRenamedBackupRecords({ type, sourceRecords:prepared, targetRecords, targetKey })
        : prepared.map((record) => rekeyBackupRecord(record, targetKey, type));
      for (const record of migratedRecords) {
        await requestToPromise(store.put(record));
      }
      for (const record of sourceRecords) {
        await requestToPromise(store.delete(primaryKeyForRecord(record, type)));
      }
    }
    }

    const sourceMeta = metas.find((meta) => meta.chatKey === sourceKey);
    // Snapshot IDs and immutable message rows stay unchanged during Rename.
    const snapshots = stores.get(STORES.snapshots);
    if (snapshots.eachForChat) await snapshots.eachForChat(sourceKey, header => requestToPromise(snapshots.put({ ...header, chatKey: targetKey })));
    else for (const header of await requestToPromise(snapshots.index("by_chat").getAll(sourceKey))) {
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

  function createPendingRekeyer(targetKey,readRecord) {
    const memo=new Map(),visiting=new Set();
    const prepare=async record=>{
      const migrated=rekeyBackupRecord(record,targetKey,'pending'),cached=memo.get(record.id);
      if(cached){if(cached.references)migrated.supersedes=cached.references;return migrated;}
      if(visiting.has(record.id))throw new Error('保护记录的关联关系异常，改名接续未完成，原备份已保留。');
      visiting.add(record.id);
      if(record.pendingFormat&&Array.isArray(record.supersedes)) {
        for(let index=0;index<record.supersedes.length;index++) {
          const original=record.supersedes[index];let proof=memo.get(original.id);
          if(!proof) {
            const referenced=await readRecord(original.id);
            if(referenced&&pendingRecordFingerprint(referenced)===original.fingerprint){await prepare(referenced);proof=memo.get(original.id);}
          }
          if(proof?.originalHash===original.fingerprint)migrated.supersedes[index]={...migrated.supersedes[index],fingerprint:proof.targetHash};
        }
      }
      visiting.delete(record.id);
      memo.set(record.id,{originalHash:pendingRecordFingerprint(record),targetHash:pendingRecordFingerprint(migrated),references:migrated.supersedes});
      return migrated;
    };
    return prepare;
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
      const guard=row=>{if(row.pendingFormat)throw Object.assign(new Error('聊天已有新版保护记录，不能整批替换；请更新箱装前端扩展并重新预览恢复。'),{code:'backup-client-upgrade-required'});};
      if(store.eachForChat)await store.eachForChat(chatKey,guard);
      else for(const row of await requestToPromise(store.index(INDEXES.pendingByChat).getAll(chatKey)))guard(row);
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

    const proofStores = [STORES.pendingChanges, ...new Set(safeRecords.flatMap(record => (record.backupTargets ?? []).filter(name => [STORES.fullMessages, STORES.historicalChanges, STORES.recentMessages].includes(name))))];
    if(safeRecords.some(record=>record.verifiedSupersededBy)&&!proofStores.includes(STORES.historicalChanges))proofStores.push(STORES.historicalChanges);
    if (safeRecords.some(record => record.pendingFormat || record.verifiedSupersededBy || record.backupTargets?.includes(STORES.recentMessages) || record.backupTargets?.includes(STORES.fullMessages) && !Number.isInteger(record.messageIndex))) proofStores.push(STORES.chatMeta);
    return runTransaction(db, proofStores, "readwrite", async (stores) => {
      const store = stores.get(STORES.pendingChanges);
      const deletedIds = [];
      for (const expected of safeRecords) {
        const current = await requestToPromise(store.get(expected.id));
        if (!shouldDelete()
          || pendingDeletionFingerprint(current) !== pendingDeletionFingerprint(expected)) {
          continue;
        }
        const meta=(current.pendingFormat||expected.verifiedSupersededBy)?await requestToPromise(stores.get(STORES.chatMeta).get(current.chatKey)):null;
        if(current.pendingFormat && (!isJournalRecord(current)||expected.verifiedRecordHash!==pendingRecordFingerprint(current)
          || !/^[a-f0-9]{64}$/.test(expected.verifiedNativeHash??'')))continue;
        if(current.pendingType==='operation') {
          let dependenciesRemain=false;
          for(const id of current.insertIds??[])if(await requestToPromise(store.get(id))){dependenciesRemain=true;break;}
          if(!dependenciesRemain)for(const reference of current.supersedes??[]) {
            const related=await requestToPromise(store.get(reference.id));
            if(related&&pendingRecordFingerprint(related)===reference.fingerprint){dependenciesRemain=true;break;}
          }
          if(!dependenciesRemain)for(const reference of expected.verifiedDependencies??[]) {
            const related=await requestToPromise(store.get(reference.id));
            if(related&&pendingRecordFingerprint(related)===reference.fingerprint){dependenciesRemain=true;break;}
          }
          if(dependenciesRemain)continue;
        }
        let source;
        if(expected.verifiedSupersededBy) {
          source=await requestToPromise(store.get(expected.verifiedSupersededBy));
          if(!source||source.pendingType!=='operation'||pendingRecordFingerprint(source)!==expected.verifiedSupersedingHash)continue;
        }
        let backedUp = true;
        for (const target of new Set([...(current.backupTargets??[]),...(source?.backupTargets??[])])) {
          if (![STORES.fullMessages, STORES.historicalChanges, STORES.recentMessages].includes(target)) { backedUp = false; break; }
          if(current.pendingFormat||source) {
            if(target===STORES.fullMessages&&meta?.fullBackupNativeHash!==expected.verifiedNativeHash)backedUp=false;
            if(target===STORES.recentMessages&&!recentProofMatches(meta,expected))backedUp=false;
            if(target===STORES.historicalChanges) {
              if(!Array.isArray(expected.verifiedHistoricalCopies))backedUp=false;
              else for(const proof of [...expected.verifiedHistoricalCopies,...(expected.verifiedSupersedingHistoricalCopies??[])]) {
                const copy=await requestToPromise(stores.get(target).get([current.chatKey,proof.messageIndex]));
                if(!copy?.message?.raw||nativeMessageHash(copy.message.raw)!==proof.nativeHash)backedUp=false;
              }
            }
            continue;
          }
          if (Number.isInteger(current.messageIndex)) {
            const copy = await requestToPromise(stores.get(target).get([current.chatKey, current.messageIndex]));
            if ((target === STORES.historicalChanges ? copy?.message : copy)?.canonicalHash !== current.canonicalHash) {
              const meta = target === STORES.recentMessages ? await requestToPromise(stores.get(STORES.chatMeta).get(current.chatKey)) : null;
              if (!(Number.isInteger(meta?.recentFirstIndex) && current.messageIndex < meta.recentFirstIndex)) backedUp = false;
            }
          } else {
            const meta = await requestToPromise(stores.get(STORES.chatMeta).get(current.chatKey));
            if (target !== STORES.fullMessages || meta?.fullBackupChatHash !== (expected.verifiedFullChatHash ?? current.canonicalChatHash)) backedUp = false;
          }
        }
        if (!backedUp || !shouldDelete()) continue;
        await requestToPromise(store.delete(expected.id));
        deletedIds.push(expected.id);
      }
      return deletedIds;
    });
  }

  function pendingDeletionFingerprint(record) {
    return pendingRecordFingerprint(record);
  }
  function recentProofMatches(meta,expected) {
    return Boolean(expected.verifiedRecentHash)&&meta?.recentNativeHash===expected.verifiedRecentHash&&meta?.messageCount===expected.verifiedLength
      &&meta?.recentCount===expected.verifiedRecentCount&&meta?.recentFirstIndex===expected.verifiedRecentFirstIndex&&meta?.recentLastIndex===expected.verifiedRecentLastIndex;
  }

  async function updateChatMetaSummary(db, chatKey, patch) {
    return runTransaction(db, [STORES.chatMeta], "readwrite", async (stores) => {
      const store = stores.get(STORES.chatMeta);
      const current = await requestToPromise(store.get(chatKey));
      await requestToPromise(store.put({
        ...(current ?? { chatKey }),
        ...patch,
        ...(Object.hasOwn(patch, 'fullBackupChatHash') ? { fullBackupChatHash: null } : {}),
        ...(Object.hasOwn(patch,'fullBackupNativeHash')?{fullBackupNativeHash:null}:{}),
        ...(Object.hasOwn(patch,'recentNativeHash')?{recentNativeHash:null}:{}),
        chatKey,
      }));
    });
  }

  async function deleteRecentMessagesForChat(store, chatKey) {
    return deleteMessagesForChat(store, INDEXES.recentByChat, chatKey);
  }

  async function deleteMessagesForChat(store, indexName, chatKey) {
    if (store.deleteForChat) return store.deleteForChat(chatKey);
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
