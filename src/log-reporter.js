import {formatRuntimeLog} from '../vendor/frontend/src/storage/runtime-log-format.js';
import {runtimeLogSeverity} from '../vendor/frontend/src/storage/runtime-log-labels.js';

const FINAL_WRITES=new Set(['commitBackupWrite','applyBackupPatch','replaceFullSnapshot','replaceRecentSnapshot','putFullMessages','putRecentMessages','putHistoricalChanges','putHistoricalChange','deletePendingChangesIfUnchanged','publishSnapshot','createSnapshot','deleteSnapshot','renameSnapshot','deleteBackupV2','deleteBackupBatchV2','deleteBackupBatch','deleteBackupTypeForChat','resolveFrozenFullBackup','migrateRenamedChatIdentity']);
export class LogReporter {
 constructor(getLogger,{now=()=>Date.now(),maxPerMinute=60}={}){
  this.getLogger=getLogger;this.now=now;this.maxPerMinute=maxPerMinute;this.health={available:true};this.contexts=new Map();this.frontendActivity=new Map();this.seen=new Map();this.pending=new Set();this.windowAt=-Infinity;this.windowCount=0;this.lastDaily=-Infinity;this.lastProgress=-Infinity;this.lastTerminal=-Infinity;this.lastProbe=-Infinity;this.suppressed=0;
 }
 remember(event,frontend){
  if(!event.taskId)return;
  if(['switch','clear'].includes(event.kind)){
   if(this.contexts.size>=32&&!this.contexts.has(event.taskId))this.contexts.delete(this.contexts.keys().next().value);
   this.contexts.set(event.taskId,{kind:event.kind,from:event.from,to:event.to});
  }
  if(frontend){if(this.frontendActivity.size>=32&&!this.frontendActivity.has(event.taskId))this.frontendActivity.delete(this.frontendActivity.keys().next().value);this.frontendActivity.set(event.taskId,this.now());}
 }
 accepted(input){
  const event={...this.contexts.get(input.taskId),...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined)),...(input.kind==='restore'?{operation:'restore'}:{})},now=this.now();
  const severity=runtimeLogSeverity(event);
  if(!event.taskId&&!event.recoveryId&&!event.errorCode&&event.operation!=='worker'){
   if(event.stage!=='finished'||!FINAL_WRITES.has(event.operation)||now-this.lastDaily<60000)return null;
   this.lastDaily=now;
  }
  const key=JSON.stringify([event.stage==='restore-blocked'?undefined:event.recoveryId,event.taskId,event.chatRef,event.operation,event.stage,event.errorCode,event.causeCode,event.workerExitCode,event.backupStore,event.workStage,...(!event.errorCode&&!event.recoveryId?[event.count,event.verified,event.batch]:[])]);
  const previous=this.seen.get(key);
  if(previous!==undefined&&now-previous<60000){this.suppressed++;return null;}
  if(now-this.windowAt>=60000){this.windowAt=now;this.windowCount=0;}
  const essential=event.operation==='worker'||event.recoveryId&&event.stage!=='restore-blocked'||event.taskId&&['registered','completed','cancelled','paused','recover','committed','activated','error','timeout'].includes(event.stage);
  if(this.windowCount>=this.maxPerMinute&&!essential){this.suppressed++;return null;}
  this.windowCount++;
  if(this.seen.size>=256&&!this.seen.has(key))this.seen.delete(this.seen.keys().next().value);
  this.seen.set(key,now);
  return {...event,severity,...(this.suppressed?{suppressedCount:this.takeSuppressed()}:{} )};
 }
 takeSuppressed(){const value=this.suppressed;this.suppressed=0;return value;}
 failed(){if(this.health.available)console.warn('[箱装辣白菜] 运行日志暂时无法写入；备份结果仍以任务登记为准。请检查服务器备份目录。');this.health={available:false};}
 async probe(){
  if(this.now()-this.lastProbe<60000)return;this.lastProbe=this.now();
  try{await this.getLogger().probe();}catch{this.failed();}
 }
 record(input,frontend=false){
  this.remember(input,frontend);const event=this.accepted(input);if(!event)return Promise.resolve(null);
  const task=(async()=>{
   try{
    const row=await this.getLogger().record(event);this.health={available:true};
    if(row.category==='error'||row.recoveryId||['registered','completed','cancelled','paused','recover'].includes(row.stage)||this.now()-this.lastTerminal>=5000){console.log('[箱装辣白菜]',formatRuntimeLog(row,{utc:true}));this.lastTerminal=this.now();}
    return row;
   }catch(error){this.failed();console.error('[箱装辣白菜]',formatRuntimeLog({...event,timestamp:new Date(this.now()).toISOString()},{utc:true}),'（本条日志未能写入文件）');throw Object.assign(error,{runtimeLogReported:true});}
  })();
  this.pending.add(task);task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
 }
 observe(event){
  this.remember(event,false);
  if(!event.errorCode&&event.taskId){
   if(['inspect','status'].includes(event.operation))return;
   if(event.stage==='progress'){
    if(this.now()-(this.frontendActivity.get(event.taskId)??-Infinity)<10000||this.now()-this.lastProgress<5000)return;
    this.lastProgress=this.now();
   }else if(event.stage==='started'?!['begin','commit','activate','beginAbort'].includes(event.operation):!['begin','commit','activate','beginAbort','release'].includes(event.operation))return;
  }
  void this.record(event).catch(()=>{});
 }
 consoleOnly(input){const event=this.accepted(input);if(event)console.error('[箱装辣白菜]',formatRuntimeLog({...event,timestamp:new Date(this.now()).toISOString()},{utc:true}));}
 async idle(){await Promise.allSettled([...this.pending]);}
}
