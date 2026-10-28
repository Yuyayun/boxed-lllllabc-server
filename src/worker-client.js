import { Worker } from 'node:worker_threads';
import { failure } from './errors.js';

export class SqliteWorker {
  constructor(file, { maxQueued = 32, timeoutMs = 15000 } = {}) {
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { file } });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      const timeout = setTimeout(() => { const error = failure('database-unavailable', 'SQLite 工作线程初始化超时。'); reject(error); this.fail(error); }, timeoutMs);
      this.worker.on('message', (message) => {
        if (message.ready) { clearTimeout(timeout); resolve(); return; }
        if (message.startupError) { clearTimeout(timeout); reject(Object.assign(new Error(message.startupError.message), { code: 'database-unavailable' })); return; }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.cleanup();
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
        else entry.resolve(message.value);
      });
      this.worker.on('error', (error) => { clearTimeout(timeout); this.fail(error); });
      this.worker.on('exit', (code) => { clearTimeout(timeout); if (!this.closed) this.fail(failure('outcome-unknown', `SQLite 工作线程异常退出（${code}）；请重新读取确认写入结果。`)); });
    });
    // Startup failure is observable through call(), even before the first call.
    this.ready.catch(() => {});
  }
  fail(error) {
    this.closed = true;
    this.rejectReady(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.cleanup(); entry.reject(error); }
    this.pending.clear();
    void this.worker.terminate();
  }
  async call(operation, args, owner, { signal, authorize } = {}) {
    if (this.closed) throw failure('database-unavailable', 'SQLite 工作线程不可用，请检查日志后重启插件。');
    if (this.pending.size >= this.maxQueued) throw failure('queue-full', 'SQLite 请求队列已满，请稍后重试。', 429);
    const id = ++this.nextId;
    const cancelBuffer = new SharedArrayBuffer(4);
    const cancel = new Int32Array(cancelBuffer);
    const abort = () => Atomics.store(cancel, 0, 1);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = failure('outcome-unknown', 'SQLite 操作超时；没有报告成功，请重新读取确认结果。');
        if (operation === '_batchTransfer') {
          // Keep the entry queued until the worker acknowledges it. A timed-out
          // batch must not kill unrelated jobs or become an unbounded retry queue.
          abort(); reject(error);
        } else this.fail(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      this.ready.then(async () => {
        if (!this.pending.has(id)) return;
        if (authorize) await authorize();
        if (!this.pending.has(id)) return;
        this.worker.postMessage({ id, operation, args, owner, cancel: cancelBuffer });
      }).catch((error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id); clearTimeout(timer); entry.cleanup(); reject(error);
      });
    });
  }
  async close() {
    if (this.closed) { await this.worker.terminate(); return; }
    try { await this.call('_close', [], ''); }
    finally { this.fail(failure('database-unavailable', 'SQLite 插件已经关闭。')); await this.worker.terminate(); }
  }
}
