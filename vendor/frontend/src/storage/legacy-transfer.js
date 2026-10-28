import { STORAGE_LOCK } from "./managed.js";
import { emptyManifest, sameManifest } from "./transfer-format.js";

export function createLegacyTransferCoordinator({ control, adapters, locks = globalThis.navigator?.locks, pause = async () => {}, resume = async () => {}, validate = async () => {}, progress = () => {}, hook = async () => {} }) {
  let busy = false;
  const call = (mode, action, args) => {
    if (!adapters[mode]?.transfer) throw new Error("所需备份位置不可用，未改用其他位置。");
    return adapters[mode].transfer(action, args);
  };
  async function recoverInternal() {
    const state = await control.read();
    const journal = state.journal;
    if (!journal) return { recovered: false };
    const { id, from, to, kind } = journal;
    progress("正在核实并恢复未完成的存储操作");
    const receipt = await call(to, "status", { id });
    if (journal.phase === "activated") {
      if ((kind === "switch" && state.active !== to) || !["committed", "finished"].includes(receipt?.phase)) throw new Error("当前使用位置与切换记录不一致，已暂停操作，请保留两个位置的备份。");
      await call(to, "finish", { id });
      if (kind === "switch") await call(from, "finish", { id });
    } else {
      if (receipt?.phase === "finished") throw new Error("新位置已完成处理，但当前使用位置的记录不一致，无法自动选择备份位置。");
      await call(to, "rollback", { id });
      if (kind === "switch") await call(from, "rollback", { id });
    }
    await control.update((current) => {
      if (current.journal?.id !== id) throw new Error("存储控制记录已变化。");
      return { ...current, journal: null };
    });
    return { recovered: true, active: (await control.read()).active };
  }
  async function check(mode, id) {
    let after = 0;
    while (true) { const result = await call(mode, "check", { id, after }); if (result.done) return; after = result.after; }
  }
  async function exclusive(operation) {
    if (busy) throw new Error("已有存储操作正在执行。");
    if (!locks?.request) throw new Error("当前浏览器不支持安全的跨页签操作锁，暂不能切换备份位置。");
    busy = true;
    try {
      await pause();
      return await locks.request(STORAGE_LOCK, { mode: "exclusive" }, operation);
    } finally {
      busy = false;
      if (!(await control.read()).journal) await resume();
    }
  }
  async function finishSuccess(journal, original) {
    await call(journal.to, "finish", { id: journal.id });
    if (journal.kind === "switch") await call(journal.from, "finish", { id: journal.id });
    await control.update((state) => {
      if (state.journal?.id !== journal.id) throw new Error("存储控制记录已变化。");
      return { ...state, journal: null };
    });
    return { ok: true, active: journal.kind === "switch" ? journal.to : original.active };
  }
  async function execute(kind, to, confirmed) {
    if (!confirmed) throw new Error("必须明确确认覆盖新位置或清空原位置的备份，才能执行。");
    return exclusive(async () => {
      const original = await control.read();
      if (original.journal) throw new Error("请先恢复未完成的存储操作。");
      if (!["indexeddb", "sqlite"].includes(to) || to === original.active) throw new Error("不能覆盖或清空当前正在使用的备份位置。");
      if (kind === "clear" && (!original.lastTransfer || original.previous !== to)) throw new Error("没有已确认可清空的原存储位置。");
      for (const mode of new Set([original.active, to])) {
        const status = await adapters[mode]?.status?.();
        if (status && !status.ok) throw new Error(status.reason || "备份位置暂不可用。");
      }
      const journal = { id: crypto.randomUUID(), kind, from: original.active, to, phase: "working" };
      await control.update((state) => ({ ...state, journal }));
      try {
        let manifest;
        if (kind === "switch") {
          progress("正在读取并保护原位置的备份");
          await call(journal.from, "source", { id: journal.id });
          manifest = await call(journal.from, "seal", { id: journal.id });
        } else manifest = await emptyManifest();
        await adapters[to]?.checkCapacity?.(manifest);
        await hook("source", journal);
        progress("正在准备新位置的备份副本");
        await call(to, "prepare", { id: journal.id, manifest });
        if (kind === "switch") {
          let after = 0;
          while (true) {
            const rows = await call(journal.from, "page", { id: journal.id, after });
            if (!rows.length) break;
            await call(to, "append", { id: journal.id, rows });
            after = rows.at(-1).n;
            progress(`已复制 ${after} / ${manifest.count} 条记录`);
            await hook("append", journal);
          }
        }
        progress("正在逐项校验新位置的备份");
        const verified = await call(to, "seal", { id: journal.id });
        if (!sameManifest(manifest, verified)) throw new Error("新位置的备份数量、聊天归属或内容校验不一致，已停止切换。");
        await hook("verified", journal);
        if (kind === "switch") await check(journal.from, journal.id);
        await validate();
        progress(kind === "clear" ? "正在清空原存储位置的备份" : "正在切换并更新新位置的备份");
        await call(to, "commit", { id: journal.id });
        await check(to, journal.id);
        await hook("committed", journal);
        await control.update((state) => {
          if (state.active !== original.active || state.journal?.id !== journal.id) throw new Error("切换前备份位置已变化。");
          return kind === "switch"
            ? { ...state, active: to, previous: journal.from, lastTransfer: journal.id, journal: { ...journal, phase: "activated" } }
            : { ...state, previous: null, lastTransfer: null, journal: { ...journal, phase: "activated" } };
        });
        await hook("activated", journal);
        progress(kind === "clear" ? "正在完成原位置的备份清空" : "正在完成切换，原位置的备份仍会保留");
        return await finishSuccess(journal, original);
      } catch (error) {
        if (error.simulateCrash) throw error;
        try { await recoverInternal(); }
        catch (recoveryError) { throw new Error(`操作结果待恢复，备份保持锁定：${recoveryError.message}`, { cause: error }); }
        const current = await control.read();
        if (kind === "switch" && current.active === to || kind === "clear" && current.previous === null && current.lastTransfer === null) return { ok: true, active: current.active, recovered: true };
        throw error;
      }
    });
  }
  return {
    switchTo: (to, { confirmed = false } = {}) => execute("switch", to, confirmed),
    clearInactive: (mode, { confirmed = false } = {}) => execute("clear", mode, confirmed),
    recover: async () => (await control.read()).journal ? exclusive(recoverInternal) : { recovered: false },
    isBusy: () => busy,
  };
}
