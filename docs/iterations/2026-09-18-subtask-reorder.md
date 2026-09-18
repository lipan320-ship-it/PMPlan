# 迭代：子任务在母任务内可拖动调整顺序

- 日期：2026-09-18
- 状态：Completed
- 关联需求：REQ-2026-09-18-02
- 关联决策：docs/plans/2026-09-18-subtask-reorder.md

## 目标

为工作规划时间板的子任务提供与母任务一致的拖动重排能力：在所属母任务**内部**按住子任务行首手柄上下拖动即可调整顺序，并持久化，重启后保持。

## 范围

- 子任务行新增拖动手柄（视觉对齐母任务柄），按下后可在同一母任务内上下拖动重排。
- 复用母任务拖动交互：4px 阈值区分点击/拖动、指针捕获、拖动中抑制误触、松手落位高亮。
- 落点仅限同一母任务的子任务行；拖到其它母任务区域不处理（不做跨母移动）。
- 本地重算子任务 `sortOrder` 并乐观更新 `board`，调用 `gateway.reorderSubTasks` 持久化，失败时回滚并提示。
- 新增 `ReorderSubTasksInput`、网关方法（Memory / Tauri）、Rust `reorder_sub_tasks` 命令与事务存储；服务端校验 `orderedIds` 必须恰好等于该母任务全部子任务 id。
- 补充前端、内存网关与 Rust 三层测试，并更新需求登记、产品基线、验收矩阵。

## 完成结果

- 子任务重排完全对称母任务重排，复用既有拖拽架构，未引入新模式。
- `SubTask` 已含 `sortOrder`、`sub_tasks` 表已含 `sort_order` 列，故**未改动数据模型与数据库 schema、无迁移**。
- 落点查询限定在同母任务子任务行（`[data-sub-row-id][data-mother-row-id="<motherId>"]`），与母任务拖拽状态隔离，互不干扰。
- 自动化已覆盖：列宽持久化（上一轮）与本轮子任务重排的 App、Memory gateway、Rust SQLite 事务测试。

## 验证

- `npm run check:web`：typecheck、lint、30 个前端测试、lint:md、build 全部通过。
- `npm run check:rust`：19 个 Rust 测试通过，rustfmt 与 clippy 无告警。
- `git diff --check` 通过。

## 遗留事项

- 真实桌面窗口下的人工视口检查尚未执行：宽屏、1080px、700px、320px 的拖动与触控体验，以及同母任务内落点高亮、跨母任务不处理的真实渲染，需在 `npm run dev` / Tauri 桌面环境中补做。
