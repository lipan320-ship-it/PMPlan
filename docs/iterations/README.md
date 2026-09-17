# 迭代记录

迭代记录回答“这一轮为什么做、实际做了什么、如何验证、还剩什么”，不替代需求文档、ADR 或 Git 历史。

## 索引

| 日期 | 主题 | 状态 |
| --- | --- | --- |
| [2026-09-17](2026-09-17-repository-documentation-baseline.md) | 建立仓库与文档治理基线 | Completed |
| [2026-09-17](2026-09-17-v0.1-implementation-planning.md) | 制定 v0.1 开发实施计划 | Completed |
| [2026-09-17](2026-09-17-v0.1-development.md) | v0.1.0 开发 | In Progress |

## 命名规则

使用 `YYYY-MM-DD-short-topic.md`。同一天有多轮独立工作时，在主题中明确区分，不使用“记录 1”“记录 2”。

## 记录模板

```markdown
# 迭代：主题

- 日期：YYYY-MM-DD
- 状态：Planned / In Progress / Completed / Paused
- 关联需求：链接或“无”
- 关联决策：链接或“无”

## 目标

## 范围

## 完成结果

## 验证

## 遗留事项
```

记录应以事实为准。未运行的测试不得写成“通过”，计划完成但尚未交付的内容不得写入“完成结果”。
