# 工作规划时间板

工作规划时间板是一款面向个人规划场景的本地优先桌面工具，用于把母任务拆分为子任务，并在真实日期时间线上安排工作、调整工期和表达母任务之间的依赖关系。

## 当前阶段

项目已完成 M0–M7，形成 Windows x64 v0.1.0 内部测试发布候选。仓库中包含：

- 已整合的产品需求文档；
- 可供视觉和交互参考的 HTML 原型；
- 已接受的关键技术决策；
- 迭代与变更记录规范。
- 可构建的 React/TypeScript/Vite/Tauri 工程壳。

当前原型不是可发布产品，也不应作为正式运行入口。

## 本地开发

前置环境：

- Node.js 与 npm；
- Rust MSVC 工具链；
- Visual Studio Build Tools 的 `Desktop development with C++` 工作负载；
- Windows WebView2 Runtime。

常用命令：

```powershell
npm install
npm run dev
npm run check:web
npm run check:rust
npm run build:desktop
npm run build:installer
```

日常体验不需要生产构建。命令、入口地址、桌面开发和各类构建产物见[本地体验与构建](docs/development/local-development.md)。

若启动报 `listen EACCES`，可运行 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查 Windows 保留端口。本机原端口 1420 位于 1364–1463 保留范围，开发与预览入口已统一改为 5173。若另选端口，需同步修改 `package.json` 的 `dev` / `preview`、`vite.config.ts` 的 `server.port` 和 `src-tauri/tauri.conf.json` 的 `build.devUrl`。若报端口已占用，先检查是否已有开发服务运行，避免重复启动。

每次准备桌面构建或安装包前，先执行 `npm run version:patch`（或 `npm run version:set -- <major.minor.patch>`）升级版本。版本会同步写入 `package.json`、`package-lock.json`、Tauri 配置和 Rust manifest；所有构建会通过 `check:version` 拒绝版本不一致的工作区。

## 产品与技术方向

- 产品形态：Windows 优先的本地桌面应用；
- 桌面框架：Tauri 2；
- 前端：React、TypeScript、Vite；
- 本地持久化：SQLite；
- 数据交换：版本化 JSON 导入与导出；
- 运行边界：所有运行资源随应用打包，不依赖 CDN、服务端、账号或网络连接。

详细取舍见 [ADR-0001：采用本地优先的 Tauri 桌面应用](docs/decisions/ADR-0001-local-first-tauri-desktop.md)。

## 文档导航

| 内容 | 入口 |
| --- | --- |
| 文档总索引 | [docs/README.md](docs/README.md) |
| 产品需求 | [docs/requirements/planning-board-prd.md](docs/requirements/planning-board-prd.md) |
| 决策记录 | [docs/decisions/README.md](docs/decisions/README.md) |
| 迭代记录 | [docs/iterations/README.md](docs/iterations/README.md) |
| 发布级变更 | [CHANGELOG.md](CHANGELOG.md) |
| 参考原型 | [docs/prototypes/README.md](docs/prototypes/README.md) |
| v0.1 实施计划 | [docs/development/v0.1-implementation-plan.md](docs/development/v0.1-implementation-plan.md) |
| 本地体验与构建 | [docs/development/local-development.md](docs/development/local-development.md) |
| 仓库结构约定 | [docs/development/repository-structure.md](docs/development/repository-structure.md) |
| 使用指南 | [docs/user-guide.md](docs/user-guide.md) |
| v0.1 验收矩阵 | [docs/requirements/v0.1-acceptance-matrix.md](docs/requirements/v0.1-acceptance-matrix.md) |
| v0.1.2 发布说明 | [docs/releases/v0.1.2.md](docs/releases/v0.1.2.md) |

## 文档维护原则

1. `docs/requirements/planning-board-prd.md` 是当前产品范围的权威入口，不并行维护“最终版”“最新版”等副本。
2. 已达成且会影响后续实现的技术或产品选择写入 ADR；ADR 一经接受不改写结论，如需改变则新增 ADR 取代旧决策。
3. 每次有明确目标的工作周期，在 `docs/iterations/` 中留下范围、结果、验证和遗留事项。
4. 面向使用者的发布变化记录到根目录 `CHANGELOG.md`，日常提交明细不重复抄入变更日志。
5. 原型只用于验证设计；正式功能、数据模型和验收标准以需求与决策文档为准。
