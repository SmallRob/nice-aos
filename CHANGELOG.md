# 更新日志

本项目的所有重要变更均记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.6.0] - 2026-08-20

### 新增

- **脚本蓝图视图（viewer 第五视图"脚本蓝图"）**：油猴脚本开发者一图直读"入口函数 → 调用链 → DOM 注入锚点 / 网络域"的完整逻辑注入链
  - **SVG 函数调用关系图**：函数节点按调用深度分层布局（入口 → 逐层调用，BFS 定级），实线为函数调用、青色虚线为 DOM 注入（指向页面锚点）、紫色点线为网络请求（指向域名端点）；悬停高亮相邻节点与边，点击查看函数详情（角色/行号/调用关系/注入目标/GM API）或锚点详情（归属函数/插值标记/@connect 比对）
  - **DOM 注入锚点列**：还原后的页面选择器（如 `querySelector('#app')`、`getElementById('sfd-status-txt')`）作为图上独立节点，注入类型/次数/动态插值标记一目了然
  - **网络端点列**：请求域名 + kind（gm-xhr/fetch/xhr/websocket/beacon）+ 方法 + `@connect` 声明比对
  - **函数业务角色分布**：render/data/state/event/ui/logic 六类角色统计条形图；函数清单表含调用/被调/GM/DOM/网络五维计数
  - **数据聚合**：函数重要性加权排序（被调×3 + 调出 + 注入/请求×2）取 Top N 入图，入口函数（topLevelCalls 命中）必进图；脚本按函数数排序展示 Top 24；大脚本截断保护（图节点 50 / 函数表 40 / 注入 20 / 端点 12，计数保留全量）
- **油猴脚本解析增强（userScriptAnalyzer）**
  - **函数业务角色推断（roles）**：按函数内行为推断 render（innerHTML/挂载）/ data（网络请求）/ state（GM 存储）/ event（监听/观察/定时）/ ui（createElement）/ logic（纯逻辑），最多双角色；ScriptFunction 携带 `roles` 字段
  - **注入点与网络端点归属函数（fns/fnIds）**：DOM 注入与网络请求按"最内层包含函数"归属，InjectionPoint/NetworkEndpoint 携带 `fns`（函数名）与 `fnIds`（指向 ScriptFunction），构成逻辑注入链的数据基础
  - **类风格调用链补全**：类 `constructor` 收集为逻辑单元；`this.method()` 类内互调解析为 `Owner.method`；`const app = new Xxx(); app.method()` 实例变量调用经别名表解析为 `Xxx.method`；`new Xxx()` 记为 `Xxx.constructor` 入口调用
  - **innerHTML/insertAdjacentHTML 锚点还原**：receiver 为 `querySelector`/`getElementById` 变量时还原为页面选择器（此前保留变量名），与挂载点还原口径一致
- 真实仓库验证：steam-tampermonkey-scripts（227 个脚本 / 47588 个函数 / 5381 个注入点 / 419 个网络端点），最大脚本（Steam 游戏库展示 v2.11.35，900+ 函数）调用图 58 节点中 42 个有调用关系；steam-friend-manager 的注入锚点归属函数链清晰（如 `renderActiveTab/renderPersonalLibraryTab → getElementById('sfd-pl-tab-content')`）
- 新增 4 个测试（类风格调用链解析 / 注入与网络归属函数 / 角色推断 / viewer 脚本蓝图聚合与 HTML 渲染），总计 52 个全部通过

## [0.5.0] - 2026-08-20

### 新增

