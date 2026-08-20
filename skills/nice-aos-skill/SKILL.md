---
name: nice-aos
description: |
  Nice AOS（Nice Anterior Ontology Service）是通用的 React/Vue/油猴脚本前端项目的代码本体分析组件。
  它将 React/TypeScript、Vue 3（SFC/vue-router/Pinia）源码与油猴脚本（Tampermonkey UserScript）
  预先分析为结构化本体快照，把"代码文件"转化为 AI agent 可直接查询的"关系图谱"——包含模块、组件、
  Hook/Composable、Zustand/Pinia Store、Service、路由（Overlay / vue-router）、npm 依赖、
  油猴脚本（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction），以及 import 依赖、
  JSX/template 渲染、页面跳转（navigatesTo）、Store/Hook 使用、GM API 使用/DOM 注入/网络端点/脚本函数调用图等 15 种关系。
  语义本体引擎：15 种对象按概念范畴与抽象层级（L3 架构/L2 结构/L1 单元/L0 事实）组织，
  架构分层（archLayer）按内容信号推断而非目录名直译，功能域（Domain）聚合横向业务切片，
  Project/Domain/Module 自动生成职责画像与自然语言总结（summary/architecture/health）。
  基于 TypeScript Compiler API 静态解析，不做类型检查；React/Vue 项目全量分析约 3.5 秒
  （含数百个超大脚本的纯油猴仓库可能需要数十秒）。
  触发：用户说"分析这个前端项目的结构 / 项目有哪些页面 / overlay 有哪些 / 这个组件在哪个文件 /
  谁渲染了这个组件 / 修改这个 service 会影响哪些代码 / 变更影响分析 / 页面跳转关系 / 导航图 /
  这个 store 被谁用了 / 项目有哪些自定义 Hook / 循环依赖 / 死代码 / 孤儿组件 / 刷新快照 /
  生成代码地图 / 依赖关系图 / 项目架构是什么样 / 有哪些功能模块 / 某目录的职责 /
  分析油猴脚本 / 这个脚本用了哪些 GM API / 脚本往页面注入了什么 DOM /
  脚本请求了哪些域名 / 油猴脚本安全风险审计 / 脚本函数调用图 / 这个 GM 调用有没有 @grant 声明"，
  或在需要理解前端代码结构但不想 grep 1700+ 文件时，
  或需要做前端变更影响分析（修改 X 会影响谁）但手动追踪引用太耗时时。
  英文触发词：analyze frontend structure, overlay routes, who renders this component,
  change impact analysis, navigation graph, store usage, dead code, circular imports,
  build code map, refresh snapshot, userscript analysis, GM API audit, script injection points,
  project architecture, functional domains。
  不做：代码生成 / 重构建议 / 构建 / 运行测试 / ESLint（用专用工具）；不分析 Java 后端（asdm-aos 负责）。
---

# Nice AOS Skill — 前端代码本体分析

> Nice AOS 参考 asdm-aos（Java 代码本体分析）的设计，针对 React（React 19 + TS + Vite + Zustand + 自研 overlay 路由）、
> Vue 3（SFC + vue-router + Pinia + unplugin-vue-router）与油猴脚本（Tampermonkey UserScript）三类前端源码重新建模，
> 三个解析器（tsAnalyzer / vueAnalyzer / userScriptAnalyzer）平级共存、逻辑完全独立。
> **核心价值**：把"逐文件 grep + LLM 推理"降级为"毫秒级本体查询"，在 1700+ 源文件的项目中保障 agent 的响应速度和结构理解准确度。

## 概述

本 Skill 让 AI agent 通过 `nice-aos` CLI 查询前端代码仓库的结构化本体（模块/组件/Hook/Store/Service/路由/依赖/油猴脚本 + 关系图谱），无需全量扫描源码。油猴脚本走独立的 `userScriptAnalyzer` 解析链，产出 GM API 使用、DOM 注入点、网络端点与脚本函数调用图，供安全审计与行为理解。

