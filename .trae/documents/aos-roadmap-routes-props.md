# aos 后续更新规划：路由链体系增强 + Props 传递链分析

> 版本路线：v0.13.0（路由数据层）→ v0.14.0（路由地图视图）→ v0.15.0（Props 传递链）
> 参考项目：Next.js App Router = `E:\WorkSource\steam-py\steam-workspace\next-web-app`；React SPA = `E:\WorkSource\nice-today-2.0\src`；Flutter = `E:\WorkSource\keylol_discourse_app\flutter`

> **实施状态（2026-08-22）：三个里程碑全部完成。**
> - M1 → 0.13.0：nextAppAnalyzer（App Router 页面/API/layout 链）+ Link 导航边 + dartAnalyzer 原生 routes 表与 pushNamed 跳转边；122 测试通过
> - M2 → 0.14.0：viewer「路由地图」标签页（导航链 SVG/路径层级树/域分组/全量清单）+ routeMap 视图模型 + exporter 列扩展；125 测试通过
> - M3 → 0.15.0：tsAnalyzer props 七类来源分类 + builder PropEdge 组件对聚合 + passesProps 链接 + overlay factoryProps + viewer「组件数据流」标签页 + exporter 章节；132 测试通过；nice-today-2.0 冒烟 414 边/434 组件/1120 props，next-web-app 冒烟 3 边（服务端组件为主，如实稀疏）

---

## 一、概述

本次规划落地三项能力，按「数据层 → 展示层 → 新分析维度」顺序拆为三个里程碑：

| 里程碑 | 内容 | 对应需求 |
|---|---|---|
| M1 (v0.13.0) | Next.js App Router 路由提取 + Next 导航边 + Flutter 原生路由（MaterialApp routes 表 + pushNamed） | 需求 1 + Flutter 参考 |
| M2 (v0.14.0) | 「路由地图」新标签页：路由树/域分组 + 导航链 SVG 图（覆盖全部 routeType，含 overlay 体系的层级推断） | 需求 3 的展示层 |
| M3 (v0.15.0) | React Props 传递链分析（PropEdge 对象体系）+ 「组件数据流」新标签页 + overlay props 工厂链 | 需求 2 |

用户已确认的范围决策：Props 仅 React（不含 Vue template 属性分析）；Flutter 原生路由纳入；展示采用两个新增独立标签页。

---

## 二、现状分析（代码探索结论）

### 2.1 路由体系现状

- 路由分析集中在 `src/analyzers/overlayAnalyzer.js`：`analyzeOverlayRoutes()`（自研 overlayGroups/lazyImports 体系，即 nice-today-2.0 的形态）与 `analyzeJsxRoutes()`（react-router v6/v7 `<Routes>/<Route>`）。
- `builder.js` 第 7/7b/7c/7c-b 节分别合并 overlay+react、Vue Router、Flutter GoRoute 路由；Route 节点含 `routeType`（`overlay|react|vue|flutter`）、`navigatesToIds`（导航边）、`backTarget`、`hidesNav` 等字段。
- **导航边已有数据但无可视化**：`navigatesToIds` 仅在 `exporter.js:139` 导出为 markdown 边表，`viewer.js` 完全未渲染；路由在「领域蓝图」详情中只是扁平列表（`viewer.js:1064 renderDomainDetail`）。
- **Next.js 无路由提取**：仅在 `projectScanner.js` 检测 `deps.next` → framework `next`，`.next` 构建目录已排除；`scan.framework` 字段可用。
- **Flutter 仅支持 GoRoute**：keylol 项目用原生 `Map<String, WidgetBuilder> routes` 表 + `Navigator.pushNamed`，当前提取不到。dartAnalyzer 走「注释剥离 + 正则」通道（无 Dart AST），GoRoute 的 builderWidget 构造调用提取正则可复用。
- tsAnalyzer 的导航收集：`<Navigate to>`（react-router）、`setActiveOverlay` 系列、`useRouter()` 声明变量 + `router.push/replace`（pendingNavCalls 机制，**对 next/navigation 的 useRouter 同样生效，无需改动**）。`<Link href>`（next/link）未收集。

### 2.2 Props / 组件关系现状

- Component 对象有 `propsCount`（解构参数个数）、`rendersIds`（仅 primary 组件、仅标签名级：`facts.jsxTags` 只存 PascalCase 标签集合，**不存属性**）。
- overlay 路由有 `hasPropsFactory` 布尔标记，但**不提取工厂产出的 props 名**。
- 无任何 props 传递链 / 组件级数据流对象与展示。

### 2.3 参考项目形态要点

