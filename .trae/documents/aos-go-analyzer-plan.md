# aos CLI Go 语言解析器计划：实体映射 + CLI 命令树 + HTTP 路由 + 前后端逻辑映射

> 版本目标：0.17.0
> 参考项目：Go CLI/代理类 = `E:\WorkSource\smartide\cli`（cobra + viper，161 个 .go / 22,497 行）；前后端融合 = `E:\WorkSource\leaniss-oneapi`（Gin + GORM 后端 222 个 .go / 18,881 行 + React 18 前端 3 主题 web/default|air|berry，前端 API 调用散在组件 `API.get('/api/xxx')`）
> 范围决策：**不做** Java 后端（该仓库实际无 Java）与 Python Flask 微服务（oneapi-service，留待后续）；本期专注 Go 解析 + 前端↔Go 后端映射

> **实施状态（2026-08-22）：全部完成，版本 0.17.0 发布。**
> - goAnalyzer 轻量语法级解析器落地（双通道噪声剥离：全剥离供块状态机 / 保字符串供字面量提取），与 ts/vue/rust/dart 平级
> - 实体：112/244 struct（两仓库）、interface、646/1224 Method、796/994 调用边、goOrphanMethods 同包跨文件方法回填、`Go 包 = 目录` 语义
> - cobra 命令树：smartide/cli 24 条命令链（16 一级 + host×4 + k8s×2，最大深度 3）+ 孤儿 `help` 命令（从未 AddCommand，死代码信号）
> - gin 路由：oneapi 124 条（43 动态段、全带中间件链），handler 关联 Method；前后端映射 45 条路由命中前端调用（三主题），未匹配 4 条如实暴露
> - 验证：新增 12 用例（goAnalyzer.test.mjs + goFrontendMap.test.mjs），总计 152 测试全过；nice-today-2.0 回归 414 PropEdge / 831 Component 与基线一致

> **实施状态（2026-08-22 追加）：0.18.0 完成 Go 五盲区修复 + 项目根目录识别优化。**
> - 五盲区（参考 smartide-server / smartide-agent 的 gin-vue-admin 形态）：子目录 go.mod 发现（framework=go 判定 + 依赖并入）、zap.Any 日志调用误报路由（router 变量白名单）、handler 字段链间接引用（`baseApi := v1.ApiGroupApp...BaseApi` → handlerChain 子树搜索）、前端 axios 配置对象形态 httpCalls（`service({url, method})`）、深链调用链（`pkgchain` 链长 ≥3 边类型）
> - 根识别：siblingProjects 兄弟项目发现（git/workspace 根定位 + 自身路径排除）、Go module 上级发现（goModule.dir='..' 折叠解析）、代码集合目录依赖并入防误吸附（无 .git / 无根清单 / >4 子项目只报告）
> - 验证：新增 7 用例（scanner 4 + goFrontendMap 2 + goAnalyzer 1），总计 170 测试全过；smartide-server 冒烟 96 路由 / 92 handler 解析 / 76 前端命中 / zap 零误报；oneapi 与 aise-ui 回归与基线完全一致

## 一、Summary（要做什么）

为 aos CLI 新增 **goAnalyzer**（轻量语法级解析器，与 rustAnalyzer/dartAnalyzer 平级同构），使 Go CLI / agent 代理类项目与「Go 后端 + 前端」融合项目可生成完整分析蓝图：

1. **实体映射**：Go `struct` → Class（含 json/yaml tag 字段）、`interface` → Interface、方法/顶层函数 → Method、package/目录 → Module、go.mod require → Dependency（registry=go）
2. **CLI 命令树**（cobra）：`var xxxCmd = &cobra.Command{Use:...}` + `rootCmd.AddCommand(xxxCmd)` → Route（routeType=`go-cli`，routePath=`smartide new` 式命令链），路由地图展示命令层级
3. **HTTP 路由**（Gin/标准库）：`router.Group("/api")` 前缀累积 + `.GET("/path", handler)` → Route（routeType=`go`，apiMethods + middlewares + handler 关联 Method），含 `:param` / `*wildcard` 动态段
4. **逻辑走向**：包级函数跨文件调用链（`pkgAlias.Func()` → Method.callIds/calledByIds，复用 Dart callEdges 聚合模式）+ 方法体内调用
5. **前后端逻辑映射**（oneapi 核心价值）：tsAnalyzer 提取前端 `API.get/post/put/delete('/api/...')`、`axios.x()`、`fetch()` 调用 → 与 Go Route 路径匹配（`:param` 通配、去 query、尾斜杠归一）→ Route.frontendCalls + 「未匹配前端调用」清单（发现死接口/路径漂移）

