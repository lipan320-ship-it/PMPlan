# 本地体验与构建

## 先记住一件事

修改代码后的日常体验不需要生产构建。开发模式会启动 Vite 热更新服务，保存源码后浏览器或 Tauri 窗口会自动刷新；只有验证生产包、生成 EXE 或制作安装包时才需要执行构建命令。

## 命令对照

| 目的 | 命令 | 入口或产物 |
| --- | --- | --- |
| 浏览器热更新 | `npm.cmd run dev` | `http://127.0.0.1:5173` |
| Tauri 桌面开发窗口 | `npm.cmd run tauri -- dev` | 本地桌面窗口；会复用 Vite 开发服务 |
| 前端生产包 | `npm.cmd run build` | `dist/` |
| Debug EXE | `npm.cmd run build:desktop` | Tauri debug EXE，不生成安装包 |
| Windows 安装包 | `npm.cmd run build:installer` | Windows x64 NSIS 安装包 |

开发命令需要在仓库根目录执行。浏览器模式使用内存存储，适合检查页面和交互；需要验证 SQLite、项目 JSON 自动回写和桌面文件权限时，使用 Tauri 桌面开发窗口。

## 端口

当前仓库统一使用 `5173`：`package.json` 的 `dev` / `preview`、`vite.config.ts` 的 `server.port` 和 `src-tauri/tauri.conf.json` 的 `build.devUrl` 必须保持一致。

如果要改用 `1420`，请同时修改这三处配置，再运行 `npm.cmd run dev`，浏览器入口变为 `http://127.0.0.1:1420`。端口被占用或被 Windows 保留时，先检查现有开发服务和系统端口保留范围。

## 生产构建前的版本

准备桌面构建或安装包前，先同步版本号：

```powershell
npm.cmd run version:patch
npm.cmd run check:version
```

也可以指定完整版本：

```powershell
npm.cmd run version:set -- 0.1.2
```

版本脚本会同步 `package.json`、`package-lock.json`、Tauri 配置、Rust manifest 和 Cargo lock。`npm.cmd run build` 会自动检查版本是否一致。

## 停止开发服务

保持开发命令所在终端运行。结束体验时按 `Ctrl+C` 停止服务。
