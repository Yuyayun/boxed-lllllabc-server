import { Worker } from 'node:worker_threads';
import { failure } from './errors.js';

// Main-thread supervision remains runnable when synchronous SQLite work blocks
// the worker. Heartbeats and completed work are deliberately different clocks.
export class SqliteWorker {
  constructor(file,{maxQueued=32,timeoutMs=120000,heartbeatMs=1000,workerFactory=(url,options)=>new Worker(url,options)}={}) {
    this.maxQueued=maxQueued;this.timeoutMs=timeoutMs;this.nextId=0;this.pending=new Map();this.startedAt=Date.now();this.lastMessageAt=this.startedAt;this.lastProgressAt=this.startedAt;this.progressSeq=0;this.initializing=true;
    this.worker=workerFactory(new URL('./worker.js',import.meta.url),{workerData:{file,heartbeatMs}});
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});this.ready.catch(()=>{});
    this.worker.on('message',message=>this.message(message));
    this.worker.on('error',error=>this.fail(error));
    this.worker.on('exit',code=>{if(!this.closed)this.fail(failure('outcome-unknown',`SQLite 工作线程异常退出（${code}），需核对持久任务后恢复。`));});
  }
  notify(event){try{this.observe?.(event);}catch{/* Logging cannot change a committed database outcome. */}}
  message(message) {
    this.lastMessageAt=Date.now();
    if(message.type==='heartbeat')return;
    if(message.type==='progress') {
      this.lastProgressAt=Date.now();this.progressSeq++;this.stage=message.stage??this.stage;
      this.metrics=message.metrics??{};
      const entry=this.pending.get(message.id);if(entry){entry.lastProgressAt=this.lastProgressAt;entry.workSeq=(entry.workSeq??0)+1;}
      if(!entry||!entry.lastLoggedProgressAt||Date.now()-entry.lastLoggedProgressAt>=1000){if(entry)entry.lastLoggedProgressAt=Date.now();this.notify({taskId:entry?.taskId,operation:entry?.action??entry?.operation,stage:'progress',progressSeq:this.progressSeq,...message.metrics});}return;
    }
    if(message.ready){this.initializing=false;this.lastProgressAt=Date.now();this.resolveReady();return;}
    if(message.startupError){this.startupFailed=true;const error=Object.assign(new Error(message.startupError.message),{code:'database-unavailable'});this.rejectReady(error);this.notify({stage:'error',operation:this.stage??'initialize',errorCode:message.startupError.code??error.code,sqliteCode:message.startupError.sqliteCode});return;}
    const entry=this.pending.get(message.id);if(!entry)return;
    if(message.type==='started'){
      entry.startedAt=Date.now();entry.lastProgressAt=entry.startedAt;this.activeId=message.id;this.stage=entry.action??entry.operation;this.metrics={};
      this.notify({taskId:entry.taskId,operation:this.stage,stage:'started'});return;
    }
    this.pending.delete(message.id);clearInterval(entry.timer);entry.cleanup();if(this.activeId===message.id)this.activeId=null;this.lastProgressAt=Date.now();
    const state=message.value;
    this.notify({taskId:entry.taskId,operation:entry.action??entry.operation,stage:message.error?'error':'finished',errorCode:message.error?.code??(message.error?'database-error':undefined),sqliteCode:message.error?.sqliteCode,elapsedMs:Date.now()-entry.queuedAt,count:state?.summary?.count,verified:state?.verified,batch:state?.verifiedBatch,bytes:state?.summary?.bytes});
    if(message.error)entry.reject(Object.assign(new Error(message.error.message),message.error));else entry.resolve(state);
  }
  supervision() {
    const now=Date.now(),entry=this.pending.get(this.activeId),idleMs=now-(entry?.lastProgressAt??this.lastProgressAt),silentMs=now-this.lastMessageAt;
    return {state:this.closed?'unavailable':this.initializing?'initializing':!entry?'idle':idleMs>this.timeoutMs?'no-progress':silentMs>Math.min(15000,this.timeoutMs)?'unresponsive':idleMs>10000?'slow':'working',stage:this.stage??null,queued:this.pending.size,lastMessageAt:this.lastMessageAt,lastProgressAt:entry?.lastProgressAt??this.lastProgressAt,progressSeq:this.progressSeq,count:this.metrics?.count,verified:this.metrics?.verified,elapsedMs:entry?now-entry.queuedAt:now-this.startedAt};
  }
  fail(error) {
    if(this.closed)return;this.closed=true;this.rejectReady(error);
    for(const entry of this.pending.values()){clearInterval(entry.timer);entry.cleanup();entry.reject(error);this.notify({taskId:entry.taskId,operation:entry.action??entry.operation,stage:'error',errorCode:error.code??'worker-exit'});}
    this.pending.clear();void this.worker.terminate();
  }
  async call(operation,args,owner,{signal,authorize}={}) {
    if(this.closed)throw failure('database-unavailable','SQLite 工作线程不可用，请检查日志后重启插件。');
    if(this.pending.size>=this.maxQueued)throw failure('queue-full','SQLite 请求队列已满，请稍后核对已有任务。',429);
    const id=++this.nextId,cancelBuffer=new SharedArrayBuffer(4),cancel=new Int32Array(cancelBuffer),abort=()=>Atomics.store(cancel,0,1);
    if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
    const action=operation==='_batchTransfer'?args[0]:operation==='_transfer'?args[0]:undefined;
    const taskId=operation==='_batchTransfer'?(action==='begin'?args[1]?.[0]?.id:args[1]?.[0]):operation==='_transfer'?args[1]?.id:undefined;
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,queuedAt:Date.now(),operation,action,taskId,cleanup:()=>signal?.removeEventListener('abort',abort)};
      entry.timer=setInterval(()=>{
        const latest=entry.startedAt?entry.lastProgressAt:Math.max(entry.queuedAt,this.lastProgressAt);
        if(!entry.timedOut&&Date.now()-latest>this.timeoutMs){entry.timedOut=true;abort();entry.reject(failure('outcome-unknown','SQLite 等待超时，长时间没有有效进展；请求结果待核对，工作线程未被自动终止。'));this.notify({taskId,operation:action??operation,stage:'timeout',errorCode:'outcome-unknown',elapsedMs:Date.now()-entry.queuedAt});}
      },Math.max(5,Math.min(1000,this.timeoutMs/4)));
      this.pending.set(id,entry);
      this.ready.then(async()=>{
        if(!this.pending.has(id))return;if(authorize)await authorize();if(!this.pending.has(id))return;
        this.worker.postMessage({id,operation,args,owner,cancel:cancelBuffer});
      }).catch(error=>{if(!this.pending.has(id))return;this.pending.delete(id);clearInterval(entry.timer);entry.cleanup();reject(error);});
    });
  }
  async close() {
    if(this.closed){await this.worker.terminate();return;}
    if(this.startupFailed){this.fail(failure('database-unavailable','SQLite 初始化失败后已关闭。'));await this.worker.terminate();return;}
    let timer;
    try{await Promise.race([this.call('_close',[],''),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
    finally{clearTimeout(timer);this.fail(failure('database-unavailable','SQLite 插件已经关闭。'));await this.worker.terminate();}
  }
}
