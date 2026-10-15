# ADR 0015: linkDefs 元数据层（v0.50.0）

> **Status**: Accepted (v0.50.0, 2026-10-15)
> **Predecessors**: [ADR 0014 (withSnapshot/vocabulary envelope)](./0014-asdm-aos-withsnapshot-vocabulary-envelope.md), [ADR 0012/0013 (查询投影/RPC/factsCache/refIntegrity)](./0012-aos-borrow-query-projection-rpc-rules-skill-contract.md), [ADR 0005 (GitNexus 借鉴)](./0005-gitnexus-borrowed-capabilities.md)
> **Trigger**: `.nice-aos/analysis/asdm-aos-borrow-analysis.md` §2-A "LinkDef 数据驱动" (analysis 推荐)

## Context

借鉴分析报告 §2-A 中指出 nice-aos 的 linkType 处理分散在 3 个位置：
1. `blueprint.js:LINK_TYPES` — 56 个 linkType 名（顶层数组，**仍是顺序的事实源**）
2. `blueprint.js:linkImpls` — 27 个具名函数（其余 29 个走 void / empty 实现）
3. `linkMeta.js` + `toolRegistry.js` — 各种 `*Ids` 字段名约定 + vocabulary 计算

`v0.48.0` 在 `get_schema.vocabulary` 加了 11 条手写 `LINK_TYPE_PAIRS` 常量，与 `viewerModel.js` 的对应字段不一致——两处硬编码是技术债。本 ADR 抽取**元数据层**，让 linkType 描述性信息（描述、reverse 名、sourcePrefixes 等）有单一来源。

## Decision

### D1. 新增 `src/ontology/linkDefs.js`

**约束：本阶段只抽元数据，不改 linkImpls 行为**。linkDefs.js 是**描述性**事实源；blueprint.js 仍是**行为/顺序**事实源。

```js
// LINK_DEFS 数组：56 个 LinkDef
{
  name: 'renders',
  reverse: 'renderedBy',  // 只在 FORWARD def 上声明
  sourcePrefixes: ['comp:'],
  targetPrefixes: ['comp:'],
  description: '组件渲染其他组件（JSX/模板标签 → 目标组件）',
  category: 'reference',
  hasImpl: true,  // 是否在 blueprint.js linkImpls 中有具名实现
}

// 派生常量
LINK_DEF_BY_NAME       // name → def
LINK_TYPE_NAMES        // 56 个 linkType 全集
IMPLEMENTED_LINK_TYPES // 27 个有具名实现的子集
REVERSE_OF / FORWARD_OF
LINK_TYPE_PAIRS        // { renders: 'renderedBy', ... } —— 与 viewerModel 对齐
REVERSE_LINK_TYPES     // [renderedBy, importedBy, ...] 去重
LINK_DEFS_BY_CATEGORY  // { hierarchy: [...], reference: [...], derive: [...] }

// 派生工具函数
getLinkDef(name)         // 查 def；未知返回 null
acceptsSource(name, srcId)  // srcId 是否被 linkType 接受
hasLinkImpl(name)        // linkImpls 是否处理
```

### D2. 单一事实源：blueprint.js LINK_TYPES 是顺序/行为源，linkDefs 是描述源

为什么**不**把 `LINK_TYPES` 替换为 linkDefs 派生？
- `LINK_TYPES` 在多处被消费，**顺序敏感**（工具 schema enum / viewer UI 渲染顺序）
- 引入派生会让"linkDefs 一改，blueprint.LINK_TYPES 顺序跟着变"——回归风险大
- 测试已校验同步（test/linkDefs.test.mjs 的 56 个 ↔ 56 个同步断言）

### D3. `get_schema.vocabulary` 从内联常量切到 linkDefs 派生

`v0.48.0` 的 `LINK_TYPE_PAIRS` 11 条手写常量移除，改为从 linkDefs 派生。

```js
// 之前（v0.48.0）：
const LINK_TYPE_PAIRS = {
  contains: 'containedBy', belongsTo: 'belongsTo',
  imports: 'importedBy', ...
};

// 之后（v0.50.0）：
import { LINK_TYPE_PAIRS } from './linkDefs.js';
```

