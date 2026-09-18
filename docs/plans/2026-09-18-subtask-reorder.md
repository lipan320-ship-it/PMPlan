# 计划：子任务在母任务内可拖动调整顺序

- 日期：2026-09-18
- 需求：REQ-2026-09-18-02
- 关联决策：无（复用既有母任务拖动架构，无独立 PRD）

## 背景与目标

母任务已支持在左侧任务树中按住拖动柄上下重排（Pointer Events + 乐观更新 + 持久化）。用户希望子任务也能以相同方式，在所属母任务**内部**上下拖动以调整顺序，让排期阅读顺序更贴合实际执行顺序。

目标：在不改动数据模型与数据库 schema 的前提下，为子任务行提供与母任务一致的拖动重排体验，并将新的子任务顺序持久化，重启后恢复。

## 范围

### 本次做

- 子任务行新增拖动柄（视觉对齐母任务柄），按住后可在**同一母任务内**上下拖动重排。
- 复用既有 Pointer Events 拖动模型：4px 阈值区分点击/拖动、指针捕获、拖动中抑制点击、松手落位。
- 落点仅限同一母任务的子任务行；拖到其它母任务区域不做处理。
- 本地重算子任务 `sortOrder` 并乐观更新 `board`，调用 `gateway.reorderSubTasks` 持久化，失败时回滚并提示。
- 新增 `reorderSubTasks` 网关方法（Memory + Tauri）、`ReorderSubTasksInput { motherId, orderedIds }`、Rust `Storage::reorder_sub_tasks` 与 `reorder_sub_tasks` 命令；服务端校验 `orderedIds` 必须恰好等于该母任务全部子任务 id（去重、不可缺失、不可多余）。
- 补充三层测试：前端拖动重排并持久化、内存网关校验、Rust 原子重排与越界拒绝。
- 更新需求登记、产品基线、验收矩阵。

### 本次不做

- 跨母任务移动子任务（拖到别的母任务下）——用户仅要求“在母任务内”。
- 子任务键盘重排——与母任务现有交互保持一致，仅指针拖动；若后续需可访问性增强再单独做。
- 列宽拖动等无关改动。
- 数据模型 / DB schema 迁移——`sub_tasks.sort_order` 列已存在，重排只更新其同母任务行。

## 执行分级

档位：中
预计步骤：新增网关与本地重排函数 / 加子任务拖拽 UI 与状态 / 实现 Rust 存储与命令 / 补三层测试 / 更新需求与验收文档
将跳过项：独立 PRD（范围小、复用既有交互，技术设计内联即可）；真实视口手工检查（以自动化为主，真实视口检查登记为遗留，同列宽需求）
预估工作量：约 12 处改动（TS UI + 网关接口 + memory + tauri + Rust storage/command/domain + 测试 + 文档）
降级：无

## 方案（技术设计）

### 前端 `src/features/board/BoardPage.tsx`

- 新增类型：`SubTaskDropPosition = "before" | "after"`；`SubTaskDropTarget { id: string; position: SubTaskDropPosition }`；`ActiveSubTaskDrag { pointerId; motherId; subTaskId; startY; moved }`。
- `reorderSubTasksWithinMother(tasks, motherId, draggedId, targetId, position)`：定位母任务，对其 `subTasks` 做与 `reorderMotherTasks` 同构的 `splice` + `sortOrder` 重映射，其它母任务保持不变；拖到自身或非同母目标直接返回原数组。
- `handleReorderSubTask(motherId, draggedId, targetId, position)`：镜像 `handleReorderMother`——`reorderedTasks` 与原序无变化则早退；乐观 `setBoard` → `gateway.reorderSubTasks({ motherId, orderedIds })` → 成功 toast「子任务排序已更新」→ 失败回滚 `setBoard` 并 error toast。
- 拖拽状态与三件套：`activeSubTaskDragRef`、`subTaskDropTargetRef`、`draggedSubTaskId`、`subTaskDropTarget`；`beginSubTaskDrag / updateSubTaskDrag / finishSubTaskDrag` 镜像母任务实现，但 `updateSubTaskDrag` 只查询 `[data-sub-row-id][data-mother-row-id="<motherId>"]` 的同级子任务行，过滤掉其它母任务。
- `TaskTreeRow` 增加 `onReorderSubTask` 等 props；子任务分支渲染 `subtask-drag-handle`（`data-testid=subtask-drag-handle-<id>`、`aria-label`「按住拖动调整子任务顺序」），并加 `is-dragging` / `is-drop-before|after` 样式类；在子任务行补 `data-sub-row-id` 与 `data-mother-row-id`。

