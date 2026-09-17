# 变更日志

本文件记录对使用者或项目交付有意义的变化。提交级细节由 Git 历史保存，具体工作过程记录在 `docs/iterations/`。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号将在首个可运行版本建立后开始使用。

## [Unreleased]

## [0.1.0] - 2026-09-17

### Added

- 建立需求、决策、迭代、原型和开发约定的文档目录。
- 记录本地优先 Tauri 桌面应用的技术决策。
- 制定 v0.1.0 开发实施计划、里程碑和验收归属。
- 补充母任务与子任务的最小管理范围和首次启动规则。
- 接受由 Rust 存储层封装 bundled SQLite 的事务边界。
- 建立 React、TypeScript、Vite 与 Tauri 2 工程壳、测试基线和本地图标资源。
- 建立日期、排期和依赖领域规则，以及 Rust SQLite migration、事务、CRUD 与业务级 Tauri commands。
- 实现周、双周、月时间板、日期导航、任务 CRUD、搜索、展开收起和本地自动保存界面。
- 实现双击日期快速新增、任务条整体拖动、两端拉伸、按天吸附和失败回滚。
- 实现多重母任务依赖、循环校验、SVG 箭头、聚焦和排期冲突警示。
- 实现版本化 JSON 全量导出、覆盖/合并导入、错误预览和 Rust 单事务保护。

### Changed

- 将整合需求文档迁移到 `docs/requirements/`。
- 将 HTML 参考原型迁移到 `docs/prototypes/`。
