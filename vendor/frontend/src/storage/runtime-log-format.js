import {runtimeLogOperation,runtimeLogWorkStage,runtimeLogResult,runtimeLogError,shortLogRef} from './runtime-log-labels.js';
const locations={indexeddb:'浏览器本地备份',sqlite:'服务器备份'};
const stages={registered:'开始任务',inventory:'正在清点备份',source:'来源清点完成','source-check':'正在核对来源','source-checked':'来源核对完成',prepare:'正在准备存放位置',prepared:'存放位置准备完成',append:'正在写入备份','batch-verified':'本批备份已读回核对','resume-batch':'正在核对中断前的备份','target-check':'正在做最后检查',verified:'最后检查通过',committing:'准备启用新位置',committed:'已确认存储提交结果','commit-check':'正在核对中断后的提交结果','target-checked':'提交结果核对完成','before-control':'准备确认使用位置',activated:'已确认使用位置','target-activated':'存储位置已确认','finish-target':'正在完成收尾','finish-source':'正在完成来源收尾','release-source':'来源收尾完成','release-target':'目标收尾完成',completed:'任务完成',cancelled:'任务已撤销',paused:'任务已暂停',recover:'正在核对中断任务',error:'操作出现异常',timeout:'等待超时，结果需要核对',started:'开始处理',finished:'处理完成',progress:'正在处理'};
function formatLocalTimestamp(value) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatRuntimeLog(entry,{diagnostic=false,utc=false}={}){
  const cleanup=entry.kind==='clear'||entry.scope==='cleanup';
  const subject=cleanup?`清空旧位置${locations[entry.to]?'：'+locations[entry.to]:''}`
    :entry.kind==='switch'||entry.scope==='migration'&&locations[entry.from]&&locations[entry.to]?`切换备份位置${locations[entry.from]&&locations[entry.to]?'：'+locations[entry.from]+' → '+locations[entry.to]:''}`
    :entry.taskId?'存储任务（类型待核对）':runtimeLogOperation(entry);
  let stage=Object.hasOwn(stages,entry.stage)?stages[entry.stage]:'正在处理';
  if(cleanup){const clearStages={committing:'准备确认清空结果',activated:'清空结果已确认',completed:'旧位置备份已清空',cancelled:'清空已撤销，原有备份保留',recover:'正在核对中断的清空任务','finish-target':'正在完成清理收尾'};if(Object.hasOwn(clearStages,entry.stage))stage=clearStages[entry.stage];}
  stage=runtimeLogResult(entry,stage);
  const parts=[utc?entry.timestamp:formatLocalTimestamp(entry.timestamp),subject];
  const recoverySources={pending:'待确认改动',recent:'最近楼层备份',full:'完整聊天备份',historical:'历史楼层改动',snapshot:'聊天快照'};
  if(entry.recoveryId&&Object.hasOwn(recoverySources,entry.recoverySource))parts.push('来源：'+recoverySources[entry.recoverySource]);
  const references=[typeof entry.chatRef==='string'?`聊天#${entry.chatRef.slice(0,8)}`:'',typeof entry.recoveryId==='string'?`恢复#${shortLogRef(entry.recoveryId)}`:typeof entry.taskId==='string'?`任务#${shortLogRef(entry.taskId)}`:typeof entry.requestId==='string'?`请求#${shortLogRef(entry.requestId)}`:''].filter(Boolean);
  if(references.length)parts.push(references.join(' · '));
  if(entry.taskId&&entry.operation)parts.push(runtimeLogOperation(entry));
  const workStage=runtimeLogWorkStage(entry);if(workStage&&workStage!==subject&&entry.stage!=='finished')parts.push(workStage);
  parts.push(stage);
  if(Number.isSafeInteger(entry.count))parts.push(cleanup&&['finish-target','progress','finished'].includes(entry.stage)?`本任务已清理（含暂存）${entry.count} 条记录`:`本阶段已处理 ${entry.count} 条记录`);
  if(Number.isSafeInteger(entry.verified))parts.push(`已读回核验 ${entry.verified} 条记录`);
  if(Number.isSafeInteger(entry.elapsedMs))parts.push(`本次耗时 ${(entry.elapsedMs/1000).toFixed(1)} 秒`);
  if(Number.isSafeInteger(entry.queuedMs)&&entry.queuedMs>=1000)parts.push(`其中排队或初始化等待 ${(entry.queuedMs/1000).toFixed(1)} 秒`);
  if(Number.isSafeInteger(entry.targetCount))parts.push(`恢复目标 ${entry.targetCount} 层`);
  if(Number.isSafeInteger(entry.selectedOption))parts.push(`选择内容 ${entry.selectedOption}${entry.candidateCount?'／共 '+entry.candidateCount+' 套':''}`);
  if(Number.isSafeInteger(entry.workerExitCode))parts.push(`线程退出码 ${entry.workerExitCode}`);
  if(Number.isSafeInteger(entry.affectedCount)&&entry.affectedCount>0)parts.push(`受影响请求 ${entry.affectedCount} 个`);
  if(entry.causeCode)parts.push(`原因代码：${entry.causeCode}`);
  if(Number.isSafeInteger(entry.suppressedCount)&&entry.suppressedCount>0)parts.push(`已合并 ${entry.suppressedCount} 条重复或高频记录`);
  if(entry.errorCode){
    const detail=runtimeLogError(entry);
    parts.push(`${detail}（错误代码：${entry.errorCode}）`);
  }
  if(diagnostic)parts.push(`诊断：${JSON.stringify({taskId:entry.taskId,stage:entry.stage,operation:entry.operation,backupStore:entry.backupStore,backupState:entry.backupState,workStage:entry.workStage,batch:entry.batch,bytes:entry.bytes,errorCode:entry.errorCode,sqliteCode:entry.sqliteCode})}`);
  return parts.filter(value=>value!==undefined&&value!==null).join(' | ');
}
