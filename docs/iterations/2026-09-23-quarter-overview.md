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
- 任务条按真实日期连续映射，单日任务保留最小可见标记；季度模式支持拖动整条子任务按天平移并保持持续天数，也支持拖动左右边缘分别调整开始和结束日期，点击子任务仍打开现有精确日期编辑弹窗。
- 现有周、双周、月视图、按天拖拽/拉伸、依赖开关和 JSON 数据格式保持不变。

## 完成结果

- `src/features/board/quarterOverview.ts` 提供滚动范围、月份带、周刻度、日期映射和裁切几何计算。
- `src/features/board/QuarterTimeline.tsx` 提供语义化季度表头、可拖动子任务条和单日任务的扩展命中区。
- 季度子任务拖动复用现有日期平移、边缘拉伸与保存回滚边界；4px 内的手势仍视为点击，窄任务条使用扩展边缘命中区。
- `BoardPage` 的翻页、今天定位和平移在季度模式下使用实际 90-92 天窗口；切回详情模式时仍保存合法的既有视图模式。
- 季度总览的状态不进入 SQLite `view_settings.view_mode`，旧数据库无需迁移。

## 后续增强：季度子任务拖动

- 日期：2026-09-26
- 季度总览中的子任务条支持整条拖动，按完整日期吸附并保持持续天数；4px 内的手势仍打开日期编辑弹窗。
- 短任务保留最小 6px 的视觉标记，同时使用至少 24px 的主体命中宽度；左右边缘各向外扩展 12px，避免占满窄任务的主体平移区域。
- 修复预览气泡被季度任务条裁切的问题，拖动中实时显示日期范围，结束后移除。
- 提交前同步最后修改的提示文案测试断言，并重新通过 62 项测试、全量 ESLint 和生产构建（含 TypeScript 检查）。

## 验证

- `npx.cmd vitest run src/features/board/quarterOverview.test.ts src/features/board/quarterOverview.test.tsx`：16 tests passed。
- `npx.cmd vitest run`：11 test files / 62 tests passed。
- `npm.cmd run typecheck`：passed。
- `npx.cmd eslint src`：passed。
- `npm.cmd run build`：passed。
- `npm.cmd run check:rust`：21 Rust tests passed；季度功能未改 Rust/SQLite 代码。
- `git diff --check`：passed（仅显示 Git 的 CRLF 提示）。
- `npm.cmd run lint:md`：仍受仓库既有 `.agents/skills`、`.codebuddy/plans` 无效链接/末尾换行问题阻塞，未将该基线问题归因于本次文件。

## 遗留事项

- 尚未执行真实桌面窗口的人工视觉检查；应重点确认 1280px、1440px 和窄屏下月份标签、周刻度和任务条可读性。
- 依赖线沿用现有 SVG 坐标层；若后续发现季度压缩下过于拥挤，可增加季度专用依赖简化开关。
