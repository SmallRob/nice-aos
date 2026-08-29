# ADR 0010: v0.42.0 前后端 RPC 双向链 —— outbound 端点 ↔ 服务端 API 路由

**状态**：已实施（v0.42.0）
**日期**：2026-08-29
**触发**：ADR 0008 的 v0.41+ 候选 1。ADR 0009（v0.41.0）已把 Python outbound 端点接进本体图谱，
本 ADR 完成其上层应用：把这些端点与服务端路由双向建链，构成完整 RPC 拓扑。

## 背景

v0.41.0 之前，nice-aos 对"谁调用了这个 API"只有半条链路：

- **7c-d 段**（`builder.js`）已实现 TS/JS 前端 `httpCalls` ↔ Go 路由的匹配，产出 `route.frontendCalls`。
  但它只覆盖 `routeType === 'go'`，且源侧硬编码为 `facts.httpCalls`（tsAnalyzer 产出）。
- v0.41.0 建出的 Python outbound `NetworkEndpoint` 是孤立节点 —— 没有与任何服务端路由关联。
- 图谱缺少一条显式的"客户端端点 ↔ 服务端 API"边，agent 只能靠读实体字段自行拼装。

## 决策

### D1. 抽取公共匹配逻辑，不重写

7c-d 段的 `normPath` + 段级 `matchRoute` 已经是可用实现。本 ADR 把它上提为三个模块级函数：

| 函数 | 职责 |
|---|---|
| `apiPathOf(urlOrPath)` | 从绝对 URL 取 path（`https://host/a/b?x=1` → `/a/b`）；纯变量名返回 `null` |
| `apiPathSegments(urlOrPath)` | 去 query + 尾斜杠归一后切段 |
| `matchApiRoute(reqSegs, routeSegsList)` | 段级匹配，通配 `:param` / `*wildcard` / `{param}` |

相比原实现有两点扩展：

1. **支持 FastAPI 的 `{param}` 语法** —— 原实现只认 Go 的 `:` 与 `*`，Python 服务端路由无法匹配
2. **host 含占位符也能正确切 path** —— `https://%s/redfish/v1/Systems` 用 `^https?:\/\/[^/]*(\/[^?#]*)?`
   切到首个 `/`，占位符留在 host 侧不污染 path

7c-d 段改为调用公共函数，**行为不变**（仍只匹配 `routeType === 'go'`，仍只处理 `facts.httpCalls`）。

### D2. 新增 7c-d2 段：Python outbound 端点 ↔ 服务端路由

匹配目标限定 `SERVER_API_ROUTE_TYPES = ['go', 'python']`：

- **不含 `php`** —— zentaopms 的路由形态是 `/<module>-<method>` 的 query 式 URL，path 段匹配会误命中
- **不含 `next-api`** —— 构建于 7e 段，晚于匹配点；且 Next 项目的 Python 客户端场景罕见

匹配结果双向落盘：

- 端点侧：`serverRouteId` / `serverRoutePath` / `apiMatch`
- 路由侧：`clientEndpointIds[]`

### D3. method 采用软校验

路径命中即建链，method 是否一致记在 `apiMatch.methodMatches`。理由：

- 与 7c-d 段既有的"method 不一致仍记录（详情可见）"哲学保持一致
- 为候选 3（跨语言 API surface diff）预留数据：method 不一致正是要 diff 出来的东西
- 硬校验会漏掉真实链路（如服务端声明 `ANY`、客户端用具体 method）

### D4. 新边 `callsApi`（LINK_TYPES 55 → 56）

在 `blueprint.js` 的 link 解析器里注册双向实现：

- `net:` 前缀 → 返回 `serverRouteId` 指向的 Route
- `route:` 前缀 → 返回 `clientEndpointIds` 指向的全部 NetworkEndpoint

`OBJECT_TYPES` 仍 38。**`LINK_AXIOMS`（`seed.js`）未新增条目** —— 该表只覆盖 13 条核心边，
v0.38/39/40 新增的边同样未列入，遵循既有惯例。

### D5. 覆盖度统计落 `_meta.rpcChain`

`{ serverRouteCount, endpointCount, matched, methodMismatch, unresolved }`。
无服务端路由或无 Python 端点时为 `null`（该维度不适用，区别于"匹配到 0 条"）。

## 影响

### 数据形态变更

- `NetworkEndpoint.serverRouteId` / `serverRoutePath`：新增（未命中时为 `undefined`）
- `NetworkEndpoint.apiMatch`：新增 `{ methodMatches, routeMethods, endpointMethod }`
- `Route.clientEndpointIds`：新增（被调用方端点 id 数组）
- `dataMap._meta.rpcChain`：新增
- `LINK_TYPES`：55 → 56（`callsApi`）

### 端到端实测（fixture：FastAPI 服务端 + requests 客户端）

| 端点 | 命中路由 | methodMatches |
|---|---|---|
| `GET http://localhost:8000/api/users/{uid}` | `route:/api/users/{user_id}` | ✅ |
| `POST http://localhost:8000/api/users` | `route:/api/users` | ✅ |
| `DELETE http://localhost:8000/api/orders` | `route:/api/orders`（GET） | ❌ 如实记录 |
| `GET http://localhost:8000/api/nope` | 未命中 | — |

