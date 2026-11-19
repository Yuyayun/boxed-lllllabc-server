# 1.0.3 正式发布核对

日期：2026-11-20。配套[前端 1.0.3](https://github.com/Yuyayun/boxed-lllllabc/releases/tag/v1.0.3)，从 `codex/1.0.3-backup-race` 快进合并至 main，创建附注 Tag `v1.0.3` 和正式 GitHub Release。

运行代码基线为 `3f7e6b9`，前端为 `b68c38a`。本次发布整理只调整正式说明、验收索引及共享来源记录，不增加运行逻辑。

- 备份正文按类型区分版本，完整副本额外核对保护状态，避免无关核对写入干扰分页。
- 条件清除保护记录时，在同一事务中验证相应备份；支持前端接续中断的历史修改，旧接口继续保留。
- 日志区分具体操作、暂存/提交/步骤结果、错误原因和排队时间，减少同一次异常的重复记录。
- package/status 为 1.0.3，SQLite schema 4、协议 6 不变，无需清库或重迁移。30 个共享模块与正式前端逐字节一致；控制台显式选择 UTC，浏览器使用设备本地时间。
- 1.0.3 使用 CC BY-NC-SA 4.0，保留根 LICENSE 和 vendor/frontend/LICENSE；此前版本仍适用其发布时许可证。

## 本次验证

Node 22.14.0、24.15.0 各 150/150 通过，串行运行且不跳过。配套前端 352/352、SQLite 专项 19/19 通过。桌面和手机模拟的 IndexedDB 契约、9 组当前聊天布局，以及真实 HTTP 的 3001 层、约 129 MiB 聊天、60 页交错读取、两类回执丢失和两个 1.0.2 新旧组合均通过。

安装 ZIP 从最终提交生成，核对文件字节、内部模块引用、版本和许可证，不包含测试数据及本地运行时。完整配套记录见前端 [1.0.3 发布核对](https://github.com/Yuyayun/boxed-lllllabc/blob/v1.0.3/docs/acceptance/release-1.0.3.md)。

## 下载与安装

[服务器 Release](https://github.com/Yuyayun/boxed-lllllabc-server/releases/tag/v1.0.3) 提供 `boxed-lllllabc-server-v1.0.3.zip` 与 `SHA256SUMS.txt`。解压目录为 `boxed-lllllabc-server`，放入酒馆 plugins；GitHub 自动源码包保留完整源码及测试。

服务器插件继续可选，Node.js 要求仍为 22.14.0 或以上并提供内置 SQLite。使用服务器存储时两端共同更新，更新前停止酒馆，保留现有备份目录；安装或发布不自动切换位置、迁移数据。

桌面设备模拟不代表 Android/Termux、Safari 或真实用户数据库已经全部验收；自动化没有访问真实聊天或备份库。