## 二、Current State Analysis（现状与接入点）

### 现有架构（v0.16.0）

| 环节 | 位置 | Go 接入方式 |
|---|---|---|
| 文件扫描 | projectScanner.js:6-16 `SOURCE_EXTENSIONS` / `SKIP_DIRS` | 加 `.go`；`vendor/`、`testdata/` 加入 SKIP_DIRS |
| 框架检测 | projectScanner.js:412-430 `detectFramework` | 加 go.mod 存在检测 → `framework='go'` |
| 解析分发 | projectScanner.js:506-521 按扩展名三元链 | 加 `.go → analyzeGoFileFromDisk` 分支 |
| 实体合成 | builder.js:117-257 `collectTypeEntities` 统一消费 `facts.interfaces/classes/moduleFunctions` | Go facts 按同构字段产出即可，无需新模板 |
| 调用链聚合 | builder.js:810-870（Dart callEdges → Method.callIds/calledByIds/compCallIds） | Go callEdges 走同一段逻辑或并列小段 |
| 路由合成 | builder.js:1343-1439（Dart GoRoute → Route） | goRoutes/goCliCommands 并列小段 |
| 视图模型 | viewer.js:601 `LANG_LABEL`、:784 routeMap `TYPE_ORDER` | 加 `go: 'Go'`；TYPE_ORDER 加 `'go'`、`'go-cli'` |
| 导出 | exporter.js:34-65 项目概览表 | 加「Go 文件」行 + Go 依赖章节 |
| importResolver | importResolver.js:76-139 | **不改**：Go import 由 goAnalyzer 自解析（module 前缀判定 internal/external），不走通用 resolver（URL 风格与 npm 路径语义不同） |

### 两个参考项目的关键形态（决定解析规则）

**smartide/cli（cobra CLI）**：
- 命令注册：`cmd/root.go:144-205` init() 内 `rootCmd.AddCommand(newCmd)` 批量注册；根命令 `var rootCmd = &cobra.Command{Use: "smartide", ...}`
- 叶子命令：`cmd/new.go:39` `var newCmd = &cobra.Command{Use: "new", Short: ..., Run: func(...)...}`；`cmd/new.go:149` init() 注册 Flags（`newCmd.Flags().StringP("type","T",...)`）
- 跨包导入带别名：`cmdCommon "github.com/leansoftX/smartide-cli/cmd/common"`、`coreV1 "k8s.io/api/core/v1"`（别名 or 路径末段作 local 名）
- struct 方法：`func (w WorkspaceInfo) IsNil() bool`（值/指针接收者均有）
- 语法面：goroutine/channel/类型断言/json+yaml tag（595 处）/32 个 init()/匿名内嵌 struct 字段；**无泛型**（Go 1.17）
- 无 HTTP 服务端路由

**leaniss-oneapi（Gin 后端 + React 前端）**：
- 路由：`router/api.go:13` `apiRouter := router.Group("/api")` → `:34` `userRoute := apiRouter.Group("/user")` → `:36` `userRoute.POST("/register", middleware.CriticalRateLimit(), middleware.TurnstileCheck(), controller.Register)`；分组前缀链在单文件内累积；`router/relay.go:23` 含 `:channelid/*target` 动态段；`router/web.go:22` 静态托管（不计入）
- 入口：`main.go:26` `router.SetRouter(server, buildFS)`（main.go 标记 isEntry）
- 调用链：`controller/user.go:208 SearchUsers` → `model/user.go:53 GetAllUsers`（controller→model 直连，无 service 层）
- 前端调用：`web/default/src/components/ChannelsTable.js:81` `API.get('/api/channel/?p=' + page)`、`:272` `API.get('/api/channel/test/' + id)`；API 实例封装于 `web/default/src/helpers/api.js`（axios.create）；**无集中常量文件，路径散在组件**
- 依赖：go.mod `require` 段；module = `github.com/songquanpeng/one-api`（internal 判定前缀）

