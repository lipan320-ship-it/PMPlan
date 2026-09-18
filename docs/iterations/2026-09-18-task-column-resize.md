# 迭代：任务名列宽可拖动调整并持久化

- 日期：2026-09-18
- 状态：Completed
- 关联需求：REQ-2026-09-18-01
- 关联决策：docs/plans/2026-09-18-task-column-resize.md

## 目标

为工作规划时间板的任务名列增加可拖动调宽能力，并将用户选择的宽度持久化到视图设置，关闭并重新打开应用后恢复上次宽度。

## 范围

- Pointer Events 拖动调整任务名列宽度；支持鼠标与触控。
- 键盘方向键、Shift 加速、Home 最小宽度、End 最大宽度调整。
- 统一最小值 240px、最大值 600px、默认值 348px 的边界约束。
- 列宽参与时间轴可用宽度计算，拖动时实时重算日期列宽并保持左右行对齐、横向滚动。
- 将列宽加入 ViewSettings，贯通 Memory gateway、Tauri/Rust、SQLite schema v2 持久化与旧库迁移。
- 补充前端、内存网关、Rust 默认值与边界测试，并更新需求登记、产品基线与验收矩阵。

## 完成结果

- 任务名列分隔柄实现拖动与键盘调整，带 ARIA 当前值与聚焦样式。
- ViewSettings 新增 `taskColumnWidth`，前端与 Rust 均对非法/越界值做 clamp。
- SQLite 新增 schema version 2 迁移，为历史数据库补充默认列宽列。
- 自动化已覆盖：列宽持久化、键盘调整、内存网关 clamp、Rust 默认宽度与越界校正。

## 验证

- `npm run check:web`：typecheck、lint、30 个前端测试、lint:md、build 全部通过。
- `npm run check:rust`：20 个 Rust 测试通过。
- `git diff --check` 通过。

## 遗留事项

- 真实桌面窗口下的人工视口检查尚未执行：宽屏、1080px、700px、320px 的拖动与触控体验，以及 sticky 与时间轴对齐的真实渲染，需在 `npm run dev` / Tauri 桌面环境中补做。
