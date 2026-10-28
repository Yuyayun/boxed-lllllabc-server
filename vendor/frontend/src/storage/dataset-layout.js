import { stableText } from "./value-digest.js";

// Two physical data areas share the existing domain operations. Area 0 is the
// untouched 1.0.0 layout; area 1 is created empty, never by copying the old data.
export const ACTIVE_DATASET_KEY = "active-dataset";
export const DATASET_NAMES = Object.freeze([
  "chat_meta", "recent_messages", "pending_changes", "full_messages",
  "historical_changes", "snapshots", "snapshot_messages",
]);

export function datasetId(value = 0) {
  if (value !== 0 && value !== 1) throw new Error("数据区标记无效，已保留原数据并停止操作。");
  return value;
}

export function datasetStore(name, dataset = 0) {
  if (!DATASET_NAMES.includes(name)) throw new Error("未知备份仓库。");
  return datasetId(dataset) === 0 ? name : `__boxed_next_${name}`;
}

export const ALL_DATASET_STORES = Object.freeze([0, 1].flatMap(id => DATASET_NAMES.map(name => datasetStore(name, id))));

// These transitions run inside the driver's metadata/data transaction. They do
// not claim that committing the target also changes the browser control DB.
export function commitDataset(state, { active, revision, expectedManifest }) {
  if (!state || state.version !== 3 || state.role !== "target") throw new Error("目标任务登记无效。");
  datasetId(state.previousDataset); datasetId(state.dataset); datasetId(active);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(state.baseRevision) || state.baseRevision < 0) throw new Error("数据修订记录无效。");
  if (state.dataset === state.previousDataset) throw new Error("目标数据区不能覆盖原正式数据区。");
  if (expectedManifest && stableText(state.manifest) !== stableText(expectedManifest)) throw new Error("目标验收清单与提交请求不一致。");
  if (state.phase === "committed") {
    if (active !== state.dataset || revision !== state.commitRevision) throw new Error("已提交任务与活动数据区不一致。");
    return state;
  }
  if (state.phase !== "verified" || active !== state.previousDataset || revision !== state.baseRevision
      || !expectedManifest || stableText(state.manifest) !== stableText(expectedManifest)) {
    throw new Error("目标尚未验收或正式数据已变化，未启用新数据。");
  }
  return { ...state, phase: "committed", commitRevision: revision + 1 };
}

export function rollbackDataset(state, { active, revision }) {
  if (!state || state.version !== 3 || state.role !== "target") throw new Error("目标任务登记无效。");
  datasetId(active); datasetId(state.dataset); datasetId(state.previousDataset);
  if (!Number.isSafeInteger(revision) || revision < 0 || state.dataset === state.previousDataset) throw new Error("数据区或修订记录无效。");
  if (state.phase === "activated" || state.phase === "finished") throw new Error("已正式启用的任务只能继续收尾，不能撤销。");
  if (!["preparing", "staging", "checking", "verified", "committed", "rolling-back"].includes(state.phase)) throw new Error("目标任务阶段无效，不能自动回退。");
  if (state.phase === "committed" && (active !== state.dataset || revision !== state.commitRevision)) {
    throw new Error("提交后正式数据已变化，不能自动回退。");
  }
  if (state.phase !== "committed" && active !== state.previousDataset) throw new Error("活动数据区与登记簿不一致。");
  return { ...state, phase: "rolling-back" };
}
