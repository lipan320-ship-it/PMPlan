# 项目文档

本目录集中保存产品范围、长期决策、迭代过程、原型与工程约定。

## 文档地图

| 目录 | 用途 | 当前入口 |
| --- | --- | --- |
| `requirements/` | 产品范围、功能规则、验收条件 | [需求索引](requirements/README.md) |
| `decisions/` | 影响长期实现方向的产品与技术决策 | [ADR 索引](decisions/README.md) |
| `iterations/` | 每轮工作的目标、结果、验证与遗留事项 | [迭代索引](iterations/README.md) |
| `prototypes/` | 非生产原型及其适用边界 | [原型说明](prototypes/README.md) |
| `development/` | 实施计划、仓库结构、开发流程及工程约定 | [v0.1 实施计划](development/v0.1-implementation-plan.md)、[仓库结构约定](development/repository-structure.md) |

## 信息归属

- “要做什么、如何验收”写入需求文档。
- “为什么选择这种方式”写入 ADR。
- “这一轮实际做了什么”写入迭代记录。
- “发布后使用者看到什么变化”写入根目录 `CHANGELOG.md`。
- 尚未成为正式需求的视觉探索或交互实验放入原型目录，并明确标注状态。