**自闭环设计**：CLI 位于仓库的 `nice-aos/` 子项目内（无独立安装步骤），快照存放在本 Skill 目录的 `data/` 子目录中，不污染代码库。

## 触发场景

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **项目架构总览** | "项目架构是什么样？" / "各层文件占比？" | `query Project` 看 summary/architecture/health |
| **功能域地图** | "项目有哪些功能模块？" / "health 域包含什么？" | `query Domain --pretty` / `link belongsTo --src dom:health` |
| **模块职责** | "src/store 目录的职责？" / "哪些模块是状态层？" | `query Module --where "path=src/store"` 看 summary / `query Module --where "archLayer=state"` |
| **了解项目结构** | "项目有哪些模块？" / "components 下分多少领域？" | `query Module` + `query Project` |
| **页面/路由清单** | "项目有哪些页面？" / "overlay 有哪些？" / "这个页面的 backTarget 是什么？" | `query Route` / `query Route --where "domain=health"` |
| **页面跳转关系** | "从饮食健康页能跳到哪？" / "页面导航图" | `link navigatesTo --src route:dietary_health` |
| **查找组件定义** | "TalentResultPage 在哪定义？" / "这个组件多少行？" | `query Component --where "name=TalentResultPage"` |
| **谁渲染了这个组件** | "ExerciseReportPage 被谁用了？" | `link renderedBy --src comp:ExerciseReportPage` |
| **这个组件渲染了什么** | "HealthStatsPage 里用了哪些子组件？" | `link renders --src comp:HealthStatsPage` |
| **变更影响分析** | "修改 exerciseService 会影响哪些文件？" | `link importedBy --src file:src/services/exerciseService.ts` |
| **Store 分析** | "项目有哪些 store？" / "useThemeStore 被谁用了？" / "storage key 是什么？" | `query Store` / `link usesStore --src store:useThemeStore` |
| **Hook 分析** | "有哪些自定义 Hook？" / "useEnergySystem 被谁用了？" | `query Hook` / `link usesHook --src hook:useEnergySystem` |
| **油猴脚本清单** | "项目有哪些油猴脚本？" / "哪个脚本风险最高？" / "哪个脚本跑在 Vue 页面？" | `query UserScript` / `query UserScript --where "riskLevel=high"` / `--where "hostFramework=vue"` |
| **GM API 审计** | "这个脚本用了哪些 GM API？" / "有没有越权调用（未 @grant 声明）？" | `link usesGmApi --src us:<path>` / `query GmApiUsage --where "declared=false"` |
| **DOM 注入分析** | "脚本往页面注入了什么？" / "哪里有动态插值 XSS 面？" | `link injectsInto --src us:<path>` / `query InjectionPoint --where "interpolated=true"` |
| **网络与劫持分析** | "脚本请求了哪些域名？" / "@connect 白名单齐吗？" / "有没有请求劫持？" | `link requestsTo --src us:<path>` / `query NetworkEndpoint --where "allowedByConnect=false"` / 看脚本 `risks` |
| **脚本函数调用图** | "renderOverview 调用了谁？" / "谁调用了 fetchGameDetail？" | `link calls --src "fn:<path>#<fnName>"` / `link calledBy --src "fn:<path>#<fnName>"` |
| **油猴安全审计** | "这个脚本有什么风险？" / "有没有 eval / unsafeWindow / cookie 写？" | `query UserScript --where "name=<脚本名>"` 看 risks/riskLevel，或导出 Markdown 安全风险清单节 |
| **页面 ↔ 组件映射** | "steam_dashboard 路由对应哪个组件文件？" | `query Route --where "overlayId=steam_dashboard"` 或 `link registers --src route:xxx` |
| **循环依赖** | "有没有循环依赖？" | 看 `_meta.cycles`（`export --format json` 后 jq）或导出 Markdown 的循环依赖节 |
| **死代码候选** | "哪些文件没人用？" | 导出 Markdown 的死代码候选节 `_meta.orphanCandidates` |
| **外部依赖** | "哪些 npm 包用得最多？" / "有没有未声明的导入？" | `query Dependency` |
| **构建/刷新快照** | "刷新快照" / "代码变了重新分析" | `action refreshRepo` |
| **代码 Review 辅助** | "标记这个组件已审查" / "给这个类加备注" | `action markReviewed` / `action addNote` |

