---
name: nice-aos
description: |
  Nice AOS（Nice Anterior Ontology Service）是通用的 React/Vue/Flutter/油猴脚本前端项目与 PHP/Kotlin 后端项目的代码本体分析组件（核心查询 Skill）。
  它将 React/TypeScript、Vue 2+3（Options API/SFC/vue-router/Pinia）、Flutter（Dart Widget + GoRouter + Riverpod）、Go、Python、PHP（zentaopms 类）、Kotlin（Android/JVM）源码与
  油猴脚本（Tampermonkey UserScript）预先分析为结构化本体快照，把"代码文件"转化为 AI agent 可直接查询的
  "关系图谱"——包含模块、组件、Hook/Composable、Zustand/Pinia/Riverpod Store、Service、
  接口/类/Trait/方法（Interface/Class/Trait/Method，含跨文件 implements/extends/overrides 关系与 Dart 方法逻辑调用链）、
  路由（Overlay / vue-router / GoRoute / Gin / zentaopms control.php）、npm/pub 依赖、
  油猴脚本（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction），以及 import 依赖、
  JSX/template 渲染、页面跳转（navigatesTo）、Store/Hook 使用、接口实现/类继承/方法覆盖/Trait 复用、
  GM API 使用/DOM 注入/网络端点/脚本函数调用图等 26 种关系。
  语义本体引擎：20 种对象按概念范畴与抽象层级（L3 架构/L2 结构/L1 单元/L0 事实）组织，
  架构分层（archLayer）按内容信号推断而非目录名直译，功能域（Domain）聚合横向业务切片，
  Project/Domain/Module 自动生成职责画像与自然语言总结（summary/architecture/health）。
  单文件分析（action analyzeFile）：不落盘直接输出单文件本体 JSON（类型实体 + 油猴五类对象 + 死代码候选；支持 .ts/.tsx/.js/.jsx/.mjs/.vue/.rs/.dart/.py/.kt/.kts/.php）。
  本体查看器（viewer）：export --format html 生成自包含蓝图 HTML（领域蓝图/业务数据图/
  业务逻辑流向/脚本蓝图，零依赖可离线打开，宽屏分档适配），--format viewmodel 输出聚合视图模型 JSON 供 agent 直接消费。
  基于 TypeScript Compiler API 静态解析，不做类型检查；React/Vue 项目全量分析约 3.5 秒
  （含数百个超大脚本的纯油猴仓库可能需要数十秒）。
  触发：用户说"分析这个前端项目的结构 / 项目有哪些页面 / overlay 有哪些 / 这个组件在哪个文件 /
  谁渲染了这个组件 / 修改这个 service 会影响哪些代码 / 变更影响分析 / 页面跳转关系 / 导航图 /
  这个 store 被谁用了 / 项目有哪些自定义 Hook / 循环依赖 / 刷新快照 /
  这个接口有哪些实现类 / IStorage 被谁实现了 / 这个方法在哪定义哪实现 / 找 createinterface 方法 /
  单例类有哪些 / 生成代码地图 / 依赖关系图 / 项目架构是什么样 / 有哪些功能模块 / 某目录的职责 /
  生成项目蓝图 / 领域蓝图 / 业务数据图 / 业务逻辑流向 / 可视化架构 / 分析单个文件"，
  或在需要理解前端代码结构但不想 grep 1700+ 文件时，
  或需要做前端变更影响分析（修改 X 会影响谁）但手动追踪引用太耗时时。
  英文触发词：analyze frontend structure, overlay routes, who renders this component,
  change impact analysis, navigation graph, store usage, circular imports,
  build code map, refresh snapshot, analyze single file, interface implementations,
  project architecture, functional domains, blueprint viewer, domain blueprint, data map,
  logic flow diagram。
  不做：油猴安全审计工作流（用 nice-aos-userscript skill）、死代码清理工作流（用 nice-aos-deadcode skill）、
  代码生成 / 重构建议 / 构建 / 运行测试 / ESLint（用专用工具）；不分析 Java 后端（asdm-aos 负责）。
---

# Nice AOS Skill — 前端代码本体分析（核心查询）

> Nice AOS 参考 asdm-aos（Java 代码本体分析）的设计，针对 React（React 19 + TS + Vite + Zustand + 自研 overlay 路由）、
> Vue 3（SFC + vue-router + Pinia + unplugin-vue-router）、Flutter（Dart Widget + GoRouter + Riverpod）与
> 油猴脚本（Tampermonkey UserScript）四类前端源码重新建模，五个解析器（tsAnalyzer / vueAnalyzer / dartAnalyzer /
> rustAnalyzer / userScriptAnalyzer）平级共存、逻辑完全独立（rustAnalyzer 覆盖 Tauri 客户端 Rust 侧，dartAnalyzer 覆盖 Flutter 客户端 Dart 侧）。
> **核心价值**：把"逐文件 grep + LLM 推理"降级为"毫秒级本体查询"，在 1700+ 源文件的项目中保障 agent 的响应速度和结构理解准确度。
> **分工**：本 Skill 承载通用查询/快照/影响分析/蓝图导出；油猴审计工作流见 `nice-aos-userscript` skill；死代码清理工作流见 `nice-aos-deadcode` skill。三者共享同一份快照与 CLI。

## 概述

