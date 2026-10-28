// Private acceptance worker: real repository/recovery code with artificial
// slow-device stalls after completed steps. Never loaded by the plugin.
import {parentPort,workerData} from 'node:worker_threads';
import {SqliteRepository} from '../../src/sqlite.js';
let current;
const repo=new SqliteRepository(workerData.file),wait=new Int32Array(new SharedArrayBuffer(4));
repo.reportProgress=(metrics={},stage)=>{parentPort.postMessage({type:'progress',id:current?.id,stage,metrics});if(current&&stage?.startsWith('legacy-'))Atomics.wait(wait,0,0,2500);};
await repo.initialize();parentPort.postMessage({ready:true});
setInterval(()=>parentPort.postMessage({type:'heartbeat'}),500).unref();let queue=Promise.resolve();
parentPort.on('message',job=>{queue=queue.then(async()=>{current=job;parentPort.postMessage({type:'started',id:job.id});try{
  let value;if(job.operation==='_close'){repo.close();value=true;}else{repo.owner(job.owner);repo.cancel=new Int32Array(job.cancel);if(job.operation==='_transfer')value=await repo.transfer(...job.args);else if(job.operation==='_status')value=repo.status();else value=await repo.execute(job.operation,job.args,repo.cancel);}parentPort.postMessage({id:job.id,value});
}catch(error){parentPort.postMessage({id:job.id,error:{code:error.code,message:error.message,status:error.status}});}finally{repo.cancel=null;current=null;}});});
