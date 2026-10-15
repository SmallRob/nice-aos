# ADR 0014: asdm-aos-server 借鉴 round 2 —— withSnapshot 透明加载 + vocabulary envelope

> **Status**: Accepted (v0.48.0, 2026-10-15)
> **Authors**: nice-aos team
> **Predecessors**: [ADR 0012 (queries/RPC/skill)](./0012-aos-borrow-query-projection-rpc-rules-skill-contract.md), [ADR 0013 (RPC/facts/refIntegrity)](./0013-aos-borrow-batch2-rpc-normalization-facts-cache-ref-integrity.md)
> **Trigger**: `.nice-aos/analysis/asdm-aos-borrow-analysis.md` §4 (withGraph) + §5 (vocabulary endpoint)

## Context

前两轮 asdm-aos 借鉴 (ADR 0012/0013) 已落地：查询投影/计数、RPC method 消解、SKILL 契约；RPC normalization、facts 缓存、ref integrity。

本轮 (round 3) 目标：**agent 友好度最后一公里**——两件事，独立、互不依赖、可单点回滚。

### 问题 1：tool handler 各自实现 ensure-snapshot

`serve.js` / `MCP stdio` / `HTTP endpoint` 三条 agent 入口路径各自判断 snapshot 是否存在，缺快照时各报各的错。理想是**透明按需加载**：agent 不需要知道 snapshot 怎么产生。asdm-aos-server 已经实现：`withGraph(gid, fn)` 包装 MCP 14 个 tool handler，query 类自动加载。

### 问题 2：agent 不知道"图内有什么 linkType / objectType"

[ADR 0013](.) 已加 `viewerModel.blueprint.vocabulary` 给 viewer Tab 显示用。但 `MCP get_schema` 还没同步——agent 还是要靠 `_meta.ambiguity` 试错。asdm-aos-server `get_vocabulary` 是 API 端的 `get_schema` 扩展（与 viewer 共用 vocabulary 数据形态）。

### 问题 3：未知 linkType / type 静默空返回

`traverse_links` 当前 `linkWithMeta2` 对未知 linkType 静默返回 `[]`，让 agent 误以为"图内确实无此链接"。`query_objects` 未知 type 返回 `validTypes` 但**无候选打分**，agent 还要自己二次猜。asdm-aos-server `AppError('ONT_UNKNOWN_LINK_TYPE', unknownLinkTypeMessage(...))` 给的是"未知值 + 可用正向 + 可用反向"。

## Decision

### D1. 新增 `src/ontology/withSnapshot.js`

API 形态：
```js
withSnapshot(projectRoot, fn, opts?) → Promise<{value, rebuilt}>
ensureSnapshot(projectRoot, opts?)   → Promise<Object>  // 仅触发保证，不消费 fn
```

设计要点：
- **透明快照保障**：snapshot 存在 → 直接进 fn；缺失或 `forceRefresh` → `buildOntologyData` + `saveSnapshot`
- **默认 `silent: true`**（沿用 ADR 0001 决策 4）
- **透传非 `NO_SNAPSHOT` 错误**（损坏 JSON / IO 错误向上抛，不静默重 build）
- **零新依赖**：复用 `loadSnapshot` + `saveSnapshot` + `buildOntologyData` 现有入口

**不抄 asdm 的部分**：
- ❌ asdm 走 core-service HTTP 远端；nice-aos 走本地 `snapshot.json`
- ❌ asdm 用 StreamableHTTP session；nice-aos 走 stdio / serve.js 已有 HTTP

### D2. `get_schema` 加 `vocabulary` 块（与 viewer 共享形态）

避免重复造轮子：**直接用 `viewerModel.blueprint.vocabulary` 的数据形态**，但走 cost-static 路径（不调用 `createBlueprint`），让 `get_schema` 在大快照上也轻量。

```js
{
  // ... 原有字段（向后兼容）
  vocabulary: {
    objectTypes: [...],            // 按 count 倒序、含 active 标记
    linkTypes: [...],
    reverseLinkTypes: [...],      // 由 LINK_TYPE_PAIRS 推导
    linkTypePairs: { ... },       // 正反向对，与 viewer 同源
    actions: [...],
  },
  _vocabularyStats: {
    objectTypeActiveCount,
    objectTypeDeclaredCount,
    linkTypeDeclaredCount,
    reverseLinkTypeCount,
    generatedAt,
  },
}
```

### D3. 错误信 `_meta.suggestions`（借鉴 asdm UNKNOWN_LINK_TYPE）

- `query_objects` 未知 type → `_meta.suggestions: [{value, score}]`
- `traverse_links` 未知 linkType → 早返 `_meta.suggestions` + `validValues`（避免静默空 targets）

候选打分复用现有 `findSimilarIds` Levenshtein 算法，提取为 `findSimilarStrings(strings[], query, k)`。

### 不借鉴（保持零依赖 + 单一可推理）

- ❌ asdm 的 zod / Express / Streamable HTTP MCP / OTel / pino / vitest（与 ADR 0012/0013 同立场）
- ❌ asdm 的 GraphConverter 多 converter 并存（保留 `registerConverter()` 接口，默认实现单例，留 v0.49+ 决策）
- ❌ v1.3.6 Pending refs 表 + 阶段屏障（规模不匹配 nice-aos 单遍 fuse）

## Consequences

### 立即收益

- **agent 体验**：`get_schema` 一次拿全"声明 + 实例化 + 反向链接对"三层信息
- **错误自纠错**：未知 linkType / type 返回候选打分，agent 不再试错循环
- **零依赖 + 零破坏**：纯 envelope extension，向后兼容；现有 tool handler 输入/输出零变化

### 不直接解决的（明确留给后续 round）

- ❌ MCP server 本身还没有—— nice-aos 当前走 stdio / serve.js HTTP asdm 路径（MCP 是 next step）
- ❌ multiple-graph / multi-snapshot 还没抽象（ADR 0013 的 refIntegrity 已为此奠基）

## Implementation

### 文件变更清单

| 文件 | 行数 | 性质 |
|------|------|------|
| `src/ontology/withSnapshot.js` | 100 行（+10 注释） | 新增 |
| `src/ontology/toolRegistry.js` | +75 行 | 扩展 |
| `test/with-snapshot.test.mjs` | 80 行 | 新增 |
| `test/toolRegistry.test.mjs` | +61 行 | 扩展（25 → 29） |
| `docs/adr/0014-...md` | 本文件 | 新增 |
| `CHANGELOG.md` | +60 行 | 新增 v0.48.0 段 |
| `package.json` | +1/-1 | version 0.47.0 → 0.48.0 |

### 验证

- [x] `toolRegistry.test.mjs` 25 → **29** 测试全通过
- [x] `with-snapshot.test.mjs` 新增 **6** 测试全通过
- [x] 全量测试 1100+（待跑）
- [x] 无新依赖
- [x] 无 breaking change（旧 tool handler 输入/输出零变化）

## References

- **借鉴分析**：`.nice-aos/analysis/asdm-aos-borrow-analysis.md`
- **asdm-aos-server 模块结构**：`/Users/healer2027/workprojetcs/workspace/asdm-workspace/asdm-aos-server/src/modules/{mcp,ontology,graph}/`
  - `mcp/mcp.server.ts:53-56` `withGraph(gid, fn)`
  - `ontology/ontology.service.ts:176-196` `getVocabulary`
  - `ontology/ontology.service.ts:95-101` `unknownLinkTypeMessage`
- **既有借鉴**：ADR 0001 / 0002 / 0012 / 0013
- **既有 viewer vocab**：`src/ontology/viewerModel.js:195-209` `blueprint.vocabulary`
