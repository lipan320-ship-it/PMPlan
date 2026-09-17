# 决策记录

本目录使用 ADR（Architecture Decision Record）保存会长期影响产品或工程实现的决策。

## 状态

- `Proposed`：正在讨论，尚不能作为实现依据。
- `Accepted`：已接受，后续实现必须遵循。
- `Superseded`：已被新 ADR 取代，但保留历史原因。
- `Rejected`：已评估但未采用。

## 索引

| 编号 | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [ADR-0001](ADR-0001-local-first-tauri-desktop.md) | 采用本地优先的 Tauri 桌面应用 | Accepted | 2026-09-17 |
| [ADR-0002](ADR-0002-rust-sqlite-storage-boundary.md) | 通过 Rust 存储层封装 SQLite | Accepted | 2026-09-17 |

## 新增规则

1. 文件名使用 `ADR-NNNN-short-title.md`。
2. 内容至少包含背景、决策、理由、备选方案、影响和状态。
3. Accepted ADR 不通过改写来掩盖旧结论；方向改变时新增 ADR，并把旧 ADR 标记为 Superseded。
4. 只记录有长期影响且存在真实取舍的选择，不把普通实现步骤写成 ADR。
