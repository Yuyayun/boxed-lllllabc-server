# 超大聊天有界备份支持

2026-11-17，分支 `codex/large-chat-backups`，基于 main／v1.0.1 提交 `5d8fff54cfcb5ea6dca522ff994431777b9860d2`。

本轮版本为 1.0.2，package 与 /status 的 pluginVersion 一致；更新说明已写入 CHANGELOG.md。尚未推送或发布。

协议继续为 6，SQLite user_version 继续为 4。没有新表、索引、迁移或提高限额。

## 新能力

`/status` 声明 `capabilities.boundedBackup=1`。原接口保留，新接口仍走受限的 operation 路由，不接受 SQL／路径：

- `getBackupSummary`：聊天元信息、各类型数量和已有 revision。
- `getBackupPage`：按类型及游标读取有界正文或消息摘要，检查 revision。
- `getBackupCatalogPage`：数据库内部聚合，按聊天摘要分页，不返回正文。
- `applyBackupPatch`：有界目标变更与元数据在同一事务提交。
- `beginBackupWrite / appendBackupWrite / commitBackupWrite`：暂存并核验完整替换，最后一次事务发布。
- `getBackupWriteStatus / abortBackupWrite / cleanupBackupWrites`：结果核对及暂存清理。
- `deleteBackupV2 / deleteBackupBatchV2`：事务内复核版本和保护条件的清理。

暂存复用 transfer_rows，以独立 id／kind 和 plugin_meta 前缀区分迁移任务。发布检查绑定数据区、revision、数量和楼层连续性。中断不产生半份正式备份；重复批次逐条按无损协议值比较。正式消息结构与旧客户端保持一致。

改名接续在同一事务内使用有界游标，不再将全部消息汇集进大数组。快照发布与删除不再收集全部键。SQLite 迭代语句固定持有，兼容 Node 22 的 statement 生命周期。

## 验证

- Node 22.14.0：146/146；Node 24.15.0：146/146。Node 24 最终采用 test-concurrency=1，规避本机测试运行器并行 IPC 问题，未跳过测试。
- 新测试涵盖 25001 层、超过 128 MiB、半份暂存重开、版本变化、重复批次、Date／undefined／BigInt、异常目录隔离、超大聊天改名和清理保护。
- 对应前端真实 HTTP 测试：135282448 字节单聊天写入、目录、完整分页读取通过；最大请求 1048849 字节；提交回执丢失可确认实际提交。
- 新前端／旧后端以及旧前端／新后端组合通过；原版 1.0.1 来自发布基线，不通过修改协议号实现兼容。
- 原浏览器迁移恢复契约 18 个场景、10 项界面检查通过，页面错误 0。

均为合成数据及隔离临时库。没有推送、发布或实际酒馆部署。手机实机及 Safari 尚未验证。
