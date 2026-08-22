# aos CLI Vue2 适配计划：props 传递链分析 + 蓝图展示 + 类视图/业务流向

> 版本目标：0.16.0
> 验证仓库：`E:\WorkSource\leaniss-system-core\aise-ui`（Vue 2.6.12 + Vue CLI 4.4.6 + element-ui 2.15.13 + vuex 3.6.0 + vue-router 3.4.9，159 个 .vue SFC，无 TS/JSX，纯 Options API）

> **实施状态（2026-08-22）：全部完成，版本 0.16.0 发布。**
> - 别名修复：vue.config.js configureWebpack.resolve.alias + jsconfig.json paths + vue-cli `@/* → src/*` 兜底；unresolvedImports 261→0
> - 附加修复：产物目录名 `build` 在 `src/` 源码树内不再跳过（RuoYi `src/views/tool/build/` 误伤，6 个 .vue 恢复扫描；node_modules/.git 等恒跳过不受影响）
> - Vue2 链路：vueAnalyzer Options API 解析（props/data/computed/methods/components/storeKeys）+ 模板绑定七类来源分类（vuePropRenders）+ element-ui/原生标签/指令排除 + router-link 静态导航
> - builder：统一 resolveTagToComponent 标签解析（局部注册→导入索引→Vue.component 全局→同文件）+ PropEdge 扩展 .vue + vclass 类视图实体（props 字段/computed+methods 方法/renders 组合边）
> - viewer：类图 renders 边（绿色实线 + arr-rnd marker + 图例/chips）+ propFlow 消费 Vue PropEdge
> - 验证：新增 test/vuePropsChain.test.mjs 8 用例，总计 140 测试全通过；aise-ui 冒烟：198 PropEdge / 519 props（state×269/handler×141/computed×78/literal×27/forward×3）、81 组件 renders、7 Vuex store、162 vclass（207 renders 边）、127 路由 + 2 导航边；nice-today-2.0 回归 414 PropEdge 与基线一致

## 一、Summary（要做什么）

为 aos CLI 增加 **Vue（重点 Vue2 Options API）props 传递链分析**能力并接入现有蓝图展示体系；同时修复 Vue2 项目（aise-ui）在本工具上的四类断点，使以下视图全部可用：

1. **组件数据流 tab（propFlow）**：Vue 模板绑定（`:prop` / 静态属性 / `v-model` / `.sync` / `@event` / `v-bind="obj"`）→ 来源分类 → PropEdge 聚合 → 蓝图展示
2. **实体类图 tab（类视图）**：Vue 组件合成为类实体（props 为字段、computed/methods 为方法、组件组合为 renders 边）
3. **业务数据图 tab**：Vuex 模块检测为 Store 实体（stateKeys/actionKeys）
4. **路由地图 / 业务逻辑流向 tab**：`@` 别名解析修复 + `<router-link to>` 导航边提取

## 二、Current State Analysis（现状与缺口）

### 现有架构（v0.15.0，React 链路完备）

| 环节 | 位置 | 说明 |
|---|---|---|
| JSX 属性收集 | `src/analyzers/tsAnalyzer.js` 425-448 行 | PascalCase 标签属性原文 → pendingPropAttrs |
| 来源分类（词法近似） | `tsAnalyzer.js` 830-902 行 | forward/state/store/handler/computed/literal/spread |
| PropEdge 聚合 | `src/ontology/builder.js` 977-1056 行 | **仅扫描 `.tsx/.jsx`**，组件对聚合，SOURCE_PRIORITY 覆盖，出入度统计 |
| propFlow 模型 | `src/ontology/viewer.js` 849-930 行 | 通用消费 PropEdge；无 PropEdge → null → 2668 行隐藏 tab |
| Vue 文件分析 | `src/analyzers/vueAnalyzer.js` | 仅 Vue3 script setup：splitSfc / extractTemplateTags（→ jsxTags 供 renders）/ countDefineProps（**仅计数**） |
| Vue 路由 | `tsAnalyzer.js` 708-776 行 + `builder.js` 1118-1211 行 | vueRoutes 提取（含 /router/ 目录或导入 vue-router 触发）→ routeType 'vue' Route + 导航边 |
| 实体类图 | `builder.js` collectTypeEntities + `viewer.js` 558-730 行 | 仅 Interface/Class（TS/Rust/Dart），LANG_LABEL 已含 'vue' |

### 针对 aise-ui 的 7 个缺口

