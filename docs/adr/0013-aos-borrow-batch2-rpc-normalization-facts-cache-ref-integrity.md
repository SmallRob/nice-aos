# ADR 0013: 借鉴 asdm-aos（第二批）—— RPC 占位符归一/tier 回执、facts 内容寻址缓存、跨仓补链、引用完整性、迁移校验和、查询谓词与分析器注册表

**状态**：已实施（v0.47.0）
**日期**：2026-09-23
**触发**：对上游 asdm-ontology-research/aos（D:\workspace\asdm-new\asdm-ontology-research\aos，~32k LOC TypeScript）
的系统性对比分析。ADR 0001/0002/0012 已吸收 method health、蓝图引擎 V2、查询投影/规则层等能力；
本 ADR 是第二批，聚焦上游经实战验证、而 nice-aos 自查存在缺口的六个机制。
总体原则不变：**只借模式不借重量**——零构建、单管线、JSON-first 哲学保持。

## 背景（对比分析结论）

| 上游机制 | nice-aos 缺口 |
|---|---|
| endpointSignature 段签名归一（`%s`/模板/`{param}` 双侧统一） | ADR 0009 自认：iDRAC 160/166 个 `%s` 端点永远匹配不上 |
| contentHash + snapshot manifest 继承 | incrementalParser 仅进程内缓存且默认关，跨 CLI 调用每次全量重解析 |
| multiRepoMerge.crossRepoApiMatch | merge.js 输出期文本合并，不解析任何跨仓链接 |
| pending-refs + validate | 引用字段可悬空（本次审计实抓 2 个真 bug） |
| Flyway checksum（迁移被改过即硬错） | migrate.js 仅版本号推进，代码改过静默漂移 |
| whereClause 4 形式（`k>N` 数值、点路径） | parseWhere 仅 `=`/`~` |
| registry（分析器协议） | 分发链在 builderScan 与 buildSingleFileOntology 重复维护两份 |

## 决策

### D1. RPC 匹配占位符归一 + tier 回执（rpcMatch.js / builderBackendRoutes.js）

- `apiPathSegments` 双侧归一到 `:param`（单段占位）/ `*all`（尾段吞剩余）规范形：
  printf `%s`/`%1$s`、FastAPI `{id}`、Next `[id]`/`[...slug]`、`<id>`、模板表达式 `${expr}`
  （aos toSegments 思想：参数名不参与匹配）；
- 全大写环境变量模板前缀剥离（`${API_BASE_URL}/users` → `/users`），前缀差异仍交给 ADR 0012 人工规则解释；
- 尾段吞剩余扩展到 Next 的 `:slug*` / `:slug?`；
- `matchApiRouteTiers` 返回 `{route, tier}`（1 字面量+method → 4 通配），记入
  `apiMatch.tier` / `frontendCalls[].tier` / `_meta.rpcChain.tierCounts`（matchedVia 同思路：命中可审计）；
- **7e（Next 路由）前移到 7c-d 之前**，`SERVER_API_ROUTE_TYPES` 纳入 `next-api`
  （相位顺序不再约束匹配能力——aos pending-refs"顺序无感"思想的重排版实现）；
- php 仍默认排除（zentaopms query 式 URL 误命中），经 api-routes.json
  `{"serverRouteTypes":["php"]}` 显式开启；
- 未命中清单无条件收集（本仓无服务端路由时也进 unmatchedFrontendCalls）——跨仓补链（D3）的原料；
- pythonAnalyzer：拼接表达式（`base + "/api/x" % id`）取首个含 `/` 的字符串字面量。

### D2. facts 内容寻址缓存 + 文件 manifest（analyzers/factsCache.js / builderScan.js）

aos 在对象层做内容寻址（sha256 稳定序列化 + manifest 继承）；nice-aos 的构建是
"facts → 相位推导对象"的单管线，对象层继承会破坏跨文件相位（renders/路由聚合依赖全量 facts），
故把同一思想**下沉到 facts 粒度**：

- `<dataDir>/facts-cache.json`：`{ version, projectRoot, entries: { relPath → { h: hash16, f: facts } } }`；
- **内容哈希为权威判定**（不做 mtime 快路径，杜绝同尺寸同时间戳的脏命中）；命中 → 复用 facts
  跳过 parse，后续相位照常全量运行——正确性等价（facts 是文件内容的纯函数）；
- 序列化：Set/Map 显式编码；`resolved` 键剥离（import 解析每次重跑，tsconfig 变化不脏）；
  `node`/`statementNode`（TS AST 节点，循环引用）与一切非普通类实例不落盘——下游只消费普通字段；