## 三、Proposed Changes（改动方案）

### 3.1 `src/analyzers/goAnalyzer.js`（新文件，核心，~700 行）

导出 `analyzeGoFile(relPath, content, projectRoot)`（内存版，供测试）与 `analyzeGoFileFromDisk(relPath, projectRoot)`（读盘版，供 scanner）。轻量语法级：深度状态机 + 大括号配对（同 rust/dart 惯例），不依赖 tree-sitter/gopls。

facts 结构（对齐 rust/dart 惯例）：

```js
{
  language: 'go',
  packageName: 'workspace',          // package 声明（Go 目录级包名）
  goModuleName: null,                // projectRoot 下 go.mod 的 module（扫描时传入或 builder 统一持有）
  imports: [                         // 标准 facts.imports 形态，供文件 importIds/unresolved
    { specifier: 'github.com/x/cli/pkg/common', alias: null,
      resolved: null, isTypeOnly: false,
      names: [{ local: 'common', imported: '*' }] }   // Go 整包导入，local = alias || 路径末段
  ],
  interfaces: [{ name, line, exported, extendsNames: [], methods: [...], language: 'go' }],
  classes: [{ name, line, exported, kind: 'struct', derives: [], fields: [{name, type, tag}], variants: [],
              implementsNames: [], extendsName: null, methods: [...], language: 'go',
              pos, end, isStore: false }],
  moduleFunctions: [...],            // 顶层 func（含 init/main）→ ownerKind=module
  goCommands: [...],                 // cobra 命令：{ varName, use, short, file, line }
  goCommandEdges: [...],             // { parentVar, childVar }（AddCommand 调用对）
  goRoutes: [...],                   // gin：{ method, path, handlers: ['controller.Register'], middlewares: ['CriticalRateLimit'] }
  callEdges: [...],                  // { fromFunc, toKind: 'pkg'|'local'|'method', toPkg, toName, receiverType }
}
```

**A. 基础语法解析**

1. **package/import**：`package x` 行；import 分组块 `import ( ... )` 与单行 import；`alias "path"` 别名提取（smartide 的 `cmdCommon "..."` 形态）
2. **type 声明**：
   - `type X struct {` → Class（kind=struct）；字段解析 `Name Type \`json:"x"\``：tag 提取进 field.tag；匿名内嵌字段（如 `sync.Mutex`）记 name=类型末段；匿名内嵌 struct 字面量（oneapi 的 `Data struct {...}`）取 tag 或字段名为 name，type 记 'struct'
   - `type X interface {` → Interface；方法签名行（`Name(args) ret`）提取为 methods
   - `type X = Y` / `type X Y`（别名/定义）→ 跳过（低价值，避免噪声）
3. **func 解析**：
   - `func (r *T) Name(args) ret {` → Method（ownerKind=class，ownerName=T，剥离 `*`；值接收者 `(w WorkspaceInfo)` 同理）
   - `func Name(args) ret {` → 顶层函数（ownerKind=module）；`func init()` / `func main()` 特殊标记
   - exported = Name 首字母大写（Go 可见性惯例）
   - 方法体行数统计（lineCount，同 dart）
4. **方法体调用提取**（callEdges，正则 + 接收者变量表，词法近似）：
   - 包级调用 `\b(\w+)\.(\w+)\(`：若第一段是本文件导入的包 local 名（别名优先）→ `toKind='pkg'`（builder 全局解析目标包的顶层函数）
   - 本文件函数调用 `\b(\w+)\(`（排除关键字 if/for/return/defer/go/make/new/len 等）→ `toKind='local'`
   - 方法调用 `x.Method(`：文件级接收者变量表（`x := pkg.NewT(...)` / `x := &T{...}` / `var x T`）→ 推断类型 → `toKind='method'`（builder 端与同类型 Class 的同名 Method 关联）
   - defer/go 前缀剥离后照常提取