本 Skill 让 AI agent 通过 `nice-aos` CLI 查询前端代码仓库的结构化本体（模块/组件/Hook/Store/Service/路由/依赖/接口/类/方法 + 关系图谱），无需全量扫描源码。

**自闭环设计**：CLI 位于仓库的 `nice-aos/` 子项目内（无独立安装步骤），快照统一存放在仓库根的 `.nice-aos/data/` 目录，不污染代码库。

## 触发场景

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **项目架构总览** | "项目架构是什么样？" / "各层文件占比？" | `query Project` 看 summary/architecture/health |
| **功能域地图** | "项目有哪些功能模块？" / "health 域包含什么？" | `query Domain --pretty` / `link belongsTo --src dom:health` |
| **模块职责** | "src/store 目录的职责？" / "哪些模块是状态层？" | `query Module --where "path=src/store"` 看 summary / `query Module --where "archLayer=state"` |
| **项目蓝图 / 可视化** | "生成项目蓝图" / "领域蓝图" / "业务数据图" / "业务逻辑流向图" | `export --format html --output blueprint.html`（浏览器打开）；agent 自己分析用 `export --format viewmodel` |
| **了解项目结构** | "项目有哪些模块？" / "components 下分多少领域？" | `query Module` + `query Project` |
| **页面/路由清单** | "项目有哪些页面？" / "overlay 有哪些？" / "这个页面的 backTarget 是什么？" | `query Route` / `query Route --where "domain=health"` |
| **页面跳转关系** | "从饮食健康页能跳到哪？" / "页面导航图" | `link navigatesTo --src route:dietary_health` |
| **查找组件定义** | "TalentResultPage 在哪定义？" / "这个组件多少行？" | `query Component --where "name=TalentResultPage"` |
| **谁渲染了这个组件** | "ExerciseReportPage 被谁用了？" | `link renderedBy --src comp:ExerciseReportPage` |
| **这个组件渲染了什么** | "HealthStatsPage 里用了哪些子组件？" | `link renders --src comp:HealthStatsPage` |
| **变更影响分析** | "修改 exerciseService 会影响哪些文件？" | `link importedBy --src file:src/services/exerciseService.ts` |
| **Store 分析** | "项目有哪些 store？" / "useThemeStore 被谁用了？" / "storage key 是什么？" | `query Store` / `link usesStore --src store:useThemeStore` |
| **Flutter 客户端分析** | "这个 Flutter 页面用了哪些 store？" / "GoRoute 跳转到哪？" / "这个方法调用了谁？" | `query Route --where "routeType=flutter"` / `link navigatesTo --src route:xxx` / `query Method --where "name~xxx"` 看 callIds/compCallIds |
| **Hook 分析** | "有哪些自定义 Hook？" / "useEnergySystem 被谁用了？" | `query Hook` / `link usesHook --src hook:useEnergySystem` |
| **接口实现关系** | "IStorage 有哪些实现类？" / "这个接口被谁实现了？" | `link implementedBy --src "iface:src/types/storage.ts#IStorage"`（实现关系记录在实现类里，grep 接口文件查不到——本体已双向化） |
| **方法定位** | "createinterface 方法在哪定义？" / "这个方法的签名和实现？" | `query Method --where "name~createinterface"`（一次命中接口签名/类实现/模块函数） |
| **类继承分析** | "UserRepo 继承了谁？" / "BaseRepo 有哪些子类？" / "有哪些单例？" | `link extends --src "class:src/core/repo.ts#UserRepo"` / `link extendedBy --src "class:..."` / `query Class --where "isSingleton=true"` |
| **方法覆盖矩阵** | "这个接口方法都有实现吗？" / "谁覆盖了父类 find？" | `link overriddenBy --src "method:src/types/storage.ts#IStorage#get"` / `link overrides --src "method:...#find"` |
| **油猴脚本清单（浅查询）** | "项目有哪些油猴脚本？" / "哪个脚本跑在 Vue 页面？" | `query UserScript` / `--where "hostFramework=vue"`（GM 审计/注入/网络深挖 → nice-aos-userscript skill） |
| **死代码（浅查询）** | "哪些函数没人调用？" | `query Method --where "deadCandidate=true"`（三级清理工作流 → nice-aos-deadcode skill） |
| **单文件分析** | "分析这个文件" / "这个独立脚本的内部结构？" | `action analyzeFile --params '{"file":"path/to/x.js"}'` |
| **页面 ↔ 组件映射** | "steam_dashboard 路由对应哪个组件文件？" | `query Route --where "overlayId=steam_dashboard"` 或 `link registers --src route:xxx` |
| **循环依赖** | "有没有循环依赖？" | 看 `_meta.cycles`（`export --format json` 后 jq）或导出 Markdown 的循环依赖节 |
| **外部依赖** | "哪些 npm 包用得最多？" / "有没有未声明的导入？" | `query Dependency` |
| **构建/刷新快照** | "刷新快照" / "代码变了重新分析" | `action refreshRepo` |
| **代码 Review 辅助** | "标记这个组件已审查" / "给这个类加备注" | `action markReviewed` / `action addNote` |

**不触发的场景**：写/改代码（agent 自身能力）、构建/测试（npm scripts）、Lint（ESLint）；油猴审计与死代码清理走各自专用 skill。

