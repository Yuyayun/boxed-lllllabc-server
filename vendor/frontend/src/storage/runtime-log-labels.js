// Fixed labels only: callers must never turn chat text, SQL, paths or raw error
// messages into a log label. New storage operations need an explicit entry here.
export const RUNTIME_LOG_OPERATIONS = Object.freeze({
  getBackupSummary:'读取当前聊天备份摘要', getBackupPage:'分批读取备份内容', getBackupCatalogPage:'分批读取全部聊天备份目录',
  beginBackupWrite:'准备分批写入备份', appendBackupWrite:'写入备份暂存批次', commitBackupWrite:'提交分批备份',
  abortBackupWrite:'撤销备份暂存写入', getBackupWriteStatus:'核对分批备份写入结果',
  deleteBackupV2:'删除指定类型备份', applyBackupPatch:'更新备份的变更楼层', deleteBackupBatchV2:'批量删除选定备份', cleanupBackupWrites:'清理过期备份暂存',
  getChatMeta:'读取聊天信息', putChatMeta:'保存聊天信息', updateChatMetaSummary:'更新聊天备份摘要和核对状态',
  getRecentMessages:'读取最近楼层备份', putRecentMessages:'保存最近楼层备份', replaceRecentSnapshot:'替换最近楼层备份',
  getFullMessages:'读取完整聊天备份', putFullMessages:'保存完整聊天备份', replaceFullSnapshot:'替换完整聊天备份',
  getHistoricalChanges:'读取历史楼层改动', putHistoricalChanges:'保存历史楼层改动', putHistoricalChange:'保存历史楼层改动',
  getPendingChanges:'读取未保存变更保护记录', putPendingChanges:'保存未保存变更保护记录', replacePendingChanges:'替换未保存变更保护记录',
  deletePendingChangesIfUnchanged:'核对并清除已满足条件的保护记录', getBackupCatalogData:'读取备份目录数据',
  reconcileChatIdentity:'核对聊天身份', migrateRenamedChatIdentity:'接续改名聊天的备份', deleteBackupTypeForChat:'删除当前聊天指定类型备份',
  resolveFrozenFullBackup:'处理暂停更新的完整备份', deleteBackupBatch:'批量清理选定备份', getBackupCatalog:'读取全部聊天备份目录',
  beginSnapshot:'建立聊天快照草稿', appendSnapshotMessages:'写入聊天快照暂存批次', publishSnapshot:'发布完整聊天快照',
  getSnapshotHeader:'读取聊天快照信息', getSnapshotMessages:'分批读取聊天快照内容', listSnapshots:'读取聊天快照列表', renameSnapshot:'重命名聊天快照', deleteSnapshot:'删除聊天快照',
  createSnapshot:'创建聊天快照', _status:'检查服务器存储', _close:'关闭服务器存储', initialize:'准备服务器存储',
  request:'处理服务器存储请求', _operation:'校验备份操作请求', _transfer:'处理旧版存储任务', _batchTransfer:'处理分批存储任务',
  _readLogs:'读取运行日志', _writeLogEvent:'记录存储任务日志', _cleanupLogs:'清理已结束任务的日志',
  begin:'登记存储任务', status:'读取存储任务状态', inspect:'核对存储任务记录', prepareStep:'准备目标存放位置',
  sourceNext:'读取来源备份批次', append:'写入目标备份批次', verifyBatch:'读回核对目标批次', startSeal:'开始最终核对', sealStep:'分批最终核对',
  startSourceCheck:'开始复核来源', sourceCheckStep:'分批复核来源', commit:'提交本次存储变更', activate:'确认启用存储结果',
  beginAbort:'开始撤销存储任务', finishStep:'整理存储任务收尾数据', release:'解除已结束任务的锁定', rollback:'回滚旧版存储任务', finish:'完成旧版存储任务收尾',
});

