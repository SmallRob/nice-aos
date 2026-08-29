# ADR 0009: v0.41.0 统一 NetworkEndpoint —— outbound 侧接入（还清 v0.40.0 技术债）

**状态**：已实施（v0.41.0）
**日期**：2026-08-29
**触发**：ADR 0008 的 v0.41+ 候选清单中，候选 6（统一 NetworkEndpoint 升级）与候选 1（HTTP 客户端 ↔ NetworkEndpoint 双向 RPC 链）被选为优先项；实施前勘察发现候选 6 的真实性质是**还清 v0.40.0 的技术债**而非新增能力。

## 背景

### v0.40.0 遗留两处"孤儿 fact"

ADR 0008 的 D2（argparse CLI 参数）与 D3（Python HTTP 客户端）只完成了 **analyzer 层**抽取，**本体层从未消费**：

| fact | 抽取位置 | `src/` 内消费方 | 进本体图谱 |
|---|---|---|---|
| `facts.httpClientCalls` | `pythonAnalyzer.js:1110` | 无（仅声明 + 赋值） | ❌ |
| `facts.pythonCliParams` | `pythonAnalyzer.js:1108` | 无（仅声明 + 赋值） | ❌ |
| `facts.crossLangEdges` | `builder.js:3437-3473` | 有 → `_meta` | ✅ |

`dataMap.NetworkEndpoint` 的唯一来源是 `builder.js` 的油猴分支（`isUserScript`），最终汇入 `dataMap.NetworkEndpoint`。
**结论：iDRAC 一类仓库的全部 outbound URL 都不在图谱里。**

### 实体模型的油猴耦合

`NetworkEndpoint` 虽在 `blueprint.js` 里被声明为通用审计事实类型（L0 / AuditFact），但实体字段是油猴专用的：

- `scriptId` / `scriptName` —— 强绑定 UserScript
- `allowedByConnect` —— 对应油猴 `@connect` 白名单
- `kind` 取值域 —— `gm-xhr` / `fetch` / `xhr` / `websocket` / `beacon`，全部是浏览器侧概念
- 无 `direction` 字段 —— 无法区分 inbound / outbound，而这是 RPC 双向链的前提

### 存储投影层是空壳

`src/storage/seed.js` 的 `TYPE_PROPERTIES.NetworkEndpoint` 只有 `id` 一项。即便实体建出来，
v0.37.0 落地的 `aos_type_properties` 投影层也查不到任何维度。

## 决策

选定 ADR 0008 候选 6 的实现路径为**加 `direction` 字段而非拆新类型**（保持 `OBJECT_TYPES` 38 不变），
并连带三项改造 + 一项数据质量修复。

### D1. Python outbound 端点建实体（候选 6a）

新增 `buildPythonOutboundEndpoints()`（`builder.js`），消费 `facts.httpClientCalls`：

- **聚合键 = (method, url)，全局跨文件聚合** —— 同一端点被 N 个文件调用只产出一个实体。
  这是 RPC 链需要的语义（"这个 URL 被谁调用"），也避免 iDRAC 一类仓库产出数千个碎片实体。
- **id 规则**：`net:out:${method.toLowerCase()}:${slug(url)}`，slug 保留 `{}`/`%s`/`$` 等插值占位符，
  其余非安全字符折叠为 `_` 并截断到 140 字符；碰撞时追加 `#2`。排序后生成，保证不依赖扫描顺序。
- **油猴 id 规则不变**（`net:${relPath}#${kind}:${domain}`），向后兼容。

新增字段：

| 字段 | 说明 |
|---|---|
| `url` | 聚合键的 URL（单值） |
| `files` / `fileIds` | 调用该端点的文件（去重 + 排序） |
| `lines` | 调用点证据 `[{ file, line, lib, method, url }]` |
| `libs` / `lib` | 客户端库集合；`lib` 为 `libs.join('+')` |
| `hasAuth` / `hasJson` / `hasData` | 请求特征（任一调用点存在即为 true） |

接入两条路径：全仓库扫描（`buildOntologyData` 5b-1 段）与单文件分析（`buildSingleFileOntology`）。

### D2. 实体模型统一（候选 6b）

所有 NetworkEndpoint 实体（油猴 + Python）补齐三个通用字段：

- `direction: 'outbound'` —— 当前两侧都是客户端发出。**`inbound` 留待 v0.42.0 服务端 handler 接入时启用**。
- `lang: 'javascript' | 'python'`
- `lib: string | null` —— 油猴侧为 null

油猴专有字段 `allowedByConnect` / `scriptId` / `scriptName` 在 Python 侧置 `null`，
**字段保留以维持两端实体同构**，不做条件式字段裁剪。

### D3. 存储投影属性补齐（候选 6c）

`TYPE_PROPERTIES.NetworkEndpoint` 从 1 项扩到 10 项：
`direction` / `lang` / `lib` / `kind` / `domain` / `url` / `callCount` / `hasAuth` / `filePath`。
其中 `domain` 与 `url` 用 `btree` 索引提示（RPC 链的主要检索维度）；方向与语言是低基数枚举，不建索引。

### D4. 增量解析失效类型

`incrementalParser.js` 的 `defaultTypesForFile()` 对 `.py` 追加 `NetworkEndpoint`
（此前只有 `.user.js` 触发），否则改了 Python 里的 URL 不会重建端点。
该函数由 private 改为 export 以便单测覆盖。

### D5. 数据质量修复：`%` 格式化 URL 截断错误

