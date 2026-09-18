# 迭代：时间轴无边界连续平移（跨月不间断）

- 日期：2026-09-18
- 状态：Completed
- 关联需求：REQ-2026-09-18-03
- 关联决策：[计划](../plans/2026-09-18-timeline-continuous-pan.md)

## 目标

把时间轴从「对齐窗口 + 整段翻页」改造为「任意起点的连续日期窗口」，支持按住拖动与滚轮横移，实现从十月到十一月的无间断移动；周 / 双周 / 月三档保留为日期密度档位。

## 范围

- `viewRange.ts` 重写为连续窗口模型：`getViewRange(anchorDate, dayCount)` 不再对齐周首 / 月初；新增 `getVisibleDayCount`、`shiftAnchor`、`getPanStepDays`、`getAnchorForFocusDate`。
- 视口测量（`scrollRef` + ResizeObserver）从 `TimelineBoard` 上提到 `BoardPage`，统一计算 `dayCount → range → columnWidth` 后下传给工具栏期间标签与画板。
- 时间轴空白处拖拽平移（4px 阈值 + 指针捕获），命中任务条 / 拉伸柄等交互元素时不启动；滚轮横移用非被动监听，按像素累积换算为整天。
- 平移与翻页改为静默持久化：立即更新本地状态，不置 `busy`、不弹成功提示，手势结束或停止滚动后写入一次。
- 表头新增月份分组带，跨月时标明每个日期所属月份。
- 补测试与文档：`viewRange.test.ts` 按新模型重写、新增 `timelinePan.test.tsx` 集成用例、同步 `BoardScale.test.tsx` 与 `App.test.tsx` 中依赖旧窗口语义的断言。

## 完成结果

- 时间轴不再有月份与周次边界：连续窗口可同窗显示 10/31 与 11/1，拖拽与滚轮均按天连续平移；翻页改为约半个窗口步进，相邻窗口保留重叠。
- 三档视图变为日期密度档位（每天基准宽度 104 / 74 / 48px），可见天数由页面可用宽度推导并在 7–92 天之间取值，切档不改变窗口起点。
- **Rust、数据库 schema 与迁移零改动**：`view_settings.anchor_date` 无范围校验，旧库已保存的 `anchorDate` 直接按新语义解释，无需数据迁移。
- 静默持久化避免了平移期间的高频写库与提示轰炸；视图模式、显示依赖、任务名列宽仍沿用原有带提示的即时写入路径。
- 去掉对齐后早于窗口起点的任务不再渲染（新模型的固有语义），已据此调整 `BoardScale.test.tsx` 的锚点夹具与 `App.test.tsx` 的日期断言。

## 验证

- `npm run check:web`：typecheck、lint、42 个前端测试（9 个文件）、lint:md、build 全部通过。
- `npm run check:rust`：21 个 Rust 测试通过，rustfmt 与 clippy 无告警。

## 遗留事项

- 真实桌面窗口下的人工视口检查尚未执行：宽屏、1080px、700px、320px 的平移与滚轮手感，以及 50 × 10 = 500 条大板拖动帧率。
- 滚轮 / 触控板横移（验收点 45）尚无自动化证据，待人工核对后回填为 Passed。
- 跨窗口依赖连线维持「越界不画」的既有行为；亚日平滑与惯性滑动未实现。
