# 更新日志

本项目的所有重要变更均记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