- 失效：version / projectRoot 不匹配或 JSON 损坏 → 整体弃用回全量；
- `_meta.fileManifest`（relPath → `{s,m,h}`，aos snapshot manifest 的 nice-aos 版）与
  `_meta.factsCache`（hit/miss）随快照发布；
- 启用：`refreshRepo` 默认开（`--no-incremental` 或 params.incremental=false 关），
  缓存与快照同目录（跟随 --snapshot-dir 覆盖链）；自扫描实测 **1942ms → 598ms（3.2×）**，产物计数一致。

### D3. 合并后跨仓 RPC 补链（ontology/merge.js）

借鉴 multiRepoMerge.crossRepoApiMatch：合并后在总路由池上重跑阶梯匹配，
只补"构建期因跨仓不可见而未命中"的链路（unmatchedFrontendCalls / 无 serverRouteId 的
outbound 端点），不动已建链的边。命中记 `crossRepo: true` + tier/matchedVia 回执，
统计进 `_meta.merged.rpcChain`；`output --merge` stderr 汇报补链数。
fileId 按合并 SourceFile path 重定位（rename 策略下原 fileId 可能已前缀化）。

### D4. 引用完整性审计（ontology/refIntegrity.js）

aos pending-refs 的"顺序无感 + 收口"思想的最小版（单管线内存构建无乱序问题，
不需要挂起表）：组装末尾全局 id 索引一次建立 → 批量存在性判定 → 悬空 `*Id/*Ids` 摘除
（宁摘除不悬挂，与 aos"歧义即不连"同哲学）→ `_meta.refIntegrity` 上报计数与样本。
豁免字段：`overlayId`（展示名）、`opensOverlayIds`（原始声明清单）。

**实施中实抓并修复 2 个真 bug**：
1. scriptObjects.js 同名函数（如多个 `out`）时 `fnIdMap` 按名覆盖 →
   UserScript.functionIds 悬空 + ScriptFunction 重复对象 id（自扫描 19 处）；
2. PHP/Kotlin 外部导入只写 `dep:x` 引用不建 Dependency 对象（npm/Go 路径都建）→
   `query Dependency` 查不到 Guzzle/java 等外部归并项。

### D5. 迁移校验和（storage/migrate.js）

Flyway checksum 语义的代码迁移版：新口径 `sha256(version:up源码)` 绑定实际执行的
迁移实现；已应用迁移的 up 被改过 → **硬错**并给出 `storage rebuild` 指引；
v0.31–v0.46 旧口径账本（描述哈希）一次性静默采纳新口径（等价 Flyway repair）。

### D6. --where 扩展（cli/shared.js）

对齐 aos whereClause：`k>N` / `k>=N` / `k<N` / `k<=N` 数值比较（两侧可数值化才参与，
否则不命中——不做字符串字典序）；点路径取嵌套字段（`health.cyclomatic`、
`apiMatch.methodMatches`）。既有 `=`/`:`/`~` 语义与"首个操作符胜出"规则零变化；
CLI query / serve /api/objects / MCP query_objects 三消费方自动生效。

### D7. 分析器注册表（analyzers/analyzerRegistry.js）

aos registry.ts 的进程内简化版（stdio 协议插件留待真实需求出现再演进）：
扩展名/谓词 → 分析器的分发链从 builderScanPhase（集合判定，FromDisk 签名）与
buildSingleFileOntology（文件名谓词判定，fileName/content 签名）两份重复实现收敛为单一注册表
（arch-review F2 类问题）。条目 = `{ name, match({diskPath,ext,scan}), fromDisk, single }`，
判定顺序与拆分前逐一对应；`registerAnalyzer(entry)` 为进程内扩展点（追加在 config 之后、
ts 默认之前），返回注销函数。

## 后果

- **正向**：iDRAC 类 `%s` 端点、Next API 路由、跨仓前后端链路进入图谱且命中可归因；
  二次构建 3× 提速；悬空引用清零；迁移漂移硬错兜底；agent 查询谓词表达力对齐上游；
  新增语言从"改 5 处"降为"注册 1 条"。
- **代价与风险**：facts-cache.json 引入缓存失效面（version/projectRoot/哈希三重防护，
  损坏自动回全量）；Dependency 计数对 PHP/Kotlin 项目增大（更真实的代价）；
  tier 字段是新增输出契约（viewers 不受影响，纯增量）。
- **不做**（本批明确排除）：对象级内容寻址存储（与 JSON-first 哲学冲突）、MySQL 双后端、
  stdio 插件协议、progressive 双管线（上游自身因位等漂移付出过多次修复代价）。
