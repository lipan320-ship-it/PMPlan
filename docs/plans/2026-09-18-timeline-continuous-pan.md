# 计划：时间轴无边界连续平移（跨月不间断）

- 日期：2026-09-18
- 需求：REQ-2026-09-18-03
- 关联决策：无（沿用既有画板模块与拖动模式，无独立 PRD；技术设计内联本计划）

## 背景与目标

时间轴当前是「对齐窗口 + 整段翻页」：周 / 双周视图强制从周一开始（`startOfWeek`）、月视图强制从月初开始（`startOfMonth`）；翻页一次跳整个窗口（月 ±1 月、周 ±7 天、双周 ±14 天，`navigateAnchor`）。因此从十月到十一月只能"整屏替换"，中间没有过渡，且永远看不到跨月衔接（例如窗口内同时出现 10-31 与 11-01）。列宽又按视口铺满，视觉上没有可拖动的"画布"。

目标：把时间轴改造为**任意起点的连续日期窗口**，支持按住拖动与滚轮横移，实现跨月无间断移动；保留周 / 双周 / 月三档仅作为日期密度档位；平移过程静默（不弹 toast、不禁用按钮），停止后持久化，重启后位置保持。

## 范围

### 本次做

- `viewRange.ts` 改为连续窗口模型：`getViewRange(anchorDate, dayCount)` 不再对齐周首 / 月初；新增 `getVisibleDayCount`、`shiftAnchor`、`getPanStepDays`、`getAnchorForFocusDate`。
- 可见天数由视口宽度推导，列宽仍铺满视口（保留既有"无横向滚动条"行为）；`viewportWidth === 0`（jsdom / 首帧）按档位兜底 7 / 14 / 30。
- `BoardPage` 上提 `scrollRef` + ResizeObserver + `viewportWidth`，统一计算 `dayCount → range → columnWidth` 后下传给工具栏期间标签与 `TimelineBoard`。
- 拖拽平移：pointer 事件 + 指针捕获 + 4px 阈值，命中 `.timeline-bar` / `.resize-handle` / `[data-no-pan]` 时不启动；位移换算复用 `directManipulation.ts` 的 `pixelsToDayOffset`；拖动态 `is-panning`（`cursor: grabbing` / `user-select: none` / `touch-action: none`）。
- 滚轮 / 触控板横移：`deltaX`（或 shift + wheel 的 `deltaY`）按同样换算平移，用非被动监听以便 `preventDefault`。
- 静默持久化 `commitViewSettings(settings, { silent: true })`：立即更新本地 state，debounce 300–500ms 后写一次网关，不置 `busy`、不弹成功 toast；平移与翻页走静默路径，切换视图模式保留现有 toast 行为。
- 表头月份分组带：按 `range.dates` 中连续同 `YYYY-MM` 的区段渲染月份格（`gridColumn: span N`），显示「2026 年 10 月」。
- 翻页步长改为约半个窗口（相邻窗口有重叠，维持连续感）；「今天」与聚焦定位把关注日放在窗口前约 1/4 处。
- 补测试（`viewRange.test.ts` 重写、新增平移集成用例、同步规模测试）并完成文档收尾。

### 本次不做

- 虚拟化 / 无限画布（方案 B 已排除）：不重写布局，不做可见列虚拟化。
- 跨窗口依赖连线补画：维持"越界不画"的现有行为，作为已知限制写入文档。
- 惯性滑动、拖拽缓动动画、自由缩放档位。
- 数据模型 / DB schema / Rust 改动：`view_settings.anchor_date` 无范围校验、档位 CHECK 不变、`LATEST_SCHEMA_VERSION` 仍为 2，**无迁移**。

## 执行分级

```text
档位：中
预计步骤：重写 viewRange 连续窗口模型 / 上提视口测量并接入 dayCount 与 columnWidth / 实现拖拽与滚轮平移 / 新增月份分组带与静默持久化 / 补测试与文档
将跳过项：独立 PRD（单模块、复用既有拖动模式，技术设计内联）；docs/prototypes 原型（沿用现有页面，无新页面与导航，交互以计划与自动化断言界定）；真实视口手工检查（登记为遗留，同列宽与子任务重排需求）
预估工作量：约 8 处改动（viewRange 及单测、BoardPage、styles.css、新增集成测试、BoardScale / App 测试同步、文档若干）
降级：无
```

## 方案（技术设计）

### 1. `src/features/board/viewRange.ts`（重写核心模型）

