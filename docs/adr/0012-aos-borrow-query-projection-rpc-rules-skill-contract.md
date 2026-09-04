# ADR 0012: 借鉴 asdm-aos —— 查询投影/计数、RPC 匹配 method 消解与人工规则层、SKILL 行为契约

**状态**：已实施（v0.44.0）
**日期**：2026-09-04
**触发**：对上游 @leansoftx/asdm-aos v0.0.24（D:\workspace\aos）的对比分析。ADR 0001/0002 已吸收
蓝图引擎等早期能力；本 ADR 吸收三个经对方实战验证、nice-aos 仍欠缺的点：
①查询字段投影与计数 ②RPC 匹配的 method 歧义消解 + 人工路由规则层（matchedVia 可审计）
③SKILL 的 agent 行为契约写法。

## 背景

1. **agent 消费链路无字段投影**。query / serve `/api/objects` / MCP `query_objects` 都是全字段输出，
   Method/SourceFile 等类型单条就含大量属性，`--all` 全量输出轻易撑爆 agent 上下文。
   asdm-aos 的 `--field` 投影把输出降到 KB 级，其 SKILL §8.5 明确记录了"大输出禁管道，必须落临时文件
   或投影"的实战教训；另有 `count <Type> --where` 一行 JSON 供聚合。
2. **匹配存在两类缺口**：
   - 同 path 不同 method 的多路由（`GET /api/users` + `POST /api/users`）在两轮严格段匹配
     （ADR 0010 D3）下返回声明顺序的第一个命中，method 明明可分辨却选错路由；
   - 网关/nginx 前缀改写场景（nice-aos 自身就分析 nginx.conf）没有人工规则入口，自动匹配失败
     即断链，且无审计字段区分"自动命中"与"规则命中"。
   asdm-aos matchEngine 的结论可移植：**API 路径是强契约，拒绝评分制；平台层路由知识必然来自
   人工输入，规则命中必须 matchedVia 可审计**。
3. **SKILL 已有"Agent 行为规范"表**，但缺三类对方打磨出的契约：防呆（先看真实样本再写 where）、
   停止条件（链路中断何时停止追溯）、大输出纪律。

## 决策

### D1. 投影公共件 `parseFields` / `projectObjects`（cli/shared.js）

- `parseFields('id,name,filePath')` → `['id','name','filePath']`（逗号分隔、trim、去空；空/undefined → null）；
- `projectObjects(objects, fields)`：字段白名单投影。**`id` 恒保留**（agent 定位锚点，无需重复请求）；
  对象上不存在的请求字段不产生键（投影结果即"该对象实际拥有的白名单子集"，不产生 undefined 键）；
- 三个消费方共用：CLI `query --field`、serve `/api/objects?fields=`、MCP `query_objects.fields`。

### D2. `count` 命令

- `nice-aos count <type> [--where "..."]` → **单行紧凑 JSON** `{ok, type, where?, total}`；
- 单行而非 `outputJson` 两空格缩进：计数是聚合动作，agent 与 jq 管道都只需要一行；
- 未知类型走 `fail()`，与 query 一致；不提供 `--field/--limit/--all`（对计数无意义）。

### D3. `matchApiRouteEx`：method 作同路径多路由的优先级判据（不违反 ADR 0010 D3）

- 新函数 `matchApiRouteEx(reqSegs, routeSegsList, { method, rules })` → `{ route, via } | null`；
  `matchApiRoute` 变薄包装（`matchApiRouteEx(...)?.route ?? null`），**既有调用方（7c-d 段）行为零变化**；
- 阶梯（提供 method 且 ≠ `'MIXED'` 时）：**1 字面量+method 命中 → 2 字面量 → 3 通配+method → 4 通配**；
  无 method（或 MIXED，含义是 method 未定）时退化为现状（1 字面量 → 2 通配）；
- **method 只作同路径多路由的消解优先级，不做硬门**：路径唯一命中时 method 不一致仍建链，
  `methodMatches` 仍如实记录——ADR 0010 D3 的"软校验 + 为跨语言 API diff 留数据"哲学不变；
- 两者关系：D3 决定"建不建链不看 method"，本决策只决定"多条路径命中时先试 method 一致的那条"。

### D4. 人工路由规则层（`apiRouteRules.js` + `<root>/.nice-aos/api-routes.json`）

- 规则格式：`{ "rules": [{ "from": "/gw-api", "to": "/v2/api", "comment": "网关前缀改写" }] }`
  （顶层裸数组也接受）。`from`/`to` 必须以 `/` 开头；段级前缀改写语义：请求段前缀 `from` → `to`，
  余段保留。**不做正则/通配**——人工规则要可读可审计；