const backupTypes = Object.freeze({full_messages:'完整聊天备份',recent_messages:'最近楼层备份',historical_changes:'历史楼层改动',pending_changes:'未保存变更保护记录'});
const typedVerbs = Object.freeze({getBackupPage:'分批读取',beginBackupWrite:'准备分批写入',applyBackupPatch:'更新',deleteBackupV2:'删除',deleteBackupBatchV2:'批量删除'});
export function runtimeLogContext(operation,args=[]) {
  const store=args[0]?.store;
  return typeof operation==='string'&&Object.hasOwn(typedVerbs,operation)&&typeof store==='string'&&Object.hasOwn(backupTypes,store)?{backupStore:store}:{};
}
export function runtimeLogOutcome(operation,value) {
  if(!['beginBackupWrite','appendBackupWrite','commitBackupWrite','abortBackupWrite','getBackupWriteStatus'].includes(operation))return {};
  return {backupState:['draft','committed','aborted'].includes(value?.state)?value.state:operation==='getBackupWriteStatus'&&value==null?'missing':undefined,
    ...(typeof value?.store==='string'&&Object.hasOwn(backupTypes,value.store)?{backupStore:value.store}:{})};
}
export function runtimeLogOperation(entry) {
  if(Object.hasOwn(typedVerbs,entry.operation)&&Object.hasOwn(backupTypes,entry.backupStore))return typedVerbs[entry.operation]+backupTypes[entry.backupStore];
  if(Object.hasOwn(RUNTIME_LOG_OPERATIONS,entry.operation))return RUNTIME_LOG_OPERATIONS[entry.operation];
  return Object.hasOwn(workStages,entry.operation)?workStages[entry.operation]:'其他服务器存储操作';
}

const workStages = Object.freeze({
  initialize:'打开备份数据库', 'startup-audit':'逐页检查已有备份', 'startup-audit-complete':'已有备份检查完成',
  'storage-statistics':'统计备份占用空间', 'storage-statistics-complete':'空间统计完成',
  'upgrade-backup':'生成旧库升级前副本', 'upgrade-backup-complete':'升级前副本已生成', 'upgrade-backup-recheck':'复核升级前副本',
  'upgrade-source-recheck':'复核旧库来源', 'upgrade-copy-verified':'写入并核对新结构', 'upgrade-target-check':'核对升级结果',
  'upgrade-target-recheck':'复核已升级内容', 'upgrade-activated':'新结构已启用', 'upgrade-cleanup':'清理升级暂存',
  'operation-committed':'本次数据库处理已结束', 'legacy-inventory':'清点旧任务副本', 'legacy-clear':'整理旧任务恢复位置',
  'legacy-copy':'分批写回旧任务副本', 'legacy-verify':'核对旧任务恢复内容', 'legacy-cleanup':'清理旧任务暂存',
});
export function runtimeLogWorkStage(entry) {
  const key=Object.hasOwn(workStages,entry.workStage)?entry.workStage:entry.operation;
  return Object.hasOwn(workStages,key)?workStages[key]:undefined;
}

const readOperations = new Set(['_status','getBackupSummary','getBackupPage','getBackupCatalogPage','getBackupWriteStatus','getChatMeta','getRecentMessages','getFullMessages','getHistoricalChanges','getPendingChanges','getBackupCatalogData','getBackupCatalog','getSnapshotHeader','getSnapshotMessages','listSnapshots','status','inspect','sourceNext']);
export function runtimeLogResult(entry,defaultStage) {
  if(entry.errorCode==='outcome-unknown')return '结果尚待核对';
  if(entry.errorCode==='cancelled')return '请求已取消';
  if(entry.stage!=='finished')return defaultStage;
  if(entry.taskId)return '本步骤完成';
  if(entry.operation==='_status')return '连接检查完成';
  if(entry.operation==='abortBackupWrite'&&entry.backupState==='committed')return '备份已经提交，未执行暂存撤销';
  if(entry.operation==='abortBackupWrite'&&entry.backupState==='aborted')return '暂存写入已撤销';
  if(['commitBackupWrite','getBackupWriteStatus'].includes(entry.operation)&&entry.backupState==='committed')return '正式备份提交已确认';
  if(entry.operation==='getBackupWriteStatus'&&entry.backupState==='missing')return '未找到写入回执，请继续核对备份结果';
  if(entry.operation==='getBackupWriteStatus'&&entry.backupState==='draft')return '仍有暂存内容，尚未提交正式备份';
  if(entry.operation==='getBackupWriteStatus'&&entry.backupState==='aborted')return '本次暂存写入已撤销';
  if(entry.operation==='getBackupPage'||entry.operation==='getSnapshotMessages')return '本批读取完成';
  if(['beginBackupWrite','appendBackupWrite'].includes(entry.operation))return '暂存步骤完成，尚未提交正式备份';
  if(entry.operation==='beginSnapshot'||entry.operation==='appendSnapshotMessages')return '快照暂存步骤完成，尚未发布';
  if(entry.operation==='deletePendingChangesIfUnchanged')return '核对完成，仅清除满足条件的保护记录';
  return '本次存储请求完成';
}