- **本体查看器（viewer.js，src/ontology 视图层）**：延续"方案查看器（蓝图）"架构理念，把快照的抽象结果聚合为可交互消费的蓝图，解决"语义总结有了、但没有可视化载体"的问题
  - **数据聚合（buildViewerModel）**：DataMap → 视图模型（JSON），四个板块：本体蓝图（taxonomy + 对象/链接类型 + 实例计数）、领域蓝图（每个功能域的业务层级构成/代码组织/模块清单/单元清单/职责画像）、业务数据图（Store 数据枢纽 + 被哪些域使用 + 跨域数据依赖 + 持久化状态汇总）、业务逻辑流向（架构层间导入流向矩阵 + 跨域依赖边 + 高扇入 Service/Store 枢纽节点）
  - **视图渲染（renderViewerHtml）**：视图模型 → 自包含 HTML（零外部依赖，可离线打开），四个标签页：总览 / 领域蓝图 / 业务数据图 / 业务逻辑流向；层间流向以矩阵呈现（行=来源层，列=目标层），单元清单带大仓库截断保护（计数保留全量）
  - **视图模型独立于渲染**：`export --format viewmodel` 输出聚合 JSON，供 AI agent 与其他前端直接消费；`export --format html` 输出蓝图 HTML
  - 真实仓库验证：React 仓库（steam-portal，26 域 / 3 Store / 76 条层间流向 / 15 个服务枢纽）与纯油猴仓库（steam-tampermonkey-scripts，28 域 / 无 Store 与路由时数据图与流向优雅降级为空态）
- 新增 3 个测试（viewer：视图模型结构完整性/自包含 HTML 嵌入数据无损解析/空数据仓库降级），总计 48 个全部通过

## [0.4.0] - 2026-08-20

### 新增

- **语义本体引擎（semantics.js）**：解决"对象结构只罗列事实、无抽象总结"的问题，解析产出从词法级事实升级为具备语义分层与聚合总结的本体
  - **概念分类体系（taxonomy）**：`ONTOLOGY_META` 显式定义概念范畴（Container/CodeUnit/EntryPoint/Script/Environment/AuditFact，is-a 族）与抽象层级（L3 架构层 / L2 结构层 / L1 单元层 / L0 事实层），15 种对象类型全部挂接双维分类，不再平铺
  - **语义架构分层**：`archLayer`（entry/presentation/state/service/integration/shared/types/config/script/test/mixed）按内容信号推断（单元构成、路由归属、引用结构），目录名仅作弱信号回退；Module 附带 `layerComposition` 层构成画像，构成分散（主导层 < 60%）时如实标记 mixed；取代原先"目录名即层级"（`layer` 字段保留为目录层，两者并存）
  - **功能域聚合（Domain 对象，dom:）**：路由域段 + 业务命名目录（父目录为技术边界、自身命名非技术词，大小写/连字符/下划线归一）聚合为横向功能切片，与纵向架构层正交；成员含路由/组件/Store/Hook/Service/油猴脚本/模块，附 `capability`（路由 meta 能力描述）与 `summary`（含 Hook/Service 计数，`hookCount`/`serviceCount` 可查询）
  - **自然语言总结**：Project 新增 `summary`（框架定位 + 分层构成 + 功能域清单 + 健康度）、`architecture`（style 分层画像/层占比）、`health`（循环依赖/死代码/未声明依赖/高风险脚本/解析错误计数）、`capabilities`（每域一句话）；Module 新增 `summary` 职责画像（层级、单元构成、模块外引用数、承载路由数）、`subtreeFileCount`、`unitCounts`、`dominantShare`、`domainIds`
  - **单元级归属回填**：Component/Hook/Store/Service/UserScript/ScriptFunction 新增 `archLayer`（继承所在文件）与 `domainIds`（所属功能域，数组支持 `--where "domainIds=dom:xxx"` 成员过滤）
  - **belongsTo 链接（第 15 种）**：功能域 ↔ 成员双向（`link belongsTo --src dom:health` 列成员；src 传 comp:/store:/mod:/route: 反查所属域，fn: 归属其脚本的功能域）；Project 的 `contains` 现包含直属 Domain
  - **报告升级**：新增"执行摘要"（总结句列表 + 健康指标表）、"架构总览（语义分层）"（层/定位/文件数/占比）、"功能域地图（Domain）"（域/来源/路由/组件/Store/脚本/文件/职责画像）三个章节；模块 Top 30 升级为语义层 + 层构成 + 直属/子树文件数 + 职责画像
