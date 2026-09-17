# ADR-0002：通过 Rust 存储层封装 SQLite

- 状态：Accepted
- 决策日期：2026-09-17
- 决策者：项目维护者
- 影响范围：数据持久化、Tauri IPC、事务、迁移和测试

## 背景

产品需要在每次编辑后自动保存，并支持覆盖、合并两种 JSON 导入方式。导入必须先完整校验，再以“全部成功或完全不写入”的方式更新数据库。

Tauri 官方 SQL 插件提供 SQLite 和 migration 支持，但当前 JavaScript API 没有完整的事务抽象，上游仍有事务支持的开放需求。让 React 前端直接发出多条 SQL 还会扩大权限面，使业务规则、事务和数据库结构泄漏到 UI。

## 决策

1. 使用 Rust `rusqlite` 存储层持有 SQLite 连接，并启用 bundled SQLite。
2. 数据库放在 Tauri 应用本地数据目录，文件名为 `pmplan.sqlite3`。
3. React 前端只通过业务级 Tauri commands 调用存储能力，不获得通用 SQL、任意路径或 shell 权限。
4. migration 作为只增不改的版本化 SQL 随应用打包，由 Rust 在打开数据库时按顺序执行。
5. 多步骤写入、依赖变更、覆盖导入和合并导入必须在 Rust 单事务中完成。
6. JSON 导入由 Rust 完成权威解析与校验；前端只负责选择文件、展示预览和收集确认。
7. 前端定义 storage gateway 接口，并提供 Tauri adapter 和测试用内存 adapter。
8. IPC 错误使用稳定的错误代码和可展示消息，不把原始 SQL 或本机路径直接暴露给 UI。

## 初始命令边界

命令按业务用途组织，包括：

- 加载完整画板和视图设置；
- 新建、重命名、删除母任务；
- 新建、编辑、移动、拉伸、删除子任务；
- 设置或解除母任务依赖；
- 保存视图设置；
- 分析、覆盖或合并导入；
- 生成并保存完整 JSON 导出。

具体命令可以在不改变本决策的前提下合并或拆分，但不得退化为“执行任意 SQL”接口。

## 理由

- `rusqlite` 提供连接级事务对象，可直接验证提交与回滚。
- 数据约束和事务集中在可信边界，能够保证导入失败不污染现有规划。
- Rust 层可以对 migration、外键、级联删除和异常恢复做独立测试。
- 前端不依赖数据库表结构，未来调整 schema 时只需保持业务命令契约。
- Tauri commands 支持带类型参数、返回值和错误的前端到 Rust 调用，符合窄 IPC 接口需求。

## 备选方案

### 前端直接使用 Tauri SQL 插件

不采用。它能减少早期 Rust 代码，但事务边界、权限收敛和测试隔离不符合覆盖/合并导入的可靠性要求。

### 浏览器 IndexedDB

不采用。它不符合 ADR-0001 已确认的 SQLite 权威存储，也会使桌面数据位置和迁移能力依附于 WebView 存储。

### 直接保存单个 JSON 文件

不采用。频繁自动保存、关系完整性、并发写入失败恢复和未来 schema migration 都需要额外自行实现。

## 影响

### 正向影响

- 导入、级联删除和多表编辑具有清晰的原子事务。
- UI 不接触 SQL 和数据库路径。
- 数据层能够在不启动 WebView 的情况下测试。
- Tauri capabilities 可以保持较小范围。

### 成本与约束

- 需要维护少量 Rust command、序列化类型和错误映射。
- TypeScript 与 Rust 两侧共享的数据契约需要契约测试防止漂移。
- 数据库操作不得阻塞 UI 主线程；命令实现需要选择合适的异步或阻塞任务边界。
- 已发布 migration 不允许原地修改，只能通过新 migration 演进。

## 验证要求

- migration 能在空数据库和上一 schema 版本上成功执行；
- 外键约束实际开启；
- 覆盖/合并导入的中途错误会回滚全部写入；
- 删除母任务时子任务和相关依赖不会残留；
- IPC 契约具有至少一组前后端一致性测试；
- 数据库异常不会让 UI 显示保存成功。

## 参考

- [Tauri：从前端调用 Rust](https://v2.tauri.app/zh-cn/develop/calling-rust/)
- [Tauri SQL 插件 README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/README.md)
- [Tauri SQL 插件事务支持跟踪](https://github.com/tauri-apps/plugins-workspace/issues/886)
- [rusqlite Transaction API](https://docs.rs/rusqlite/latest/rusqlite/struct.Transaction.html)