const errors = Object.freeze({
  'outcome-unknown':'尚未确认最终结果，请先检查保存状态或存储任务记录，再决定是否重试',
  QuotaExceededError:'浏览器空间不足，请清理空间后重新检查备份', SQLITE_FULL:'服务器空间不足，请腾出空间后重新检查备份', 'disk-full':'存储空间不足，请腾出空间后重新检查',
  'database-unavailable':'服务器存储暂不可用，请检查服务器连接及备份目录权限', 'database-error':'数据库操作失败，请检查服务器连接、磁盘空间和目录权限',
  ERR_SQLITE_ERROR:'数据库读写失败，请检查服务器日志中的数据库错误代码',
  'permission-denied':'没有操作权限，请检查登录状态和服务器权限', forbidden:'服务器拒绝请求，请检查当前登录和访问方式',
  'security-unavailable':'酒馆请求保护未启用，服务器存储已拒绝操作，请检查服务器安全设置',
  'identity-unavailable':'无法核实当前账户，请检查登录状态', 'owner-mismatch':'当前账户与备份库归属不符，请使用原账户检查', 'multi-user':'当前账户配置不满足单用户存储条件，请检查服务器账户设置',
  'source-changed':'来源内容发生变化，已停止继续提交，请重新核对来源', 'target-changed':'目标内容发生变化，已停止继续提交，请重新核对存储任务',
  'source-baseline-incomplete':'来源清点未完成，无法确认完整范围，请按存储恢复提示处理',
  'backup-version-changed':'备份内容在操作期间发生变化，请重新查看或检查后再试', 'backup-conflict':'备份状态与本次操作条件不符，请重新查看后再试',
  'backup-source-changed':'当前聊天在备份期间发生变化，请等待最新一轮备份后重新检查',
  'backup-limit':'本批备份超过处理限额，请缩小范围后重试', 'too-large':'本次数据超过处理限额，请分批或缩小范围后重试',
  'backup-upgrade-required':'缺少所需备份能力，请同时更新前端扩展和服务器插件', 'protocol-incompatible':'前后端协议不兼容，请同时更新前端扩展和服务器插件',
  'transfer-locked':'存在未结束的存储任务，请先在备份位置设置中恢复或撤销任务', 'transfer-conflict':'存储任务记录或内容不一致，请先查看备份位置设置中的恢复提示',
  'recovery-required':'检测到未结束的存储任务，请按备份位置设置中的提示处理', 'recovery-conflict':'存储恢复条件不一致，请保留现有数据并检查任务记录',
  'context-changed':'当前聊天或生成状态已变化，已停止继续提交，请重新核对任务',
  'cleanup-conflict':'清理范围或状态已变化，请重新选择清理目标', 'stale-cleanup-plan':'备份已变化，原清理清单失效，请重新预览后再清理',
  'snapshot-conflict':'快照内容或状态与本次操作不符，请重新查看快照后再试', conflict:'当前备份保护条件不满足，请重新查看备份状态',
  'queue-full':'服务器请求正在排队，请等待已有操作结束后重试', 'invalid-request':'请求参数未通过检查，请确认前后端版本一致后重试',
  'worker-exit':'服务器存储线程已退出，请检查服务器日志并在重启后核对操作结果', paused:'任务已暂停，请在备份位置设置中继续处理',
});
export function runtimeLogError(entry) {
  if(entry.errorCode==='cancelled'){
    if(entry.operation==='_status')return '本次连接检查已取消，可重新检查服务器连接';
    if(readOperations.has(entry.operation))return '本次读取已取消，未取得完整读取结果，可重新查看';
    return '本次请求已取消，需要检查操作结果后再继续';
  }
  if(['database-error','database-unavailable','ERR_SQLITE_ERROR'].includes(entry.errorCode)){
    const sqlite=Number.isSafeInteger(entry.sqliteCode)?entry.sqliteCode&255:null;
    const sqliteErrors={5:'数据库正被其他操作占用，请稍后重新检查',6:'数据库暂时被锁定，请等待已有操作结束',8:'备份目录或数据库只读，请检查写入权限',10:'数据库读写发生磁盘错误，请检查磁盘及目录权限',11:'数据库完整性检查异常，请保留原库并检查服务器日志',13:'服务器空间不足，请腾出空间后重新检查备份',14:'无法打开备份数据库，请检查目录及访问权限',26:'数据库文件格式异常，请保留原文件并检查服务器日志'};
    if(sqliteErrors[sqlite])return sqliteErrors[sqlite];
  }
  return Object.hasOwn(errors,entry.errorCode)?errors[entry.errorCode]:'未识别的操作异常，请结合操作名称及错误代码检查服务器日志';
}
