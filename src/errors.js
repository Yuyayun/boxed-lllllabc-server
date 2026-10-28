export function failure(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}
export function safeError(error) {
  if (['transfer-conflict','source-changed','target-changed','source-baseline-incomplete'].includes(error?.code)) return failure(error.code, error.message, 409);
  if (error?.code === 'stale-cleanup-plan') return error;
  if (/^(批量清理|请先选择角色|请先勾选)/.test(error?.message || '')) return failure('cleanup-conflict', error.message, 409);
  if (/^(聊天快照|快照名称|单条快照)/.test(error?.message || '')) return failure('snapshot-conflict', error.message, 409);
  if (/^(切换任务|另一项存储操作|切换操作|分页游标|切换批次|目标|传输摘要|重复批次|无法校验|正式|包含未知|发现|原始记录|单条原始|pending 主键|记录逐项|暂存)/.test(error?.message || '')) return failure('transfer-conflict', error.message, 409);
  if (error?.code && ['transfer-locked', 'invalid-request', 'protocol-incompatible', 'forbidden', 'multi-user', 'identity-unavailable', 'security-unavailable', 'owner-mismatch', 'cancelled', 'too-large', 'queue-full', 'outcome-unknown', 'database-unavailable'].includes(error.code)) return error;
  if (/^(这类备份|完整聊天备份|完整备份|冻结|当前聊天|缺少|无法识别)/.test(error?.message || '')) return failure('conflict', error.message, 409);
  return failure('database-unavailable', 'SQLite 读取或写入失败；没有报告保存成功，请检查服务器日志。');
}