- 新增 13 个测试（semantics：taxonomy 完整性/文件级分层推断/模块级混合层判定/总结生成/buildDomains 归一合并/React fixture 端到端/油猴仓库端到端），总计 45 个全部通过

### 修复

- Module 画像口径不一致：原 `fileCount` 为直属文件数，聚合模块（如 `steam-account-history`）显示"0 个文件"却带大量子树单元 → 总结改用 `subtreeFileCount` 子树口径，导出表同时呈现直属/子树两列

## [0.3.0] - 2026-08-20

### 新增

- **油猴脚本（Tampermonkey UserScript）扫描**：独立 `userScriptAnalyzer` 解析器，与 React/Vue 解析器平级共存、逻辑互不干扰
  - 脚本识别：`.user.js` 扩展名，或 `.js` 文件头部 4KB 内含 `==UserScript==` 元数据块；纯油猴仓库无需 package.json（`framework=userscript`，refreshRepo 不再强制要求 package.json）
  - 5 种新对象：`UserScript`（us:，元数据/@match/@grant/@connect/宿主框架/风险等级）、`GmApiUsage`（gm:，GM 调用与 @grant 声明比对）、`InjectionPoint`（inject:，mount/innerHTML/insertAdjacentHTML/document.write/GM_addStyle/style 元素/Shadow DOM，动态插值 XSS 标记）、`NetworkEndpoint`（net:，gm-xhr/fetch/xhr/websocket/beacon 域名 + @connect 白名单比对）、`ScriptFunction`（fn:，函数/类/对象方法逻辑单元）
  - 5 种新链接：`usesGmApi`/`injectsInto`/`requestsTo`（脚本 ↔ 子对象双向）与 `calls`/`calledBy`（脚本内函数静态调用图）
  - 解析能力：元数据块全字段提取（@grant none 归零）、GM_*/GM.* 双风格归一、querySelector 变量锚点还原挂载目标、unsafeWindow 读/写区分、window 全局暴露与 Object.defineProperty、宿主框架推断（__vue__/__reactContainer$）、原型/全局请求劫持识别（fetch/XHR/EventTarget/WebSocket/history）、eval/new Function、cookie 读写、MutationObserver/定时器/CustomEvent 事件总线
  - 安全风险清单：按 high/medium/low 汇总为脚本级 riskLevel（请求劫持/动态执行/沙箱突破/XSS 面/权限越界）
  - 报告新增 6 个章节：油猴脚本一览（含逐脚本元数据详情）、GM API 使用、DOM 注入点、网络请求与请求劫持、脚本函数 Top 30、安全风险清单
- 新增 11 个测试（userScriptAnalyzer：元数据/候选识别/GM API/DOM 注入/网络与劫持/函数调用图/unsafeWindow/宿主框架/扫描器/本体构建与链接），总计 32 个全部通过

### 修复

- 多入口识别：入口文件原硬编码为 `src/App.tsx` 等单根路径，多 roots monorepo 下 isEntry 全部为空 → 改为按扫描根顶层入口文件名动态匹配（`web/src/main.tsx`、`server/src/index.ts` 等均可命中）
- zustand 泛型 `create<T>()(...)` 漏识别：`create` 位于内层 call 不满足收集条件，8 个 store 仅识别 1 个 → 收集阶段向上穿透到外层 call，factory 改取外层 call 的 `arguments[0]`，persist/devtools 双层嵌套（`devtools(persist(...))`）改为循环穿透

## [0.2.0] - 2026-08-20

### 新增

