import { parentPort, workerData } from 'node:worker_threads';
import { SqliteRepository } from './sqlite.js';

let repository;
try { repository = new SqliteRepository(workerData.file); parentPort.postMessage({ ready: true }); }
catch (error) { parentPort.postMessage({ startupError: { code: error.code, message: error.message } }); }
let queue = Promise.resolve();
parentPort.on('message', (job) => {
  queue = queue.then(async () => {
    try {
      if (!repository) throw new Error('SQLite 初始化失败。');
      const cancel = new Int32Array(job.cancel);
      if (Atomics.load(cancel, 0)) throw Object.assign(new Error('请求已取消。'), { code: 'cancelled', status: 409 });
      let value;
      if (job.operation === '_close') { repository.close(); value = true; }
      else {
        repository.owner(job.owner);
        if (job.operation === '_transfer') {
          repository.cancel = cancel;
          try { value = await repository.transfer(...job.args); }
          finally { repository.cancel = null; }
        } else value = job.operation === '_status' ? repository.status() : await repository.execute(job.operation, job.args, cancel);
      }
      parentPort.postMessage({ id: job.id, value });
    } catch (error) {
      parentPort.postMessage({ id: job.id, error: { code: error.code, message: error.message, status: error.status } });
    }
  });
});
