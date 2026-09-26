# 迭代：连续季度总览时间轴

- 日期：2026-09-23
- 状态：Completed
- 关联需求：用户确认的连续 90-92 天窗口
- 关联决策：无（季度总览状态不写入现有 ViewMode）

## 目标

在不压缩日级编辑命中区的前提下，让用户一次查看连续约一个季度的规划时间线。

## 范围

- 新增临时的“季度总览”开关，不扩展 TypeScript/Rust/SQLite 的持久化 `ViewMode`。
- 总览窗口保留当前 `anchorDate`，按三个月周年日计算并将长度约束在 90-92 天。
- 表头改为按真实天数比例的月份带和周一刻度；行背景只绘制周/月边界，不生成 90 个日格。
- 任务条按真实日期连续映射，单日任务保留最小可见标记；季度模式支持拖动整条子任务按天平移并保持持续天数，点击子任务仍打开现有精确日期编辑弹窗，左右边缘拉伸继续在详细视图完成。
- 现有周、双周、月视图、按天拖拽/拉伸、依赖开关和 JSON 数据格式保持不变。

## 完成结果

- `src/features/board/quarterOverview.ts` 提供滚动范围、月份带、周刻度、日期映射和裁切几何计算。
- `src/features/board/QuarterTimeline.tsx` 提供语义化季度表头、可拖动子任务条和单日任务的扩展命中区。
- 季度子任务拖动复用现有日期平移与保存回滚边界；4px 内的手势仍视为点击，左右边缘不在季度模式中承担拉伸操作。
- `BoardPage` 的翻页、今天定位和平移在季度模式下使用实际 90-92 天窗口；切回详情模式时仍保存合法的既有视图模式。
- 季度总览的状态不进入 SQLite `view_settings.view_mode`，旧数据库无需迁移。

## 后续增强：季度子任务拖动

- 日期：2026-09-26
- 季度总览中的子任务条支持整条拖动，按完整日期吸附并保持持续天数；4px 内的手势仍打开日期编辑弹窗。
- 单日任务保留 6px 的视觉标记，同时使用至少 24px 的拖动命中区；左右边缘拉伸继续使用周 / 双周 / 月详细视图。

## 验证

- `npx.cmd vitest run src/features/board/quarterOverview.test.ts src/features/board/quarterOverview.test.tsx`：13 tests passed。
- `npx.cmd vitest run`：11 test files / 59 tests passed。
- `npm.cmd run typecheck`：passed。
- `npx.cmd eslint src`：passed。
- `npm.cmd run build`：passed。
- `npm.cmd run check:rust`：21 Rust tests passed；季度功能未改 Rust/SQLite 代码。
- `git diff --check`：passed（仅显示 Git 的 CRLF 提示）。
- `npm.cmd run lint:md`：仍受仓库既有 `.agents/skills`、`.codebuddy/plans` 无效链接/末尾换行问题阻塞，未将该基线问题归因于本次文件。

## 遗留事项

- 尚未执行真实桌面窗口的人工视觉检查；应重点确认 1280px、1440px 和窄屏下月份标签、周刻度和任务条可读性。
- 依赖线沿用现有 SVG 坐标层；若后续发现季度压缩下过于拥挤，可增加季度专用依赖简化开关。
