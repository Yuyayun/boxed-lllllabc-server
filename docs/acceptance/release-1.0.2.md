# 1.0.2 正式发布核对

日期：2026-11-18。前后端从各自最新 main 配套发布 `v1.0.2`，服务器插件仍为可选组件。

## 发布范围

- 后端功能基线为 `c092156`，包含超大聊天分批备份及读取、权威目录摘要、完整备份暂存提交和回执核对；旧前端接口保留。
- 本次仅整理正式 README、更新日志日期、验收索引和发布记录，不修改运行时代码。package 与 status 版本均为 1.0.2。
- SQLite 版本 4、存储协议 6 保持不变，既有数据库无需重建。安装或升级不自动换用服务器存储，不自动迁移数据。
- 后端引用的 28 个前端模块中，27 个与前端 1.0.2 逐字节一致。`runtime-log-format.js` 保留服务器 UTC 控制台输出；前端本地时间格式化只影响显示，不改变日志传输或存储格式。

## 本次重跑验证

- Node 22.14.0、Node 24.15.0 下各 146/146 测试通过，串行运行，未跳过用例。
- 配套前端 338/338 测试通过；真实 Edge IndexedDB 桌面与手机模拟视口的大聊天、快照、手动核对及清理入口契约通过。
- 运行时代码语法和打包清单检查通过；安装包保留 `src`、`vendor`、根许可证及 `vendor/frontend/LICENSE`。
- 大规模 HTTP、旧版组合及重启的先前验收见[超大聊天链路记录](../2026-11-17-large-chat-backups.md)。本次发布不将未重复执行的压力测试或手机实机验收记为新通过。

## 包与正式入口

- [服务器插件 Release](https://github.com/Yuyayun/boxed-lllllabc-server/releases/tag/v1.0.2)：`boxed-lllllabc-server-v1.0.2.zip`，解压后将 `boxed-lllllabc-server` 放入酒馆的 `plugins`。
- [前端 Release](https://github.com/Yuyayun/boxed-lllllabc/releases/tag/v1.0.2)：`boxed-lllllabc-v1.0.2.zip`，前端也可以独立使用浏览器本地备份。
- 每个 Release 附 SHA256 校验文件，并保留 GitHub 自动生成的完整仓库源码 ZIP/TAR。
- 继续要求 Node.js 22.14.0 或以上及内置 `node:sqlite`。服务器插件需在酒馆配置中启用，更新前停止酒馆，保留现有备份目录。

## 使用者实机边界

Android/Termux、iOS/Safari、真实软键盘和使用者设备中的实际数据仍需独立验收。所有自动化检查使用隔离数据，不操作正式酒馆或使用者聊天数据库。