**B. cobra CLI 命令（goCommands / goCommandEdges）**

- `var (\w+Cmd) = &cobra\.Command\{` 块内提取 `Use: "new"`（取首 token）、`Short: "..."`（截断 80 字符）
- `(\w+)\.AddCommand\((\w+)\)` → 边（parentVar→childVar），init() 内外均扫
- Flags 注册（`newCmd.Flags().StringP("type","T",...)`）→ `flags: [{name, shorthand}]` 附在命令上（展示用）

**C. Gin/标准库 HTTP 路由（goRoutes）**

- 变量前缀表（文件内）：`(\w+)\s*:?=\s*(\w+)\.Group\("([^"]+)"\)` → varName 的前缀 = 父 var 前缀 + path（链式累积，支持 `apiRouter.Group("/user")`）
- 路由注册：`(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\("([^"]*)"(,\s*[^)]+)*\)` → 完整路径 = 前缀表[varName] + path；参数列表逐个解析：`middleware.Xxx()` → middlewares；`controller.Xxx` / `relay.Xxx`（非调用形态）→ handlers
- 标准库兜底：`http.HandleFunc("/path", handler)` 同样进 goRoutes（method=GET）
- 动态段 `:id` / `*target` 保留原样（builder 标记 isDynamic）
- 噪声控制：`router.Use(static.Serve(...))`、`router.NoRoute(...)` 不产路由；Group 前缀变量表仅在含路由注册的文件生效

### 3.2 `src/analyzers/projectScanner.js`

1. `SOURCE_EXTENSIONS` 加 `'.go'`；`SKIP_DIRS` 加 `'vendor'`, `'testdata'`（Go 惯例产物/测试目录；`bin`/`pkg` 已有 `build`/`target` 类似物，Go 的 pkg 为模块缓存不进仓库，`bin` 加入）
2. go.mod 检测：`fs.existsSync(path.join(projectRoot,'go.mod'))` → 读取 module 名与 require 列表（轻量文本解析：`module x` 行、`require (` 块内 `path v1.2.3` 行）→ 产出 `goModule: {name, goVersion}` 与 `goDeps: [{name, version}]` 挂在 scan 结果
3. `detectFramework` 参数加 `goDetected`（go.mod 存在且 .go 文件数 > 0）→ 返回 `'go'`（排在 flutter/dart 检测之后、npm deps 之前；混合仓库 leaniss-oneapi 根有 go.mod + web/ 子目录 package.json —— framework 主体判 go，前端文件仍各自解析）
4. 文件计数加 `counts.go`；`frameworkLabel` 映射 `go: 'Go'`
5. 分发链（506-521）加 `.go` 分支调 `analyzeGoFileFromDisk`；同时把 `scan.goModule` 传入（供 import internal/external 判定）

### 3.3 `src/ontology/builder.js`

1. **分发**：解析入口加 `.go` 分支；facts 消费对齐现有段落
2. **类型实体**：`collectTypeEntities` 天然消费（interfaces/classes 带 language='go'）；Method 合成时 Go 的 `isAsync=false`、`signature` 取参数+返回文本（截断 120）
3. **架构层 archLayer**（对齐现有层定义，Go 目录信号表）：
   - `main.go` / `cmd/` → entry（无 entry 层则映射现有对应层，实施时对齐 builder 现有 archLayer 取值集合后微调）
   - `router/` / `controller/` / `middleware/` → presentation
   - `model/` / `dal/` / `relay/`（数据/适配）→ service/data（按现有层命名）
   - `pkg/` / `common/` / `internal/` → 按现有 util/common 层
