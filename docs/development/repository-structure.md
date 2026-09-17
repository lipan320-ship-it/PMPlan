# 仓库结构约定

## 当前结构

```text
PMPlan/
├─ README.md
├─ CHANGELOG.md
└─ docs/
   ├─ README.md
   ├─ requirements/
   ├─ decisions/
   ├─ iterations/
   ├─ prototypes/
   └─ development/
```

## 工程初始化后的目标结构

```text
PMPlan/
├─ src/                 # React/TypeScript 前端与领域逻辑
├─ src-tauri/           # Tauri 配置、Rust 命令、SQLite 迁移
├─ tests/               # 跨模块与端到端测试
├─ scripts/             # 构建、校验、打包辅助脚本
├─ public/              # 随应用打包的静态资源
├─ docs/                # 产品与工程文档
├─ README.md
└─ CHANGELOG.md
```

只有在产生对应内容时才创建目录，不保留无意义的空目录占位。

## 职责边界

### `src/`

- `components/`：通用界面组件；
- `features/`：按时间板、任务、依赖、导入导出等能力组织；
- `domain/`：日期、排期汇总、依赖环检测和冲突判断等纯业务逻辑；
- `storage/`：数据库与文件接口的前端适配层；
- `styles/`：主题、设计变量和全局样式。

具体子目录应随首个工程计划确认，不为了符合示意树提前拆分。

### `src-tauri/`

- Tauri 配置和权限声明；
- SQLite 初始化与迁移；
- 文件打开、保存和备份等需要桌面权限的命令；
- 安装包图标与平台资源。

### `tests/`

优先覆盖跨模块流程和离线桌面验收。与单个源文件紧密关联的单元测试可与源文件共置，避免在两个目录中来回定位。

### `docs/`

文档归属遵循 [文档总索引](../README.md)，不把临时设计稿或重复导出的文件堆放在仓库根目录。

## 数据与生成物

- 真实用户数据库、导出文件和备份不得提交到仓库。
- 测试夹具必须使用虚构数据，并放在明确的测试目录。
- `node_modules/`、前端构建输出、Rust `target/`、安装包和日志属于生成物，应由 `.gitignore` 排除。
- 字体、图标等运行依赖必须确认许可并纳入本地构建，不得在正式版本中引用 CDN。
