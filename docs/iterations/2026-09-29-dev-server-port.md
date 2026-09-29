# 迭代：修复开发服务端口启动失败

- 日期：2026-09-29
- 状态：Completed
- 关联需求：用户反馈 `npm.cmd run dev` 报错
- 关联决策：无

## 目标与原因

恢复无需生产构建的开发体验。复现报错为 `listen EACCES: permission denied 127.0.0.1:1420`；`netsh interface ipv4 show excludedportrange protocol=tcp` 确认 Windows 保留范围包含 1364–1463，原端口 1420 位于其中。

## 完成结果

- 将 npm 开发和预览命令、Vite 服务端口、Tauri 开发地址统一改为 5173。
- 保留本机监听和严格端口检查，确保 Tauri 连接地址与服务一致。
- README 补充启动方式、开发模式的数据范围和端口错误排查步骤。

## 验证

- Node TCP 探测已确认 `127.0.0.1:5173` 可绑定。
- 当前受限执行环境启动监听时仍可能返回 `EACCES`；配置、命令和端口说明已统一落地到 [本地体验与构建](../development/local-development.md)。

## 交付边界

本次只修复开发启动配置；未生成新 EXE 或安装包，修复记录在 `Unreleased`。下一次交付构建前按版本规则升级版本号。