- **next-web-app**（Next 16 + React 19，App Router）：6 个静态 page（全部 `'use client'`）、1 个根 layout、无动态路由/路由组/route.ts/middleware；页面跳转全靠 `<Link href="/library">` 字面量；`@/*` 别名指向项目根。
- **nice-today-2.0**（React 19 SPA）：自研 overlayRegistry（12 个 overlayGroups 域注册表 + lazyImports 懒加载），`props: (app) => ({...})` 工厂注入是 App → 页面组件的主干 props 通道；Zustand store + 组件内 useState 并存。
- **keylol**（Flutter 3 + BLoC）：`lib/config/router.dart` 顶层 `routes` Map（13 条，箭头与块体两种 builder，含 `ModalRoute.of` 取参），导航用 `Navigator.of(context).pushNamed('/x')` 与 `pushReplacementNamed`。

### 2.4 基础设施约定

- 测试：`node:test`，`test/*.test.mjs`，临时目录 fixture 模式（`fs.mkdtempSync`），当前 115 个。
- 快照入口：`buildOntologyData()`（`builder.js:487`）由 `nice-aos action refreshRepo` 触发；蓝图 HTML 由 `nice-aos export --format html` 生成。
- SVG 文字必须显式设置 fill 适配深色背景（v0.12.0 UML 黑字教训，`svg.uml` 复合选择器写法）。

---

## 三、M1（v0.13.0）：路由数据层增强

### 3.1 新建 `src/analyzers/nextAppAnalyzer.js`

导出 `analyzeNextAppRoutes(projectRoot, scan, resolver, factsMap)`，返回与 overlayAnalyzer 输出同构的 raw 路由数组。

**app 目录定位**：从 `scan.files` 中匹配 `^(src/)?app/.+/(page|layout|route)\.(tsx|jsx|ts|js)$`；`app` 与 `src/app` 同时存在时取含 page 文件者；两者皆无 → 返回 `[]`。

**约定文件识别与 URL 计算**（目录相对 appDir 的路径段逐段处理）：

| 形态 | URL 处理 | 说明 |
|---|---|---|
| `page.tsx` | 所在目录 → 路由 | routeType `'next'` |
| `route.ts` | 所在目录 → API 路由 | routeType `'next-api'` |
| `layout.tsx` | 不生成路由 | 记入后代路由的 `layoutFileIds`（外→内） |
| `(group)` | 段剔除 | 保留在 `rawPath` 供树展示 |
| `@slot` | 段剔除 | 平行路由 slot |
| `_private` | 整目录跳过 | 不产出路由、不递归 |
| `[id]` | → `:id` | `isDynamic: true` |
| `[...slug]` | → `:slug*` | catch-all |
| `[[...slug]]` | → `:slug?` | optional catch-all |

- `routePath` = 归一化 URL（`/` + 段 join，根为 `/`）；`rawPath` 保留原始目录串。
- `overlayId` = `routePath`（API 与 page 不同目录不会冲突）。
- `componentFile` = page/route 文件自身；`componentRef` = 该文件 facts 的 default export 名。
- `isClient`：page 文件文本匹配 `/^\s*['"]use client['"]/m`。
- `apiMethods`：route.ts 中导出的 `GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS` 函数名数组（从 facts.exportSymbols 过滤）。
- `layoutFileIds`：沿目录向上收集各层 `layout.tsx`（含根 layout）的相对路径数组。
- `domain`：routePath 首个非参数段；`':x'` 或空 → `'root'`。
- 特殊文件 `loading/error/not-found/template/global-error`：记入所在目录路由的 `specialFiles` 数组，不生成路由对象。

### 3.2 builder.js：新增 7e 节（Next 路由合并 + 导航边）

位置：7c-b Flutter 节之后。当 `scan.framework === 'next'` 时调用 `analyzeNextAppRoutes`，复用现有合并模式（`componentsByFile` 取 primary 组件 id、`uniqueId('route:...')`、push 进 routes、`comp.routeIds` 回填）。Route 对象在现有字段基础上新增：`rawPath`、`layoutFileIds`、`specialFiles`、`isDynamic`、`isClient`、`apiMethods`（其余 routeType 置 null/[] 保持 schema 一致）。

**导航边**：构建 `routePath → routeId` 映射；遍历 next **page 文件**的 `facts.overlayOpens`（Link href / router.push 已由 tsAnalyzer 收集，见 3.3），target 以 `/` 开头且命中映射 → 加入该路由的 `navigatesToIds`。layout 与共享组件文件中的导航调用 v1 不归属（避免边爆炸，记入 README 后续优化项）。

### 3.3 tsAnalyzer.js：收集 `<Link href>`