```ts
export function getViewRange(anchorDate: DateOnly, dayCount: number): ViewRange;
// 从 anchorDate 起连续 dayCount 天：dates[i] = addDays(anchorDate, i)，不做任何对齐

export function getVisibleDayCount(availableTimelineWidth: number, viewMode: ViewMode): number;
// availableTimelineWidth > 0 → clamp(round(available / baseColumnWidth(viewMode)), 7, 92)
// availableTimelineWidth === 0（jsdom / 首帧）→ 按档位兜底 7 / 14 / 30

export function shiftAnchor(anchorDate: DateOnly, days: number): DateOnly;   // addDays
export function getPanStepDays(dayCount: number): number;                    // max(1, round(dayCount / 2))
export function getAnchorForFocusDate(focusDate: DateOnly, dayCount: number): DateOnly;
// addDays(focusDate, -max(1, floor(dayCount / 4)))：把关注日放在窗口前约 1/4 处
```

- `getDayColumnWidth` 保留（周 104 / 双周 74 / 月 48），语义变为"日期密度基准列宽"。
- 移除 `navigateAnchor` 的按整段步进语义，由 `shiftAnchor` 取代；`ViewRange` 结构（`startDate` / `endDate` / `dates`）不变，下游无需改契约。

### 2. `src/features/board/BoardPage.tsx`

- **视口测量上提**：`scrollRef` + ResizeObserver + `viewportWidth` 从 `TimelineBoard` 提到 `BoardPage`，通过 `scrollContainerRef` prop 挂到 `.board-scroll`；`BoardPage` 内算 `dayCount = getVisibleDayCount(available, viewMode)` → `range = getViewRange(anchorDate, dayCount)` → `columnWidth = available / dayCount`（兜底 `baseColumnWidth`），统一下传，使工具栏 `formatRange` 与画板共用同一 `range`。
- **平移状态**：`ActiveTimelinePan { pointerId; startX; anchorDate; committedDays }`，配 `beginPan / updatePan / finishPan` 三件套（镜像母任务 / 子任务拖动实现）；累积满 1 天才 `shiftAnchor` 提交，避免每像素重渲染。
- **命中排除**：`event.target.closest(".timeline-bar, .resize-handle, [data-no-pan]")` 命中则不启动平移，保证任务条拖动 / 拉伸、快速新增、列宽拖拽不受影响。
- **滚轮横移**：`useEffect` + `addEventListener("wheel", handler, { passive: false })`，仅处理横向意图（`deltaX` 为主、shift + `deltaY` 次之），按 `pixelsToDayOffset` 换算并 `preventDefault`。
- **静默持久化**：`commitViewSettings(settings, { silent: true })` 立即 `setBoard` 更新本地 state；用 ref 保存 debounce 定时器，`finishPan` / 停止滚动 / 翻页后 300–500ms 写一次 `gateway.saveViewSettings`；不置 `busy`、不弹成功 toast，失败时 `console.warn` 并至多一次 error toast。
- **翻页与今天**：「上一段 / 下一段」→ `shiftAnchor(anchorDate, ±getPanStepDays(dayCount))`；「今天」→ `getAnchorForFocusDate(todayDateOnly(), dayCount)`；导入后定位最早任务日沿用同一聚焦偏移；均走静默路径。
- **月份分组带**：表头上方新增一行，按连续同 `YYYY-MM` 区段渲染 `gridColumn: span N` 的月份格。

### 3. `src/styles.css`

- `.date-header__months`：月份分组带（分隔线、浅色背景、与日期网格同列宽）。
- `.is-panning`：`cursor: grabbing`、`user-select: none`、`touch-action: none`。

### 4. 不受影响（已核实）

- Rust / schema / 迁移零改动：`save_view_settings` 仅 `parse_date` 校验 `anchor_date`，无范围钳制；`view_mode` CHECK 仍为 `('week','biweek','month')`；旧库已保存的 `anchorDate` 直接按新语义解释。
- `getBarGeometry`、`today-line`、快速新增等下游逻辑基于 `range.startDate` + `diffDays`，窗口模型变化后无需修改。

## 受影响页面流程与用户活动

- **页面**：工作规划时间板（BoardPage）时间轴区域（表头 + 行区）。
- **用户活动**：
  - 在时间轴空白处按住并左右拖动 → 时间轴连续平移，从十月拖到十一月不跳变、不出现月份边界；松手后位置静默保存。
  - 滚轮 / 触控板横向滚动 → 时间轴平移。
  - 点「上一段 / 下一段」→ 按约半个窗口步进（相邻窗口有重叠）。
  - 点「今天」→ 回到今天，且今天显示在窗口靠前位置，前后文都可见。
  - 切换周 / 双周 / 月 → 日期密度变化（列宽档位），窗口起点保持不动。
  - 按住任务条拖动或拉伸其两端、拖动任务名列宽、拖动母任务 / 子任务柄 → 均不触发平移，行为与现状一致。

## 关键决策与取舍