1. **`@` 别名断裂**：aise-ui 无 tsconfig/jsconfig，`@`→src 仅在 `vue.config.js` 的 `configureWebpack.resolve.alias`；`importResolver.js` 只读 tsconfig paths → 所有 `@/` 导入 unresolved → renders / 路由 component 解析 / 层间流向全部断裂。
2. **Vue2 props 链缺失**：vueAnalyzer 不解析 `export default { props: {...} }`（对象/数组形式）、不分析模板绑定 → PropEdge=0，组件数据流 tab 隐藏。
3. **组件名匹配断裂**：`import userAvatar from '.../userAvatar.vue'`（camelCase local 名）↔ 组件名 `UserAvatar`；`import CrontabDay from './day.vue'` ↔ 文件派生名 `Day`；且 default 导入记录 `imported:'default'`，`builder.js` 970 行精确名匹配失败 → renders 关系大面积丢失。
4. **全局组件未解析**：`main.js` 中 `Vue.component('Pagination', Pagination)` 等 7 个 + `svg-icon` 全局注册，模板标签无局部注册记录。
5. **Vuex 未检测**：tsAnalyzer stores 仅支持 zustand/pinia → 业务数据图为空（aise-ui 有 7 个 namespaced 模块：app/dict/user/tagsView/permission/settings/dashBoard）。
6. **类视图为空**：Options API 无 class 声明 → 实体类图 tab 隐藏。
7. **导航边缺失**：aise-ui 无 `this.$router.push`（实测 grep 为 0），导航靠模板内 `<router-link to="...">`（静态 + `:to` 动态）→ 未提取。

## 三、Proposed Changes（改动方案）

### 3.1 `src/analyzers/projectScanner.js` — `@` 别名解析

位置：472-485 行 tsconfig 解析之后，合并进 `tsconfigPaths`（仅补充缺失键）：

1. **jsconfig.json**：存在 `jsconfig.json` 时用 `parseTsconfigPaths` 同样解析（Vue CLI 项目惯例）。
2. **vue.config.js 文本解析**（不 require，避免执行副作用/缺失依赖）：正则定位 `alias\s*:\s*{...}` 块，提取 `'键' : 值` 对，值支持三种形式：`resolve('src')`、`path.resolve(__dirname, 'src')`、`'src'`。产出 `键 + '/*'` → `值 + '/*'` 的 paths 条目。
3. **vue-cli 兜底**：存在 `vue.config.js` 且存在 `src/` 目录且仍无 `@` 别名时，默认补 `@/*` → `src/*`。

### 3.2 `src/analyzers/vueAnalyzer.js` — Vue2 Options API + 模板 props 链（核心改动）

新增 `import ts from 'typescript'`（项目已有依赖）。在 `analyzeVueFile` 中，script 块除现有 `analyzeFile` 复用外，追加一次自有 TS 解析：

**A. `parseOptionsApi(scriptContent)` — Options API 选项提取**（`export default {}` / `Vue.extend({})` / `defineComponent({})` 的对象字面量）：
- `props`：对象形式（`{ total: { type: Number, required: true }, value: [String, Object] }`）→ `propsDefs: [{name, type}]`（type 取 `type:` 属性的文本，如 `Number`、`[String, Object]`）；数组形式（`['check', 'cron']`）→ type null。
- `components`：`{ CrontabDay, 'x-y': X }` → `vueComponents` 注册表：`PascalCase(注册键) → 值标识符名`（shorthand 键=值）。
- `data`：函数返回对象（或直接对象）→ `dataKeys`。
- `computed`：对象键 → `computedKeys`；**SpreadAssignment 中 `mapState/mapGetters/mapActions/mapMutations` 调用** → `storeKeys: [{name, module}]`：
  - 对象参数 `{ theme: state => state.settings.theme }`：键为 name，模块名从箭头函数体 `state\.(\w+)` 提取；
  - 数组参数 `['roles','permissions']`：module null；
  - 双参形式 `mapState('app', [...])`：模块名取首参。
- `methods`：对象键 → `methodKeys`。
- Vue3 script setup 兼容：`defineProps` 从"计数"升级为**提取名字**（数组形式字符串 / 对象形式顶层键）填入 propsNames，使 forward 分类对 Vue3 同样生效。

**B. `extractTemplateBindings(template, ctx)` — 模板绑定提取与分类**（正则，不依赖 AST）：

标签匹配：`/<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g`（引号内 `>` 安全）。标签规范化为 PascalCase（复用 `toPascalCase`）；排除：`NATIVE_TAGS`、`VUE_BUILTIN_TAGS`（router-view/router-link/template 等已有集合）、**`el-` 前缀**（element-ui 全局组件，不进传递链）。

属性匹配：`/([@:#A-Za-z_][\w:@.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g`，按名称前缀分流：