## 前置条件

- Node.js 18+
- CLI 获取方式（二选一）：
  - **仓库内源码**（默认）：`nice-aos/` 子项目，无需全局安装；`nice-aos/node_modules` 需已安装（若缺失，执行 `cd nice-aos && npm install`）；版本跟随 git，无需 npm 版本检测
  - **npm 包安装**：`npm install -g nice-aos`（全局安装）或 `npx nice-aos`（按需拉取，包已发布至 npm.org，详见 [npm 页面](https://www.npmjs.com/package/nice-aos)）
- **版本检测（npm 包方式必须）**：agent 首次调用前先执行 `nice-aos update --check` 确认使用最新版（分析能力随版本演进，旧版会缺失新对象类型/字段/命令）：
  ```bash
  nice-aos update --check   # 输出 JSON：current / latest / upToDate / installMode
  nice-aos update           # upToDate=false 且 installMode=global 时一键升级（npm install -g nice-aos@latest）
  ```
  - `installMode=npx/local/repo` 时无法自动升级，按输出中的 `upgradeCommand` 指引处理（npx 用 `npx nice-aos@latest ...` 拉新；repo 源码跟随 git）
  - `update` 命令不存在 → 版本过旧（< 0.10.0），先执行一次 `npm install -g nice-aos@latest`，此后即可用 `nice-aos update` 自更新
  - 网络不可达时 `--check` 返回 `ok:false`（带 current 版本号），跳过升级继续用当前版本，不要阻塞主流程

## CLI 调用方式

快照目录统一约定：**`<REPO_ROOT>/.nice-aos/data`**（CLI 默认回退链第一候选）。在仓库根目录执行命令时无需传 `--snapshot-dir`；在其他目录执行时显式传参：

```bash
NICE_AOS="node <REPO_ROOT>/nice-aos/src/cli/index.js"
SNAPSHOT_DIR="<REPO_ROOT>/.nice-aos/data"

# 仓库根目录下执行（推荐，零参数）
$NICE_AOS query Route --where "domain=steam"

# 其他目录执行（显式快照目录）
$NICE_AOS --snapshot-dir "$SNAPSHOT_DIR" query Route --where "domain=steam"
```

若通过 npm 包方式获取 CLI，将 `$NICE_AOS` 替换为 `nice-aos`（全局安装）或 `npx nice-aos` 即可，其余参数不变。旧路径（如 `.codebuddy/skills/.../data`）仍可通过 `--snapshot-dir` 显式访问。

也可使用仓库根 package.json 提供的快捷脚本：

```bash
npm run aos -- query Route --all
npm run aos -- link importedBy --src "file:src/services/ai.ts"
npm run aos -- action refreshRepo --params '{"repoPath":"."}'
```

## 首次使用：构建快照

```bash
# 在仓库根目录执行（快照写入 <REPO_ROOT>/.nice-aos/data/snapshot.json）
node <REPO_ROOT>/nice-aos/src/cli/index.js \
  action refreshRepo --params '{"repoPath":"<REPO_ROOT>","roots":["src","nicekit/src","nice-steam/src"]}'
```

**预期输出**（JSON）：
```json
{
  "ok": true,
  "message": "已成功导入 nice-today-2.0（1761 个源文件，3500ms）",
  "stats": { "Module": 256, "SourceFile": 1761, "Component": 851, "Hook": 71,
             "Store": 17, "Service": 407, "Interface": 320, "Class": 180,
             "Method": 5800, "Route": 296, "Dependency": 86,
             "UserScript": 0, "GmApiUsage": 0, "InjectionPoint": 0,
             "NetworkEndpoint": 0, "ScriptFunction": 0 },
  "cycles": 8, "orphanCandidates": 352, "analysisErrors": 0
}
```

stats 固定包含全部 16 类对象计数（含类型实体 Interface/Class/Method，大仓库 Method 可达万级）；React/Vue 项目中油猴 5 类（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction）为 0，纯油猴仓库则 React/Vue 类为 0（实测 226 脚本仓库：UserScript 226 / InjectionPoint 5409 / ScriptFunction 47327）。

构建完成后 `.nice-aos/data/snapshot.json` 即为所有查询的数据源。**代码有变动后需重新执行 refreshRepo 刷新**。

**纯油猴脚本仓库**（如 steam-tampermonkey-scripts）无需 package.json 即可分析：扫描器自动识别 `.user.js` 与头部含 `==UserScript==` 元数据块的 `.js` 文件（`framework=userscript`），refreshRepo 只校验目录存在性。

React/Vue 项目与油猴脚本混合时同样自动识别（以宿主框架为准，脚本独立产出 UserScript 对象体系）。

## 本体模型

### 概念分类体系

20 种对象类型按「概念范畴」（Container/CodeUnit/EntryPoint/Script/Environment/AuditFact）与「抽象层级」（L3 架构层：Project/Domain；L2 结构层：Module/SourceFile/Route/UserScript/Dependency；L1 单元层：Component/Hook/Store/Service/Interface/Class/Trait/Method/ScriptFunction；L0 事实层：GmApiUsage/InjectionPoint/NetworkEndpoint）双维组织。聚合节点（Project/Domain/Module）自动生成职责画像与自然语言总结（summary/architecture/health）。

**语义架构层（archLayer）**：每个文件/模块推断一个语义层——entry/presentation/state/service/integration/shared/types/config/script/test/mixed，以内容信号为准（单元构成、路由归属、引用结构），目录名仅作弱信号回退；构成分散（主导层 < 60%）时如实标记 mixed。**功能域（Domain）**与架构层正交：架构层是纵向技术切片，功能域是横向业务切片（路由域段 + 业务命名目录聚合）。

### 对象类型（18 种）

| 类型 | 说明 | 典型属性 | ID 前缀 |
|------|------|---------|---------|
| Project | 代码仓库（含架构画像） | name, framework(react/vue/flutter/dart/userscript/unknown), fileCount, tsxFileCount, vueFileCount, dartFileCount, userScriptFileCount, rustFileCount, flutterDetected/tauriDetected, commitHash, branch, summary（框架定位+分层画像+功能域清单）, architecture（语义分层占比）, health（循环依赖/死代码四级/未声明依赖/高风险脚本/解析错误）, analysisErrors | `proj:` |
| Domain | 功能域（横向业务切片） | name, sources(route/module), routeCount, componentCount, storeCount, scriptCount, fileCount, lineCount, capability（路由能力描述）, summary（职责画像） | `dom:` |
| Module | 目录模块（含语义分层） | name, path, archLayer, archLayerLabel, layerComposition（子树层构成）, fileCount, subtreeFileCount, parentId, unitCounts, routeCount, summary（职责画像） | `mod:` |
| SourceFile | 源文件 | path, ext(ts/tsx/js/jsx/vue/dart/rs), archLayer, layer, lineCount, isTest, isEntry, importIds, exportNames, unusedExports（导出级死代码候选）, opensOverlayIds | `file:` |
| Component | 前端组件（React / Vue SFC / Flutter Widget） | name, filePath, kind(page/modal/card/.../widget), isDefaultExport, propsCount, hooksUsed, stateCount, lineCount, rendersIds, routeIds, archLayer, domainIds, description | `comp:` |
| Hook | 自定义 Hook / Composable | name, filePath, lineCount, archLayer, domainIds, description | `hook:` |
| Store | Zustand / Pinia / Riverpod Store | name, stateKeys, actionKeys, hasPersist, storageKey, providerType/notifierClass（Riverpod）, location(store/services/other), archLayer, domainIds | `store:` |
| Service | 服务/引擎模块 | name, pattern(singleton/class/functions), exportsCount, lineCount, archLayer, domainIds | `svc:` |
| Interface | TS 接口（含 .d.ts）/ Dart 抽象类 | name, filePath, line, exported, methodIds, extendsIds/extendsNames（跨文件解析）， deadCandidate/deadReason | `iface:` |
| Class | TS 类 / Dart class/enum/mixin | name, filePath, line, exported, isSingleton, methodIds, implementsIds/implementsNames, extendsId/extendsName, deadCandidate/deadReason | `class:` |
| Method | 方法/函数（类方法/接口方法签名/模块函数/Rust impl fn/Dart 方法） | name, ownerKind(class/interface/module), ownerName, isStatic, isAsync, signature（展示用）, overridesId/overriddenByIds, isOverride（Dart）, callIds/calledByIds/compCallIds（Dart 方法逻辑调用链：调用的方法/被调用方/渲染的 Widget 组件）, exported, deadCandidate/deadReason；ID：`method:<file>#<Owner>#<name>`（模块函数 `method:<file>#<fnName>`） | `method:` |
| Route | 路由条目（Overlay / vue-router / GoRoute） | overlayId(path), routePath, backTarget, hidesNav, domain, domainIds, routeType(overlay/react/vue/flutter), componentFileId, navigatesToIds, description | `route:` |
| Dependency | npm / pub 依赖 | name, version, scope, source(npm/pub/workspace/undeclared), importCount | `dep:` |
| UserScript | 油猴脚本（元数据 + 行为画像） | name, version, matches, grants, grantNone, connects, requires, runAt, hostFramework(vue/react/mixed/unknown), isIife, usesStrict, riskLevel, riskCount, risks, hijackCount, unsafeWindowReads/Writes, storageUsage, functionCount, deadFunctionCount, injectionCount, networkEndpointCount, archLayer=script, domainIds | `us:`（= 文件相对路径） |
| GmApiUsage | GM API 使用（与 @grant 比对） | name（GM_* 与 GM.* GM4 风格统一归一）, category(storage/network/style/...), callCount, lines, declared | `gm:` |
| InjectionPoint | DOM 注入点（含归属函数） | kind(mount/inner-html/insert-adjacent/document-write/style-gm/style-element/shadow-dom), target（receiver 为 querySelector/getElementById 变量时还原为页面选择器）, callCount, lines, interpolated, fns/fnIds（执行注入的函数，逻辑注入链） | `inject:` |
| NetworkEndpoint | 网络端点（与 @connect 比对） | kind(gm-xhr/fetch/xhr/websocket/beacon), domain（动态拼接 URL 记为 `(dynamic)`）, urls, methods, callCount, allowedByConnect, fns/fnIds（发起请求的函数） | `net:` |
| ScriptFunction | 脚本函数/类/对象方法（含业务角色） | name（对象/类方法含 `.`，如 `storage.get`）, kind(function/arrow/class/object/method), owner, isTopLevel, roles(render/data/state/event/ui/logic，按函数内行为推断), line, lineCount, gmApiCount, domOpCount, networkCallCount, callCount, calledByCount, deadCandidate/deadReason（函数级死代码候选）, callIds, calledByIds, archLayer=script | `fn:` |

### 链接（21 种）

| 链接 | 语义 | 方向 |
|------|------|------|
| contains | 层次包含 | Project→Domain/Module→SourceFile→Component/Hook/Store/Service/Interface/Class/Method/UserScript；iface:/class:→其方法；us:→GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction |
| imports | 模块导入 | SourceFile→SourceFile / Dependency |
| importedBy | 被导入（反向） | 谁导入了这个文件 |
| renders | JSX 渲染 | Component→Component |
| renderedBy | 被渲染（反向） | 谁渲染了这个组件 |
| navigatesTo | 页面跳转 | Route→Route（overlay 的 `setActiveOverlay('x')`、React 的 `<Navigate to="/x"/>`、Vue 的 `router.push('/x')`、Flutter 的 `context.go('/x')`/`context.push('/x')` 字面量调用） |
| registers | 路由注册 | Route↔Component（双向：src 为 route: 给组件，src 为 comp:/file: 给路由） |
| usesStore | Store 使用 | file:/comp:→Store 或 store:→反向使用方 |
| usesHook | Hook 使用 | file:/comp:→Hook 或 hook:→反向使用方 |
| implements | 类实现接口 | class:→Interface（跨文件解析：本文件声明优先，其次具名导入，含 import type 与别名导入） |
| implementedBy | 被实现（反向） | iface:→实现该接口的全部 Class（实现关系记录在实现类里，本体已双向化——核心新能力） |
| extends | 继承 | class:/iface:→父类/父接口 |
| extendedBy | 被继承（反向） | class:/iface:→全部子类/子接口 |
| overrides | 方法覆盖 | method:（类方法）→所实现的接口/父类同名方法 |
| overriddenBy | 被覆盖（反向） | method:（接口/父类方法）→全部实现/覆盖方法 |
| usesGmApi | GM API 使用 | us:→GmApiUsage 或 gm:→所属脚本（反查） |
| injectsInto | DOM 注入 | us:→InjectionPoint 或 inject:→所属脚本（反查） |
| requestsTo | 网络请求 | us:→NetworkEndpoint 或 net:→所属脚本（反查） |
| calls | 函数调用图 | ScriptFunction→ScriptFunction（该函数调用了谁）；Dart Method 的调用链在对象属性 callIds/compCallIds 上（`query Method` 直读或蓝图/导出展示） |
| calledBy | 被调用（反向） | ScriptFunction→调用它的函数（修改影响面）；Dart Method 反向在 calledByIds 属性上 |
| belongsTo | 功能域归属（双向） | dom:→全部成员；或 mod:/comp:/store:/hook:/route:/us:→所属功能域 |

### 动作（4 种）

| 动作 | 用途 | 守卫 |
|------|------|------|
| refreshRepo | 重新分析仓库（全量；React/Vue 项目约 3.5s，大型油猴仓库可达数十秒） | repoPath 必须为存在的目录（纯油猴脚本仓库无需 package.json） |
| analyzeFile | 单文件分析（不落盘，stdout 输出 dataMap 形状 JSON；支持 .ts/.tsx/.js/.jsx/.mjs/.vue/.rs/.dart/.py/.kt/.kts/.php 与油猴脚本） | file 必须为存在的普通文件 |
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
query Component --where "name~steam"                  # ~ 模糊匹配（子串包含，忽略大小写）
query SourceFile --where "path~steam,layer=components" # 模糊可与精确条件 AND 混用
query Dependency --where "source=undeclared"      # 未声明依赖（治理点）
query Store --where "hasPersist=true"             # 持久化 store（核对 storageKey 命名）
query Module --where "archLayer=state" --pretty   # 按语义架构层过滤模块
query Component --where "domainIds=dom:health"    # 按功能域过滤成员

# ---- 类型实体（接口/类/方法）----
query Method --where "name~createinterface" --all   # 按名找方法：一次命中接口签名/类实现/模块函数
query Method --where "ownerKind=interface" --pretty # 全部接口方法签名
query Method --where "ownerKind=module,isAsync=true" # 异步模块函数
query Interface --where "exported=true" --pretty    # 导出接口清单
query Class --where "isSingleton=true"              # 单例类
query Class --where "extendsName=BaseRepo"          # 按父类名过滤（未解析成功也能按名过滤）

# ---- 油猴脚本（浅查询；审计工作流见 nice-aos-userscript skill）----
query UserScript --all                           # 脚本清单（元数据 + 行为画像）
query UserScript --where "hostFramework=vue"     # 跑在 Vue 页面上的脚本
query UserScript --where "riskLevel=high"        # 高风险脚本（请求劫持/eval/cookie 写）
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

# ---- 类型实体（接口/类/方法）----
link implements --src "class:src/impl/localStorage.ts#LocalStorage"       # 类实现了哪些接口
link implementedBy --src "iface:src/types/storage.ts#IStorage"            # 接口被哪些类实现（反向，核心新能力）
link extends --src "class:src/core/repo.ts#UserRepo"                      # 类继承的父类
link extendedBy --src "class:src/core/base.ts#BaseRepo"                   # 父类的全部子类
link overriddenBy --src "method:src/types/storage.ts#IStorage#get"        # 接口方法的全部实现
link overrides --src "method:src/impl/localStorage.ts#LocalStorage#get"   # 实现方法覆盖的契约方法
link contains --src "iface:src/types/storage.ts#IStorage"                 # 接口下钻方法签名

# ---- 油猴脚本（us:/gm:/inject:/net:/fn:；审计工作流见 nice-aos-userscript skill）----
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
# 单文件分析（不落盘，stdout 直接输出 dataMap 形状 JSON，可与 jq/findstr 管道组合）
action analyzeFile --params '{"file":"Steam-License-Classifier.js"}'
action markReviewed --params '{"objectId":"comp:TalentResultPage"}'
action addNote --params '{"objectId":"comp:TalentResultPage","note":"核心页面"}'
```

**analyzeFile 输出形状**（`_meta.mode === 'single-file'`）：
- TS/Vue 文件：`SourceFile`（单条）+ `Interface/Class/Method`（非导出零引用实体判死；导出实体不判死——单文件模式无法判定跨文件使用）
- Rust 文件：`Interface/Class/Method`（rustAnalyzer 链：trait/struct/enum/impl fn）
- Dart 文件：`Interface/Class/Method`（dartAnalyzer 链：抽象类/class/mixin/方法，含 callIds 调用链）
- 油猴文件：追加 `UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction` 五类（ScriptFunction 含函数级 deadCandidate）
- 典型管道用法：`nice-aos action analyzeFile --params '{"file":"x.user.js"}' | jq '.ScriptFunction[] | select(.deadCandidate)'`

### ask / serve / storage — 快照协同（外部 AI CLI 与 HTTP 数据源）

```bash
# 向外部 AI CLI 提问：自动把快照浓缩为上下文（项目画像/架构分层/功能域/模块 Top 10/依赖/健康指标）拼进 prompt
# agent 探测顺序 codebuddy → opencode → 模型服务兜底（--agent 可显式指定；--json 输出结构化结果）
# 空数据自动快照：无 snapshot.json 或空项目快照（fileCount=0）时先自动 refreshRepo 再问答（--no-auto-refresh 跳过）
ask "这个项目有哪些功能域？"
ask "架构分层的文件分布？" --agent opencode
ask "有哪些循环依赖？" --serve        # 同时后台起 serve，HTTP URL 拼进 prompt 供 AI CLI 深查完整快照
ask "依赖健康度？" --json             # {ok, agent, contextSource, durationMs, answer}
ask "ASDM架构？"                     # 无快照/空项目 → 自动 refreshRepo 重建后再答

# 备选模型服务（OpenAI 兼容，如 DeepSeek）：CLI 超时/失败自动降级；--agent api 直连
ask config set --provider deepseek --api-key sk-xxx   # 密钥 AES-256-GCM 加密落盘 ~/.nice-aos/config.json
ask config show                                        # 查看生效配置（掩码；env 变量 NICE_AOS_API_KEY/BASE_URL/MODEL 优先）
ask config unset                                       # 清除
ask "Q" --agent api                                    # 直连模型服务

# 本地 HTTP 数据源（全端点 CORS *，就绪状态每请求实时探测）
serve                                 # 默认 http://127.0.0.1:8420
serve --port 0                        # 自动分配端口

# SQLite 镜像（可选加速层；JSON 始终是主数据源，better-sqlite3 缺失自动降级不阻塞）
storage rebuild --kind code          # snapshot.json → <snapshotDir>/aos.sqlite
storage status                       # 镜像状态
```

serve 端点：`/snapshot.json`（完整快照）/ `/blueprint.html` / `/api/status` / `/api/stats` / `/api/schema`（本体元模型，agent 自我发现能力）/ `/api/objects/:type?where=k=v,k2~v2&limit=200`（对象级查询，SQLite 优先回退 JSON）/ `/api/ask/context?q=问题`（与 ask 命令同一上下文构建器）。

上下文构建性能：SQLite 镜像存在时 ask/serve 走 4 次预过滤 SQL（12MB 快照实测热查询 0.2ms、冷启动 39ms）；无镜像回退 JSON 全量 parse（同快照约 500ms）。写入双写闭环：refreshRepo / markReviewed / addNote 落 JSON 同时镜像 SQLite，跨进程 WAL + 锁文件保护。

agent 降级链：CLI agent（codebuddy → opencode）超时/失败自动降级到已配置的 OpenAI 兼容模型服务（每级独立超时预算，`--json` 的 `fallbackFrom` 记录失败链）。

### mcp — MCP server（Claude Code / Cursor 直连协议，v0.32.0+）

```bash
# 启动 stdio MCP server（与 Claude Code / Cursor 配套使用）
mcp --root /abs/path/to/your/project

# Claude Code 集成（一次性配置 ~/.claude.json）：
# claude mcp add nice-aos -- npx nice-aos mcp --root /abs/path/to/your/project
```

把 nice-aos 7 个能力暴露为 [Model Context Protocol](https://modelcontextprotocol.io) tools，让 Claude Code / Cursor / Continue / Cline 等 MCP 客户端**直接调用**——无需复制上下文、无需手写 fetch。

| Tool | 用途 | 关键参数 |
|------|------|---------|
| `get_stats` | 项目元信息 + counts + 循环依赖 + 孤儿候选 | — |
| `get_schema` | 本体元模型（20 对象类型 / 26 链接 / 4 action / 4 抽象层 / 6 范畴） | — |
| `list_types` | 20 种对象类型精简列表 | — |
| `query_objects` | 按类型 + 条件查询 | `type`（必填）/ `where`（如 `deadCandidate=true,name~Button`）/ `limit`（默认 200） |
| `get_node` | 按 id 查单个对象（含自动推断的 `_type`） | `id`（必填，如 `comp:Button`） |
| `traverse_links` | 链接遍历 | `linkType`（必填，`links` 看所有 / 具体名看一类）/ `srcId` / `depth`（默认 1） |
| `get_health` | 五维健康审计摘要 | — |

**与 `serve` 的关系**：`serve` 暴露 HTTP 端点（人 / 油猴脚本 / 网页消费），`mcp` 暴露 MCP 协议（AI agent 直连）。两者数据源相同（`snapshot.json`），工具语义一致。**实现细节**：低层 `Server` + `setRequestHandler`（非 `McpServer.tool()`）以避免 zod 依赖；inputSchema 用 JSON Schema 形态（MCP 协议层接受）；handler 错误用 `{ok: false, error}` 返回值表达（不抛）。详细决策见 `docs/adr/0004-code-graph-rag-reusable-patterns.md`。

### export — 导出

```bash
# Markdown 全景报告（含路由地图、导航图、接口与实现（方法覆盖矩阵）、类与方法（契约热点）、
# 循环依赖、死代码候选四级（文件/导出/类型/函数）、Store 一览；
# 存在油猴脚本时追加 6 节：油猴脚本一览、GM API 使用、DOM 注入点、网络请求与请求劫持、脚本函数 Top 30、安全风险清单）
export --format markdown --output ".nice-aos/data/report.md"

# JSON 供 jq 聚合
export --format json | jq '._meta.orphanCandidates | length'
export --format json | jq '._meta.deadExportCandidates'          # 导出级死代码
export --format json | jq '.UserScript[] | select(.riskLevel=="high") | .filePath'

# 自包含蓝图 HTML（本体查看器）：五个标签页（总览/领域蓝图/业务数据图/业务逻辑流向/脚本蓝图），
# 零外部依赖、数据内嵌、可离线打开分享；告诉用户文件路径即可用浏览器打开。
# 脚本蓝图（有油猴脚本时）：函数调用关系 SVG 图（悬停高亮相邻、点击看详情）+
#   DOM 注入锚点列（还原后的页面选择器）+ 网络端点列（域名/@connect 比对），
#   一图直读"入口函数 → 调用链 → 注入锚点/网络域"的逻辑注入链
export --format html --output ".nice-aos/data/blueprint.html"

# 视图模型 JSON（buildViewerModel 聚合结果：领域蓝图/业务数据图/逻辑流向/脚本蓝图），
# 供 agent 直接消费（比原始 snapshot.json 小且已聚合，无需再拼装）
export --format viewmodel --output ".nice-aos/data/viewmodel.json"
```

**何时用 html / viewmodel**：用户要"给人看的蓝图/可视化/汇报材料"→ `html`；agent 自己要整体理解领域划分、数据枢纽、层间流向 → `viewmodel`（一次读取即得聚合视图，避免数十次 query/link 拼装）；用户要"看脚本的函数调用关系 / 注入链"→ `html`（脚本蓝图页有交互式 SVG 调用图）。

## 使用建议

### 通用工作流

1. **检查快照**：`.nice-aos/data/snapshot.json` 不存在或代码大改后 → `action refreshRepo`
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

### 接口/类/方法导航（类型实体场景）

实现关系记录在实现类的 `implements` 子句里——从接口文件本身 grep 查不到实现方；本体已将关系双向化：

```bash
# 1. 找方法：不记得确切名字时模糊匹配（与 findstr 语义一致，一次命中签名+实现）
query Method --where "name~createinterface" --all
# 2. 接口 → 实现类（反向，正向 grep 不到的核心场景）
link implementedBy --src "iface:src/types/storage.ts#IStorage"
# 3. 接口方法 → 全部实现方法（含未覆盖缺口检查：结果数 < 实现类数即有类未实现该方法）
link overriddenBy --src "method:src/types/storage.ts#IStorage#get"
# 4. 类 → 继承/实现上下文（改动类前先看契约约束）
link extends --src "class:src/core/repo.ts#UserRepo"          # 继承了谁
link implements --src "class:src/impl/localStorage.ts#LocalStorage"  # 实现了哪些接口
# 5. 交接给用户：导出 Markdown 的「接口与实现」（方法覆盖矩阵）与「类与方法」章节
```

方法 ID 记忆规则：类/接口方法 `method:<file>#<Owner>#<name>`，模块函数 `method:<file>#<fnName>`；不确定 ID 时先 `query Method --where "name~xxx"` 拿到 id 再 link。

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
| npm 包方式运行（全局/npx） | 先 `nice-aos update --check`；`upToDate=false` 且 `installMode=global` 时执行 `nice-aos update` 一键升级；命令不存在则先 `npm install -g nice-aos@latest`（< 0.10.0 旧版） |
| 查询返回"未找到本体快照" | 提示后直接执行 `action refreshRepo`（React/Vue 项目约 4 秒，无需用户确认；大油猴仓库耗时见下条） |
| 用户报"查询结果不对/过期" | 代码可能已变更 → 重新 refreshRepo |
| 回答结构类问题 | 优先用 nice-aos 查询，而不是 grep 1700+ 文件 |
| 用户要油猴安全审计（GM 越权/@connect/XSS/风险清单） | 切换到 `nice-aos-userscript` skill 的工作流 |
| 用户要死代码清理（文件/导出/函数三级） | 切换到 `nice-aos-deadcode` skill 的工作流 |
| 分析独立单文件（不属于某仓库或不需快照） | `action analyzeFile --params '{"file":"<path>"}'`（不落盘，直接 JSON） |
| 分析纯油猴脚本仓库 | 直接 refreshRepo（无需 package.json）；快照不存在时照常自动构建 |
| 大型油猴仓库 refreshRepo | 数百个超大脚本（单脚本 2 万+ 行）全量分析可达数十秒，属正常耗时，耐心等待而非中断重试 |
| 用户要"项目蓝图 / 可视化 / 汇报材料" | `export --format html` 生成自包含蓝图 HTML 并告知文件路径（无需起服务）；agent 自用聚合数据用 `--format viewmodel` |
| 用户想让 codebuddy/opencode 等外部 AI CLI 理解本项目 | `ask "<问题>"`（快照上下文自动注入；`--serve` 附带 HTTP 深查端点；未装 AI CLI 时报错并提示安装） |
| ask 时快照缺失或为空项目（fileCount=0） | ask 自动执行 refreshRepo 重建快照后作答，无需手动先跑；仅 CI 等显式控制场景用 `--no-auto-refresh` |
| markReviewed/addNote | 执行 review 类任务后主动回写，下次会话可恢复上下文（JSON 与 SQLite 镜像双写） |

## 输出格式

- 默认 stdout 输出 JSON（agent 直接解析）
- `--pretty` 人类可读表格
- 退出码：0 成功，1 失败
- 快照单文件 `snapshot.json`（本仓库约 2-4MB；含类型实体后大仓库可达 6-10MB）

## 技术限制

- 基于 TypeScript Compiler API 的**语法级**解析（不跑类型检查），个别动态引用（变量拼接的 import、字符串组件名）无法解析
- 类型实体覆盖 `.ts/.tsx/.js/.jsx`、`.d.ts`、`.rs` 与 `.dart`；**Vue SFC `<script>` 内的 interface/class 不提取**（Vue 侧走 Hook/Composable/Store 体系）；方法级调用链仅 Dart Method 有（`callIds/calledByIds/compCallIds` 属性，蓝图类图与 Markdown 导出展示），TS/Vue/Rust 的 Method 暂无调用图（`link calls/calledBy` 命令仍仅覆盖油猴 ScriptFunction）
- Dart 解析为轻量语法级（深度状态机 + 等长噪声剥离，不依赖 dart analyzer）：Widget 基类（StatelessWidget/StatefulWidget/ConsumerWidget 等）→ Component，ChangeNotifier/Notifier 子类与 Riverpod Provider 变量 → Store，GoRoute + 路由常量回填 → Route；方法调用链按本类/导入解析/全仓库唯一名兜底匹配，闭包内间接调用与动态构造无法静态追踪；Flutter 框架识别依赖 pubspec.yaml 声明 flutter sdk（纯 Dart 包记为 framework=dart）
- 跨文件 implements/extends 按具名导入静态解析（含 `import type` 与别名导入）；命名空间导入、`export *` 再导出、动态 `import()` 的目标文件无法按名追踪，整体豁免死代码判定（保守不误报）
- `renders` 归属到文件的主组件（default export 优先）；同文件多组件的内部渲染关系不细分
- 跳转边均为字面量调用：overlay 体系来自 `setActiveOverlay/openOverlay('id')`，React 来自 `<Navigate to="/x"/>`（相对 `to` 基于所属路由归一为绝对路径），Vue 来自 `router.push/replace('/path')`（含解构 `const { push } = useRouter()`）；`onOpenOverlay: app.setActiveOverlay` 这类函数透传与动态变量导航无法静态追踪
- App.tsx 内部跳转（Tab 级）不计入 navigatesTo（仅 Route→Route）
- Vue 适配范围：Vue 3 SFC（`<script setup>`/`<template>`/`<route lang="yaml">`）、vue-router RouteRecordRaw 显式路由、views/pages 目录文件路由推导、Pinia `defineStore`（setup/options 两种写法）、composables（导出 `useXxx`）；模板渲染关系支持 PascalCase/kebab-case 标签与 `:is` 动态组件（不含动态变量拼装）
- 油猴脚本识别为启发式：`.user.js` 扩展名，或 `.js` 文件头部 4KB 内含 `==UserScript==` 元数据块（元数据块须在文件头部 8KB 内）；无元数据块的普通 .js 不会误判
- 每次查询全量加载 JSON（1760 文件规模毫秒级；无并发写保护）
- `--where` 为全表扫描：`=`/`:` 精确相等、`~` 模糊包含（不支持数值比较，数值过滤请配合 jq）