在 JSX 元素处理分支（现 `Navigate` 检测旁，`tsAnalyzer.js:388-398`）增加：`tag.text === 'Link'` 且 `facts.importMap.get('Link') === 'next/link'` 时——

- href 为 StringLiteral → `facts.overlayOpens.push({ target, pos })`；
- href 为对象字面量 → 提取 `pathname` 字符串属性值（忽略 query/hash）。

`useRouter().push('/x')` 已由现有 `routerVarDecls + pendingNavCalls` 机制覆盖（`next/navigation` 与 `vue-router` 同名 API），实施时用测试验证即可。

### 3.4 dartAnalyzer.js：原生路由 + pushNamed

1. **routes Map 提取**（commentsOnly 通道，模式仿 `extractGoRoutes`）：
   - 匹配 `Map<String, WidgetBuilder> routes = {`（变量名任意，`final/const/var` 可选前缀），平衡花括号扫描取 map 体；
   - 条目 `'/path':` 的值取 builder Widget：箭头体 `(context) => const XxxPage()` 与块体 `(context) { ... return XxxPage(...); }`，复用 `parseGoRouteArgs` 的「最后一个大写构造调用」正则提取 `builderWidget`；
   - `facts.dartRoutes.push({ path, name: null, builderWidget, native: true })`。
2. **pushNamed 导航收集**：扩展现有 navRe（`dartAnalyzer.js:379`）：
   - 方法集追加 `pushNamed|pushReplacementNamed|popAndPushNamed|restorablePushNamed`；
   - 新增 `).method(` 形式分支，覆盖 `Navigator.of(context).pushNamed('/x')`（现有正则仅匹配 `identifier.method` 形式，即 `Navigator.pushNamed(context, '/x')`）；
   - 产出 `kind: 'nav'` 调用 → 现有 facts.overlayOpens 转换链路（`dartAnalyzer.js:530/556`）与 builder 7c-b 的边构建逻辑**零改动复用**。

### 3.5 M1 验证

- 新增 `test/nextRoutes.test.mjs`：临时项目含根 page（`'use client'` + 2 个 Link）、`dashboard/page`、`shop/[id]/page`、`(marketing)/about/page`、`api/items/route.ts`（GET+POST）、根/嵌套 layout、`_lib/page.tsx`（应被忽略）。断言：路由数、路径归一（`/shop/:id`、`/about`）、layoutFileIds 链、isClient、apiMethods、Link 导航边、domain。
- 新增 `test/dartNativeRoutes.test.mjs`：routes Map（箭头 + 块两种 builder）+ `Navigator.of(context).pushNamed` + `Navigator.pushNamed` 两种形式。断言：dartRoutes 提取、Route 生成、导航边挂接。
- 全量 `npm test` 回归；对 next-web-app 与 keylol\flutter 真实项目跑 `action refreshRepo`，检查 snapshot 中 Route 数量（预期 6 条 next / 13 条 flutter-native）与导航边。
- README/CHANGELOG 更新，版本 0.13.0。

---

## 四、M2（v0.14.0）：「路由地图」标签页

### 4.1 viewer.js：模型层

`buildViewerModel()` 新增 `routeMap` 数据块：

- 统计：`total`、`byType`（overlay/react/vue/flutter/next/next-api 各计数）、`dynamicCount`、`apiCount`、`navEdgeCount`、域分布；
- `routes[]`：`{id, path, routeType, domain, isDynamic, isApi, isClient, layoutChain（文件路径数组）, specialFiles, backTarget, hidesNav, navigatesTo（path 数组）, componentFile, factoryPropsCount}`；
- `tree`：URL path 体系（next/vue/flutter）按 `/` 段递归建树（动态段节点带标记）；overlay/react 体系按 domain 一级分组（各含路由列表）；
- `layers`（overlay 体系层级推断，满足「按内部组织方式推断路由链」）：`backTarget === 'home'` 或无嵌套 routePath → 顶层；其余 → 深层；供 SVG 分列布局。

### 4.2 viewer.js：渲染层