| 形式 | 处理 | 产出条目 |
|---|---|---|
| `v-bind="expr"` | spread | `{name: '...'+expr根名, source:'spread'}` |
| `:name.mod="expr"` / `v-bind:name.mod="expr"` | prop（剥离 `.sync` 等修饰符） | name=剥离后属性名 |
| `name="静态值"`（无前缀） | 跳过 DOM/指令属性后 | literal（valueText=静态值） |
| 裸属性（`clearable`） | 同上 | literal（valueText='true'） |
| `v-model="expr"` / `v-model:arg="expr"` | 双向绑定 | name=`v-model`（或 `v-model:arg`） |
| `@event.mod="expr"` / `v-on:event.mod="expr"` | 事件（剥离 `.stop/.prevent/.native` 等修饰符） | name=`@event`，source=handler |
| `v-if/v-else/v-for/v-show/v-html/v-text/v-once/v-pre/v-cloak/v-slot/ref/key/slot/slot-scope/scope/is/#xxx/class/style/id/aria-*/data-*` | **跳过** | — |

**表达式来源分类**（词法近似，与 React 版语义对齐）：
- 字面量（`'...'`、数字、true/false/null）→ `literal`
- 取根标识符（`queryParams.pageNum` → `queryParams`），按序查 ctx 键集：
  1. `propsNames` → `forward`（父组件 props 转发）
  2. `dataKeys` → `state`
  3. `storeKeys` → `store`（storeHook=模块名，无模块则 'vuex'）
  4. `methodKeys` → `handler`
  5. `computedKeys` → `computed`
  6. 兜底 → `computed`（含 `scope.row.x`、`$t(...)`、复杂表达式）
- 事件绑定（`@xxx`）：`getList`（methodKeys 命中）或内联语句 → `handler`
- `valueText`：表达式原文截断 60 字符（同 React 版 trimText 规则）

**C. 产出 facts 新字段**（保持与 jsxPropRenders 同构，分类已在 analyzer 完成）：
```js
facts.vuePropRenders = [{ tag: 'UserAvatar', props: [{name, source, valueText, storeHook}] }]  // 每个标签出现一次（renderCount 语义）
facts.vueComponents = { UserAvatar: 'userAvatar' }   // PascalCase 注册键 → import local 名
facts.vueOptions = { propsDefs, dataKeys, computedKeys, methodKeys, storeKeys }
```
`facts.components[0]` 增强：`propsCount`（Vue2=propsDefs.length，Vue3=defineProps 数）、`propsNames`、`stateCount`（Vue2=dataKeys.length）。

**D. router-link 导航**：模板内 `<router-link to="/path">` 的**静态** `to` → push 进 `facts.overlayOpens`（`{target, pos}`），复用 builder 7c 的 vueRouteOwner 导航边机制（动态 `:to` 含表达式的跳过——路径不可静态解析）。

### 3.3 `src/analyzers/tsAnalyzer.js` — 全局注册 + Vuex 检测 + $router 导航

1. **全局组件注册**：`Vue.component('X', Y)` 调用（CallExpression，expression 为 `Vue.component` PropertyAccess）→ `facts.vueGlobalComponents = [{name:'X', local:'Y'}]`（任何 .js/.ts 文件均收集，main.js 为主源）。
2. **Vuex store 检测**（zustand/pinia 段之后）：条件 = 文件在 `/store/` 目录**或** importMap 含 'vuex'，且 default export（`export default {...}` 或 `export default new Vuex.Store({...})` 取首参）对象含 `state`/`actions`/`mutations` 属性：
   - `stateKeys`：state 对象键（函数则取返回对象键，复用现有 `objectPropKeys` helper）
   - `actionKeys`：actions 键 + mutations 键（合并去重）
   - `name`：文件 stem；`providerType: 'vuex'`；无 state/actions/mutations 的文件（如 store/index.js 仅 modules 接线、getters.js）自动跳过
   - 组件 .vue 的 options 对象无这些键 → 不会误触发
3. **`this.$router.push('/path')`**：PropertyAccessExpression callee 且 `expression.expression.text === '$router'`、`name` 在 `VUE_ROUTER_NAV_METHODS` → 首参字符串字面量 push 进 `facts.overlayOpens`（aise-ui 无此用法，通用性补充；对象参数 `{name:'X'}` 形式不支持，记为已知限制）。

### 3.4 `src/ontology/builder.js` — 解析、聚合与类视图实体