- **Vue 3 框架适配**：`.vue` SFC 扫描与框架检测（package.json 依赖含 vue/nuxt → `framework=vue`，快照新增 `vueFileCount`）
  - SFC 解析：`<script setup>`/`<template>`/`<style>`/`<route lang="yaml">` 块拆分（template 内嵌 `<template #footer>` 不误拆）；组件名 `defineOptions({ name })` 优先，否则文件名派生；`defineProps` 数组/对象形式计数；template 标签（kebab/PascalCase 统一）供 renders 关系
  - Pinia store：`defineStore` 的 setup 写法（shorthand 函数经函数名集合识别为 action）与 options 写法（`login() {}` MethodDeclaration 计入 actions），`persist` 插件第三参数提取 storageKey；支持 unplugin-auto-import 无 import 语句的隐式 `defineStore`
  - vue-router：`RouteRecordRaw` 显式声明（path/name/meta.title/动态 import/Layout 函数包装/children 拼接，空 path 子路由正确拼接）；`useRouter()` 声明与解构 `push` 归属导航调用（数组 push 不误报）；`src/views|pages/**/*.vue` 文件路由推导（`index.vue` → 父级路径，`[...all].vue` → catch-all），`<route lang="yaml">` meta 作为路由描述
- **React JSX 声明式路由提取**（react-router v6/v7 的 `<Routes>/<Route path element>` 模式，自动探测）
  - 布局 Route（无 path）+ 绝对 children、嵌套相对路径拼接（`/:scopeUid` + `edit` → `/:scopeUid/edit`）、`index` 路由、`path="*"` catch-all
  - element 解析链：`<Guard><Page /></Guard>` 嵌套包装取最内层组件；`element={layoutElement}`（`createElement` 布局变量）穿透到实际布局组件
  - `<Navigate to>` 重定向边：字面量提取，相对 `to` 基于所属路由归一为绝对 overlayId（`to="_overview/summary"` → `/:scopeUid/_overview/summary`）；动态 `to={expr}` 不误报
  - 测试文件中的 mock 路由自动排除
- **page kind 升级**：`pages/` 目录下被路由直接引用的 common 组件自动标记为 page（asdm-admin-web 实测 8 → 48）
- Route 对象新增 `routeType`（overlay/react/vue）；React 路由 id 冲突（index 路由与父路由同 overlayId）经 uniqueId 去重

### 修复

- Vue 显式路由的 domain 取自路由声明文件名（`router/index.ts` 时全部为 `index`）→ 统一按路径顶层段计算（`/` 与动态参数/catch-all 顶层段归入 `root`，如 `/:all(.*)*` → `root`）
- tsconfig.json 含 `//`/`/* */` 注释时（如 shadcn-vue CLI 生成的文件）`JSON.parse` 失败导致 `@/` 别名全部解析失败 → 解析前自动剥离注释（字符串内序列受保护）
- `src/views/index.vue` 文件路由被推导为 `/index` 而非 `/`
- 显式路由与文件路由重复生成（explicitRouteFiles 未命中时）

### 测试

- 新增 14 个测试：Vue（SFC 拆分/route meta/defineProps/defineOptions/Pinia setup/options store/RouteRecordRaw/useRouter 导航/template 嵌套）与 React JSX 路由（布局/嵌套相对路径/index/包装 element/Navigate 归一/普通项目空路由），总计 21 个全部通过

## [0.1.0]

### 新增

- 初始版本：React/TypeScript 前端代码本体分析 CLI
  - 结构化本体快照：Project/Module/SourceFile/Component/Hook/Store/Service/Route/Dependency 9 种对象 + import/render/navigate/register/usesStore/usesHook 等关系图谱
  - 命令：`query`（`--where` 过滤）、`link`（关系遍历）、`action`（refreshRepo/markReviewed/addNote）、`export`（Markdown 全景报告/JSON）
  - 解析能力：tsconfig paths 别名解析、`.tsx` 组件识别（React.FC/memo/forwardRef/分离式 default）、Zustand create/persist store、useXxx Hook、Service 目录识别、依赖治理、死代码候选、Tarjan 循环依赖
  - overlay 路由体系自动探测（overlayGroups + lazyImports）
