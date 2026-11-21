# 1.0.4 正式发布核对

日期：2026-11-21。与[前端 1.0.4](https://github.com/Yuyayun/boxed-lllllabc/releases/tag/v1.0.4) 配套，从 `codex/1.0.4-backup-version` 快进合并至 main，发布附注 Tag `v1.0.4` 与正式 GitHub Release。

## 内容与兼容

普通 SQLite 事务根据实际 put/delete/deleteForChat 更新正文类型版本，不因打开 store、确认身份、空写入或无实际删除而制造变化。分批正式提交、空提交、暂存撤销和批量清理采用一致的 mutation 规则，同类型每事务只推进一次，失败回滚时版本也回滚。

真实正文变更仍使旧页失效；冻结/事件状态保护、有限重读、迁移 epoch、旧全局 revision 和条件核销证明保持生效。SQLite schema 4、协议 6 不变，无需清库、重新迁移或覆盖冻结副本。

package/status 统一为 1.0.4；状态接口版本测试直接比较 package.json。30 个 vendored 共用模块与前端逐字节一致，ORIGIN.json 记录最终前端来源提交。Node.js 要求仍为 22.14.0 或以上并提供 node:sqlite，根和 vendor 许可证保持 CC BY-NC-SA 4.0。

## 验证

发布前 Node 22.14.0、24.15.0 各 170/170，串行且无跳过；包含 20 项新增真实 SQLite 正文版本回归。配套前端 352/352、SQLite 旧楼层专项 19/19。Edge 桌面/360px 触摸模拟各 27 项 IndexedDB、各 32 项浏览器 → HTTP → worker → SQLite 通过，含完整预览、恢复中心和两个实际保存确认交错场景。

同一修复的大聊天、断线回执、旧版组合与 IndexedDB 事务原子性验收见[修复记录](2026-11-21-backup-version-fix.md)；配套完整发布记录见[前端发布核对](https://github.com/Yuyayun/boxed-lllllabc/blob/v1.0.4/docs/acceptance/release-1.0.4.md)。

安装包从最终提交生成，逐文件与 Git 核对，检查内部引用、语法、版本、许可证及 SHA256；排除测试、日志、数据库与本地运行时。

## 安装与边界

[服务器 Release](https://github.com/Yuyayun/boxed-lllllabc-server/releases/tag/v1.0.4) 提供 `boxed-lllllabc-server-v1.0.4.zip` 与 `SHA256SUMS.txt`。将解压后的 `boxed-lllllabc-server` 放入酒馆 plugins；Git 安装使用 main。服务器存储前后端共同更新；更新前停止酒馆并保留备份目录，发布本身不部署或迁移用户数据。

全部自动测试为隔离数据。真实手机/Safari/Termux 和用户原库未检查；浏览器夹具模拟酒馆原生聊天保存接口，服务器 HTTP、路由、worker 与 SQLite 使用真实实现。自动验收已完成，不要求使用者额外跑测试清单。