**A. 统一组件标签解析 helper `resolveTagToComponent(relPath, facts, tag, componentsByFile, globalVueComponents)`**（替换现 renders 段与 props 段各自的 localToExport 精确匹配）：
1. 构建导入索引：每个内部 import 的具名项注册**两个键**：`local 名` + `PascalCase(local 名)` → `{file, exported}`；
2. 查 `facts.vueComponents` 注册表（PascalCase 化的 tag → local 名）→ 再查导入索引；
3. 直接查导入索引（`tag` / `PascalCase(tag)`，覆盖 Vue3 script setup 无注册场景）；
4. 命中后取目标文件组件集：`exported === 'default'` → **目标文件 primary 组件**（修复 Vue 默认导入名不匹配）；否则按 exported 名找 → 按 `PascalCase(tag)` 找 → primary 兜底；
5. 全局注册表兜底：`globalVueComponents`（由全仓库 `facts.vueGlobalComponents` 聚合：PascalCase(name) → 该文件导入解析出的目标文件 → primary 组件）；
6. 同文件兜底：fileComps 按名匹配。

**B. renders 关系（948-975 行段）**：改用上述 helper（React 文件行为是超集：新增 PascalCase 键与 default→primary 兜底，不改已有精确匹配语义）。

**C. PropEdge 聚合（977-1056 行段）**：文件过滤从 `.tsx|.jsx` 扩展为"`.tsx/.jsx` 处理 jsxPropRenders、`.vue` 处理 vuePropRenders"；`.vue` 的 fromComponent 固定取文件 primary 组件；tag 经 helper 解析为 to 组件；聚合/优先级/出入度逻辑复用不变。

**D. Vue 组件类视图实体**（renders 段之后、props 段之前插入，避开 916-928 行 dead-code 循环避免误标死代码）：
- 每个 .vue 文件 primary 组件 → Class 实体：`id = uniqueId('vclass:'+name)`、`kind:'component'`、`language:'vue'`、`exported:true`、`fields = propsDefs（name+type）`、`methodIds = computedKeys + methodKeys 生成的 Method 实体（id=vmethod:Comp.key, ownerName=组件名）`、`rendersIds=[]`；推入 `classes`/`methods` 数组（后续 1496 行 archLayer、1599/1615 行 objectCounts/dataMap 自动生效）。
- renders 边回填：组件实体 `rendersIds` → 对应 vclass 的 `rendersIds`（组件 id → vclass id 映射表）。
- 混合仓库（React+Vue）不受影响：vclass 仅由 .vue 文件产生。

### 3.5 `src/ontology/viewer.js` — 类视图 renders 边渲染

1. `entities` 模型（558 行段）：edges 构建追加——遍历 classEntities 的 `rendersIds`，目标在 entityById 内 → `edges.push({from, to, kind:'renders'})`；统计追加 `rendersCount`。
2. `KIND_LABEL` 增加 `component: '组件'`（vclass 的 kind='component' 经现有 `kindOf`/stereo 逻辑自动显示 `«组件»`）。
3. `buildEntitiesSvg`（2360 行段）：
   - defs 增加 `arr-rnd` marker（实线菱形/箭头，绿色系，区别于 implements 虚线青色 / extends 紫色）；
   - 边 path class 三分支：`implements→impl / renders→rnd / 其余→ext`，marker 同步三选一；
   - CSS 增加 `svg.uml path.ge.rnd` 样式（实线、绿色）。
4. 图例（2615 行段）追加 `renders（实线箭头）`；类图面板标题统计追加 renders 边数（>0 时）。
5. propFlow 无需改动（模型已通用消费 PropEdge）。

### 3.6 测试 `test/vuePropsChain.test.mjs`（新增，沿用 propsChain.test.mjs 的 mkdtemp 临时目录 fixture 模式）

1. Options API 提取：props 对象/数组/混合形式、data/computed/methods 键、components 注册表、mapState 对象+数组形式的 storeKeys（模块名提取）
2. 模板绑定分类：七类 source 各至少一例（forward/state/store/handler/computed/literal/spread）+ v-model + `.sync` + 静态属性 + 裸属性
3. PropEdge 聚合：Vue 父传子边 `prop:Parent→Child`、props 内容、renderCount
4. 组件解析：camelCase 默认导入（userAvatar→UserAvatar）renders + PropEdge；显式 components 注册键（CrontabDay→day.vue 的 Day）；main.js `Vue.component` 全局注册解析
5. Vuex：store/modules/user.js → Store 实体（stateKeys/actionKeys/providerType 'vuex'）；store/index.js（仅 modules）不产出
6. 别名：vue.config.js 项目 `@/` 导入 internal 解析成功
7. 类视图：vclass Class 实体（fields/methodIds）+ renders 边 + viewer 模型 rendersCount
8. router-link 静态 to → 路由导航边（navigatesToIds）
9. 回归保护：Vue 文件无 PropEdge 时 propFlow 仍 null；既有 132 个测试全部通过（propsChain.test.mjs React 行为不变、vueAnalyzer.test.mjs 现有断言不变）

