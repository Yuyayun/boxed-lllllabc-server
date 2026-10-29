import { STORAGE_LOCK } from "./managed.js";
import { BATCH_TRANSFER_VERSION } from "./protocol.js";
import { initialSummary, same } from "./transfer-batch-format.js";
import { createLegacyTransferCoordinator } from "./legacy-transfer.js";

const error = (message, code = "recovery-conflict") => Object.assign(new Error(message), { code });
const terminal = state => state && ["finished", "rolled-back"].includes(state.phase);

export function createTransferCoordinator({ control, adapters, locks = globalThis.navigator?.locks, pause = async () => {}, resume = async () => {}, validate = async () => {}, progress = () => {}, hook = async () => {}, budget } = {}) {
  let busy = false, pauseRequested = false;
  let lastLogProgress = -Infinity, logUnavailable = false;
  const progressStages = new Set(['inventory','source-check','prepare','append','batch-verified','resume-batch','target-check','commit-check','finish-target','finish-source']);
  const legacy = createLegacyTransferCoordinator({ control, adapters, locks, pause, resume, validate, progress, hook });
  const call = (mode, action, args) => {
    if (!adapters[mode]?.batchTransfer || adapters[mode].batchVersion !== BATCH_TRANSFER_VERSION) throw error("需要配套的新版分批迁移能力，未使用旧流程或其他存储端。", "protocol-incompatible");
    return adapters[mode].batchTransfer(action, args);
  };
  const boundary = () => { if (pauseRequested) throw error("存储操作已暂停，恢复时会核对已登记进度；备份操作保持锁定。", "paused"); };
  async function notify(stage,journal,metrics={}) {
    if(!adapters.sqlite?.logEvent || logUnavailable)return;
    if(progressStages.has(stage)) {
      if(Date.now()-lastLogProgress<1000)return;
      lastLogProgress=Date.now();
    }
    try{await adapters.sqlite.logEvent({taskId:journal.id,from:journal.from,to:journal.to,kind:journal.kind,stage,...metrics});}
    catch{logUnavailable=true;/* The adapter exposes log failure separately; recovery uses the database journal. */}
  }
  async function event(stage, journal, message,metrics) { if (message) progress(message); await notify(stage,journal,metrics);await hook(stage, journal); }
  async function journalUpdate(journal, changes) {
    return control.update(state => {
      if (state.journal?.id !== journal.id || state.journal.version !== 3) throw error("控制登记簿已变化，未猜测存储位置。");
      return { ...state, journal: { ...state.journal, ...changes } };
    });
  }
  async function inspect(journal, mode, role, checkRevision = false) {
    const view = await call(mode, "inspect", [journal.id]), state = view.receipt;
    if (view.lock && view.lock !== journal.id || !state && view.lock) throw error("持久锁与任务登记簿不一致，请保留两端数据。");
    if (!state) return null;
    if (state.version !== 3 || state.id !== journal.id || state.role !== role || state.from !== journal.from || state.to !== journal.to || (state.kind ?? "switch") !== journal.kind
        || !terminal(state) && view.lock !== journal.id) throw error("任务身份、方向或持久锁不一致，未猜测存储位置。");
    if (journal.manifest && (role === "source" && state.phase !== "capturing" || role === "target" && ["committed", "activated", "finishing", "finished"].includes(state.phase) && state.outcome !== "cancelled") && !same(journal.manifest, state.summary)) throw error("持久清单与控制记录不一致，请保留两端数据。");
    const expected = role === "source" || ["committed", "activated", "finishing", "finished"].includes(state.phase) && state.outcome !== "cancelled" ? state.dataset : state.previousDataset;
    if (view.active !== expected) throw error("活动数据区与任务回执不一致，请保留两端数据。");
    if (checkRevision && view.revision !== (role === "target" && state.phase === "committed" ? state.commitRevision : state.baseRevision)) {
      throw error("启用前数据修订已变化，未继续使用旧验收结果。", role === "source" ? "source-changed" : "target-changed");
    }
    return state;
  }
  async function exclusive(fn, operation) {
    if (busy) throw error("已有存储操作正在执行。");
    if (!locks?.request) throw error("当前浏览器不支持安全的跨页签操作锁，暂不能切换备份位置。");
    busy = true; pauseRequested = false;
    try { await pause(operation); return await locks.request(STORAGE_LOCK, { mode: "exclusive" }, fn); }
    finally { busy = false; if (!(await control.read()).journal) await resume(); }
  }
  async function sourceCheck(journal) {
    await call(journal.from, "startSourceCheck", [journal.id]);
    let state;
    do {
      boundary(); state = await call(journal.from, "sourceCheckStep", [journal.id, budget]);
      await event("source-check", journal, `正在复核来源：已核对 ${state.checkSummary.count} / ${state.summary.count} 条`,{count:state.checkSummary.count});
    } while (!state.sourceChecked);
    await event("source-checked", journal);
  }
  async function targetCheck(journal, committed = false) {
    await call(journal.to, "startSeal", [journal.id, journal.manifest, true]);
    let state;
    do {
      boundary(); state = await call(journal.to, "sealStep", [journal.id, budget]);
      const count = Object.values(state.scanCounts).reduce((sum, n) => sum + n, 0);
      await event(committed ? "commit-check" : "target-check", journal, `正在${committed ? "提交后" : "最终"}验收：已核对 ${count} / ${journal.manifest.count} 条`,{count});
    } while (!state.auditDone);
    await event(committed ? "target-checked" : "verified", journal);
  }
  async function finish(journal, mode, role, outcome) {
    let state = await inspect(journal, mode, role);
    if (!state) throw error("收尾任务登记缺失，未解除持久锁。");
    while (!terminal(state)) {
      boundary(); state = await call(mode, "finishStep", [journal.id, budget]);
      await event(role === "target" ? "finish-target" : "finish-source", journal, journal.kind==='clear'?(state.outcome==='cancelled'?"正在撤销清空并整理临时记录，旧位置原有备份保留":"正在分批清理原位置数据，当前使用位置的备份不变"):"正在分批收尾，原位置的备份继续保留",journal.kind==='clear'&&Number.isSafeInteger(state.cleaned)?{count:state.cleaned}:undefined);
    }
    if (state.outcome !== outcome) throw error("收尾结果与控制记录不一致，未选择其他位置。");
  }
  async function clearJournal(journal) {
    await control.update(state => {
      if (state.journal?.id !== journal.id) throw error("控制记录已变化，未结束其他任务。");
      return { ...state, journal: null };
    });
  }
  async function wrapUp(journal) {
    if (journal.phase !== "activated") throw error("前端尚未确认启用，不能删除目标旧备份。");
    const target = await inspect(journal, journal.to, "target");
    if (!target || !["committed", "activated", "finishing", "finished"].includes(target.phase)) throw error("启用记录与目标提交结果不一致，备份保持锁定。");
    if (target.phase === "committed") await call(journal.to, "activate", [journal.id]);
    await event("target-activated", journal);
    await finish(journal, journal.to, "target", "completed");
    if (journal.kind === "switch") {
      await finish(journal, journal.from, "source", "completed");
      await call(journal.from, "release", [journal.id]); await event("release-source", journal);
    }
    await call(journal.to, "release", [journal.id]); await event("release-target", journal);
    await clearJournal(journal);
    await notify('completed',journal,journal.kind==='clear'?{}:{count:journal.manifest?.count??0,verified:journal.manifest?.count??0});
    return { ok: true, active: (await control.read()).active };
  }
  async function cancel(journal, reason) {
    reason??=journal.kind==='clear'?"已撤销本次清空，旧位置原有备份仍保留，当前使用位置不变。":"已放弃本次迁移，两端原有正式备份保持保留。";
    if (journal.phase === "activated") throw error(journal.kind==='clear'?"清空结果已确认，只能继续收尾，不能撤销。":"已经正式启用，只能继续收尾，不能撤销。");
    await journalUpdate(journal, { phase: "aborting" }); journal = { ...journal, phase: "aborting" };
    const target = await inspect(journal, journal.to, "target");
    const source = journal.kind === "switch" ? await inspect(journal, journal.from, "source") : null;
    if (target && target.outcome === "completed" || source && source.outcome === "completed") throw error("发现已完成的启用记录，不能根据不完整控制记录猜测回滚。");
    if (target && !terminal(target)) await call(journal.to, "beginAbort", [journal.id]);
    if (source && !terminal(source)) await call(journal.from, "beginAbort", [journal.id]);
    if (target) await finish(journal, journal.to, "target", "cancelled");
    if (source) await finish(journal, journal.from, "source", "cancelled");
    if (source) await call(journal.from, "release", [journal.id]);
    if (target) await call(journal.to, "release", [journal.id]);
    await clearJournal(journal);
    await notify('cancelled',journal);
    return { ok: false, cancelled: true, reason, active: (await control.read()).active };
  }
  async function contextCheck() {
    boundary();
    try { await validate(); } catch (cause) { throw Object.assign(new Error(cause.message, { cause }), { code: "context-changed" }); }
  }
  async function run(journal, recovering = false) {
    try {
      if (journal.phase === "aborting") return cancel(journal);
      if (journal.phase === "activated") return wrapUp(journal);
      const target = await inspect(journal, journal.to, "target");
      let source = journal.kind === "switch" ? await inspect(journal, journal.from, "source") : null;
      if (recovering && journal.kind === "switch" && (!source || source.phase === "capturing")) return cancel(journal, "最初清点尚未完成，无法确认未读来源未变，已安全撤销；请重新发起迁移。");
      if (journal.kind === "switch") {
        if (!source) source = await call(journal.from, "begin", [{ id: journal.id, from: journal.from, to: journal.to, kind: journal.kind, role: "source" }]);
        if (source.phase === "capturing") {
          let after = source.batches;
          while (true) {
            boundary(); const packet = await call(journal.from, "sourceNext", [journal.id, after, budget]);
            if (packet.done) break;
            after = packet.index; await event("inventory", journal, `正在清点来源：已登记 ${packet.last} 条，尚未启用新位置`,{count:packet.last,batch:packet.index,bytes:packet.bytes});
          }
          source = await inspect(journal, journal.from, "source");
        }
        if (!source || source.phase !== "captured") throw error("来源任务不在可搬运阶段。");
        if (journal.manifest && !same(journal.manifest, source.summary)) throw error("来源清单与前端控制记录不一致。");
        journal = { ...journal, manifest: source.summary }; await journalUpdate(journal, { manifest: source.summary });
        await event("source", journal);
        // A fresh inventory already checked every source row. sourceNext()
        // re-reads and fingerprints each captured batch before sending it.
        // A resumed process must additionally check the whole source baseline.
        if (recovering) await sourceCheck(journal);
      } else if (!journal.manifest) { journal = { ...journal, manifest: await initialSummary() }; await journalUpdate(journal, { manifest: journal.manifest }); }
      if (!target) {
        await adapters[journal.to]?.checkCapacity?.(journal.manifest);
        await call(journal.to, "begin", [{ id: journal.id, from: journal.from, to: journal.to, kind: journal.kind, role: "target" }]);
      }
      let current = await inspect(journal, journal.to, "target");
      if (recovering && current.phase === "staging") {
        for (let index = 1; index <= current.verifiedBatch; index++) {
          boundary(); await call(journal.to, "verifyBatch", [journal.id, index]);
          await event("resume-batch", journal, `正在核对已验货批次 ${index} / ${current.verifiedBatch}`);
        }
      }
      if (current.phase === "preparing") {
        do { boundary(); current = await call(journal.to, "prepareStep", [journal.id, budget]); await event("prepare", journal, "正在分批准备目标，原有正式备份保持保留"); } while (current.phase === "preparing");
        await event("prepared", journal);
      }
      if (current.phase === "staging" && journal.kind === "switch") {
        let after = current.verifiedBatch;
        while (true) {
          boundary(); const packet = await call(journal.from, "sourceNext", [journal.id, after, budget]);
          if (packet.done) break;
          await adapters[journal.to]?.checkCapacity?.({ bytes: packet.bytes, count: packet.rows.length });
          await call(journal.to, "append", [journal.id, packet]); await event("append", journal);
          const verified = await call(journal.to, "verifyBatch", [journal.id, packet.index]); after = packet.index;
          await event("batch-verified", journal, `已搬运并核验 ${verified.verified} / ${journal.manifest.count} 条`,{verified:verified.verified,count:journal.manifest.count,batch:packet.index});
        }
      }
      let committedHere = false;
      current = await inspect(journal, journal.to, "target");
      if (["staging", "checking", "verified"].includes(current.phase)) {
        await targetCheck(journal);
        if (journal.kind === "switch") await sourceCheck(journal);
        await contextCheck();
        await journalUpdate(journal, { phase: "committing" }); journal = { ...journal, phase: "committing" };
        await event("committing", journal); boundary();
        await call(journal.to, "commit", [journal.id, journal.manifest]); await event("committed", journal);
        committedHere = true;
      } else if (current.phase !== "committed") throw error("目标阶段与未激活的控制记录不一致。");
      const committed = await inspect(journal, journal.to, "target", true);
      // Commit changes only the active dataset pointer in the transaction that
      // checks the verified receipt and revision. Reuse that audit only for an
      // acknowledged commit in this live run. Lost replies/restarts (and older
      // servers that invalidate auditDone at commit) still re-audit actual rows.
      if (!committedHere || !committed?.auditDone) await targetCheck(journal, true);
      else await event("target-checked", journal);
      if (journal.kind === "switch") await inspect(journal, journal.from, "source", true);
      await contextCheck(); await event("before-control", journal);
      const result = await control.update(state => {
        if (state.journal?.id !== journal.id || state.active !== journal.from) throw error("启用前控制记录发生变化。");
        return journal.kind === "switch"
          ? { ...state, active: journal.to, previous: journal.from, lastTransfer: journal.id, journal: { ...journal, phase: "activated" } }
          : { ...state, previous: null, lastTransfer: null, journal: { ...journal, phase: "activated" } };
      });
      journal = result.journal; await event("activated", journal);
      return await wrapUp(journal);
    } catch (cause) {
      if(!cause.simulateCrash)await notify(cause.code==='paused'?'paused':'error',journal,cause.code==='paused'?{}:{errorCode:typeof cause.code==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(cause.code)?cause.code:['QuotaExceededError','AbortError','TimeoutError'].includes(cause.name)?cause.name:'unexpected'});
      if (cause.simulateCrash || ["paused", "recovery-required"].includes(cause.code)) throw cause;
      const current = (await control.read()).journal;
      if (current && current.phase !== "activated" && ["source-changed", "target-changed", "source-baseline-incomplete", "context-changed", "transfer-conflict", "snapshot-conflict"].includes(cause.code)) {
        try { return await cancel(current, current.kind==='clear'?`已停止清空并撤销临时成果：${cause.message} 旧位置原有备份仍保留，当前使用位置不变。`:`已停止迁移并撤销临时成果：${cause.message} 原位置现有备份和目标原正式备份已保留。`); }
        catch (cleanup) { throw new Error(`撤销尚待恢复，备份保持锁定：${cleanup.message}`, { cause }); }
      }
      throw cause;
    }
  }
  async function execute(kind, to, confirmed) {
    if (!confirmed) throw error("必须明确确认覆盖新位置或清空原位置的备份，才能执行。");
    return exclusive(async () => {
      logUnavailable=false;lastLogProgress=-Infinity;
      const state = await control.read();
      if (state.journal) throw error("请先恢复未完成的存储操作。");
      if (!["indexeddb", "sqlite"].includes(to) || to === state.active) throw error("不能覆盖或清空当前正在使用的备份位置。");
      if (kind === "clear" && (!state.lastTransfer || state.previous !== to)) throw error("没有已确认可清空的原存储位置。");
      const modes = [...new Set([state.active, to])], healthByMode = {};
      for (const mode of modes) {
        const health = await adapters[mode]?.status?.();
        if (health && !health.ok) throw error(health.reason || "备份位置暂不可用。");
        healthByMode[mode] = health;
      }
      for (const mode of modes) {
        const health = healthByMode[mode];
        if (!adapters[mode]?.batchTransfer || adapters[mode].batchVersion !== BATCH_TRANSFER_VERSION || mode === "sqlite" && health?.database?.batchTransfer !== BATCH_TRANSFER_VERSION) throw error("前后端未提供一致的新版分批迁移能力，请更新配套插件。", "protocol-incompatible");
      }
      const journal = { version: 3, id: crypto.randomUUID(), kind, from: state.active, to, phase: "working", manifest: null };
      await control.update(current => { if (current.journal || current.active !== state.active) throw error("控制记录已变化。"); return { ...current, journal }; });
      await event("registered", journal);
      return run(journal);
    }, {kind,to});
  }
  async function recover({ confirmed = false } = {}) {
    const state = await control.read();
    if (!state.journal) return { recovered: false };
    if (state.journal.version !== 3 && confirmed) {await notify('recover',state.journal);const result=await legacy.recover();await notify(state.journal.phase==='activated'?'completed':'cancelled',state.journal);return result;}
    return exclusive(async () => {
      if (!confirmed) throw error(state.journal.kind==='clear'?"发现未完成的清空，请确认后继续核对，或放弃本次清空。":"发现未完成的迁移，请确认后继续核对，或放弃本次任务。", "recovery-required");
      logUnavailable=false;lastLogProgress=-Infinity;
      await notify('recover',(await control.read()).journal);
      return run((await control.read()).journal, true);
    }, {kind:state.journal.kind,to:state.journal.to,recovering:true});
  }
  async function abandon({ confirmed = false } = {}) {
    if (!confirmed) throw error("请明确确认放弃尚未完成的存储操作。");
    const initial=await control.read();
    return exclusive(async () => {
      const journal = (await control.read()).journal;
      if (!journal) return { cancelled: false };
      if (journal.version !== 3) throw error("旧版任务请使用兼容恢复流程，未猜测清理范围。");
      logUnavailable=false;lastLogProgress=-Infinity;
      return cancel(journal);
    }, {kind:initial.journal?.kind,to:initial.journal?.to,abandoning:true});
  }
  return { switchTo: (mode, { confirmed = false } = {}) => execute("switch", mode, confirmed), clearInactive: (mode, { confirmed = false } = {}) => execute("clear", mode, confirmed), recover, abandon,
    requestPause() { pauseRequested = true; }, canPause: () => !legacy.isBusy(), isBusy: () => busy || legacy.isBusy() };
}
