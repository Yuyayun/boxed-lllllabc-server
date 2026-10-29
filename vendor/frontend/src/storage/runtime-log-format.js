const locations={indexeddb:'浏览器本地备份',sqlite:'服务器备份'};
const stages={registered:'开始任务',inventory:'正在清点备份',source:'来源清点完成','source-check':'正在核对来源','source-checked':'来源核对完成',prepare:'正在准备存放位置',prepared:'存放位置准备完成',append:'正在写入备份','batch-verified':'本批备份已读回核对','resume-batch':'正在核对中断前的备份','target-check':'正在做最后检查',verified:'最后检查通过',committing:'准备启用新位置',committed:'已确认存储提交结果','commit-check':'正在核对中断后的提交结果','target-checked':'提交结果核对完成','before-control':'准备确认使用位置',activated:'已确认使用位置','target-activated':'存储位置已确认','finish-target':'正在完成收尾','finish-source':'正在完成来源收尾','release-source':'来源收尾完成','release-target':'目标收尾完成',completed:'任务完成',cancelled:'任务已撤销',paused:'任务已暂停',recover:'正在核对中断任务',error:'操作出现异常',timeout:'等待超时，结果需要核对',started:'开始处理',finished:'处理完成',progress:'正在处理'};
const operations={putChatMeta:'保存聊天信息',putRecentMessages:'保存最近楼层备份',putFullMessages:'保存完整聊天备份',putPendingChanges:'保存未保存变更',putHistoricalChange:'保存历史楼层改动',getChatMeta:'读取聊天信息',getFullMessages:'读取完整聊天备份',getRecentMessages:'读取最近楼层备份',createSnapshot:'创建聊天快照',deleteSnapshot:'删除聊天快照',request:'备份请求',initialize:'准备服务器存储'};
const errors={'outcome-unknown':'操作结果尚待核对',QuotaExceededError:'浏览器空间不足',SQLITE_FULL:'服务器空间不足','database-unavailable':'服务器存储暂不可用','permission-denied':'没有操作权限','source-changed':'来源内容发生变化','target-changed':'目标内容发生变化'};
export function formatRuntimeLog(entry,{diagnostic=false}={}){
  const cleanup=entry.kind==='clear'||entry.scope==='cleanup';
  const subject=cleanup?`清空旧位置${locations[entry.to]?'：'+locations[entry.to]:''}`
    :entry.scope==='migration'||entry.kind==='switch'?`切换备份位置${locations[entry.from]&&locations[entry.to]?'：'+locations[entry.from]+' → '+locations[entry.to]:''}`
    :operations[entry.operation]??'日常备份操作';
  let stage=stages[entry.stage]??'正在处理';
  if(cleanup){const clearStages={committing:'准备确认清空结果',activated:'清空结果已确认',completed:'旧位置备份已清空',cancelled:'清空已撤销，原有备份保留',recover:'正在核对中断的清空任务','finish-target':'正在完成清理收尾'};stage=clearStages[entry.stage]??stage;}
  const parts=[entry.timestamp,subject,stage];
  if(Number.isSafeInteger(entry.count))parts.push(cleanup&&['finish-target','progress','finished'].includes(entry.stage)?`本任务已清理（含暂存）${entry.count} 条`:`本阶段已处理 ${entry.count} 条`);
  if(Number.isSafeInteger(entry.verified))parts.push(`已读回核验 ${entry.verified} 条`);
  if(Number.isSafeInteger(entry.elapsedMs))parts.push(`本次耗时 ${(entry.elapsedMs/1000).toFixed(1)} 秒`);
  if(entry.errorCode)parts.push(`${errors[entry.errorCode]??'发生异常，需要检查操作结果'}（错误代码：${entry.errorCode}）`);
  if(diagnostic)parts.push(`诊断：${JSON.stringify({taskId:entry.taskId,stage:entry.stage,operation:entry.operation,batch:entry.batch,bytes:entry.bytes,errorCode:entry.errorCode,sqliteCode:entry.sqliteCode})}`);
  return parts.filter(value=>value!==undefined&&value!==null).join(' | ');
}