### 3.7 文档与版本

- `package.json` → 0.16.0；`CHANGELOG.md` 新增 0.16.0 条目
- `README.md`：Vue2 支持章节（props 传递链、模板绑定分类表、类视图组件实体、Vuex 检测、vue.config.js 别名、已知限制：动态 `:to` 不解析导航、对象参数 router.push 不支持）
- `.trae/documents/aos-roadmap-routes-props.md`：追加 M4（v0.16.0）里程碑并标记完成

## 四、Assumptions & Decisions（假设与决策）

1. **`@event` 事件计入传递链**（source=handler，name 形如 `@pagination`）：与 React 版"回调即 props"语义对齐，展示子→父回调流向；element-ui 等外部组件标签不解析，天然排除。
2. **v-model 记为名为 `v-model` 的传递项**（不展开为 value prop + input event）：展示语义更直观。
3. **类视图 = 实体类图 tab**：Vue 组件是 Vue2 项目的"类"，合成为 kind='component' 的 Class 实体 + renders 组合边；与 propFlow tab 的分工——类视图看成员结构+组合关系，组件数据流看 props 明细。
4. **业务流向 = 路由地图（vue-router 路由+导航边）+ 层间导入流向（别名修复后自动可用）+ 业务数据图（Vuex Store 实体）**。
5. **mixins 注入的键不在键集内** → 模板引用落 computed 兜底（词法近似的固有限制，可接受）。
6. **el- 前缀标签硬排除**（element-ui 全局组件）；其他 npm 组件（treeselect/count-to）因导入解析为 external 自然排除。
7. Vue3 script setup 文件同样产出 vuePropRenders（defineProps 名字提取后 forward 分类生效；ref/computed 变量名不深挖，落 computed 兜底），保证 steam-stat 等已有项目只增强不回归。

## 五、Verification（验证步骤）

1. **单元测试**：`npm test`（或项目既有测试命令）全量通过 = 132 既有 + 新增 vuePropsChain 用例。
2. **冒烟（临时 Node 脚本，用后删除——遵循项目既有约定，PowerShell JSON 参数转义不可靠）**：
   ```js
   // tmp-smoke.mjs：const { buildOntologyData } = await import('./src/ontology/builder.js');
   // const d = buildOntologyData('E:/WorkSource/leaniss-system-core/aise-ui', { roots: ['src'] });
   ```
   校验指标：
   - `@/` 别名生效：files 的 unresolvedImports 总数接近 0（改前全量 @/ 导入 unresolved）
   - 路由：vueRoutes 派生 Route ≥ 30（constantRoutes 30+ 与 dynamicRoutes 8）
   - PropEdge：数量非 0，来源分布合理（state/computed/handler 为主），抽查 `prop:User→UserAvatar`、`prop:Index→UserAvatar` 等
   - renders：非 0（修复 camelCase/CrontabDay 匹配后）
   - Store：= 7（vuex 模块）且 providerType='vuex'
   - Class：含 ~159 个 vclass 实体（kind='component'，language='vue'），renders 边非 0
   - 导航边：router-link 静态 to（如 /login、/register）→ navigatesToIds 非空
3. **端到端蓝图**：临时脚本 `saveSnapshot(dataMap)` 到 `aise-ui/.nice-aos/data` → 在 aise-ui 目录执行 `nice-aos export --format html` → 生成 blueprint.html → `nice-aos serve` 人工核验：组件数据流 tab 出现且边表/SVG 正常、实体类图 tab 出现且含 «组件» 框与 renders 实线边、业务数据图含 7 个 vuex store、路由地图 vue 路由树与导航边正常。
4. **回归冒烟**：对既有验证项目（nice-today-2.0 React / steam-stat Vue3 / next-web-app）重跑 buildOntologyData 冒烟，确认 PropEdge/renderCount 等指标不回退。
5. 清理临时脚本与临时快照目录，更新文档后收尾。

## 六、实施顺序

1. 3.1 别名（独立、无依赖，先解锁 aise-ui 的导入解析）
2. 3.2 vueAnalyzer（Options API + 模板绑定）
3. 3.3 tsAnalyzer（全局注册/Vuex/$router）
4. 3.4 builder（helper + renders + PropEdge + vclass）
5. 3.5 viewer（类视图 renders 边）
6. 3.6 测试 → 3.7 文档版本 → 五、验证
