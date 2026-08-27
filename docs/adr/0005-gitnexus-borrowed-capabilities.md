# ADR 0005: GitNexus 借鉴 v0.35.0

> 状态：已采纳
> 日期：2026-08-27
> 触发：nice-aos 自扫 GitNexus（4500+ 文件仓库）后产出的对比分析（`.nice-aos/analysis/gitnexus-graph-borrow-analysis.md`）

## 一、背景

`nice-aos` 与 `GitNexus` 同属"代码库 → 知识图谱 → AI/人消费"赛道，但工程重心不同：
- nice-aos 强在**本体建模**（19 对象 / 24 链接、L0-L3 taxonomy）与零依赖自包含蓝图
- GitNexus 强在**图的深度**（461 条端点对的单关系表 + 边元数据）、**调用边精度**（接收者类型约束）、**认知诚实**（epistemic 协议）与**交互式力导向可视化**

综合判定（见分析报告）：7 个对比维度中 5 个存在可借鉴点，其中 4 项列入 v0.35.0 路线图。

## 二、决策

v0.35.0 增量引入 GitNexus 范式 4 项：

| 决策 | 落地模块 | 优先级 |
|------|----------|--------|
| D1 | **链接元数据** `linkWithMeta2` 返回 `{id, confidence, reason}`（模糊推导边降权） | P1 |
| D2 | **epistemic 信封** MCP 工具响应加 `_meta.epistemic` + 歧义候选列表 | P1 |
| D3 | **解析覆盖度记账** `_meta.resolutionStats` 把"已知限制"从文档变成数据 | P2 |
| D4 | **蓝图邻接聚焦交互** SVG 选中节点提亮 + 其余淡出 + 大图预算熔断 | P2 |

不借鉴的项（明确否定）：
- ❌ LadybugDB 原生图数据库栈（nice-aos SQLite 镜像已够用且部署更轻）
- ❌ LangChain 内嵌 agent（ask 已有更轻的 CLI/模型服务降级链）
- ❌ Sigma.js WebGL 可视化栈（与零依赖路线冲突）
- ❌ TS 方法级 receiver-constrained 调用图（v0.35.x 范围外，P3 留作长期）

## 三、设计细节

### D1 链接元数据

**模块**：`src/ontology/linkMeta.js`（新）

```
linkWithMeta2(ctx, linkType, srcId) → [{id, confidence, reason}]
linkBfsWithMeta(ctx, linkType, srcId, depth) → {byDepth: [{depth, count, edges}]}
```

元数据写入约定（builder.js 侧）：
- 源对象上 `<linkType>Meta` 数组与 `*Ids` 一一对应
- 缺省时降级为 `confidence: 1.0, reason: 'direct'`
- 模糊推导边的预设（与 builder.js 当前解析路径对齐）：
  - `vue-global-fallback` → 0.6（renders 经 Vue.component 全局注册兜底）
  - `vue-same-file-fallback` → 0.5（renders 经同文件兜底）
  - `auto-imported` → 0.7（usesStore 经 unplugin-auto-import 隐式调用）
  - `missing-source` → 0.4（prop 边源/目标组件缺失）
  - `name-convention` → 0.5（mapsToTable 经命名约定）

**向后兼容**：现有 `link(linkType, srcId)` 仍返回对象（不破坏 24 链接解析函数）；新功能通过独立入口调用。

### D2 epistemic 信封

**模块**：`src/ontology/toolRegistry.js`（扩展）

```
traverse_links:
  _meta: { epistemic: 'exact' | 'lower-bound', confidence: 0..1, causes: [], count, at, ... }
  withMeta: true  → 额外返回 edges: [{id, confidence, reason}]
  depth > 1       → 额外返回 byDepth: [{depth, count, edges}]

get_node 不存在:
  _meta: { epistemic: 'lower-bound', ambiguity: { queried, candidates: [{id, name, _type, score}] } }

query_objects 歧义名:
  _meta: { ambiguity: { queriedName, distinctNames, candidates: [{name, count, sampleId, relevance}] } }
```

**认知诚实**：
- 找不到时返回候选（不静默二选一）—— Levenshtein + prefix + 子串打分
- 模糊匹配不抛错，但通过 `_meta.ambiguity` 提示存在歧义
- 现有返回字段（`ok` / `targets` / `count` / `links` / `refs`）零变化，零迁移成本

### D3 解析覆盖度记账

**模块**：`src/ontology/builder.js`（`_meta.resolutionStats`）

字段：
| 字段 | 含义 |
|------|------|
| `totalImportAttempts` | 所有 import 声明总数 |
| `totalResolvedImports` | 解析成功数 |
| `unresolvedImportsCount` | 解析失败（无候选文件） |
| `unresolvedDynamicImportsCount` | defineAsyncComponent / React.lazy 解析失败 |
| `vueGlobalFallbackCount` | renders 经 Vue.component 全局注册兜底 |
| `vueSameFileFallbackCount` | renders 经同文件兜底 |
| `autoImportedUsesStoreCount` | usesStore 经 unplugin-auto-import 隐式调用匹配 |
| `matchedRouteCount` | 前后端路由匹配命中数 |
| `unmatchedFrontendCallsCount` | 前端 API 调用未匹配到后端路由 |
| `importResolutionRate` | 派生：totalResolvedImports / totalImportAttempts |
| `fuzzyLinkCount` | 派生：所有模糊边计数 |

