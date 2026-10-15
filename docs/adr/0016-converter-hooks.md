# ADR 0016: ontology converter 钩子下放（v0.51.0）

> **Status**: Accepted (v0.51.0, 2026-10-15)
> **Predecessors**: [ADR 0015 (linkDefs 元数据层)](./0015-linkDefs-metadata-layer.md), [ADR 0014 (withSnapshot + vocabulary envelope)](./0014-asdm-aos-withsnapshot-vocabulary-envelope.md)
> **Trigger**: `.nice-aos/analysis/asdm-aos-borrow-analysis.md` §2-B "GraphConverter 抽象"

## Context

借鉴分析报告 §2-B 指出 ontology service 应该把"领域特定语义"与"通用遍历"分离：
- **通用遍历**（service 层）：按类型过滤、按 linkType 查邻接表 —— 当前已在 linkMeta.js 落地
- **领域特定语义**（converter 层）：多态扩展、virtualEntity、linkVocabulary 暴露 —— 当前**散落在 toolRegistry / viewerModel 两处硬编码**

v0.50.0 (linkDefs) 把数据形态抽了出来，本 v0.51.0 把"遍历方向 / 词汇派生"抽到 converter 钩子。注意**保持轻量原则**（用户明确要求）：
- 不动 blueprint.js 27 个具名 linkImpls
- 不动 linkMeta.js（除非为接入 converter 改一处）
- viewerModel 保留自身扩展的 19 对 UI 词汇（不与 linkDefs 硬同步，承认 API/UI 双视图合理）

## Decision

### D1. 新增 `src/ontology/converter.js`

单一文件承载 converter 抽象 + 默认实现 + 注册表接口：

```js
export const niceAosConverter = {
  // 钩子 1：linkType → {base, direction}
  resolveLink(linkType) {
    const forwardFromReverse = FORWARD_OF[linkType];
    if (forwardFromReverse) return { base: forwardFromReverse, direction: 'in' };
    if (LINK_DEF_BY_NAME[linkType]) return { base: linkType, direction: 'out' };
    return null;
  },
  
  // 钩子 2：遍历后处理（当前空，接口留位）
  expandLinked(_ctx) { return []; },
  
  // 钩子 3：词汇派生
  linkVocabulary() {
    return {
      linkTypePairs: { ...LINK_TYPE_PAIRS },
      reverseLinkTypes: [...new Set(REVERSE_LINK_TYPES)],
    };
  },
};

// 注册接口（接口式 API，保持默认 singleton）
export function getConverter() { return _activeConverter; }
export function registerConverter(converter, { default = false } = {}) {
  if (opts.default === true) _activeConverter = converter;  // 必须显式 default 才替换
}
export function __resetConverterForTest() { _activeConverter = niceAosConverter; }
```

### D2. 只 wire 一处：toolRegistry.get_schema.vocabulary

`get_schema.vocabulary.linkTypePairs` 与 `reverseLinkTypes` 字段从 converter.linkVocabulary() 派生：

```js
// 之前（v0.50.0）：直接从 linkDefs.LINK_TYPE_PAIRS 取
import { LINK_TYPE_PAIRS } from './linkDefs.js';

// v0.51.0：透过 converter（接口稳定，内部可替换）
const vocab = converter.linkVocabulary();
const linkTypePairs = vocab.linkTypePairs;
const reverseNames = vocab.reverseLinkTypes.filter(v => LINK_TYPES.includes(v));
```

**为什么 wire 工具层而非 viewerModel**：
- viewerModel 端有 19 对 UI 词汇（含 `passesProps → propsFrom`、`usesHook → usedByHook` 等），与 linkDefs 17 对不同
- 这是 API/MCP 端"已实现反向"vs Viewer UI 端"展示性反向"的合理双视图
- 当前 nice-aos 不需要硬同步两套视角；保持各自语义清晰

### D3. 注册表接口（接口式 API，留作 v0.52+ 评估）