- **连续窗口（去对齐）而非虚拟化**：已足以满足"跨月无间断"，改动可控且后端零改动；虚拟化留待后续演进。
- **列宽铺满视口、天数由视口推导**：保留现有"无横向滚动条"观感，档位只控制日期密度，符合用户选定的"档位 = 列宽档位"。
- **平移按整天提交**：月视图约每 48px、周视图约每 104px 才更新一次 `anchorDate`，避免每像素重渲染；若实测大板掉帧，再引入"两侧缓冲天数 + `translateX` 亚日平滑"（首版不做）。
- **静默持久化**：平移是高频操作，沿用现有 `runAction`（置 busy + toast「视图设置已保存」）会写库几十次并轰炸提示，故另开静默路径。
- **「今天」不左对齐**：去对齐后若 `anchorDate = today`，窗口只会显示未来；故用 `getAnchorForFocusDate` 把关注日放在窗口前约 1/4。
- **jsdom 兜底天数**：`viewportWidth === 0` 时按档位给出 7 / 14 / 30，否则首帧渲染与规模测试会失去窗口。

## 风险与假设

- `getBarGeometry` 越界返回 `null`：去对齐后早于 `anchorDate` 的任务不再渲染，这是新模型的固有语义，但会打破 `BoardScale.test.tsx`（fixture `anchorDate = 2026-09-17` 的窗口变为 09-17 ~ 09-30，09-14 ~ 09-16 的条消失，500 条断言失败）→ 把 fixture 的 `anchorDate` 调整为 `2026-09-14`。
- `App.test.tsx` 可能存在依赖窗口对齐 / 翻页日期 / 视图设置 toast 的断言 → 先用 code-explorer 排查出清单再同步修改。
- **命中冲突**：平移挂在时间轴容器上，必须排除任务条、拉伸柄、快速新增行与列宽拖拽，否则既有交互会被抢占。
- React 的 `onWheel` 为被动监听，需 `addEventListener(..., { passive: false })` 才能 `preventDefault`。
- DOM 规模 ≈ 行数 × 天数，设 `MAX_VISIBLE_DAYS = 92` 上限防止超宽窗口退化。
- 假设已核实：`view_settings.anchor_date` 无范围校验、档位 CHECK 不变 → 无需数据迁移。

## 验收口径与验证命令

- **纯函数**（`viewRange.test.ts` 重写）：任意起点连续生成；跨月窗口同时含 10-31 与 11-01；天数由视口推导、上下限与 jsdom 兜底；`shiftAnchor` 正负位移；`getPanStepDays` 约为半个窗口；`getAnchorForFocusDate` 把关注日落在窗口前 1/4。
- **集成**（新增 `src/features/board/timelinePan.test.tsx`）：初始窗口同时含 10-31 与 11-01（证明跨月无间断）；在时间轴空白处拖动后 `anchorDate` 按位移变化、松手后静默持久化（无 toast、按钮未被禁用）；在任务条上拖动不触发平移；翻页后重新加载位置保持。
- **规模回归**：`BoardScale.test.tsx` 500 条子任务条仍全部渲染。
- **命令**：`npm run check:web`（typecheck + lint + 测试 + lint:md + build）、`npm run check:rust`（Rust 无改动，仅回归）；真实视口检查登记为遗留。

## 需要更新的文档

- `docs/requirements/README.md`：需求登记（已置 In Progress，收尾时置 Done）。
- `docs/requirements/planning-board-prd.md`：补充时间轴连续窗口、拖拽 / 滚轮平移与三档密度语义。
- `docs/requirements/v0.1-acceptance-matrix.md`：新增验收点（跨月同窗、拖拽平移、滚轮横移、静默持久化、既有交互不冲突）。
- `docs/iterations/2026-09-18-timeline-continuous-pan.md`：收尾时按 `doc-closeout` 登记。

## 后续事项

- 真实桌面窗口下的人工视口检查尚未执行：宽屏 / 1080px / 700px / 320px 的平移手感，触控板横移，以及 50 × 10 = 500 条大板拖动帧率。
- 跨窗口依赖连线补画、亚日平滑与惯性滑动可作为后续优化项。

## 收尾记录（2026-09-18）

- 需求状态：`docs/requirements/README.md` 中 REQ-2026-09-18-03 已置 `Done`。
- 产品基线：PRD 的 2.3 功能清单、4.1 视图模式、4.2 切换规则、4.3 时间导航，以及 `docs/user-guide.md` 的时间视图小节已同步。
- 验收用例：`docs/requirements/v0.1-acceptance-matrix.md` 新增第 43–48 项；滚轮横移（45）标记为 `Pending`，待真实视口核对后回填。
- 迭代记录：`docs/iterations/2026-09-18-timeline-continuous-pan.md` 已登记并加入 `docs/iterations/README.md` 索引。
- 流程与活动图：本仓库没有 `docs/product/user-flows.md` 与 `docs/product/activity-diagrams.md`，本轮不适用。
- 验证：`npm run check:web`（typecheck、lint、42 个前端测试、lint:md、build）与 `npm run check:rust`（21 个 Rust 测试）均通过；`git diff --check` 通过。
