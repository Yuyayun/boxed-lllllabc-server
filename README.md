# 箱装辣白菜 SQLite 服务器插件

箱装辣白菜的**可选** SillyTavern 服务器插件，与 [前端扩展](https://github.com/Yuyayun/boxed-lllllabc) 分仓库、独立安装和更新。只装前端即可使用 IndexedDB；安装本插件不会切换存储方式或迁移任何前端数据。

当前版本 `1.0.0-dev.5`，存储协议 `5`，SQLite schema `3`。P7 已完成指定大目录样本和两个酒馆版本的软件回归，P4/P5 的快照与批量清理继续保留；真实手机等发布验收尚未结束。只在独立测试环境验收此开发版本。

## 运行条件

- Node.js **22.14.0 或以上**，需要内置 `node:sqlite`。本机已验证 Node 22.14.0 和 24.15.0。Node 22 的 SQLite 模块仍有实验性提示，未来 Node/SQLite 升级需重新验证。
- 已实测 SillyTavern **1.15.0 和 1.19.0** 的 `init(router)`/`info`/`exit`、服务端用户 API、会话及 CSRF 路由。其他版本暂未验证；身份接口不可靠时拒绝 SQLite，不猜测权限。
- 仅支持关闭账户系统的 Default-user，或**唯一启用账户且登录会话与它一致**。多于一个启用账户时拒绝 SQLite 读写。它不是多用户数据库，不提供跨设备同步。
- 使用酒馆的登录态和 CSRF。关闭酒馆 CSRF 保护会使本插件拒绝操作。

## 安装

在服务器上，将**本仓库根目录**安装为酒馆 `plugins/boxed-lllllabc-server`：

```sh
git clone https://github.com/Yuyayun/boxed-lllllabc-server.git plugins/boxed-lllllabc-server
```

本插件没有 npm 安装依赖；SQLite 由 Node 内置。不要把它装进 `public/scripts/extensions/third-party`。

编辑酒馆 `config.yaml`，启用 `enableServerPlugins: true`，然后重启酒馆。启用服务端插件是用户主动操作，前端不会代为下载或安装。当前仓库是开发版本，本地阶段成果未推送时，远端可能尚无可安装内容；应以实际仓库内容和发布记录为准。

可选的**服务器侧**数据库目录配置如下；必须为专用绝对路径，浏览器不能提交路径：

```yaml
boxedLllllabc:
  databaseDirectory: /absolute/path/to/boxed-lllllabc-storage
```

不配置时使用酒馆数据根目录的同级 `boxed-lllllabc-storage` 文件夹。固定文件名 `boxed-lllllabc.sqlite`；禁止放在原生数据、public、plugins 或 node_modules 内。数据库不属于前端扩展或插件安装目录。首次成功请求绑定可信账户 handle；账户归属不符时保留旧库并拒绝访问，不自动改名或转交数据。

## API 与数据安全

- 同源路由 `/api/plugins/boxed-lllllabc/status`、`/operation` 和 `/transfer`，只接受已定义的备份操作。写请求必须有酒馆原生 CSRF 头；不接受任意 SQL、文件路径或客户端 `isSingleUser` 声明。
- `GET /status` 返回协议、可写状态、记录统计和 SQLite 自身文件/WAL/SHM 占用，不使用浏览器配额充当服务器空间。
- `POST /operation` 请求 `{ protocol: 5, operation, args }`。`args` 使用前后端共用的无损标记编码；返回 `{ok, protocol, value}`，失败则为非 2xx `{ok:false, protocol, code, reason}`。前端客户端位于前端仓库 `src/storage/sqlite-client.js`。
- 仅开放业务操作，不提供直接删除 pending 的接口。清理指纹、冻结/待确认保护和身份迁移使用与 IndexedDB 相同的事务规则。
- Date、undefined、null、多 swipe、嵌套字段等无损保存。循环引用或不支持的值明确失败，禁止 JSON 静默丢字段。
- SQLite 在**同进程工作线程**中运行，不另启 Node 服务；串行执行、有界队列 32、忙等待 1 秒、WAL、FULL 同步、每操作事务。请求中断的取消标记在提交前检查；pending 还会复核原记录内容。
- 单请求上限 16 MiB、单记录 8 MiB；普通业务读取上限 25,000 行/32 MiB，响应上限 32 MiB。超限明确拒绝，不丢记录。切换使用每页最多 100 条/约 2 MiB（单条较大时单独一页），不走有过滤的全局目录。全局目录分页及完整压力验收仍待后续阶段。
- 超时或工作线程崩溃返回“结果未知/不可用”，不声称写入成功。请重读确认，检查日志后重启插件；不自动切换存储。
- 新库有应用标识和 schema 版本。已识别箱装旧库 0/1/2→3 前先做一致备份，再事务升级；损坏、未知或未来版本不覆盖为空库，不提供任意 SQLite 导入。
- 权限错误、只读、锁占用、满盘及坏记录均拒绝相应操作。无法保证同进程插件的绝对物理隔离，也不宣称零性能影响。

## 更新、停用与卸载

更新前停止酒馆，对数据库做一致备份（停止后保留 SQLite 及仍存在的 WAL/SHM 文件），更新插件代码后重启。不要在运行期间只复制主 `.sqlite` 文件来充当一致备份。协议不兼容时前端拒绝操作。

停用 `enableServerPlugins` 或停止酒馆后移除插件安装目录都**不删除数据库**。重新安装兼容插件可读原数据。以后活动端为 SQLite 时，插件不可用应报告失败，不回退写入 IndexedDB。

不提供“卸载时清空数据库”的行为。用户主动清空非活动端须在前端独立确认，使用经过校验的空暂存区事务替换，并读回确认；不删除数据库文件或用户设置。

## 聊天快照（P4）

协议 3 新增 `beginSnapshot`、`appendSnapshotMessages`、`publishSnapshot`、`getSnapshotHeader`、`getSnapshotMessages`、`listSnapshots`、`renameSnapshot`、`deleteSnapshot` 等受限业务操作。存档信息位于 `snapshots`，逐楼层正文位于 `snapshot_messages`，与普通备份分离。正文按条校验摘要，所有楼层完整后才发布；读取/恢复前再次校验完整性。管理列表可明确显示并删除未完成存档，不能恢复未完成存档。重命名仅改名称，不提供修改已发布正文的接口。

快照包含在完整切换的数量、主键、关联和内容摘要校验中，也包含在明确确认的非活动端清空中；普通备份清理不涉及快照。Rename 仅更新存档所属逻辑聊天，正文 ID 与内容保持不变。分批写入和分页读取沿用每次约 2 MiB、单记录 8 MiB 的限制；过大记录拒绝，不截断消息。

快照恢复由前端走酒馆原生聊天保存路径，本插件只负责箱装数据存储。只有实际保存内容核对一致才确认成功；失败时保留带元数据保存证明的保护记录与源快照，不靠界面变化认定保存完成。schema 0/1/2 升级到 3 前生成一致备份，未知/未来版本不会被覆盖。安装本插件仍不自动切换或迁移。

## 大目录摘要（P7）

协议 5 新增 `getBackupCatalog`。在同一数据库事务内逐聊天读取五类普通记录，复用前端目录/指纹/保护规则，只返回紧凑摘要，不把全部消息正文发送到浏览器。批量清理在同一删除事务中使用此摘要验证，不新增宽松删除规则。无效或缺失索引的记录会计入异常并阻止清理。

原普通整包接口仍保持每次 25,000 条/32MiB 限额；摘要及批量事务每次按聊天/类型读取，最多 25,000 条/128MiB。超限不截断，写入中途异常仍整批回滚。工作线程超时/队列、原生 CSRF、同源、单账户验证和持久切换锁继续适用。数据库 schema 3 不变。

前后端要同时兼容协议 5。前端始终可独立使用 IndexedDB；SQLite 断线或不兼容不自动回退。当前开发版本不代表全部平台和规模已完成发行验收。

## 普通备份批量清理（P5）

协议 4 新增受限的 `deleteBackupBatch({plan,confirmed:true})`。只针对活动端普通备份，在同一事务中重读整个选定范围、复核预览指纹和保护状态，再复用单聊天清理规则删除并修正元数据。pending 与冻结/等待确认的完整备份始终跳过，快照与其正文不在此事务的操作范围内。过期计划返回 `stale-cleanup-plan`，中途异常整批回滚；不支持任意表、SQL、路径或关闭保护规则的参数。

四种范围由前端生成预览，协议限制、单用户、CSRF、同源和持久切换锁同样适用。清理不更改前端活动端、备份设置或原生聊天文件，也不等同于清空非活动端。仍受普通读取和请求限额约束，超限明确失败；不分页截断后删除。网络结果未确认时先核对实际数据，不能自动重试旧计划。安装插件仍不自动切换或迁移。

## 切换与中断恢复

前端设置中通过「切换存储方式」明确确认覆盖目标端。`POST /transfer` 仅接受 `{protocol:5, action, args}`；action 限定为 status/source/prepare/append/page/seal/check/commit/rollback/finish。两端均保留持久任务锁；目标原数据在最终激活前保留事务回滚副本。普通读写在任务锁释放前拒绝执行，不自动回退到 IndexedDB。

活动端和恢复日志由当前浏览器独立控制库保存，服务端保留提交回执。重启后，尚未持久激活的操作回滚原目标；已激活的操作完成收尾。后端失联时保留锁和日志，在恢复连接后重试。不要手动删除锁、暂存表或浏览器控制库来跳过恢复。成功后来源原副本继续保留，不同步、不双写。任务使用临时空间；配额、磁盘或读回校验失败会拒绝切换。

## 测试与署名

运行 `npm test`。测试使用临时 SQLite 文件，包含关闭重开、事务回滚、保护规则、升级、只读、损坏、写锁和 `max_page_count` 注入 SQLITE_FULL，不会物理填满磁盘。

真实酒馆与浏览器集成记录保留于开发机本地阶段报告，不能仅凭 Node 测试宣称所有原生事件、恢复、手机视觉和压力验收通过。

原作：辣白菜 / labaicai0969。采用仓库 LICENSE 中的 AFPL 9；免费使用，禁止商业用途。`vendor/frontend` 是来自前端仓库的同一份事务规则与保护模块，保留完整原许可证和来源说明；不包含另一套备份算法。发布时须保留这些署名、许可和源代码。

参考：[SillyTavern 官方服务器插件规范](https://docs.sillytavern.app/for-contributors/server-plugins/)、[Node 22.14 SQLite 文档](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html)。