1. tab 栏（`viewer.js:919-924`）在「领域蓝图」后插入 `<div class="tab" data-tab="route">路由地图</div>`；无路由时经现有 `hideTab()`（`viewer.js:1966`）隐藏。
2. 新增 `renderRouteMap()`（前端即时渲染，模式仿 `renderData()/renderFlow()`）：
   - **概览卡片行**：路由总数、各类型徽章计数、动态/API/导航边数；
   - **路由树面板**（HTML 嵌套列表）：段名节点（动态段橙色高亮、路由组段灰色斜体）、叶节点显示类型徽章 + `isClient`（C/S 标记）+ `hidesNav`/`backTarget` 小标签 + 跳转目标 chips（点击跳转对应路由节点）+ layout 链 tooltip；
   - **overlay/react 域分组面板**：按 domain 分组的路由清单（路径 + 类型徽章 + 层级标记 + navigatesTo chips + factoryProps 数量徽章）；
   - **导航链 SVG** `buildRouteGraphSvg(g)`：复用 `buildScriptGraphSvg`（`viewer.js:1408`）的 SVG 构建模式做分层布局——按 `layers`/domain 分列，节点 = 路由（domain 着色、标签为 path），实线箭头 = navigatesTo、虚线 = backTarget 指向（'home' 画合成 home 锚点）；>120 节点时顶部提供域筛选 select；节点点击高亮关联边。
   - **CSS**：新增 `.route-tree` 样式与 `svg.route text { fill: var(--fg, #dfe6f3) }` 系列显式填充（吸取 UML 黑字教训）。
3. `exporter.js`：「路由地图」表格增加 routeType / isDynamic / layout 链列；导航边表自动覆盖新 routeType。

### 4.3 M2 验证

- `test/viewer.test.mjs` 增补：routeMap 统计正确、`renderViewerHtml` 输出含 `data-tab="route"`、空路由时 tab 隐藏、`buildRouteGraphSvg` 节点/边数量与标签。
- 三个参考项目 export HTML 人工检查：next-web-app 树形结构、nice-today-2.0 域分组 + 导航链分层、keylol 路由 + pushNamed 边；确认 SVG 文字在深色背景可读。
- 版本 0.14.0，CHANGELOG 更新。

---

## 五、M3（v0.15.0）：Props 传递链分析 + 「组件数据流」视图

### 5.1 tsAnalyzer.js：新增 facts

1. `jsxPropRenders: [{tag, pos, props: [{name, kind, valueText}]}]` —— 遍历 PascalCase JSX 标签的 `attributes.properties`：
   - `JsxAttribute` + StringLiteral/NumericLiteral → `kind: 'literal'`；
   - `JsxAttribute` + JsxExpression → `kind: 'expr'`，`valueText` = 表达式文本截断 60 字符；
   - `JsxAttribute` 无 initializer → `kind: 'bool'`；
   - `JsxSpreadAttribute` → `kind: 'spread'`，valueText = 表达式文本（不展开成员）。
2. `useStateVars: [{name, pos}]` —— `const [x, setX] = useState(...)` 取首元素名。
3. `hookVarDecls: [{hookName, varNames[], pos}]` —— callee 匹配 `/^use[A-Z]/`（排除 useRouter）且 parent 为 VariableDeclaration 时，记录 Identifier 名或 ObjectBindingPattern 元素名（覆盖 zustand `useXxxStore`、useContext、useQuery 等）。
4. `components[].propsNames: string[]` —— 组件首参 ObjectBindingPattern 元素名（`propertyName ?? name`，跳过 rest）。

### 5.2 overlayAnalyzer.js：props 工厂提取

entry 的 `props: (app) => ({...})` 箭头体为对象字面量时，取属性名（PropertyAssignment / ShorthandPropertyAssignment）→ raw 路由新增 `factoryProps: string[]`；builder 路由合并处透传到 Route 对象（`Route.factoryProps`）。

### 5.3 blueprint.js + builder.js：PropEdge 对象体系

1. `OBJECT_TYPES` 新增 `{ type: 'PropEdge', prefix: 'prop:', category: 'CodeUnit', level: 'L1 单元层', description: '组件间 props 传递边（含来源分类）' }`；`LINK_TYPES` 新增 `'passesProps'`（总览 tab 的类型清单与 objectCounts 自动带出）。
2. builder 新增构建节（第 6 步 renders 关系之后）：
   - 将现有 renders 的 `localToExport` 映射构建抽为可复用函数；
   - 对每个 tsx/jsx 文件的 `jsxPropRenders`：按 pos 落入 `facts.components` 声明范围定位父组件（无则跳过）；tag → 目标文件+导出名 → 目标 compId；
   - **来源分类**（对每个 prop）：valueText 为 identifier 且 ∈ 父组件 `propsNames` → `'forward'`；∈ 组件范围 `useStateVars` → `'state'`；∈ 组件范围 `hookVarDecls.varNames` → `'store'`（记录 hookName）；含 `=>` → `'handler'`；literal → `'literal'`；其余 → `'computed'`；
   - 按 `(fromCompId, toCompId)` 聚合去重（同名 prop 取更具体 source，优先级 forward > state > store > handler > computed）；
   - PropEdge：`{ id: 'prop:<from>→<to>', fromComponentId, toComponentId, fromFileId, toFileId, props: [{name, source, storeHook?}], renderCount }`；
   - Component 增加 `propInCount` / `propOutCount`；snapshot 顶层新增 `PropEdge` 数组与 `_meta.objectCounts.PropEdge`。