**借鉴点**：GitNexus `resolution-outcome.ts` 把"解析失败"建成机器可读数据；nice-aos 的"宁漏报不误报"哲学 → 失败本身就是信号。

### D4 蓝图邻接聚焦交互

**模块**：`src/ontology/viewer.js`（`renderCodeGraph` + CSS）

交互范式（v0.35.0 增强）：
- 选中节点 → 邻接边提亮 ×1.5 + 描边强化 + 描边阴影
- 选中节点 → 邻接节点提亮 + 尺寸描边 3.5px + drop-shadow
- 非邻接节点压暗至 0.18 alpha
- 非邻接边压暗至 0.06 alpha
- 已有 `cgSetFocus` 函数 + `Esc` / "清除聚焦" 按钮 / 重置视图 三种解除方式

**渲染预算声明**（`renderBudgets` 在 viewmodel）：
- `moduleGraphNodeCap: 90` / `componentGraphNodeCap: 130` / `storeGraphNodeCap: 36` / `graphEdgeCap: 600`
- UI 拿 budgets 与 `codeGraph` 对比，超 cap 时显示 `<span class="warn">节点已达渲染上限 N</span>`
- 借鉴 GitNexus "~25K 节点 / ~50K 边悬崖" 的明确大图阈值熔断

## 四、影响

### 4.1 API 兼容

| 表面 | 兼容性 | 说明 |
|------|--------|------|
| `traverse_links` 旧调用 | ✅ 完全兼容 | `targets` / `count` / `ok` 字段零变化；`_meta` 是新增 |
| `get_node` 旧调用 | ✅ 完全兼容 | 找不到时 `ok=false, error=...` 不变；`_meta.ambiguity` 是新增 |
| `query_objects` 旧调用 | ✅ 完全兼容 | 唯一匹配时不附 `_meta`（与原行为一致） |
| `get_health` | ✅ 完全兼容 | `summary.resolutionStats` 为 null 时等同于无此字段 |
| 快照 `_meta` | ✅ 向后兼容 | 新增 `resolutionStats`；老快照反序列化不报错（缺字段时为 undefined） |

### 4.2 性能

- 链接元数据：仅在 `withMeta=true` 时附加 `edges` 数组（零开销默认）
- epistemic 信封：固定形态的 JSON，< 200 字节开销
- 解析覆盖度计数：内联在现有循环中，开销 < 1% 总扫描时间
- SVG 邻接聚焦：CSS 切换，零 JS 计算

### 4.3 测试

新增 `test/linkMeta.test.mjs`（16 tests）：
- `linkWithMeta2` 直连边 / 模糊边 / 缺省降级 / 'links' 聚合 / 未知 linkType
- `linkBfsWithMeta` byDepth 分层 / cycle 防爆 / pathConfidence
- epistemic 信封：traverse_links 成功 / 源不存在 / withMeta / get_node 找不到 / query_objects 歧义
- get_health 暴露 resolutionStats

回归覆盖：原 22 个 toolRegistry 测试 + 96 个其他测试 = 114 全部通过。

## 五、不借鉴项的进一步说明

| 候选 | 不借鉴原因 |
|------|-----------|
| LadybugDB | 部署更重；nice-aos SQLite 镜像 + JSON 导出已满足 5s/1000 文件场景 |
| LangChain agent | 已有 ask CLI 降级链（codebuddy → opencode → OpenAI 兼容模型）更轻 |
| Sigma.js WebGL | 与"零依赖自包含 HTML"路线根本冲突；SVG 力导向已够用 |
| TS 方法级 receiver-constrained | 工作量 ~2 周；当前 v0.35.0 路线图不接受此规模；留 P3 长期 |
| Process / Leiden 社区聚类 | nice-aos 的 Domain 依赖显式结构信号（路由+目录），稳定且可解释；Leiden 适合无路由场景 |
| `[IMPACT:id]` AI 标记回灌 | 依赖外部 AI agent 行为约定；当前 blueprint-ai-agent 还未稳定接收；留 P3 |

## 六、后续（v0.36+ 候选）

1. **TS 方法级调用图**（receiver 约束简化版：点号绑定 + 显式类型注解两档）—— 配合 D3 直接降低死代码误判
2. **AI 标记回灌**：`[对象ID]` 解析 → SVG 元素高亮 —— 需 blueprint-ai-agent 协议层支持
3. **Process 入口流**：借鉴 GitNexus entry-point-scoring，给 nice-aos 增"用户触达路径"一等节点

## 七、参考文献

- 分析报告：`.nice-aos/analysis/gitnexus-graph-borrow-analysis.md`
- GitNexus 仓库：https://github.com/serena-ai-engineering/GitNexus
- 关键源文件（已扫描验证）：
  - `gitnexus-shared/src/lbug/schema-constants.ts`（单关系表 + 边元数据）
  - `gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts`（10-case 分发）
  - `gitnexus/src/core/ingestion/community-processor.ts`（Leiden + 固定种子）
  - `src/mcp/tools.ts`（17 工具 + epistemic envelope）
  - `gitnexus-web/src/hooks/useSigma.ts`（reducer 邻接聚焦）