4. **Dependency**：goDeps → Dependency 对象（`dep:` id，version、scope='require'、registry='go'）；import 的 specifier 不以 goModule.name 开头且不在 goDeps → 标 unresolved（罕见）
5. **import internal 解析**：Go import path = `{module}/{dir...}` → 内部文件相对路径 = 去 module 前缀后的目录；一个 package 目录多文件 —— importIds 关联到目录级 Module（而非单文件）；`resolved: {kind:'internal', file}` 取该 package 目录主文件（字母序首个），unresolvedImports 仅在目录不存在时记录
6. **Go 调用链聚合**（并列 Dart 段 810-870 之后）：
   - 第一遍：全仓收集 `packageName → relPath[]` 映射（目录级；包名冲突时目录前缀消歧——仅报第一个命中，词法近似可接受）
   - `toKind='pkg'`：`pkgLocal.Func` → 目标 package 内名为 Func 的 moduleFunction → Method.callIds/calledByIds
   - `toKind='local'`：同文件 moduleFunction
   - `toKind='method'`：receiverType 的 Class 的同名 Method
7. **cobra 命令树 → Route**（并列 Dart GoRoute 段）：
   - 根命令：varName 为 `rootCmd`（或无父边的命令）→ 根名取 module 名末段（`smartide-cli` → `smartide`；oneapi 无 cobra 则无此段）
   - 树遍历 goCommandEdges 拼路径：`smartide new`、`smartide k8s start`
   - Route：`routeType='go-cli'`、routePath=命令链（空格分隔）、name=Use、Short 进 notes、flags 序列化进 specialFiles 字段复用（或 notes 内文本，避免新字段）—— **决策：flags 拼进 notes 文本**（`flags: -T/--type, -o/--host`），不加新字段
   - Run 函数名 → componentRef（`newCmd.Run` 无法静态定位到具体函数——Run 是内联闭包，跳过 component 关联）
8. **gin 路由 → Route**：
   - `routeType='go'`、routePath=完整路径、apiMethods=[method]（Any → 全方法，记 ['*']）、isDynamic（含 `:` 或 `*` 段）
   - handlers[0] → componentRef（如 `controller.Register`）；解析 `controller` 包 → 该包内 `Register` 函数 Method → 关联到 Route（复用 Dart 的 componentId 机制：Method 而非 Component，componentFileId 指向 handler 所在文件）
   - middlewares → Route 新字段 `middlewares: []`（快照为 JSON 无强 schema，viewer 端容错读取）
   - domain 按路由文件目录推断（router/ 下文件级）
9. **前后端映射**（新段，置于 Route 合成后）：
   - tsAnalyzer 产出的 `facts.httpCalls`（见 3.4）汇总 → 逐条 normalize：去 `?query`、去尾 `/`、字符串拼接/模板串取静态前缀（`'/api/channel/test/' + id` 与 `` `/api/user/${id}` `` 均取前缀）
   - 匹配：分段比对，后端段 `:x`/`*x` 通配前端任意段；命中 → `Route.frontendCalls.push({fileId, filePath, line, method})`；前端 method 与后端 apiMethods 不一致时仍记录（详情可见 mismatch）
   - 未命中 → builder 产出 `unmatchedFrontendCalls`（挂 dataMap 顶层 meta 或 Project 扩展字段——**决策：挂 `dataMap._meta.unmatchedFrontendCalls`**，viewer/exporter 消费）
   - 匹配范围：仅 routeType='go'（以及未来其他后端路由）；React 前端组件→API 的调用者信息保留在 frontendCalls.filePath

### 3.4 `src/analyzers/tsAnalyzer.js`（前端 HTTP 调用提取）

新增 facts 字段 `httpCalls: [{method, path, line}]`，提取模式（限定字符串字面量首参）：
- `API.get/post/put/delete/patch('...')`（axios 实例命名惯例 API/api/axios/request —— 取 `^API$|^api$|^axios$|^request$` 标识符 + HTTP 动词方法）
- `axios.get/post/put/delete('...')`、`fetch('...')`
- `API.get('/x/' + id)` / `` API.get(`/x/${id}`) `` → 取静态前缀
- 仅相对路径（以 `/` 开头）计入；完整 URL（http://）跳过
- 行号记录；node_modules 外的 src 文件均扫（前端三个主题目录都覆盖）

