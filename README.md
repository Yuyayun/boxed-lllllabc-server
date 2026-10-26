# 箱装辣白菜 SQLite 服务器插件

箱装辣白菜的**可选** SillyTavern 服务器插件，与 [前端扩展](https://github.com/Yuyayun/boxed-lllllabc) 分仓库、独立安装和更新。只装前端即可使用 IndexedDB；安装本插件不会切换存储方式或迁移任何前端数据。

当前版本 `1.0.0-dev.1`，存储协议 `1`，SQLite schema `1`。这是分阶段开发版本：P2 已提供受限 API 和数据库，用户存储切换尚待 P3，快照功能尚待 P4，完整发布验收尚未结束。不要在日常数据上试验迁移或清理。

## 运行条件

- Node.js **22.14.0 或以上**，需要内置 `node:sqlite`。本机已验证 Node 22.14.0 和 24.15.0。Node 22 的 SQLite 模块仍有实验性提示，未来 Node/SQLite 升级需重新验证。
- 已实测 SillyTavern **1.15.0** 的 `init(router)`/`info`/`exit`、服务端用户 API、会话及 CSRF 路由。其他版本暂未验证；身份接口不可靠时拒绝 SQLite，不猜测权限。
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

- 同源路由 `/api/plugins/boxed-lllllabc/status` 和 `/operation`，只接受已定义的备份操作。写请求必须有酒馆原生 CSRF 头；不接受任意 SQL、文件路径或客户端 `isSingleUser` 声明。
- `GET /status` 返回协议、可写状态、记录统计和 SQLite 自身文件/WAL/SHM 占用，不使用浏览器配额充当服务器空间。
- `POST /operation` 请求 `{ protocol: 1, operation, args }`。`args` 使用前后端共用的无损标记编码；返回 `{ok, protocol, value}`，失败则为非 2xx `{ok:false, protocol, code, reason}`。前端客户端位于前端仓库 `src/storage/sqlite-client.js`。
- 仅开放业务操作，不提供直接删除 pending 的接口。清理指纹、冻结/待确认保护和身份迁移使用与 IndexedDB 相同的事务规则。
- Date、undefined、null、多 swipe、嵌套字段等无损保存。循环引用或不支持的值明确失败，禁止 JSON 静默丢字段。
- SQLite 在**同进程工作线程**中运行，不另启 Node 服务；串行执行、有界队列 32、忙等待 1 秒、WAL、FULL 同步、每操作事务。请求中断的取消标记在提交前检查；pending 还会复核原记录内容。
- 单请求上限 16 MiB、单记录 8 MiB；单事务读取上限 25,000 行/32 MiB，响应上限 32 MiB。超限明确拒绝，不丢记录。全局目录的大数据分页、迁移批处理和压力验收仍待后续阶段。
- 超时或工作线程崩溃返回“结果未知/不可用”，不声称写入成功。请重读确认，检查日志后重启插件；不自动切换存储。
- 新库有应用标识和 schema 版本。升级前一致备份、事务升级；损坏、未知或未来版本不覆盖为空库。当前测试中的 schema 0→1 是识别为箱装的旧库；不是任意 SQLite 导入。
- 权限错误、只读、锁占用、满盘及坏记录均拒绝相应操作。无法保证同进程插件的绝对物理隔离，也不宣称零性能影响。

## 更新、停用与卸载

更新前停止酒馆，对数据库做一致备份（停止后保留 SQLite 及仍存在的 WAL/SHM 文件），更新插件代码后重启。不要在运行期间只复制主 `.sqlite` 文件来充当一致备份。协议不兼容时前端拒绝操作。

停用 `enableServerPlugins` 或停止酒馆后移除插件安装目录都**不删除数据库**。重新安装兼容插件可读原数据。以后活动端为 SQLite 时，插件不可用应报告失败，不回退写入 IndexedDB。

不提供“卸载时清空数据库”的行为。用户主动清空非活动端属于前端 P3 的独立确认流程，本版本没有通用全库删除接口。

## 测试与署名

运行 `npm test`。测试使用临时 SQLite 文件，包含关闭重开、事务回滚、保护规则、升级、只读、损坏、写锁和 `max_page_count` 注入 SQLITE_FULL，不会物理填满磁盘。

真实酒馆与浏览器集成记录保留于开发机本地阶段报告，不能仅凭 Node 测试宣称所有原生事件、恢复、手机视觉和压力验收通过。

原作：辣白菜 / labaicai0969。采用仓库 LICENSE 中的 AFPL 9；免费使用，禁止商业用途。`vendor/frontend` 是来自前端仓库的同一份事务规则与保护模块，保留完整原许可证和来源说明；不包含另一套备份算法。发布时须保留这些署名、许可和源代码。

参考：[SillyTavern 官方服务器插件规范](https://docs.sillytavern.app/for-contributors/server-plugins/)、[Node 22.14 SQLite 文档](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html)。