跨语言（Go gin `/api/user/:id` ↔ Python 客户端 `f".../api/user/{uid}"`）同样命中。

### 修复的既有缺陷

`Route.apiMethods` **口径不统一**：Go 路由是数组 `[method]`，Python 路由是裸字符串。
直接用 `routeMethods.includes(...)` 会退化成子串匹配（`'POST'.includes('OST')` 误为 `true`）。
已归一为数组。

## 已锁定决策

- D1 抽取公共匹配函数，扩展 `{param}` 与 host 占位符支持（必做）
- D2 新增 7c-d2 段，目标限定 `go` / `python`（必做）
- D3 method 软校验，不一致如实记录（必做）
- D4 新边 `callsApi`，双向可查（必做）
- D5 `_meta.rpcChain` 覆盖度统计（必做）

## 不做（v0.42.0 范围外）

- **URL 占位符归一化** —— 仍是最关键的缺口。iDRAC 166 个端点中 160 个含占位符，
  但那些端点没有服务端路由可匹配（iDRAC 是纯客户端仓库），故本 ADR 不受其阻塞。
  真正的阻塞点在候选 3（跨语言 API diff）：需要 resolve `idrac_ip` 才能比对。
- **`php` / `next-api` 路由纳入匹配** —— 见 D2 的排除理由
- **inbound 端点** —— 需 TS/JS 服务端的 handler 抽取能力，当前只有 Go/Python 侧路由
- **`frontendCalls` 与 `clientEndpointIds` 合并** —— 两者语义不同（TS 前端调用点 vs 聚合后的端点实体），
  强行合并会丢失前端的行级证据

## 后续候选（v0.43.0 起）

1. **CLI 参数 yaml 配置文件追踪**（原候选 2）—— 隐含依赖 `pythonCliParams` 实体化（仍是孤儿 fact）
2. **跨语言 API 表面 diff**（原候选 3）—— `apiMatch.methodMatches` 已铺好数据基础，
   只差 CLI 参数与 return/error 的比对
3. **补 Python function fact 的 `end`** —— 接上 v0.41.0 留空的 `fns` / `fnIds`

## v0.42.1 闭环（v0.42.0 review 修复）

code review 发现 3 个真问题 + 2 个设计债，本小版本闭环前 3 个，后 2 个继续作为 v0.43 候选。

### 已修

- **A. matchApiRoute 字面量优先（ordering bug）**—— 原实现按 `routeSegsList` 顺序遍历，
  当通配路由（`/:id`）先于字面量（`/self`）声明时，客户端请求 `/self` 会错误命中 `:id`。
  修复：matchApiRoute 加第一轮"全字面量命中"扫描，再退化到原通配逻辑；顺序无关。
- **B. urllib/requests.request method 推断（MIXED 假阳）**—— 原实现对 `requests.request` /
  `urllib.request.urlopen` / `urllib.request.Request` 一律标 `MIXED`，导致 iDRAC 一类
  urllib 仓库的 `_meta.rpcChain.methodMismatch` 虚高。修复：
  - `urllib.request.urlopen(url)` 默认按 `GET`（HTTP 事实标准）
  - `urllib.request.urlopen(url, data=...)` 按 `POST`
  - `urllib.request.Request(url, method='PUT')` 读 `method=` kwarg
  - `urllib.request.Request(url, data=...)` 没 `method=` 时按 `POST`；都没有时仍为 `MIXED`（method 未定）
  - `requests.request(method='DELETE', url=...)` 读 `method=` kwarg
  - `requests.request('POST', 'url', ...)` 首位置参识别
- **C. 双向字段原子赋值**（`serverRouteId` / `clientEndpointIds`）—— 7c-d2 段原先分散赋值
  4 个字段（`ep.serverRouteId` / `ep.serverRoutePath` / `ep.apiMatch` / `route.clientEndpointIds`），
  易出现单边赋值失败。修复：抽 `linkRouteToEndpoint(route, ep, apiMatch)` helper 集中维护双向 invariant。

### 仍为 v0.43+ 候选（本次不做）

- **D. 7c-d 段（TS httpCalls）扩到 Python 服务端路由**—— 7c-d 当前仍只支持 Go 路由，
  纯 Python 后端 + TypeScript 前端项目的 TS 调用无法匹配 Python 路由。
  修复方向：把 7c-d 段的 `r.routeType === 'go'` 改为 `SERVER_API_ROUTE_TYPES.includes(r.routeType)`，
  并与 7c-d2 段合并为单 loop。
- **E. `slugifyEndpointUrl` 在 id 中保留 `{ }` 占位符**—— `f"https://{host}/..."` 产生的 id
  包含 `{` `}`，当前下游消费方（SQLite JSON / viewer 渲染）按 string 处理无问题，
  但视觉上不是稳定 slug。修复方向：先归一为 `<>` 或单字符占位符（**breaking change**，
  需 v0.43 重新生成 id）。

## 参考

- ADR 0008（v0.40.0）—— 候选清单出处
- ADR 0009（v0.41.0）—— 本 ADR 的前置（outbound 端点进图谱）
- 新增测试：`test/rpcChain.test.mjs`（10 例，含 v0.42.1 的字面量优先 + 双向 invariant）；
  `test/pythonAnalyzer.test.mjs` +8 例（method 推断）；全量 860/860 通过