3. 实施检查点：排查 `query.js` / `link.js` / `serve.js` 中对象类型枚举，确保 PropEdge 可查询/统计（若为白名单式需同步加入）。

### 5.4 viewer.js：「组件数据流」标签页

1. `buildViewerModel` 新增 `propFlow` 块：`total`、`sourceDist`（六类来源计数）、`topOut/topIn`（出入度 Top 组件）、`edges[]`（含双端组件名/域/props/renderCount）、`nodes[]`（参与边的组件及度数）。
2. tab 栏「业务数据图」后插入 `data-tab="props"`「组件数据流」；无 PropEdge 时 `hideTab`。
3. `renderPropFlow()`：
   - 概览卡片 + 来源分类图例（forward=父转发 / state=本地状态 / store=状态库 / handler=回调 / literal=字面量 / computed=计算值）；
   - SVG `buildPropsFlowSvg()`：节点 = 组件（domain 着色、尺寸∝连接数）、边 = PropEdge（边中点标签 = props 数）；默认渲染度数 Top 80 组件，提供域筛选 + 名称搜索；点击节点高亮全部出入边并在侧栏列出 props 明细（名称 + 来源徽章 + storeHook）；
   - 「路由地图」的路由条目同步显示 `factoryProps.length` 徽章（overlay 主干链：App → 工厂 → 页面组件）。
4. `exporter.js` 新章节「Props 传递链」：边表（来源组件/文件、目标组件/文件、props 数、来源构成）+ 高扇入组件 Top 20。

### 5.5 M3 验证

- 新增 `test/propsChain.test.mjs`：fixture Parent.tsx（useState + 解构 props + `useItemsStore()` 解构 + 五类 prop 传值 + spread）渲染跨文件导入的 Child；断言 PropEdge 生成、六类来源分类、propIn/OutCount；overlay fixture 断言 `factoryProps`。
- nice-today-2.0 真实项目冒烟：PropEdge 数量合理、SettingsOverlay 入边含 profile/useAIInterpretation 等 props、SettingsOverlay 自身出边（转发给子组件）正确。
- next-web-app 冒烟：layout → Provider → page 的 Context 链不产生 PropEdge（Context 非 props，符合预期）、page → 业务组件 props 边存在。
- 版本 0.15.0，CHANGELOG/README 更新。

---

## 六、假设与决策

1. Props 分析仅 React（用户确认）；Vue template 组件属性分析留待后续版本。
2. Flutter 原生路由纳入 M1（用户确认）；dartAnalyzer 沿用注释剥离 + 正则通道，不引入 Dart AST 依赖。
3. 新增两个独立标签页（用户确认）：「路由地图」（route）、「组件数据流」（props）。
4. Next.js 仅支持 App Router，不解析 `pages/` 旧目录体系与 `next.config` 的 rewrites/redirects（参考项目未使用；记入 README 限制说明）。
5. layout / 共享组件文件内的 Link 导航调用 v1 不归属到具体路由（避免边爆炸），仅 page 文件内生效；overlay 体系中非路由文件（如 App.tsx）的 `setActiveOverlay` 维持现状不生成边，层级改由 backTarget/hidesNav 推断展示。
6. PropEdge 来源分类为词法近似（组件声明范围 + 文件级变量表），非作用域精确分析；spread props 不展开成员。
7. API route（route.ts）以 routeType `'next-api'` 呈现，无组件关联（componentId 为 null）。
8. 每里程碑独立发版（0.13.0 / 0.14.0 / 0.15.0），均要求：单测全绿 + 真实项目冒烟 + CHANGELOG/README 更新。

---

## 七、总体实施顺序

1. **M1**：nextAppAnalyzer.js → tsAnalyzer Link 收集 → dartAnalyzer 原生路由/pushNamed → builder 7e 节 → 测试 → 冒烟 → 0.13.0
2. **M2**：viewer routeMap 模型 → renderRouteMap + buildRouteGraphSvg + CSS → exporter 列扩展 → 测试 → 三项目冒烟 → 0.14.0
3. **M3**：tsAnalyzer 四项 facts → overlayAnalyzer factoryProps → blueprint/builder PropEdge → viewer propFlow + renderPropFlow → exporter 章节 → 测试 → 冒烟 → 0.15.0

各里程碑完成后向用户展示真实项目的蓝图截图/数据摘要，确认效果再进入下一里程碑。
