# nice-aos — 通用前端代码本体分析 CLI（React / Vue 3 / 油猴脚本）

> 把任意 React、Vue 3 前端仓库或 Tampermonkey 油猴脚本仓库预先分析为**结构化本体快照**（语义架构分层/功能域/模块/文件/组件/Hook/Composable/Zustand/Pinia Store/Service/路由/依赖 + import/render/导航关系图谱；油猴脚本额外产出 GM API 使用/DOM 注入点/网络端点/脚本函数 + 调用图），供 AI agent 与开发者通过 CLI 毫秒级查询，替代逐文件 grep。
> 参考 [asdm-aos](https://www.npmjs.com/package/@leansoftx/asdm-aos)（Java 代码本体分析）的架构，针对前端生态重新建模：React（React 19 + TypeScript + Vite + Zustand + overlay 路由 / react-router）、Vue 3（SFC + vue-router + Pinia）与油猴脚本（UserScript 元数据 + GM API + 注入/请求审计）。
> 语义本体引擎：对象按概念范畴与抽象层级（L3 架构 / L2 结构 / L1 单元 / L0 事实）组织；架构分层按内容信号推断（非目录名直译）；Module/Domain/Project 自动生成职责画像与自然语言总结。

## 为什么需要它

在 1000+ 源文件的前端项目中，让 AI agent 直接 grep 全量源码，响应慢且结构理解易出错。nice-aos 将"文件"升维为"关系图谱"：

| 传统方式 | nice-aos |
|---------|----------|
| grep 谁导入了 ai.ts（遍历全部文件） | `link importedBy --src file:src/services/ai.ts`（毫秒） |
| 人工追页面跳转关系 | `link navigatesTo --src route:dietary_health` |
| 不知道哪些文件是死代码 | 快照内置 orphanCandidates |
| 循环依赖靠运气发现 | 快照内置 Tarjan SCC（`_meta.cycles`） |
| 不知道 store 被谁用了 | `link usesStore --src store:useThemeStore` |
| 审计油猴脚本是否越权调 GM API | `query GmApiUsage --where "declared=false"` |
| 不知道油猴脚本往页面哪里注入了 DOM | `link injectsInto --src us:demo.user.js` |
| 说不清项目架构和功能划分 | `query Project` 看 summary/architecture（分层画像 + 功能域清单 + 健康度） |
| 不知道某目录的职责 | `query Module --where "archLayer=state"` 看职责画像 |
| 想按功能域浏览代码 | `link belongsTo --src dom:health` 列出该域全部成员 |

## 安装

```bash
npm install -g nice-aos        # 全局安装（需要 Node.js >= 18）
# 或不安装，直接使用：
npx nice-aos query --help
```

## 快速开始

```bash
cd /path/to/your-frontend-project

# 1. 构建本体快照（约 3.5 秒 / 1000+ 文件，快照默认写入 ./.nice-aos/data/snapshot.json）
nice-aos action refreshRepo --params '{"repoPath":"."}'

# 2. 查询对象
nice-aos query Project
nice-aos query Component --where "name~steam"        # ~ 模糊匹配（子串包含，忽略大小写）
nice-aos query Route --where "domain=health"

# 3. 遍历关系
nice-aos link importedBy --src "file:src/services/ai.ts"   # 谁导入了这个文件
nice-aos link renders --src "comp:HealthStatsPage"         # 组件渲染了什么
nice-aos link usesStore --src "store:useThemeStore"        # store 被谁用了

# 4. 导出全景报告（路由地图 / 导航图 / 循环依赖 / 死代码候选 / Store 一览）
nice-aos export --format markdown --output report.md
```

> **快照目录解析优先级**：`--snapshot-dir` 参数 > `NICE_AOS_SNAPSHOT_DIR` 环境变量 > `cwd/.nice-aos/data` > `~/.nice-aos/data`。

### 多根目录项目（monorepo / 多包仓库）

默认扫描 `src/`（不存在则扫描项目根）。多根目录通过 `roots` 参数显式指定：

```bash
nice-aos action refreshRepo --params '{"repoPath":".","roots":["src","packages/ui/src","packages/core/src"]}'
```

### 油猴脚本仓库（无需 package.json）

纯油猴脚本仓库（如 steam-tampermonkey-scripts）直接扫描即可，`.user.js` 与头部含 `==UserScript==` 元数据块的 `.js` 均自动识别：

```bash
nice-aos action refreshRepo --params '{"repoPath":"/path/to/steam-tampermonkey-scripts"}'

# 审计示例
nice-aos query UserScript --where "riskLevel=high"                 # 高风险脚本
nice-aos query GmApiUsage --where "declared=false"                 # 越权 GM 调用
nice-aos query InjectionPoint --where "interpolated=true"          # 动态插值 XSS 面
nice-aos link calls --src "fn:steam-game-library-viewer/steam-game-library-viewer-2.10.0.user.js#renderOverview"
```

## 本体模型

### 对象（14 种）

| 类型 | ID 前缀 | 关键属性 |
|---|---|---|
| Project | `proj:` | framework（react/vue/userscript）, fileCount, tsxFileCount, vueFileCount, userScriptFileCount, commitHash, branch, analysisErrors |
| Module | `mod:` | path, layer, fileCount, parentId |
| SourceFile | `file:` | path, layer, lineCount, isTest, isEntry, importIds, exportNames |
| Component | `comp:` | kind（page/modal/card/…）, propsCount, hooksUsed, stateCount, rendersIds, routeIds |
| Hook | `hook:` | name, filePath, lineCount, description（React Hook 与 Vue composable 统一归属） |
| Store | `store:` | stateKeys, actionKeys, hasPersist, storageKey, location（Zustand 与 Pinia 统一归属） |
| Service | `svc:` | pattern（singleton/class/functions）, exportsCount |
| Route | `route:` | overlayId, routePath, routeType（overlay/react/vue）, domain, componentFileId, navigatesToIds |
| Dependency | `dep:` | version, scope, source（npm/workspace/undeclared）, importCount |
| UserScript | `us:` | name, version, matches, grants, connects, hostFramework（vue/react/unknown）, riskLevel, isIife, usesStrict, unsafeWindowReads/Writes |
| GmApiUsage | `gm:` | name, category（network/storage/style/…）, callCount, declared（与 @grant 比对） |
| InjectionPoint | `inject:` | kind（mount/inner-html/insert-adjacent/document-write/style-gm/style-element/shadow-dom）, target, interpolated（动态插值 XSS 面） |
| NetworkEndpoint | `net:` | kind（gm-xhr/fetch/xhr/websocket/beacon）, domain, urls, methods, allowedByConnect（与 @connect 比对） |
| ScriptFunction | `fn:` | kind（function/arrow/class/object/method）, lineCount, callCount, calledByCount, gmApiCalls, callIds/calledByIds |

### 链接（14 种）

```
contains     Project → Module → SourceFile → Component/Hook/Store/Service/UserScript
imports / importedBy    文件级依赖（含 dep: 外部包）— 变更影响分析主链路
renders / renderedBy    组件 JSX/template 渲染关系
navigatesTo  Route → Route（React 的 Navigate/overlay 跳转、Vue 的 router.push/replace 等导航边）
registers    Route ↔ Component（路由注册）
usesStore / usesHook    Store/Hook 使用关系（src 传 store:/hook: 反查使用者）
usesGmApi    UserScript ↔ GmApiUsage（src 传 gm: 反查所属脚本）
injectsInto  UserScript ↔ InjectionPoint（DOM 注入点；src 传 inject: 反查所属脚本）
requestsTo   UserScript ↔ NetworkEndpoint（网络端点；src 传 net: 反查所属脚本）
calls / calledBy    ScriptFunction 调用图（脚本内函数间静态调用关系，双向）
```

## CLI 参考

### query — 查询对象

```bash
query Route --all                                   # 全部路由
query Component --where "kind=page" --pretty        # 页面类组件，表格输出
query SourceFile --where "layer=services,isTest=false"
query Component --where "name~steam"                # ~ 模糊匹配（忽略大小写子串）
query Dependency --where "source=undeclared"        # 未声明依赖（治理点）
query Store --where "hasPersist=true"               # 持久化 store
query UserScript --where "hostFramework=vue"        # Vue 宿主页面的油猴脚本
query UserScript --where "riskLevel=high"           # 高风险脚本
query GmApiUsage --where "declared=false"           # 未在 @grant 声明的 GM 调用（越权面）
query InjectionPoint --where "interpolated=true"    # 动态插值 HTML 注入（XSS 面）
query ScriptFunction --where "kind=class" --pretty  # 脚本内类（逻辑分布）
```

`--where` 语法：逗号分隔多条件 AND；`k=v`（或 `k:v`）精确相等，`k~v` 模糊包含；值为数组时精确做成员包含、模糊做任一成员包含（如 `hooksUsed=useEffect`）。默认返回前 50 条，`--all` 全量、`--limit <n>` 限制。

### link — 遍历关系

```bash
link importedBy --src "file:src/services/exerciseService.ts"   # 变更影响分析
link renderedBy --src "comp:ExerciseReportPage"
link navigatesTo --src "route:dietary_health"                  # 页面导航图
link registers --src "route:talent_result"                     # 路由 ↔ 组件
link usesStore --src "store:useThemeStore"
link usesHook --src "hook:useUserProfile"
link contains --src "mod:src/components/health"                # 层次下钻
link usesGmApi --src "us:steam-game-library-viewer/steam-game-library-viewer-2.10.0.user.js"   # 脚本用了哪些 GM API
link injectsInto --src "us:demo.user.js"                       # 脚本注入了哪些 DOM 点
link requestsTo --src "us:demo.user.js"                        # 脚本请求了哪些域名
link calls --src "fn:demo.user.js#renderOverview"              # 函数调用了谁（调用图正向）
link calledBy --src "fn:demo.user.js#renderOverview"           # 谁调用了该函数（反向影响面）
```

### action — 受控动作

```bash
action refreshRepo --params '{"repoPath":"."}'
action markReviewed --params '{"objectId":"comp:TalentResultPage"}'
action addNote --params '{"objectId":"comp:TalentResultPage","note":"核心页面"}'
```

### export — 导出

```bash
export --format markdown --output report.md     # Markdown 全景报告
export --format json | jq '._meta.cycles'       # JSON 供 jq 聚合
```

## 解析能力

- **导入解析**：tsconfig `paths` 别名（`@/*` → `src/*`）、子路径别名、相对路径 + 扩展名探测（.ts/.tsx/.js/.jsx/.vue/index.*）、`.js` → `.ts` 回退；资产后缀（css/png/svg…）跳过；tsconfig.json 含 `//`/`/* */` 注释也能解析（自动剥离）
- **组件识别（React）**：`.tsx` 导出的 PascalCase 符号；支持 `export default function X`、`export const X: React.FC`、分离式 `export default X`、`memo()/forwardRef()` 包装；kind 按名称后缀推断（Page/Modal/Card/…），`pages/` 目录下被路由直接引用的组件自动升级为 page
- **组件识别（Vue）**：`.vue` SFC 整文件即组件；`defineOptions({ name })` 优先，否则文件名派生（`index.vue` → 目录名）；`defineProps` 数组/对象形式计数；template 标签（kebab/PascalCase 统一）供 renders 关系
- **Hook/Composable 识别**：导出的 `useXxx` 符号（含 React Hook 与 Vue composable），含 JSDoc 描述提取
- **Store 识别**：Zustand `create(...)`（含 `create<T>()(...)`、`persist(...)` 包装）与 Pinia `defineStore(...)`（setup 写法 + options 写法，含 `persist` 插件第三参数），统一提取 state/action 键与 storageKey
- **Service 识别**：`/services/` 目录或名称含 Service/Engine/Manager/Repository/Factory 后缀
- **依赖治理**：package.json 声明 vs 实际导入交叉比对，产出 `source=undeclared`（导入未声明）与 `used=false`（声明未使用）
- **死代码候选**：零引用 + 非入口 + 非测试 + 非路由组件文件（`_meta.orphanCandidates`）
- **循环依赖**：Tarjan SCC 算法（`_meta.cycles`）
- **框架检测**：package.json 依赖含 vue/nuxt → `framework=vue`；含 react → `framework=react`；无前端框架依赖但存在油猴脚本 → `framework=userscript`（纯脚本仓库无需 package.json）

### overlay 路由（可选，自动探测）

项目若使用 overlay 路由体系（`src/routes/overlayGroups/*.ts` + `src/routes/lazyImports/*.ts`，或文件名含 `overlayGroup.ts` / `lazyImports.ts`），自动解析路由条目与跳转边：

- 路由条目：overlay group 文件中含 `id` + `component` 属性的对象字面量
- 组件解析链：`lazyImports.X` → `lazy(() => import(...))` → 目标文件
- 跳转边：`setActiveOverlay/openOverlay('id')` 字面量调用（含 `app.setActiveOverlay` 属性访问形式）

无该体系的普通 React 项目自动跳过，Route 对象为空列表。

### React JSX 声明式路由（react-router v6/v7，自动探测）

项目若使用 `<Routes>/<Route path element>` 声明式路由（如 asdm-admin-web 的 `AppRoutes.tsx`），自动提取（测试文件中的 mock 路由已排除）：

- 路由条目：`<Route path="/x" element={<Page />} />`，嵌套相对路径自动拼接（`/:scopeUid` + `edit` → `/:scopeUid/edit`）、`index` 路由、布局 Route（无 path）下的绝对 children
- 组件解析链：`element={<Guard><Page /></Guard>}` 取最内层组件；`element={layoutElement}`（`createElement` 布局变量）穿透到实际布局组件
- 跳转边：`<Navigate to="/x" />` 字面量重定向，相对 `to` 基于所属路由归一为绝对路径（`to="_overview/summary"` → `/:scopeUid/_overview/summary`）

### Vue 路由（vue-router + 文件路由，自动探测）

- **显式声明**：`router/modules/*.ts` 中 `RouteRecordRaw` 对象（path/name/meta.title/component 动态 import/Layout 函数包装/children 拼接），`component: () => import('@/views/x.vue')` 经别名解析到具体文件
- **文件路由**：`src/views|pages/**/*.vue` 未被显式声明时自动推导（`index.vue` → 父级路径，`[...all].vue` → catch-all）；`<route lang="yaml">` 的 meta（title/name/path）作为路由描述
- **跳转边**：`router.push('/path')` / 解构 `push` / `router.replace` 字面量调用（数组 push 不误报）

### 油猴脚本（Tampermonkey UserScript，自动探测）

独立的 `userScriptAnalyzer` 解析器，与 React/Vue 解析器平级共存、逻辑互不干扰：油猴文件不产出 Component/Store/Route，而是产出 UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction 五类对象（React/Vue 项目内混入的油猴脚本同样被识别，framework 仍以宿主框架为准）。

- **脚本识别**：`.user.js` 扩展名（强信号），或 `.js` 文件头部 4KB 内含 `// ==UserScript==` 元数据块（如 `steam-friend-manager-1.3.12.js`）
- **元数据解析**：`@name/@version/@match/@include/@exclude/@grant/@connect/@require/@resource/@run-at/@noframes` 等字段全量提取（`@grant none` 归零处理）
- **函数使用与逻辑分布**：IIFE 体内顶层函数/箭头函数/类/常量对象（含对象方法 `storage.get`、类方法 `Xxx.render`）作为逻辑单元；每个函数统计行数、GM 调用、DOM 操作、网络调用、监听器、定时器；建立函数间静态调用图（`calls`/`calledBy` 双向）与 IIFE 顶层调用链
- **GM API 审计**：`GM_*` 与 `GM.*`（GM4 风格）两种调用风格统一归一；调用次数/行号统计，并与 `@grant` 声明交叉比对（未声明 → `declared=false`，`@grant none` 下任何调用均标记风险）
- **DOM 注入**：`innerHTML/outerHTML/insertAdjacentHTML/document.write`（含动态插值标记 → XSS 面）、`appendChild/insertBefore` 等挂载（`querySelector` 变量锚点还原目标选择器）、`GM_addStyle`、`document.createElement('style')`、`attachShadow` Shadow DOM
- **请求与劫持**：`GM_xmlhttpRequest`（URL/method 提取 + `@connect` 域名白名单比对）、`fetch`/`XHR.open`/`WebSocket`/`sendBeacon` 调用域名；`window.fetch`、`XMLHttpRequest.prototype.open/send`、`EventTarget.prototype.addEventListener`、`WebSocket`、`history.pushState/replaceState` 原型/全局重写识别为请求劫持
- **沙箱与宿主交互**：`unsafeWindow` 读/写属性区分（写 → 中风险）、`window.X = ...` 全局暴露、`Object.defineProperty(window, ...)`；`__vue__`/`__reactContainer$` 等标记推断宿主框架（vue/react/mixed/unknown）
- **风险清单**：请求劫持、eval/new Function 动态执行、cookie 读写、unsafeWindow 读写、动态插值 HTML 注入、未声明 GM API、未列入 @connect 的请求域名 —— 按 high/medium/low 汇总为脚本级 `riskLevel`

## 已知限制

- 基于 TypeScript Compiler API 的**语法级**解析（不跑类型检查）；动态拼接的 import 与动态 `navigate(path)` 变量导航无法解析
- `renders` 归属文件主组件（default export 优先），同文件多组件不细分
- 函数透传式导航（`onOpenOverlay: app.setActiveOverlay`）不产生跳转边
- Vue 适配覆盖 Vue 3 SFC（`<script setup>`）、Pinia、vue-router、unplugin-vue-router 文件路由与 unplugin-auto-import 隐式导入；Options API 与 Nuxt 专属约定仅部分支持
- 油猴脚本：调用图为脚本内静态调用（变量间接调用/回调透传不解析）；动态拼接的请求 URL 域名记为 `(dynamic)`，不做 @connect 比对；宿主框架仅按代码内 `__vue__`/`__reactContainer$` 等标记推断，未触碰宿主内部的脚本记为 unknown
- 快照为全量重建（无增量）；多进程并发写快照无保护
- `--where` 为全表扫描：`=`/`:` 精确相等、`~` 模糊包含（不支持数值比较，数值过滤请配合 jq）

## 开发

```bash
npm install
npm test          # node --test 单元测试
node src/cli/index.js --help
```

## Roadmap（候选）

- `--where` 数值比较（`lineCount>500`）与索引
- 增量刷新（按 git diff 重新解析变更文件）
- Next.js App Router 路由提取
- props 传递链分析
- 更新日志见 [CHANGELOG.md](./CHANGELOG.md)
