# 箱装辣白菜服务器插件验收记录

## 当前 1.0.1 正式发布

- [发布前四项收尾](1.0.1-pre-release-finishing.md)：空闲提示、日志限频、用户公告与正式版本号。
- [本轮问题整改与效率对照](1.0.1-remediation-report.md)：01、05–11 修复与测试，02、03、04、12 的实测及后续方案。
- [本机验收结果与边界](1.0.1-desktop-acceptance.md)
- [Termux 使用者实机清单](1.0.1-termux-checklist.md)，尚待设备反馈
- [分阶段改造记录](1.0.1-migration-worklog.md)

当前前后端正式版本均为 `1.0.1`，正式发布入口为各仓库的 main 和 `v1.0.1`；`gpt/1.0.1-migration` 保留开发历史。[发布核对](release-1.0.1.md)列出本次版本及验证依据。下列阶段报告保留当时版本与结果，其中的开发版本号、未合并和未发布说明不代表当前发行状态。

## 1.0.0 历史验收入口

正式发布核对：[1.0.0 发布检查](https://github.com/Yuyayun/boxed-lllllabc/blob/v1.0.0/docs/acceptance/release-1.0.0.md)。以下固定链接保留各阶段当时状态，旧版本号或未发布不代表当前发行状态。

按用户 2026-10-27 的授权，前端与后端各自推送 `codex/1.0.0` 开发分支，不合并 main。七阶段验收报告统一归档在前端仓库，本仓库提供固定提交入口，避免两份报告后续漂移。

完整索引：[P1–P7 阶段验收报告](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/README.md)。

| 阶段 | 固定报告 | 后端关系 |
|---|---|---|
| P1 | [P0 基线与统一存储访问层](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P1-report.md) | 前端基线，当时尚无后端实现 |
| P2 | [可选 SQLite 服务器插件](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P2-report.md) | 独立插件、真实 SQLite、主机接线与权限 |
| P3 | [显式存储切换与恢复](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P3-report.md) | 暂存、分页、事务替换、回滚与恢复 |
| P4 | [聊天快照](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P4-report.md) | 快照持久化、校验与完整迁移 |
| P5 | [受保护的批量清理](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P5-report.md) | 事务内重核、保护与整批回滚 |
| P6 | [设置与目录布局](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P6-report.md) | 后端未修改，保留回归结果 |
| P7 | [软件、压力与跨版本验收](https://github.com/Yuyayun/boxed-lllllabc/blob/7e0678c53d720eda908616165a8d21ef81d86ee5/docs/acceptance/P7-report.md) | 协议 5、数百 MB 目录与批量事务修复、1.15/1.19 实测 |

验收所用前端源码为 `742a9adb3209aa2648bc7691bdeaeebdfafa3717`，后端源码为 `6b5dc99cd29cbf6066e146447ff0abfe627d13a3`。本次仅添加报告入口，不修改产品源码、版本号、协议或验收结果。最终前端测试 284/284；后端在 Node 22.14.0 与 24.15.0 各 38/38。本次提交未重跑这些测试。

P7 的本机软件验收已通过，真实手机、实际软键盘、Safari 与外部模型生成等未执行，不能据此宣称 P7 全部完成或正式发布 1.0.0。Git 分支推送也不等于已验收真实 GitHub 安装/更新流程，详见报告范围。

报告内“不提交报告”“未推送”等文字保留当时历史状态。需求规范仍仅保留本机，原始日志、截图、测试脚本、数据库及浏览器资料未上传；机器路径与日常配置校验值已在公开报告中替换。

本插件严格可选，前端单独安装默认使用 IndexedDB；安装或检查插件不自动切换、不自动迁移。前后端始终分仓库维护。
