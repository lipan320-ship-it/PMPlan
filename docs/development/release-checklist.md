# v0.1 Windows 发布检查清单

## 发布前检查

```powershell
npm ci
npm run licenses:generate
npm run check:web
npm run check:rust
npm audit
npm run tauri -- build
```

## 必须验证

- 锁文件未被构建命令意外改写。
- `npm audit` 为 0 个已知漏洞。
- 第三方许可清单没有 `UNKNOWN` 条目。
- `dist/` 中不存在 HTTP(S) 运行资源引用。
- NSIS 安装包可以在干净 Windows 用户环境安装、启动和卸载。
- 断网时可以启动、编辑、重启、导入和导出。
- 数据库 schema 从当前正式版本升级后数据保持不变。
- 安装或升级不得覆盖用户的 AppLocalData 数据库。
- 卸载行为和用户数据保留策略与使用指南一致。
- 逐项执行 [v0.1 验收矩阵](../requirements/v0.1-acceptance-matrix.md)。

## 产物

- NSIS 安装包；
- `CHANGELOG.md`；
- [使用指南](../user-guide.md)；
- [第三方许可清单](../third-party-licenses.md)；
- 完成状态的迭代记录和验收矩阵。

## 当前签名边界

本地测试安装包未配置 Windows 代码签名。未签名包只用于受控内部测试，不应作为公开发布产物。正式分发前必须增加签名与来源说明。
