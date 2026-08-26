# ADR 0003: nice-aos 三大核心命令产品定位 + 全量升级路线

> **Status**: Accepted (v0.32.0, 2026-08-26)
> **Authors**: nice-aos team
> **Related**: ADR 0001 (asdm-aos 借鉴) / ADR 0002 (蓝图引擎借鉴) / 0002-code-review-report.md
> **Trigger**: v0.32.0 CLI 现状审计 → 用户提出三大核心叙事

## Context

nice-aos 当前有 13 个子命令（`query / link / action / export / serve / update / db / deploy / service / planning / overview / ask / storage`），其中 `db / deploy / service / planning / overview` 是"领域型"命令（按产物类型拆），其余是"通用入口型"命令。

v0.32.0 审计发现：

1. **三大核心叙事缺失**。从用户/产品视角，CLI 的"核心入口"应当收敛为三个：
   - `ask` — 基于快照向 AI 提问（输入）
   - `output` — 导出报告与蓝图（输出）
   - `serve` — 暴露给其他 agent 跨源访问（服务）
   但当前 CLI 把这 13 个命令平铺，没有凸显三大核心；README 顶部"快速开始"也按 9 步流水叙述，而非按"输入 / 输出 / 服务"三轴分块。

2. **`output` 命令名实际不存在**。用户视角三大核心是 `ask / output / serve`，但 `output` 子命令当前不存在——`output` 实际叫 `export`。直接 `nice-aos output` 会立即报 "unknown command"。

3. **功能完成度不均衡**。`ask / output / serve` 三者功能完成度均约 85-90%，但缺失方向清晰：
   - `ask` 缺流式 / 多轮 / subagent / 历史复用
   - `output / export` 缺增量 / 模板化 / 多蓝图合并
   - `serve` 缺鉴权 / WebSocket / OpenAPI / 限流

4. **存在已知工程债**（来自 0002-code-review-report）：
   - P0-2：viewer.js 缺 `analyzeFile` 动作
   - P1-1：动作定义三处重复
   - P1-3：`refreshRepo / analyzeFile` 缺 actionImpl
   - P1-6：前端 `renderActionCardHtml` 缺 enum/objectRef 渲染
   - P1-4：增量解析 LRU 注释误称 FIFO
   - P2-1：深拷贝只做一层

本 ADR 记录"三大核心叙事"的产品决策与"output → export 别名"的命令命名决策，并锁定升级方向。**具体任务清单与验收标准见 `docs/plan/aos-three-core-roadmap.md`**，不在本 ADR 展开。

## 决策

### 决策 1：产品定位收敛为"三大核心 + N 个领域型"两层级

**A 级（三大核心 / 通用入口）**：
- `ask` — 上下文 + AI 问答
- `output` — 报告与蓝图导出（实际命令 `export`）
- `serve` — 本地数据源服务

**B 级（领域型 / 产物拆）**：
- `db / deploy / service / planning / overview` — 各自独立蓝图（数据 / 部署 / 服务 / 规划 / 全景）
- `query / link / action` — 内部原子能力（被三大核心 / skill 调用）
- `update / storage` — 维护与运维

**理由**：
- 三大核心面向"AI agent / 终端用户"的入口；N 个领域型面向"特定场景子任务"
- 三大核心彼此互补：ask 把问题转成 AI 调用、output 把数据转成报告、serve 把数据转成 API
- B 级命令由 skill 编排（如 `nice-aos-fullscan-skill` 串 db+deploy），不直接面向终端用户

### 决策 2：`output` 作为 `export` 的 commander 顶层别名（不改 `export`）

**实施方案**：
```js
// src/cli/index.js
program.addCommand(exportCommand);
exportCommand.alias('output'); // 三大核心之一，output 是 export 的顶层别名
```

**理由**：
- 零迁移成本：旧脚本、CHANGELOG、贡献者代码、contrib 引用 `export` 全部不动
- commander `alias()` 原生支持双向：`nice-aos output` 和 `nice-aos export` 走同一 action
- `--help` 输出 `export|output`，用户能看到对应关系
- 已加 `test/output.test.mjs` 验证等价性（6/6 通过）

**否决方案**：
- ❌ 重命名 `export` 为 `output`：破坏性升级，所有现存 `export` 引用要改，CHANGELOG 不可读
- ❌ 维持 `export`、仅 README 说明：用户依然记忆两套名字，与"三大核心"叙事冲突

### 决策 3：升级范围一次性覆盖 品牌 + 全部 P1 + 全部 P2 + 全部工程债

**理由**：
- 用户明确要求"全量"覆盖，不做分期
- 品牌层（决策 1+2）已先于本 ADR 落地（output 别名已合入）
- 详细任务按 ask / output / serve 三轴展开，每轴分 P0/P1/P2；P0 在 v0.33.0 完成，P1 在 v0.34.0-v0.35.0 完成，P2 在 v0.36.0+ 滚动消化
- 工程债中 E1（viewer.js 缺 analyzeFile）作为 P0 阻塞 v0.33.0 释放，必须同版本修复

**否决方案**：
- ❌ 仅做品牌层（小范围）：用户已明确选择全量
- ❌ 中规模（品牌 + 主力 P1）：同上
- ❌ 跨多个版本分期：用户已选择一次性

### 决策 4：升级清单分轴落地为 `docs/plan/aos-three-core-roadmap.md`

不把任务清单写进本 ADR（避免 ADR 膨胀），独立 plan 文档按"ask 轴 / output 轴 / serve 轴 / 跨命令协同 / 工程债"五部分组织，每条任务含验收标准。

## 决策带来的变更

| 类别 | 变更 |
|------|------|
| 命令 | `output` 顶层别名（v0.33.0） |
| README | 顶部加"Three Core Commands"区块（v0.33.0） |
| README | 末尾"Roadmap（候选）"重写为按 ask / output / serve 三轴 + P0/P1/P2 优先级（v0.33.0） |
| ADR | 本文档（v0.33.0） |
| Plan | `docs/plan/aos-three-core-roadmap.md` 落地 25+ 任务（v0.33.0 起滚动） |
| 测试 | `test/output.test.mjs` 验证 output 别名（v0.33.0） |

## 升级原则

1. **向后兼容优先**：所有能力升级都不破坏既有 CLI 调用；output 别名是这一原则的范本
2. **SQLite 优先，JSON 兜底**：保持 v0.30.0 起的能力分层（SQL 4 次查询 < 50ms，JSON 全量 < 500ms），不倒退
3. **流式优先于批式**：ask 新增能力先做流式，再考虑批式增强
4. **API 优先于 CLI**：serve 新增能力先做 HTTP / WebSocket 端点，让 agent 可程序化消费
5. **可观测**：每个新能力必须同时加测试 + 输出 schema 描述

## 升级影响

- **测试**：从 483 → 目标 600+（每条新能力至少 1 个测试）
- **API 端点**：从 7 → 目标 10+（加 WebSocket / OpenAPI / 鉴权）
- **CHANGELOG**：v0.33.0 / v0.34.0 / v0.35.0 三个版本号下持续放出

## 关联文档

- `docs/plan/aos-three-core-roadmap.md` — 详细任务清单（ask 轴 / output 轴 / serve 轴 / 跨命令 / 工程债）
- `docs/adr/0001-asdm-aos-borrowed-capabilities.md` — 借鉴的工程模式参考
- `docs/adr/0002-blueprint-engine-borrowed-from-aos.md` — V2 引擎基线
- `docs/adr/0002-code-review-report.md` — 已识别工程债来源