- 加载：7c-d2 段匹配前调 `loadApiRouteRules(projectRoot)`；文件缺失 → 空规则零警告（默认形态）；
  非法 JSON / 无效条目 → 跳过并记 warning，**不阻断构建**（对齐 DDL 解析错误隔离哲学）；
- 应用时机：**自动阶梯全部未命中后重试**（asdm-aos 阶梯 5 语义），避免规则劫持本可自动匹配的路径；
- 命中回执：`apiMatch.matchedVia = "rule:/gw-api→/v2/api"`（仅规则命中才有该字段，自动命中无）；
  `_meta.rpcChain` 新增 `ruleMatched`（规则命中数）、`rulesCount`（生效规则数）、
  `rulesWarnings`（仅非空时出现）。

### D5. SKILL 行为契约扩充（nice-aos-skill 试点）

- **查询纪律**（防呆三则）：先样本后过滤（首次查询不熟悉的类型先 `query <Type> --limit 3 --field id,name`
  看真实字段与取值，再写 `--where`）；已知 id 找字段用 `--field` 投影降 token；大输出先缩小或落临时文件；
- **停止条件表**（链路中断判断，适配 nice-aos 自身语义）：`importedBy` 递归影响面不假设层数；
  `link callsApi` 未命中 ≠ 链路不存在（php/next-api 路由不在 `SERVER_API_ROUTE_TYPES`）；
  `apiMatch.methodMatches=false` 是如实记录不是 bug；`~` 模糊匹配多命中时先看候选再下结论；
- 命令参考补 `--field` 与 `count` 用法。

## 影响

### 接口形态变更

| 消费方 | 变更 |
|---|---|
| `query` | 新增 `--field <fields>`（投影在 where 过滤与 limit 截断之后应用） |
| 新命令 `count` | 顶层命令 18 → 19 |
| `serve /api/objects/:type` | 新增 `fields` 查询参数 |
| MCP `query_objects` | inputSchema 新增 `fields: string[]` |
| `NetworkEndpoint.apiMatch` | 新增可选 `matchedVia` |
| `_meta.rpcChain` | 新增 `ruleMatched` / `rulesCount`（/`rulesWarnings`） |

### 兼容性

- `matchApiRoute` 对外签名与行为不变；规则文件缺失时 RPC 链构建结果与 v0.43 完全一致；
- `--where/--limit/--all/--pretty` 语义不变；快照 schema 无 breaking change。

## 已锁定决策

- D1 投影白名单语义、id 恒保留（必做）
- D2 count 单行 JSON（必做）
- D3 method 仅作消解优先级，不做硬门，不违反 ADR 0010 D3（必做）
- D4 规则文件 `<root>/.nice-aos/api-routes.json`、自动未命中后重试、matchedVia 可审计（必做）
- D5 核心 skill 试点行为契约（必做）

## 不做（本 ADR 范围外）

- **评分制匹配**——asdm-aos 明确拒绝（"评分制把不确定伪装成高分"），nice-aos 同意；
- **7c-d 段（TS httpCalls）接入 method/rules**——ADR 0010 候选 D（7c-d 扩到 Python 路由并合并循环）
  一并留后续，本 ADR 只动 7c-d2 段；
- **SQLite `queryWhere` 投影下推**——JSON 层投影已满足 agent 场景，下推属 storage 优化；
- **规则正则/通配语法、规则热加载**——规则在构建期消费，serve 只读快照，无热加载需求；
- **其余 11 个 skill 的契约扩充**——核心 skill 试点，反馈后再铺开。

## 后续候选

1. `export`/Markdown 的 `--field` 支持（复用同一对公共件）；
2. ADR 0010 候选 D：7c-d 段扩到 `SERVER_API_ROUTE_TYPES` 并接入 method/rules；
3. `apiMatch` 增加 tier 记录（字面量/通配/method 消解来源），为跨语言 API diff（候选 3）铺数据。

## 参考

- asdm-aos v0.0.24：`src/cli/shared.ts`（parseFields/projectObjects）、`src/cli/commands/count.ts`、
  `src/server/analyzers/shared/matchEngine.ts`（严格阶梯 + matchedVia）、
  `docs/frontend-backend-route-mapping.md`（T1/T2/T3 路由差异模型）、
  `skills/asdm-aos-skill/SKILL.md` §7/§8.5/§9/§10
- 本仓库：ADR 0010（RPC 双向链、method 软校验锁定）、`docs/plan/aos-three-core-roadmap.md`
- 新增测试：`test/queryProjection.test.mjs`（投影公共件 + count CLI + 规则加载 + 匹配阶梯单元）；
  `test/rpcChain.test.mjs` +5 例（method 消解 / 规则命中 / 规则不劫持 / 无规则兼容 / matchedVia 回执）