viewerModel.js 的 `LINK_TYPE_PAIRS` 也可在后续 round 替换为 linkDefs 导入（本 ADR 不动，保持单点改动）。

### D4. 约束规则（fail-fast）

`_validateLinkDefs(defs)` 模块加载时执行：
1. `name` 唯一
2. `reverse` 字段指有效 name 且不等于自身
3. `sourcePrefixes[]` 非空
4. **反向对只能 forward 端声明 `reverse`**（防止双声明）

```js
// ✅ 正确
{ name: 'renders', reverse: 'renderedBy', ... }
{ name: 'renderedBy', ... }  // 无 reverse 字段

// ❌ 错误（_validateLinkDefs 会抛错）
{ name: 'renders', ... }
{ name: 'renderedBy', reverse: 'renders', ... }
```

### D5. 数据建模原则

- `reverse` 字段**只声明在 forward def**（统一约定，避免歧义）
- `sourcePrefixes` 含此 linkType 可接受的源对象前缀（不含 target 端约束——多个 linkType 共享 target 类型）
- `targetPrefixes` 仅作 vocabulary 维度 hint（非硬约束，与当前 implementation 不耦合）
- `category` 三档：`hierarchy` / `reference` / `derive`（viewer Tab 维度用）

## Consequences

### 立即收益

- **零行为变化**：blueprint.linkImpls 27 个具名函数原样运行，981+ 现有测试零回归
- **单一事实源**：新增 linkType 现在改一处（linkDefs.js + blueprint.js LINK_TYPES），不是改三处
- **vocabulary 与 viewer 对齐**：从内联 11 条 → linkDefs 派生（17 条完整 reverse 对）；后续 v0.51 替换 viewerModel 端硬编码
- **接受检测**：`acceptsSource(name, srcId)` 现成工具函数，可用于未来 traverse_links 运行时校验

### 不直接解决的（明确留给后续）

- ❌ linkImpls 27 个具名函数仍硬编码在 blueprint.js — 这是 v0.51+ 的下一步（converter 钩子下放）
- ❌ viewerModel.js `LINK_TYPE_PAIRS` 仍硬编码 — 可在 v0.51 同步切换到 linkDefs

## Implementation

### 文件变更清单

| 文件 | 行数 | 性质 |
|------|------|------|
| `src/ontology/linkDefs.js` | 530 行（含 56 个 def 表格） | 新增 |
| `src/ontology/toolRegistry.js` | -5 / +5 行（替换内联常量） | 扩展 |
| `test/linkDefs.test.mjs` | 192 行 | 新增（11 测试） |
| `docs/adr/0015-linkDefs-metadata-layer.md` | 本文件 | 新增 |
| `CHANGELOG.md` | +50 行 | 新增 v0.50.0 段 |
| `package.json` | +1/-1 | version 0.48.0 → 0.50.0 |

### 验证

- [x] `toolRegistry.test.mjs` 29 测试全通过（无变化）
- [x] `linkDefs.test.mjs` 11 测试全通过
- [x] 与 blueprint.js LINK_TYPES 完全同步（56↔56）
- [x] 无新依赖
- [x] 全量测试 990+（待跑）

## References

- **借鉴分析**：`.nice-aos/analysis/asdm-aos-borrow-analysis.md §2-A`
- **asdm-aos-server 借形**：`/Users/healer2027/workprojetcs/workspace/asdm-workspace/asdm-aos-server/src/modules/graph/converter/aos-gitnexus/resolvers.ts:LINK_DEFS`
- **既有 linkImpls**：`src/ontology/blueprint.js:206` 起 27 个具名函数
- **既有 vocabulary**：`.nice-aos/analysis/asdm-aos-borrow-analysis.md §2-A`

## 后续候选（v0.51+）

| 主题 | 内容 | 与本 ADR 关系 |
|------|------|--------------|
| v0.51+ converter 钩子下放 | linkImpls 27 个函数 → lookup 表 + hooks | 本 ADR 是前置 |
| viewerModel 同步 | viewerModel.LINK_TYPE_PAIRS 改 import linkDefs | 受本 ADR 数据保障 |
| data-driven 新 linkType | 用 linkDefs + converter 双表新增 linkType 流程 | 受 linkDefs 单一事实源简化 |