### 3.5 `src/ontology/viewer.js`

1. `LANG_LABEL` 加 `go: 'Go'`；语言分布图 Go 配色（gopher 蓝 `#00ACD7`，加入 byLanguage 颜色映射）
2. `KIND_LABEL` 复用现有 `struct: '结构体'`（Go struct kind=struct 天然命中）
3. routeMap：
   - `TYPE_ORDER` 加 `'go'`, `'go-cli'`；类型配色：go=天蓝 `#58b6ff`、go-cli=灰蓝 `#8b949e`
   - 路由详情面板：go 类型显示 method/handler/中间件链/前端调用方清单（文件:行）；go-cli 显示命令链/Short/flags
   - 路径层级树：go-cli 类型按**空格**分段（其余类型按 `/`）
   - 统计卡加「前后端映射」（有 frontendCalls 的 Route 数）与「未匹配前端调用」（_meta.unmatchedFrontendCalls 数）——仅存在 go 路由时显示
   - Route 清单表：go 类型行显示 method + 前端调用数列（有映射时）
4. logicFlow：Go 文件的 import 流向进入现有矩阵（internal package 目录间依赖）；callEdges 已由 Method 体系承载，类图/方法详情天然可见
5. entities 类图：Go struct/interface 自然进入（language='go' 节点着色）

### 3.6 `src/ontology/exporter.js`（markdown）

1. 项目概览表加 `['Go 文件', proj.goFileCount ?? 0]`
2. 路由表：go 类型显示 method（复用 apiMethods 列）；go-cli 显示命令路径
3. 新增「前后端 API 映射」章节（存在 go 路由 + frontendCalls 时）：匹配路由清单（路径/method/handler/前端调用文件数）+ 未匹配前端调用清单
4. 依赖章节：Go 依赖（registry=go）计入依赖统计

### 3.7 测试 `test/goAnalyzer.test.mjs` + `test/goFrontendMap.test.mjs`（新文件）

内联 Go 代码 fixture（沿用 rust/dart 测试模式）：

**goAnalyzer.test.mjs**（~8 用例）：
- struct/interface/method 提取（tag 字段、指针/值接收者、exported 大写判定、匿名内嵌）
- import 别名/local 名（`cmdCommon "..."`）；go.mod module 前缀 internal/external 判定（builder 级）
- cobra 命令：var+Use+Short 提取、AddCommand 树、多级命令路径拼接（root→k8s→start）
- gin 路由：Group 前缀链累积、多中间件、`:param`/`*wild` 动态段、Any 全方法、NoRoute/Use 排除
- 调用链：包级调用（跨文件）、本文件调用、接收者类型推断（`x := pkg.NewT()` → 方法调用）
- go.mod require → Dependency；init() 函数提取
- builder 级：Module（目录/package）、archLayer 目录信号、isEntry（main.go）
- viewer 级：LANG_LABEL/TYPE_ORDER 扩展、路由地图渲染（mock DOM）

**goFrontendMap.test.mjs**（~3 用例）：
- tsAnalyzer httpCalls 提取（API.get/axios.post/fetch、模板串前缀、query 剥离、拼接截断）
- builder 匹配：精确匹配、`:id` 通配、尾斜杠归一、method mismatch 仍记录
- 未匹配清单产出 + viewer/exporter 渲染标记

### 3.8 文档与版本

- README：标题/描述加 Go；解析能力加「Go（轻量语法级）」章节（struct/interface/method/cobra/gin/调用链/go.mod/前后端映射）；对象表 Class/Method/Route 行补 Go 来源说明；viewer 表路由地图/实体类图补 Go 语义；已知限制加 Go 段
- CHANGELOG 0.17.0 条目
- 本计划文档标记实施状态（沿用 roadmap 惯例）
- package.json 0.17.0

## 四、Assumptions & Decisions

