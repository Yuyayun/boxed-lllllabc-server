export const STORAGE_LOCK = "boxed-lllllabc-storage-operation";
export function createManagedStorage({ control, adapters, locks = globalThis.navigator?.locks }) {
  let mode = "indexeddb";
  async function refresh() { const state = await control.read(); mode = state.active; return state; }
  async function openSession(release) {
    const state = await refresh();
    if (state.journal) throw new Error("存在未完成的存储操作，恢复完成前已暂停备份。");
    const adapter = adapters[state.active];
    if (!adapter) throw new Error("活动存储不可用，没有回退到其他端。");
    const session = await adapter.open();
    return Object.freeze({ ...session, close() { try { session.close(); } finally { release?.(); } } });
  }
  return Object.freeze({
    getMode: () => mode, refresh,
    async status() { const state = await refresh(); return adapters[state.active]?.status?.(); },
    async open() {
      if (!locks?.request) return openSession();
      return new Promise((resolve, reject) => {
        locks.request(STORAGE_LOCK, { mode: "shared", ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error("正在切换备份位置，请等待操作完成。");
          let release;
          const done = new Promise((finish) => { release = finish; });
          const session = await openSession(release);
          resolve(session);
          await done;
        }).catch(reject);
      });
    },
  });
}

export function createOperationGate() {
  let paused = false, running = 0;
  const waiters = [];
  return {
    async run(operation) {
      if (paused) throw new Error("切换备份位置期间操作已锁定。");
      running += 1;
      try { return await operation(); }
      finally { if (--running === 0) waiters.splice(0).forEach((resolve) => resolve()); }
    },
    async pause() { paused = true; if (running) await new Promise((resolve) => waiters.push(resolve)); },
    resume() { paused = false; },
    isPaused: () => paused,
  };
}