**不触发的场景**：写/改代码（agent 自身能力）、构建/测试（npm scripts）、Lint（ESLint）。

## 前置条件

- Node.js 18+
- CLI 获取方式（二选一）：
  - **仓库内源码**（默认）：`nice-aos/` 子项目，无需全局安装；`nice-aos/node_modules` 需已安装（若缺失，执行 `cd nice-aos && npm install`）
  - **npm 包安装**：`npm install -g nice-aos`（全局安装）或 `npx nice-aos`（按需拉取，包已发布至 npm.org，详见 [npm 页面](https://www.npmjs.com/package/nice-aos)）

## CLI 调用方式

所有命令统一通过以下方式调用（agent 将 `<REPO_ROOT>` 替换为仓库根目录绝对路径）：

```bash
NICE_AOS="node <REPO_ROOT>/nice-aos/src/cli/index.js"
SNAPSHOT_DIR="<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data"

# 查询示例
$NICE_AOS --snapshot-dir "$SNAPSHOT_DIR" query Route --where "domain=steam"
```

若通过 npm 包方式获取 CLI，将 `$NICE_AOS` 替换为 `nice-aos`（全局安装）或 `npx nice-aos` 即可，其余参数不变：

```bash
nice-aos --snapshot-dir "$SNAPSHOT_DIR" query Route --where "domain=steam"
npx nice-aos --snapshot-dir "$SNAPSHOT_DIR" link importedBy --src "file:src/services/ai.ts"
```

> 快照目录仍建议显式传 `--snapshot-dir` 指向本 Skill 的 `data/` 目录（npm 包默认回退链为 `./.nice-aos/data` → `~/.nice-aos/data`，不会自动定位本 Skill 目录）。

也可使用根 package.json 提供的快捷脚本：

```bash
npm run aos -- query Route --all
npm run aos -- link importedBy --src "file:src/services/ai.ts"
npm run aos -- action refreshRepo --params '{"repoPath":".","roots":["src","nicekit/src","nice-steam/src"]}'
```

## 首次使用：构建快照

```bash
# 快照目录约定：本 Skill 的 data/ 子目录
mkdir -p "<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data"
node <REPO_ROOT>/nice-aos/src/cli/index.js \
  --snapshot-dir "<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data" \
  action refreshRepo --params '{"repoPath":"<REPO_ROOT>","roots":["src","nicekit/src","nice-steam/src"]}'
```

**预期输出**（JSON）：
```json
{
  "ok": true,
  "message": "已成功导入 nice-today-2.0（1761 个源文件，3500ms）",
  "stats": { "Module": 256, "SourceFile": 1761, "Component": 851, "Hook": 71,
             "Store": 17, "Service": 407, "Route": 296, "Dependency": 86,
             "UserScript": 0, "GmApiUsage": 0, "InjectionPoint": 0,
             "NetworkEndpoint": 0, "ScriptFunction": 0 },
  "cycles": 8, "orphanCandidates": 352, "analysisErrors": 0
}
```

stats 固定包含全部 13 类对象计数；React/Vue 项目中油猴 5 类（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction）为 0，纯油猴仓库则 React/Vue 类为 0（实测 226 脚本仓库：UserScript 226 / InjectionPoint 5409 / ScriptFunction 47327）。

构建完成后 `data/snapshot.json` 即为所有查询的数据源。**代码有变动后需重新执行 refreshRepo 刷新**。

**纯油猴脚本仓库**（如 steam-tampermonkey-scripts）无需 package.json 即可分析：扫描器自动识别 `.user.js` 与头部含 `==UserScript==` 元数据块的 `.js` 文件（`framework=userscript`），refreshRepo 只校验目录存在性：

```bash
node <REPO_ROOT>/nice-aos/src/cli/index.js \
  --snapshot-dir "<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data" \
  action refreshRepo --params '{"repoPath":"/path/to/steam-tampermonkey-scripts"}'
```

React/Vue 项目与油猴脚本混合时同样自动识别（以宿主框架为准，脚本独立产出 UserScript 对象体系）。

## 本体模型

### 概念分类体系

15 种对象类型按「概念范畴」（Container/CodeUnit/EntryPoint/Script/Environment/AuditFact）与「抽象层级」（L3 架构层：Project/Domain；L2 结构层：Module/SourceFile/Route/UserScript/Dependency；L1 单元层：Component/Hook/Store/Service/ScriptFunction；L0 事实层：GmApiUsage/InjectionPoint/NetworkEndpoint）双维组织。聚合节点（Project/Domain/Module）自动生成职责画像与自然语言总结（summary/architecture/health）。

**语义架构层（archLayer）**：每个文件/模块推断一个语义层——entry/presentation/state/service/integration/shared/types/config/script/test/mixed，以内容信号为准（单元构成、路由归属、引用结构），目录名仅作弱信号回退；构成分散（主导层 < 60%）时如实标记 mixed。**功能域（Domain）**与架构层正交：架构层是纵向技术切片，功能域是横向业务切片（路由域段 + 业务命名目录聚合）。

### 对象类型（15 种）

| 类型 | 说明 | 典型属性 | ID 前缀 |
|------|------|---------|---------|
| Project | 代码仓库（含架构画像） | name, framework(react/vue/userscript/unknown), fileCount, tsxFileCount, vueFileCount, userScriptFileCount, commitHash, branch, summary（框架定位+分层画像+功能域清单）, architecture（语义分层占比）, health（循环依赖/死代码/未声明依赖/高风险脚本/解析错误）, analysisErrors | `proj:` |
| Domain | 功能域（横向业务切片） | name, sources(route/module), routeCount, componentCount, storeCount, scriptCount, fileCount, lineCount, capability（路由能力描述）, summary（职责画像） | `dom:` |
| Module | 目录模块（含语义分层） | name, path, archLayer, archLayerLabel, layerComposition（子树层构成）, fileCount, subtreeFileCount, parentId, unitCounts, routeCount, summary（职责画像） | `mod:` |
| SourceFile | 源文件 | path, ext(ts/tsx/js/jsx/vue), archLayer, layer, lineCount, isTest, isEntry, importIds, exportNames, opensOverlayIds | `file:` |
| Component | 前端组件（React / Vue SFC） | name, filePath, kind(page/modal/card/...), isDefaultExport, propsCount, hooksUsed, stateCount, lineCount, rendersIds, routeIds, archLayer, domainIds, description | `comp:` |
| Hook | 自定义 Hook / Composable | name, filePath, lineCount, archLayer, domainIds, description | `hook:` |
| Store | Zustand / Pinia Store | name, stateKeys, actionKeys, hasPersist, storageKey, location(store/services/other), archLayer, domainIds | `store:` |
| Service | 服务/引擎模块 | name, pattern(singleton/class/functions), exportsCount, lineCount, archLayer, domainIds | `svc:` |
| Route | 路由条目（Overlay / vue-router） | overlayId(path), routePath, backTarget, hidesNav, domain, domainIds, routeType(overlay/react/vue), componentFileId, navigatesToIds, description | `route:` |
| Dependency | npm 依赖 | name, version, scope, source(npm/workspace/undeclared), importCount | `dep:` |
| UserScript | 油猴脚本（元数据 + 行为画像） | name, version, matches, grants, grantNone, connects, requires, runAt, hostFramework(vue/react/mixed/unknown), isIife, usesStrict, riskLevel, riskCount, risks, hijackCount, unsafeWindowReads/Writes, storageUsage, functionCount, injectionCount, networkEndpointCount, archLayer=script, domainIds | `us:`（= 文件相对路径） |
| GmApiUsage | GM API 使用（与 @grant 比对） | name（GM_* 与 GM.* GM4 风格统一归一）, category(storage/network/style/...), callCount, lines, declared | `gm:` |
| InjectionPoint | DOM 注入点 | kind(mount/inner-html/insert-adjacent/document-write/style-gm/style-element/shadow-dom), target, callCount, lines, interpolated | `inject:` |
| NetworkEndpoint | 网络端点（与 @connect 比对） | kind(gm-xhr/fetch/xhr/websocket/beacon), domain（动态拼接 URL 记为 `(dynamic)`）, urls, methods, callCount, allowedByConnect | `net:` |
| ScriptFunction | 脚本函数/类/对象方法 | name（对象/类方法含 `.`，如 `storage.get`）, kind(function/arrow/class/object/method), owner, isTopLevel, line, lineCount, gmApiCount, domOpCount, networkCallCount, callCount, calledByCount, callIds, calledByIds, archLayer=script | `fn:` |

### 链接（15 种）

| 链接 | 语义 | 方向 |
|------|------|------|
| contains | 层次包含 | Project→Domain/Module→SourceFile→Component/Hook/Store/Service/UserScript；us:→GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction |
| imports | 模块导入 | SourceFile→SourceFile / Dependency |
| importedBy | 被导入（反向） | 谁导入了这个文件 |
| renders | JSX 渲染 | Component→Component |
| renderedBy | 被渲染（反向） | 谁渲染了这个组件 |
| navigatesTo | 页面跳转 | Route→Route（overlay 的 `setActiveOverlay('x')`、React 的 `<Navigate to="/x"/>`、Vue 的 `router.push('/x')` 字面量调用） |
| registers | 路由注册 | Route↔Component（双向：src 为 route: 给组件，src 为 comp:/file: 给路由） |
| usesStore | Store 使用 | file:/comp:→Store 或 store:→反向使用方 |
| usesHook | Hook 使用 | file:/comp:→Hook 或 hook:→反向使用方 |
| usesGmApi | GM API 使用 | us:→GmApiUsage 或 gm:→所属脚本（反查） |
| injectsInto | DOM 注入 | us:→InjectionPoint 或 inject:→所属脚本（反查） |
| requestsTo | 网络请求 | us:→NetworkEndpoint 或 net:→所属脚本（反查） |
| calls | 函数调用图 | ScriptFunction→ScriptFunction（该函数调用了谁） |
| calledBy | 被调用（反向） | ScriptFunction→调用它的函数（修改影响面） |
| belongsTo | 功能域归属（双向） | dom:→全部成员；或 mod:/comp:/store:/hook:/route:/us:→所属功能域 |

### 动作（3 种）

| 动作 | 用途 | 守卫 |
|------|------|------|
| refreshRepo | 重新分析仓库（全量；React/Vue 项目约 3.5s，大型油猴仓库可达数十秒） | repoPath 必须为存在的目录（纯油猴脚本仓库无需 package.json） |
| markReviewed | 标记对象已 review（持久化到快照） | objectId 必须存在 |
| addNote | 给对象加注释（持久化） | objectId 存在且 note 非空 |

## CLI 命令参考

### query — 查询对象

```bash
# 按类型查询（默认前 50 条，--all 全量）
query Project                                        # 项目画像（summary/architecture/health）
query Domain --pretty                                # 功能域地图（横向业务切片）
query Route --all
query Component --where "kind=page" --pretty
query SourceFile --where "layer=services,isTest=false"
query Route --where "domain=health,backTarget=home"
query Component --where "name~steam"                  # ~ 模糊匹配（子串包含，忽略大小写）
query SourceFile --where "path~steam,layer=components" # 模糊可与精确条件 AND 混用
query Dependency --where "source=undeclared"      # 未声明依赖（治理点）
query Store --where "hasPersist=true"             # 持久化 store（核对 storageKey 命名）
query Module --where "layer=components" --all | <统计>
query Module --where "archLayer=state" --pretty   # 按语义架构层过滤模块
query Component --where "domainIds=dom:health"    # 按功能域过滤成员

# ---- 油猴脚本 ----
query UserScript --all                           # 脚本清单（元数据 + 行为画像）
query UserScript --where "hostFramework=vue"     # 跑在 Vue 页面上的脚本
query UserScript --where "riskLevel=high"        # 高风险脚本（请求劫持/eval/cookie 写）
query GmApiUsage --where "declared=false"        # 未在 @grant 声明的 GM 调用（越权面）
query InjectionPoint --where "interpolated=true" # 含动态插值的 HTML 注入（XSS 面）
query InjectionPoint --where "kind=mount"        # 页面挂载点（appendChild 等）
query NetworkEndpoint --where "allowedByConnect=false"  # 未在 @connect 声明的 GM 请求域名
query ScriptFunction --where "kind=class" --pretty       # 脚本内类（逻辑分布）
query ScriptFunction --where "name~fetch"        # 函数名模糊匹配
```

`--where` 语法：逗号分隔多条件 AND；`k=v`（或 `k:v`）精确相等，`k~v` 模糊匹配（子串包含，忽略大小写）；值为数组时精确做成员包含、模糊做任一成员包含（如 `hooksUsed=useEffect`）。

### link — 遍历关系

```bash
# 变更影响分析（谁导入了这个文件）
link importedBy --src "file:src/services/exerciseService.ts"

# 组件被渲染关系
link renderedBy --src "comp:ExerciseReportPage"
link renders --src "comp:HealthStatsPage"

# 页面导航图
link navigatesTo --src "route:dietary_health"

# 页面 → 组件 / 组件 → 页面
link registers --src "route:talent_result"
link registers --src "comp:TalentResultPage"

# Store / Hook 使用关系（src 传 store:/hook: 得反向使用者）
link usesStore --src "store:useThemeStore"
link usesHook --src "hook:useUserProfile"

# 层次下钻
link contains --src "mod:src/components/health"
link contains --src "file:src/components/health/HealthStatsPage.tsx"

# ---- 油猴脚本（us:/gm:/inject:/net:/fn:）----
link usesGmApi --src "us:scripts/steam-inventory.user.js"   # 脚本用了哪些 GM API
link usesGmApi --src "gm:scripts/steam-inventory.user.js#GM_xmlhttpRequest"  # 反查：该 GM API 使用所属的脚本
link injectsInto --src "us:scripts/steam-inventory.user.js" # 脚本往页面注入了什么
link requestsTo --src "us:scripts/steam-inventory.user.js"  # 脚本请求了哪些域名
link contains --src "us:scripts/steam-inventory.user.js"    # 脚本全部子对象（函数/GM/注入/端点）
link calls --src "fn:scripts/steam-inventory.user.js#renderOverview"  # 函数调用了谁
link calledBy --src "fn:scripts/steam-inventory.user.js#fetchPrice"    # 谁调用了这个函数（影响面）

# ---- 功能域（dom:）----
link belongsTo --src "dom:health"                 # 功能域 → 全部成员（组件/Store/Hook/路由/脚本）
link belongsTo --src "comp:HealthStatsPage"       # 反查组件所属功能域
```

### action — 受控动作

```bash
action refreshRepo --params '{"repoPath":"."}'
action markReviewed --params '{"objectId":"comp:TalentResultPage"}'
action addNote --params '{"objectId":"comp:TalentResultPage","note":"核心页面"}'
```

### export — 导出

```bash
# Markdown 全景报告（含路由地图、导航图、循环依赖、死代码候选、Store 一览；
# 存在油猴脚本时追加 6 节：油猴脚本一览、GM API 使用、DOM 注入点、网络请求与请求劫持、脚本函数 Top 30、安全风险清单）
export --format markdown --output "$SNAPSHOT_DIR/report.md"

# JSON 供 jq 聚合
export --format json | jq '._meta.orphanCandidates | length'
export --format json | jq '.UserScript[] | select(.riskLevel=="high") | .filePath'
```

## 使用建议

### 通用工作流

1. **检查快照**：`data/snapshot.json` 不存在或代码大改后 → `action refreshRepo`
2. **概览**：`query Project` + `query Module`
3. **定位**：`query Component/Route/Store --where ...` 拿到 ID
4. **下钻关系**：`link renders/importedBy/navigatesTo/usesStore ...`
5. **回写结论**：`action markReviewed` + `action addNote`（跨会话保留在快照中）

### 变更影响分析（核心场景）

修改某文件前，反查所有受影响方：

```bash
link importedBy --src "file:src/services/ai.ts"          # 直接导入方
# 结果中每个文件再递归 importedBy，即得传递影响面
link renderedBy --src "comp:XXXPage"                     # UI 层影响
```

### 油猴脚本审计（独立分析链）

油猴脚本与 React/Vue 组件体系并存、逻辑独立（脚本不产出 Component/Store，而是 UserScript + 4 类子对象）：

1. **清单**：`query UserScript --all` 看脚本名/版本/@match/宿主框架/风险等级
2. **越权审计**：`query GmApiUsage --where "declared=false"`（调用了未 @grant 声明的 API）与 `query NetworkEndpoint --where "allowedByConnect=false"`（GM 请求域名未在 @connect 声明，运行时会弹授权确认）
3. **注入与 XSS 面**：`query InjectionPoint --where "interpolated=true"` 定位含动态插值的 HTML 注入
4. **风险定位**：`query UserScript --where "riskLevel=high"`，逐个看 `risks` 数组（按 severity 排序）。风险类型全集：`hijack-*`（fetch/XHR/EventTarget/WebSocket/history 重写，high）、`eval-usage`（eval/new Function，high）、`cookie-write`（high）/`cookie-read`（medium）、`unsafe-window-write`（medium）/`unsafe-window-read`（low）、`html-injection`（动态插值 HTML，XSS 面，medium）、`undeclared-gm-api`（GM API 未 @grant 声明，medium）、`gm-api-without-grant`（@grant none 下调用 GM API，low）、`unlisted-connect-domain`（GM 请求域名未 @connect 声明，medium）、`window-define`（Object.defineProperty(window)，low）
5. **行为理解**：`link contains --src us:<path>` 拿全部子对象，`link calls --src fn:<path>#<fn>` 下钻函数调用图
6. **回写结论**：`action markReviewed --params '{"objectId":"us:<path>"}'`（GmApiUsage/InjectionPoint 等子对象同样支持）

### 大文件策略

- `query SourceFile --all` 会输出约 1760 条，避免直接全量；先 `--where "layer=xxx"` 缩小
- 油猴仓库的 `query ScriptFunction --all` 可能输出数万条（226 脚本仓库实测 47327 个函数对象），必须先 `--where "name~xxx"` / `--where "kind=class"` / `--limit <n>` 缩小
- 导航全图较大时，用单路由 `link navigatesTo` 或导出 Markdown 对应章节

### 与项目现有检查工具的分工

- `npm run check:overlay-hides-nav` / `check:overlay-coverage`：合规校验（CI 用）
- `.codegraph/codegraph.db`：SQLite 代码图（另一个体系）
- **nice-aos**：面向 agent 的结构化本体查询（本 Skill），擅长关系问答与影响分析

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 首次执行 nice-aos 命令 | 检查 `nice-aos/node_modules` 存在，缺失则 `cd nice-aos && npm install` |
| 查询返回"未找到本体快照" | 提示后直接执行 `action refreshRepo`（React/Vue 项目约 4 秒，无需用户确认；大油猴仓库耗时见下条） |
| 用户报"查询结果不对/过期" | 代码可能已变更 → 重新 refreshRepo |
| 回答结构类问题 | 优先用 nice-aos 查询，而不是 grep 1700+ 文件 |
| 回答油猴脚本问题（GM API/注入/请求/风险） | 优先 query UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint + link 关系，而不是通读脚本源码 |
| 分析纯油猴脚本仓库 | 直接 refreshRepo（无需 package.json）；快照不存在时照常自动构建 |
| 大型油猴仓库 refreshRepo | 数百个超大脚本（单脚本 2 万+ 行）全量分析可达数十秒，属正常耗时，耐心等待而非中断重试 |
| markReviewed/addNote | 执行 review 类任务后主动回写，下次会话可恢复上下文 |

## 输出格式

- 默认 stdout 输出 JSON（agent 直接解析）
- `--pretty` 人类可读表格
- 退出码：0 成功，1 失败
- 快照单文件 `snapshot.json`（本仓库约 2-4MB）

## 技术限制

- 基于 TypeScript Compiler API 的**语法级**解析（不跑类型检查），个别动态引用（变量拼接的 import、字符串组件名）无法解析
- `renders` 归属到文件的主组件（default export 优先）；同文件多组件的内部渲染关系不细分
- 跳转边均为字面量调用：overlay 体系来自 `setActiveOverlay/openOverlay('id')`，React 来自 `<Navigate to="/x"/>`（相对 `to` 基于所属路由归一为绝对路径），Vue 来自 `router.push/replace('/path')`（含解构 `const { push } = useRouter()`）；`onOpenOverlay: app.setActiveOverlay` 这类函数透传与动态变量导航无法静态追踪
- App.tsx 内部跳转（Tab 级）不计入 navigatesTo（仅 Route→Route）
- Vue 适配范围：Vue 3 SFC（`<script setup>`/`<template>`/`<route lang="yaml">`）、vue-router RouteRecordRaw 显式路由、
  views/pages 目录文件路由推导、Pinia `defineStore`（setup/options 两种写法）、composables（导出 `useXxx`）；
  模板渲染关系支持 PascalCase/kebab-case 标签与 `:is` 动态组件（不含动态变量拼装）；
  导航边来自 `router.push('/path')`/`replace('/path')` 字面量调用（解构 `const { push } = useRouter()` 同样支持）
- 油猴脚本识别为启发式：`.user.js` 扩展名，或 `.js` 文件头部 4KB 内含 `==UserScript==` 元数据块（元数据块须在文件头部 8KB 内）；
  无元数据块的普通 .js 不会误判
- 油猴解析限制：动态拼接的 URL/域名记为 `(dynamic)` 且不做 @connect 比对（`allowedByConnect=null`；`--where "allowedByConnect=false"` 只命中"静态域名且未声明"项）；querySelector 变量锚点同名时取全文最后声明；
  `unsafeWindow.xxx = window.xxx` 全局暴露按赋值左侧文本匹配；宿主框架仅按 `__vue__`/`__reactContainer$` 等运行时标记推断（vue/react 标记并存时为 mixed，无标记为 unknown）；
  函数调用图只覆盖静态可解析的名字调用（`obj['method']()` 可记，动态变量调用不记）；对象方法归属到声明它的顶层对象；同一文件内同名函数的 ID 追加 `@2`/`@3` 去重后缀（如 `fn:path#init@2`）
- 每次查询全量加载 JSON（1760 文件规模毫秒级；无并发写保护）
- `--where` 为全表扫描：`=`/`:` 精确相等、`~` 模糊包含（不支持数值比较，数值过滤请配合 jq）