1. **轻量语法级自研解析器**（不依赖 tree-sitter/gopls）：遵循 rust/dart 惯例；Go 语法面窄（两参考项目均无泛型），可行性高
2. **CLI 命令复用 Route 实体**（routeType='go-cli'）：路由地图已有 6 类型多态支持，语义同为「用户可触达行为入口」；不新建 CliCommand 对象类型（避免 19+1 种对象类型膨胀）
3. **前后端映射挂在 Route.frontendCalls + 路由地图增强展示**，不新建独立 tab：Route 是映射天然锚点，工程量与信息密度最优；匹配统计（映射数/未匹配数）进路由地图统计卡
4. **前端 httpCalls 提取限定 `API/axios/fetch/request` 标识符 + 字符串字面量首参**：覆盖 oneapi 三主题实际形态；变量拼接 URL 取静态前缀（词法近似，与项目现有 props 分类近似哲学一致）
5. **importResolver 不改**：Go import 由 goAnalyzer 自解析（module 前缀判定），URL 风格语义与 npm/tsconfig paths 不同，不污染通用 resolver
6. **Python Flask / Java 不做**：oneapi-service 极小（2 文件）且与本次 Go 目标正交，留待后续；本仓库实际无 Java
7. **go-cli 命令的 Run 闭包不做函数级关联**（内联匿名函数无法静态锚定），componentRef 留空，命令树本身即分析价值
8. **gin 检测不设框架门槛**：`.go` 文件内 Group/GET/POST 模式即提取（routeType 标记来源，误报可在蓝图按类型过滤）
9. **Method mismatch（前端 method ≠ 后端注册 method）仍记录映射**：详情可见，不静默丢弃（路径命中即有映射价值）

## 五、Verification（验证步骤）

1. **单测**：新增 2 个测试文件 ~11 用例全过；全量回归（现有 140 + 新增）零失败
2. **冒烟 smartide/cli**：`node tmp-smoke.mjs`（临时脚本，用后删）核验——
   - 161 个 .go 全扫（vendor 无）；struct/interface/Method 数量级合理（接口 ~6、struct 数十、方法数百）
   - cobra 命令树：root 17 个一级命令（init/start/new/stop/remove/version/list/get/host/reset/update/config/login/logout/connect/k8s...）+ k8s 子命令层级
   - 跨包调用链非零（cmd→internal/biz→pkg 常见链）
   - go.mod 依赖清单完整（cobra/viper/gorm/k8s...）
3. **冒烟 leaniss-oneapi**：
   - 222 个 .go 全扫；gin 路由数（api.go+relay.go+dashboard 等，预计 60-100 条）、`:id`/`*target` 动态段、中间件链（CriticalRateLimit/TurnstileCheck/AdminAuth）
   - 前后端映射：`/api/channel/` ↔ ChannelsTable.js、`/api/user/` ↔ UsersTable.js 等已知对（探索报告 12 组样例抽验 ≥8 组命中）；未匹配前端调用清单合理（少量动态路径）
   - 前端三主题（default/air/berry）httpCalls 均提取
   - React 前端原有指标不回归（组件数/路由数不变）
   - 蓝图端到端：`export --format html` 生成 blueprint.html，路由地图含 go 路由 + 前后端映射统计；实体类图含 Go struct
4. **回归**：aise-ui（Vue2）/ nice-today-2.0（React）指标与 0.16.0 基线一致（PropEdge 198/414 等）

## 六、实施顺序

1. goAnalyzer.js 基础语法（package/import/type/func）+ 单测
2. projectScanner 接入（.go/go.mod/framework/分发）+ go.mod 依赖
3. builder 类型实体 + Module/archLayer + 调用链聚合 + 单测
4. cobra 命令树 + gin 路由 → Route + 单测
5. tsAnalyzer httpCalls + builder 前后端映射 + 单测
6. viewer（LANG_LABEL/TYPE_ORDER/路由地图增强）+ exporter
7. 全量回归 + 双项目冒烟 + 蓝图端到端
8. README/CHANGELOG/版本 0.17.0