```js
// 单 converter swap（默认 singleton）
registerConverter(myConverter, { default: true });
const curr = getConverter();  // = myConverter
```

**保持最小化**：
- 单 converter 同时只有一个活跃
- 多 converter 并存市场场景（asdm 风格）留 v0.52+ 评估，**当前不实施**
- 任何 hook 都是纯函数，无副作用、无 IO

### D4. 不动现有架构

| 文件 | 是否改 | 原因 |
|------|--------|------|
| `blueprint.js` | ❌ | 27 个具名 linkImpls（v0.51 后续 round） |
| `linkMeta.js` | ❌ | 工作良好；后续 round 再考虑接入 converter 钩子 |
| `viewerModel.js` | ❌ | UI 端独立词汇（19 对）合理保留 |
| `linkDefs.js` | ❌ | v0.50.0 已稳定，被 converter 复用派生数据 |
| `toolRegistry.js` | ✅ | get_schema.vocabulary 走 converter（wire 一处示范） |

## Consequences

### 立即收益

- **接口稳定**：toolRegistry.get_schema.vocabulary 行为对调用方零变化（同样的 linkTypePairs / reverseLinkTypes 数据形态）
- **可扩展性**：未来 v0.52+ 若需要多 converter，可直接复用 registerConverter 接口
- **零新依赖**：与 v0.48.0/v0.50.0 一致（无新依赖）
- **零行为变化**：981+ 测试无回归（992 → 1003，+11 new converter tests）

### 不直接解决的（明确留给后续）

- ❌ linkImpls 27 个具名函数硬编码（仍在 blueprint.js）— v0.52+ 时机成熟再迁移
- ❌ linkMeta.js `expandLinked` 钩子未真接入 — 当前默认空实现，接口留位
- ❌ viewerModel.LINK_TYPE_PAIRS 仍硬编码 — UI 词汇独立原则保留

## Implementation

### 文件变更清单

| 文件 | 行数 | 性质 |
|------|------|------|
| `src/ontology/converter.js` | 178 行（含注释） | 新增 |
| `src/ontology/toolRegistry.js` | -3 / +5 行（导入 getConverter + 派生替换） | 扩展 |
| `test/converter.test.mjs` | 200 行（11 测试） | 新增 |
| `docs/adr/0016-converter-hooks.md` | 本文件 | 新增 |
| `CHANGELOG.md` | +50 行 | 新增 v0.51.0 段 |
| `package.json` | +1/-1 | version 0.50.0 → 0.51.0 |

### 验证

- [x] `toolRegistry.test.mjs` 29 测试全通过（无变化）
- [x] `linkDefs.test.mjs` 11 测试全通过
- [x] `converter.test.mjs` 11 测试全通过
- [x] 全量测试 1003（992 + 11）
- [x] 无新依赖
- [x] 无 API 兼容性破坏

## References

- **借鉴分析**：`.nice-aos/analysis/asdm-aos-borrow-analysis.md §3`
- **asdm-aos-server 借形**：`/Users/healer2027/workprojetcs/workspace/asdm-workspace/asdm-aos-server/src/modules/graph/converter/aos-gitnexus/index.ts`
- **linkDefs 数据源**：`src/ontology/linkDefs.js` v0.50.0
- **既有 API**：get_schema.vocabulary 字段 v0.48.0 首次引入

## 后续候选（v0.52+）

| 主题 | 内容 | 备注 |
|------|------|------|
| MCP server 接入 | toolRegistry.call() 接 MCP protocol | 需 user 决策 stdio vs HTTP transport |
| linkImpls 27 函数 → lookup 表 | blueprint.js linkImpls 收敛为表 + hooks | 本 ADR 是前置 |
| linkMeta.js 接入 converter.expandLinked | 当前 expandLinked 空实现；接入后真实多态扩展 | 后续 round |
| 多 converter 并存市场 | 当前 registerConverter 默认 singleton；多 converter 评估后定 | 视实际需求 |