### 网关层

- `src/domain/models.ts`：新增 `ReorderSubTasksInput { motherId: string; orderedIds: string[] }`。
- `src/storage/gateway.ts`：接口新增 `reorderSubTasks(input: ReorderSubTasksInput): Promise<void>`。
- `src/storage/memoryGateway.ts`：取出该母任务，校验 `orderedIds` 集合 === 该母任务 `subTasks` id 集合（长度、去重、全包含），否则抛 `DomainError("validation_error", "子任务排序必须完整包含每个子任务且不能重复。")`；事务式替换 `sortOrder`。
- `src/storage/tauriGateway.ts`：`reorderSubTasks(input) => invoke("reorder_sub_tasks", { input })`。

### Rust

- `src-tauri/src/domain.rs`：新增 `ReorderSubTasksInput { mother_id: String, ordered_ids: Vec<String> }`（`rename_all = "camelCase"`）。
- `src-tauri/src/commands.rs`：新增 `#[tauri::command(async)] reorder_sub_tasks(state, input) -> Result<(), CommandError>`。
- `src-tauri/src/storage.rs`：`reorder_sub_tasks(&mut self, mother_id: &str, ordered_ids: &[String])`——取该母任务全部子任务 id 集合并校验（长度 + 去重 + 全包含 + 均属于该母）；事务内 `UPDATE sub_tasks SET sort_order = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND mother_task_id = ?3`；`commit`。

### CSS `src/styles.css`

新增 `.subtask-drag-handle` 与拖拽/落位类，复用母任务柄视觉；`task-row--subtask` 增加 `data-sub-row-id` 选择器支持。

## 受影响页面流程与用户活动

- 页面：工作规划时间板（BoardPage）左侧任务树。
- 用户活动：在已展开母任务的某个子任务行，按下拖动柄并上下移动，实时预览落点高亮；松手后该子任务在同母任务内重新排序，左侧任务名与时间轴子任务条同步重排；按下但未达 4px 阈值不触发排序（视为点击），点击子任务名仍打开编辑。

## 关键决策与取舍

- 复用母任务拖动架构，保证交互一致、降低实现与回归风险。
- 限定同母任务内重排，避免引入跨母移动带来的依赖/日期重算复杂度（用户仅要求“在母任务内”）。
- 不加键盘重排，与母任务现状一致；若后续要可访问性增强再单独做。
- 不改 DB schema（`sort_order` 已存在），故无 migration，降低风险。

## 风险与假设

- 搜索态下子任务列表为过滤结果，拖动重排必须基于母任务**完整** `subTasks` 顺序而非可见行；实现以母任务实际 `subTasks` 数组为准。
- 与现有母任务拖拽共用 `pointerId` / 状态变量，需确保两套状态互不干扰（不同 ref / state）。
- 落点高亮查询依赖 `data-sub-row-id` 与 `data-mother-row-id`，需在子任务行补齐属性。
- 假设 `sub_tasks.sort_order` 列已存在且加载/导出均保留该值（现有 `load_board` 与导入逻辑均读取 `sort_order`）。

## 验收口径与验证命令

- 前端：在 `src/App.test.tsx` 增加“拖动子任务重排并持久化”用例（镜像母任务用例），用 `data-testid` 模拟 `pointerdown/move/up`，断言顺序变化且 `reorderSubTasks` 被调用、重启（重新 `loadBoard`）后顺序保持。
- 内存网关：增加校验用例（完整重排成功、缺失/重复 id 拒绝且不破坏原顺序）。
- Rust：增加 `reorders_sub_tasks_within_mother` 与越界拒绝用例。
- 命令：`npm run check:web`（typecheck + lint + 测试 + lint:md + build）、`npm run check:rust`；真实视口检查（登记为遗留，宽屏 / 约 1080px / 700px / 320px 与触控）。

## 需要更新的文档

- `docs/requirements/README.md`：需求登记（已置 Done）。
- `docs/requirements/planning-board-prd.md`：补充子任务同母任务内可拖动排序交互与验收条目。
- `docs/requirements/v0.1-acceptance-matrix.md`：新增验收点 41（Passed，自动化覆盖）。
- `docs/iterations/2026-09-18-subtask-reorder.md`：已按 `doc-closeout` 登记。

## 后续事项

- 真实桌面窗口下的人工视口检查尚未执行：宽屏、1080px、700px、320px 的拖动与触控体验，以及同母任务内落点高亮、跨母任务不处理的真实渲染，需在 `npm run dev` / Tauri 桌面环境中补做。

