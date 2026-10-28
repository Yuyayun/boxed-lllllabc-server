import { parentPort, workerData } from 'node:worker_threads';
import { SqliteRepository } from './sqlite.js';
import { validateBatchCall } from '../vendor/frontend/src/storage/protocol.js';

let repository;
let currentJob=null,workSeq=0;
const report=(metrics={},stage)=>parentPort.postMessage({type:'progress',id:currentJob?.id,stage,metrics:{...metrics,progressSeq:++workSeq}});
const heartbeat=setInterval(()=>parentPort.postMessage({type:'heartbeat',id:currentJob?.id}),workerData.heartbeatMs??1000);heartbeat.unref();
report({},'initialize');
try { repository = new SqliteRepository(workerData.file); repository.reportProgress=report; await repository.initialize();parentPort.postMessage({ ready: true }); }
catch (error) { const message=/^(旧库|旧任务|启动检查|发现|包含|单条|原始|SQLite 不属于|只读)/.test(error.message)?error.message:'SQLite 启动检查失败，请查看运行日志中的阶段及错误代码；原数据未被当作空库覆盖。';parentPort.postMessage({ startupError: { code: error.code, message,sqliteCode:error.errcode } }); }
let queue = Promise.resolve();
parentPort.on('message', (job) => {
  queue = queue.then(async () => {
    currentJob=job;parentPort.postMessage({type:'started',id:job.id});
    try {
      if (!repository) throw new Error('SQLite 初始化失败。');
      const cancel = new Int32Array(job.cancel);
      if (Atomics.load(cancel, 0)) throw Object.assign(new Error('请求已取消。'), { code: 'cancelled', status: 409 });
      let value;
      if (job.operation === '_close') { repository.close(); value = true; }
      else {
        repository.owner(job.owner);
        if (job.operation === '_batchTransfer') {
          const [action, args] = job.args;
          validateBatchCall(action, args, 'sqlite'); repository.cancel = cancel;
          try { value = await repository.batchTransfer[action](...args); }
          finally { repository.cancel = null; }
        } else if (job.operation === '_transfer') {
          repository.cancel = cancel;
          try { value = await repository.transfer(...job.args); }
          finally { repository.cancel = null; }
        } else value = job.operation === '_status' ? repository.status() : await repository.execute(job.operation, job.args, cancel);
      }
      parentPort.postMessage({ id: job.id, value });
    } catch (error) {
      parentPort.postMessage({ id: job.id, error: { code: error.code, message: error.message, status: error.status,sqliteCode:error.errcode } });
    } finally {currentJob=null;}
  });
});