v0.40.0 用 `urlRaw.replace(/^['"]|['"]$/g, '')` 去引号，遇到
`requests.get("https://%s/redfish/v1/Systems" % idrac_ip)` 会把 `" % idrac_ip` 一并留在 url 里，
产出 `https://%s/redfish/v1/Systems" % idrac_ip`。**iDRAC 大量使用此模式**（166 个端点中 160 个含占位符）。

改为提取首个字符串字面量：`/^[a-zA-Z]*(['"])((?:(?!\1).)*)\1/`，
前缀 `[a-zA-Z]*` 兼容 `f""` / `rf""` / `b""`。改动局限在 `extractHttpClientCalls` 内部，不影响其他调用点。

## 影响

### 端到端实测（iDRAC-Redfish-Scripting，225 文件）

| 指标 | v0.40.0 | v0.41.0 |
|---|---|---|
| `dataMap.NetworkEndpoint` 数量 | 0 | **166** |
| 跨文件聚合端点（files > 1） | — | 61 |
| 字面量 URL 端点 / 调用数 | 0 | 159 / 621 |
| 变量 URL 端点 / 调用数 | 0 | 7 / 164 |
| 含占位符 URL 端点 | — | 160 / 166（96%） |
| 全量扫描耗时 | ~1.5s | ~1.7s |

### 数据形态变更

- `NetworkEndpoint[].direction` / `lang` / `lib` / `libs` / `url` / `files` / `fileIds`：新增
- `facts.httpClientCalls[].url`：`%` 格式化表达式不再污染 URL（`urlRaw` 仍保留原始文本作为证据）
- `dataMap.NetworkEndpoint` 现在混合油猴端点与 Python 端点，消费方需按 `lang` / `direction` 区分

### 消费方适配

- `exporter.js` 网络请求表格：
  - 来源列 `scriptName ?? filePath`（油猴取脚本名、Python 取首调用文件），表头"脚本"→"来源"
  - kind 映射加 `http-client`（渲染为 `requests 客户端` 一类）
  - **新增"方法"列** —— 聚合后同一 URL 的 GET / POST 是独立端点，缺此列会渲染成两行完全相同的"重复行"
- `viewer.js`：`scriptBlueprint.totalNetworkCount` 改为只统计 `scriptId` 非空的端点，
  否则"脚本蓝图网络端点总数"会与列表里只列油猴端点的事实对不上
- `blueprint.js`：`NetworkEndpoint` 描述更新为统一语义（`OBJECT_TYPES` 仍 38、`LINK_TYPES` 仍 55）

### 向后兼容保证

- 油猴端点全部字段零变化（仅新增 `direction` / `lang` / `lib` / `files` / `fileIds`）
- 油猴端点 id 规则零变化
- `OBJECT_TYPES` 38 / `LINK_TYPES` 55 均不变
- 未新增依赖

## 已锁定决策

- D1 Python outbound 端点建实体（必做）
- D2 加 `direction` / `lang` / `lib` 三字段，不拆新类型（必做）
- D3 补齐存储投影属性（必做）
- D4 增量解析失效类型补 `.py`（必做）
- D5 `%` 格式化 URL 截断修复（必做）

## 不做（v0.41.0 范围外）

- **函数级归属 `fns` / `fnIds`** —— `pythonAnalyzer` 的 function fact 只有 `pos` 没有 `end`
  （`pythonAnalyzer.js:1144-1157`），无法可靠判定调用行归属哪个函数。
  用"最近前驱函数"近似归属会在模块级代码处误报，按保守原则**留空数组**，字段保留待 v0.42 补。
- **URL 占位符归一化**（`https://%s/redfish/v1/...` → 真实 host）—— 96% 端点含占位符，
  是 v0.42.0 RPC 链匹配的前置，需先 resolve `idrac_ip` 变量值（来自 CLI 参数或 `input()`）。
- **inbound 端点** —— 需 TS/Go 服务端 handler 接入，`direction` 字段已预留。
- **`callCount` 语义细化** —— analyzer 层按文件内 `(lib, method, url)` 去重只记首次，
  故 `callCount` 只在跨文件时累加，同文件内重复调用不计数。改 analyzer 去重策略会破坏既有用例，留待 v0.42。
- **`pythonCliParams` 进本体** —— 与 `httpClientCalls` 同源的孤儿 fact，但属候选 2（yaml config）的前置，留待 v0.43。
- **变量 URL 分类字段** —— 实测仅 7/166（4.2%）端点是纯变量 URL，加 `urlKind` 字段收益不抵复杂度。

## 后续候选（v0.42.0 起）

1. **HTTP 客户端 ↔ 服务端 handler 双向 RPC 链**（原候选 1）—— 可复用 `builder.js` 7c-d 段既有的
   `normPath` + `matchRoute`（当前用于 TS httpCalls ↔ Go 路由），把 Python outbound 端点接入同一套匹配。
2. **URL 占位符归一化** —— 依赖 `pythonCliParams` 进本体 + 变量值 resolve。
3. **CLI 参数 yaml 配置文件追踪**（原候选 2）—— 隐含依赖 `pythonCliParams` 实体化。
4. **跨语言 API 表面 diff**（原候选 3）—— 依赖 1 + 2，唯一有 CI 对外价值的一项。
5. 原候选 4（PowerShell DSC）/ 5（asyncio 链路）：ADR 0008 已注明 iDRAC 不使用，继续后置。

## 参考

- ADR 0008（v0.40.0 多语言脚本架构）—— 本 ADR 的触发来源与候选清单出处
- 抽样验证：`/tmp/idrac-analysis/iDRAC-Redfish-Scripting` — 225 文件 → 166 NetworkEndpoint
- 新增测试：`test/networkEndpoint.test.mjs`（11 例）；全量 864/864 通过（v0.40.0 基线 853）
