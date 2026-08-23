# 更新日志

本项目的所有重要变更均记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.21.0] - 2026-08-23

### 新增

- **部署配置目录分析（`nice-aos deploy`）**：扫描项目部署目录（如 `./deploy`），解析五类配置文件——docker-compose（`.yml`/`.yaml`）、K8s manifest（Deployment/Service/Ingress/ConfigMap/Secret/Job/CronJob）、Dockerfile（`Dockerfile*`）、nginx 配置（`nginx.conf`/`*.conf`）、环境文件（`.env`/`*.env`）与部署 shell 脚本，产出独立部署架构模型快照（`deploy-snapshot.json`，SHA-256 manifest 支持增量扫描）
- **服务归一化与跨文件合并**：compose 多文件（override/分环境）与 K8s manifest 定义的同名服务自动合并（名称归一化：小写 + 下划线转连字符；优先取首个非空值，数组字段取并集）；`${VAR:-default}` 镜像插值解引用取默认值，registry/版本 tag 提取兼容私有仓库长路径
- **服务类型识别与部署分层**：12 类服务类型（网关/前端/后端/适配器/任务/数据库/缓存/对象存储/搜索引擎/注册中心/可观测/CI-CD/工具，角色型模式优先于技术栈模式，`init`/`fixperms`/`flyway` 归任务层）+ 9 层部署分层（接入/前端/应用服务/适配器/任务/数据/可观测/CI-CD/工具）
- **nginx 路由与 upstream 解析**：`location → proxy_pass` 路由提取（含 upstream 名与服务名直连两种解析路径）、upstream server 列表解析、`auth_request`/websocket 标记；外部 https 目标识别
- **依赖推导**：三类依赖边——compose `depends_on`（启动依赖）、环境变量 URL 引用（`env_ref`，如 `SPRING_DATASOURCE_URL` 指向 mysql）、网关路由（`route`）；DFS 循环依赖检测与断链（引用不存在服务）检测
- **中间件识别**：MySQL/Redis/MinIO/Elasticsearch/Nacos/PostgreSQL 等 6+ 类中间件从镜像名识别（版本 tag 提取），自动推导消费方列表
- **5 大审计场景（`deploy audit`）**：安全审计（latest 镜像标签/明文敏感值/端口暴露/无鉴权路由）、高可用审计（健康检查缺失/探针/副本数/资源限额）、配置一致性审计（环境漂移——同名变量跨环境值不一致）、依赖审计（断链/循环依赖）→ 综合健康评分（加权四维，A-E 等级）
- **部署蓝图 deployoverview HTML（`deploy export --format html`）**：自包含 8 Tab——部署拓扑（分层卡片）/ 服务清单（搜索+类型过滤+详情展开：镜像/端口/探针/依赖/环境变量脱敏）/ 路由地图 / 依赖图谱（SVG 可缩放）/ 中间件矩阵（版本+消费方）/ 环境配置（变量统计+漂移对比）/ 文件清单 / 健康审计（评分仪表盘+Top 问题）
- **CLI**：`deploy scan`（全量/增量/`--exclude` 排除子目录）、`deploy query`（services/routes/upstreams/dependencies/middleware/environments/files/layers 8 类 + `--where` 过滤）、`deploy audit`（health/security/resilience/consistency/dependency/all）、`deploy export`（json/html/viewmodel）；全局 `--deploy-snapshot-dir` 选项
- **部署分析 Skill**（`skills/nice-aos-deployment-skill/SKILL.md`）与 **油猴 AI 助手部署智能体**：blueprint-ai-agent 自动检测 `#deploy-viewer-data` 页面并启用「部署蓝图」智能体（12 个专属工具：部署统计/服务查询/服务详情/路由/上游/依赖/中间件/环境/文件/分层/健康度/审计明细）

### 验证

- asdm-admin/deploy 冒烟：137 个部署文件 → 51 服务 / 33 路由 / 43 upstream / 52 依赖 / 6 中间件 / 9 分层 / 0 解析错误；健康评分 74（C），检出真实问题（compose 引用不存在服务、K8s latest 镜像标签、明文敏感值）
- leaniss-system-core/deploy 冒烟：29 个部署文件 → 19 服务 / 15 路由 / 5 中间件（MySQL/Redis/Milvus/Nacos 等）/ 0 解析错误；健康评分 85（B）；增量扫描复用验证通过
- 油猴智能体工具逻辑对导出 HTML 内嵌 JSON 全链路模拟验证：12 工具全部正确返回

### 增强（0.21.0 验证轮）

- **extra_hosts 外部目标识别**：compose `extra_hosts` 声明的主机名（如 `aise-smartanswer-web:%{{ADDR}}%`）视为网关静态映射的集群外服务，nginx 路由目标命中时标记 `externalHost`（原为未解析 null）
- **container_name 别名解析**：compose 服务的 `container_name`（容器网络 DNS 主机名，如服务 `jenkins` 的 `asdm-jenkins`）纳入名称解析表，nginx 路由 / upstream / 环境变量 URL 引用均可通过别名解析到所属服务
- 效果：leaniss 路由 15/15 全部有归属（12 服务 + 3 外部），依赖审计 88→100；asdm-admin `/_jenkins/` 路由与 `asdm-jenkins` upstream 正确解析到 jenkins 服务，未解析路由 2→1（仅剩真实未定义的 `asdm-portal`）
- **蓝图扫描时间本地化**：部署蓝图与数据库蓝图头部的"扫描于"时间由 ISO UTC 原文（`2026-08-23T00:30:48.328Z`）改为本地时间格式（`2026-08-23 08:30:48`），与代码蓝图的 `fmtLocalTime` 行为对齐

## [0.20.0] - 2026-08-23

### 新增

- **MySQL 迁移脚本目录分析（`nice-aos db`）**：Flyway 标准布局与 Sprint 非标准布局自动检测（`--layout`）、多数据库（`USE` 语句上下文跟踪、连字符库名 `[\w-]+`）、mysqldump 兼容（DROP+CREATE 表对按 DROP 先序处理防误删）、视图/触发器/存储过程解析、幂等 DDL 支持
- **数据库模型**：表/列/主键/外键/索引/迁移历史/领域分组/模式特征（软删除/审计字段/多租户/自引用/UUID 主键/复合主键/JSON 列），独立快照 `db-snapshot.json` 支持 SHA-256 增量扫描
- **7 大审计场景（`db audit`）**：健康度 / 迁移影响 / 领域依赖 / 索引优化 / 模型演进 / 外键链路 / 命名规范
- **数据蓝图 dataoverview HTML（`db export --format html`）**：8 Tab——SVG ER 关系图（领域分组+缩放平移）/ 表清单 / 外键关系 / 迁移时间线 / 建模特征 / 健康总览 / 演进分析 / 索引优化
- **数据库分析 Skill** 与 **油猴 AI 助手双智能体**（结构分析 + 数据概览，`#db-viewer-data` 页面自动检测）
- **CLI**：`db scan`（`--incremental` / `--all-files` / `--exclude`）、`db query`、`db audit`、`db export`；全局 `--db-snapshot-dir`

### 验证

- 120 迁移文件 / 82 表 / 33 外键 / 242 索引项目：健康评分 95，7 审计全过，HTML 8 Tab 正常
- leaniss-system-core/deploy/1.mysql：80 文件 / 106 表 / 6 数据库，非标准布局识别正确

## [0.18.2] - 2026-08-22

### 新增

- **数据路由 element 包装函数调用解析**：`element: withSuspense(X)` / `element: withPlatformGuard(X, 'platform')` / `createElement(Fn)` 等 HOC 包装形态——取第一个组件参数（Identifier 或 JSX）递归解析（steam-game-hub-2.0 惯例，43 条路由中 37 条使用）
- **数据路由 `<Navigate to>` 重定向提取**：element 内直接 `<Navigate to="/x" replace />`（index 兜底 / catch-all `*`）→ 路由导航边；`*` 相对 path 与父路径拼接为 `/*`
- **NavLink 常量成员引用解析**：数据驱动侧边栏 `{ path: ROUTES.DASHBOARD }` 形态——同文件 `const X = { KEY: '/value' }` 对象表解析 + named import 跨文件轻量解析（读模块文件 const 对象表，支持 .ts/.tsx/.js/.jsx/index.* 扩展探测）

### 验证

- 新增 `test/jsxRoutes.test.mjs` 用例（包装函数调用 / Navigate 重定向 / catch-all / 跨文件常量引用），总计 172 测试全过
- steam-game-hub-2.0（pnpm monorepo，Tauri + React）冒烟：494 文件 / 43 路由全部关联组件（41 组件 + 2 Navigate 重定向）/ 每路由 36 条侧边栏导航边（Steam + PS 导航组全集）；packages/* 6 个子包全部纳入；`../steam-client` workspace 根外条目正确不越界
- steam-game-library 回归：28/28/28（路由/关联/导航边）与基线一致

## [0.18.1] - 2026-08-22

### 新增

- **React Router 6.4+ 数据路由解析**（`createBrowserRouter` / `createHashRouter` / `createMemoryRouter`）：`[{ path, element, index, children }]` 对象树 → Route 实体，与既有 `<Routes>/<Route>` JSX 形态平级共存；`index: true` 以父路径产出，子级相对 path 与父路径拼接，有 `children` 的布局对象自身不产出（与 JSX 无 path 布局同语义）；`element` 解析支持 JSX / 括号包裹多行 JSX / 裸标识符，组件引用三级解析——import 引用 → `lazy(() => import('../pages/X'))` / `React.lazy` 包装变量（含 `.then((m) => ...)` 命名导出链，`import()` 经 ImportKeyword 识别）→ 本地包装函数（return JSX 最深组件递归展开）
- **`<NavLink to>` 导航边提取**（react-router）：字符串字面量与 `{ pathname: '/x' }` 对象形态计入 overlayOpens；**数据驱动侧边栏兜底**——`to={item.path}` 动态引用时提取同文件常量表（NAV_ITEMS 数组）中全部 `{ path: '/xxx' }` 字符串值为导航目标
- **布局外壳导航闭包**：数据路由布局对象的 componentFile 及其直接 import 的内部文件（如 Sidebar.tsx）的导航调用并入全部子路由的导航边——侧边栏导航对所有子页面可达

### 修复

- **数据路由 element 括号包裹**：`element: (\n <Suspense>...</Suspense>\n )` 多行 JSX 为 ParenthesizedExpression 包裹，此前组件解析返回 null——逐层剥离括号后解析

### 验证

- 新增 `test/jsxRoutes.test.mjs` 用例（数据路由端到端 + NavLink 字面量/动态兜底/非 react-router 排除），总计 172 测试全过
- steam-game-library 冒烟：Route 0 → 28（全部关联组件文件，`/` → LibraryPage.tsx 等 28 个页面全部建立路由地图条目与导航边，每页 27 个侧边栏可达目标）；既有 JSX 路由项目回归无变化

## [0.18.0] - 2026-08-22

### 新增

- **Vue 3 `<script setup>` 变量域解析**：setup 块内 `ref/shallowRef/reactive/shallowReactive/customRef/toRef` 声明 → state 键、`computed()` 调用 → computed 键、函数声明与 const 函数表达式 → method 键、`storeToRefs(...)` 解构名与 store 实例变量（`const userStore = useUserStore()`）→ store 键；store hook 命名兼容 `useXxxStore`（Pinia 官方惯例）与 `xxxStore`（snowy 的 globalStore/keepAliveStore 等）双形态，`storeToRefs(store)` 变量参数可溯源到真实 hook 名；变量域统一进入模板绑定 props 来源分类（此前 script setup 组件的 props 全被误判为 computed）与 vclass 类视图实体输入（stateCount 真实计数）
- **Store providerType 字段与展示**：Zustand（`zustand`）/ Pinia（`pinia`）/ Vuex（`vuex`）Store 实体携带 providerType；viewer「业务数据图」Store 卡片与单元清单、exporter Markdown 表格新增 provider 类型徽章/列
- **异步组件与路由 const 懒加载包装统一解析**：`const X = defineAsyncComponent(() => import('./x.vue'))`（Vue3 setup 惯用，unplugin-auto-import 场景无 import 记录不校验来源）与路由文件顶层 `const X = () => import(...)` 包装变量统一进组件解析索引——模板标签正常建立 renders 关系与 Props 传递边，路由 component 引用关联目标组件文件
- **Vite 动态注册死代码豁免**：`import.meta.glob(['/src/views/**.vue', '!/src/views/auth/**.vue'])` 模式采集（含 `!` 排除段、相对路径模式归一），命中文件豁免孤儿候选；vite.config.mjs 的 `unplugin-vue-components` `dirs`（自动注册组件目录）与 `unplugin-auto-import` `dirs` 目录内文件同样豁免（词法近似解析 vite 配置，`r('src/components')` 形式支持）
- **`<script setup name="X">` 组件命名**：vite-plugin-vue-setup-extend 的 name 属性优先于文件名派生（defineOptions 仍最高优先）
- **Ant Design Vue 排除**：`a-` 前缀标签（a-table/a-button 等）不进组件标签集与 props 传递链，与 element-ui `el-` 前缀同规则

### 修复

- **单行 SFC template 块丢失（定义性 bug）**：`splitSfc` 的 template 闭合配对正则误用行首锚定（`/^<(\/?)template\b/gm`），`<template>…</template>` 同行的单行 SFC 闭合标签不在行首导致 template 块整体丢失（无标签集、无传递链、无导航边）；改为非锚定配对（嵌套 template 深度计数不受影响）
- **路由组件关联断裂**：vue-router 路由文件中 `component: ClientLogin` 引用顶层 const 懒加载包装时无法定位目标 .vue 文件（此前仅支持内联 `() => import(...)`），路由地图出现无组件文件的路由条目
- **Go 解析五盲区（gin-vue-admin 形态对齐，参考 smartide-server / smartide-agent）**：
  - **子目录 go.mod 识别**：融合仓库（`server/go.mod` + `web/` 前端）根目录无 go.mod 时 framework 误判——从 `.go` 文件所在目录逐级向上发现全部 go.mod（多模块并存取源码最多者为主），Go 依赖并入、`goModule.dir` 记录所在目录
  - **`zap.Any` 等日志调用误报路由**：任意 `.Any("error", err)` 形态被误判为 gin 路由注册——引入 router 变量白名单（`gin.Engine`/`gin.RouterGroup` 类型变量与函数参数、`gin.New/Default` 产物），非 router 变量上的 HTTP 方法调用不产路由
  - **handler 字段链间接引用**：gin-vue-admin 惯例 `baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi` 后 `userRouter.POST("register", baseApi.Register)` 的 handler 无法关联 Method——字段链变量表展开为完整 `handlerChain`，链首 import 别名定位目标包子树内同名方法（纯分组目录如 `api/v1` 无直下文件时按子树搜索）
  - **前端 axios 配置对象形态调用丢失**：gin-vue-admin 前端 `service({ url: '/user/register', method: 'post', data })` 不产 httpCalls（此前仅支持 `service.get(...)` 方法形态）——封装实例（`@/utils/request` 导入的 axios 实例）配置对象字面量的 `url`/`method` 属性提取为前端调用并参与路由匹配
  - **深链调用链丢失**：`service.ServiceGroupApp.SystemServiceGroup.UserService.RegisterUser()` 形态的链长 ≥3 限定调用（链首为 import 包别名）不进调用链——`pkgchain` 边类型在目标包子树内按末段方法名搜索（词法近似）
- **项目根目录识别优化（定位任意目录均可分析）**：
  - **兄弟项目发现（siblingProjects）**：定位子项目目录（`web/`）或代码子目录（`web/src`）时，向上定位仓库根（`.git` / `go.work` / `pnpm-workspace.yaml` / `lerna.json` / `nx.json`，上限 4 层）后识别同级项目清单；普通目录（无仓库标记）不吸附邻居，只报告不并入扫描范围与依赖
  - **Go module 上级发现**：定位 Go module 子目录（如 `server/api`）时向上发现 go.mod（`goModule.dir` 以 `..` 相对形态表达），goResolver 以 `path.resolve` 折叠基准目录计算 import 目标——internal 文件边、路由 handler 关联、跨包调用链在子目录定位下全部正确
  - **依赖并入防误吸附**：无 `.git`、无根清单且子项目超过 4 个的「代码集合目录」（如工作区下并排放置的多个独立项目）只报告 subProjects 不并入依赖清单，避免框架误判与依赖污染

### 验证

- 新增 `test/vue3SetupFixes.test.mjs`（8 个用例）：script setup 变量域收集与七类来源分类（含 setup name 属性、storeToRefs 解构、vueOptions 扩展键集）、snowy 形态 store hook（无 use 前缀 + storeToRefs 变量参数溯源）、a- 前缀标签排除、路由顶层 const 懒加载包装组件关联、Pinia setup store（providerType + state/action 键）、Zustand providerType、defineAsyncComponent renders 关系与 Props 传递链、import.meta.glob + unplugin 目录孤儿豁免（含真孤儿保留）
- 新增 Go 盲区与根识别用例（`goAnalyzer.test.mjs` +1 / `goFrontendMap.test.mjs` +2 / `projectScanner.test.mjs` +4）：gin-vue-admin 形态单元测试（函数参数 router / 无前导斜杠 Group / handler 链展开 / 链式 Use / zap.Any 不误报）、融合仓库端到端（子目录 go.mod → framework=go + 依赖并入 + subProjects、handler 链解析到 Method、前端 service 配置对象匹配、深链调用链 Register→RegisterUser）、Go module 子目录定位端到端（`..` 折叠 → handler / 跨包调用链 / internal 文件边）、根识别四场景（定位 web/ 发现兄弟 server、定位 web/src 同样发现、定位仓库根不重复报告 + 代码集合目录防误吸附、定位 server/api 向上发现 go.mod）
- 总计 170 个测试全部通过（既有 162 无回归）；真实项目冒烟：
  - **snowy-admin-web**（Vue 3 + Vite + Pinia + Antdv + unplugin，597 文件）：206 条路由全部关联组件文件（const 包装修复生效）、67 条 PropEdge / 164 props（来源分布 computed×35 / handler×62 / state×41 / literal×23 / store×3——`kStore = keepAliveStore()` 无 use 前缀形态正确溯源）、9 个 Pinia store 全部携带 providerType=pinia（stateKeys 正确：globalStore 20 键等；纯 action store state=0 属实）、孤儿候选从误报收敛至 15 个（hooks/utils/403 页等真实候选）；端到端蓝图（snapshot.json 2.7MB + blueprint.html 746KB + blueprint.md 95KB），官方 CLI export 链路复核通过
  - **smartide-server**（gin-vue-admin 融合仓库，516 文件含 309 .go + web 前端）：`framework=go` 正确判定（子目录 `server/go.mod` 发现 + go 依赖并入 + subProjects 报告 server:go / web:npm）；96 条 gin 路由中 92 条 handler 解析到 Method（`baseApi.Register` 字段链展开生效；其余 4 条为 swagger/health/ws 内联闭包注册，如实无命名 handler）、`zap.Any` 无误报路由；**76 条路由命中前端调用**（web 前端 `service({url, method})` 配置对象形态提取生效）、40 条未匹配清单如实暴露；669 条调用边；定位 `web/` 前端子项目时 `framework=vue` + 兄弟项目 `server:go` 正确识别；端到端蓝图（snapshot.json 6.9MB + blueprint.html 563KB）
  - **回归**：aise-ui（Vue 2）198 PropEdge / 519 props / 159 vclass / 127 vue routes / 7 store 与 0.16.0 基线完全一致；leaniss-oneapi（Gin 融合仓库）124 路由 / 45 前端匹配 / 4 未匹配与 0.17.0 基线完全一致，定位 `router/` 子目录时 goModule 上级发现（dir=`..`）且 124 条路由完整解析；smartide-agent（Go CLI 代理）framework=go 正常；nice-today-2.0（React）831 Component 一致，PropEdge 414→429（+15 条为 React.lazy 包装组件此前无法解析、本期统一进解析索引的**预期增益**，lazy 页面的 props 传递补全）

## [0.17.0] - 2026-08-22

### 新增

- **Go 语言解析器（goAnalyzer，CLI / agent 代理 / Gin 后端）**：独立的轻量语法级解析器（深度状态机 + 双通道噪声剥离：全剥离通道供块状态机、保字符串通道供字面量提取，不依赖 gopls/tree-sitter），与 ts/vue/rust/dart 解析器平级共存，使 Go CLI、agent 代理类小程序与「Go 后端 + 前端」融合仓库可生成完整分析蓝图
  - **项目识别**：`go.mod` 存在且有 `.go` 源码 → `framework=go`（混合仓库前端文件仍各自解析）；`require` 段（分组块与单行形式，exclude/retract 块跳过）解析为 Dependency（`source=go`）；`vendor/`、`testdata/`、`bin/` 自动跳过
  - **实体映射**：`type X struct` → Class（`kind=struct`，字段含 `json/yaml` tag 与匿名内嵌——`*Base` 名取末段）、`type X interface` → Interface（嵌入接口 extends）；方法（值/指针接收者）与顶层函数 → Method（首字母大写判定 exported，`init/main` 恒为入口不判死）；package 目录 → Module；**Go 包 = 目录**：同包跨文件方法合并（接收者在另一文件声明的 `goOrphanMethods` 回填到声明文件）
  - **CLI 命令树（cobra）**：`var xxxCmd = &cobra.Command{Use/Short}` + `rootCmd.AddCommand(xxxCmd)` 边 → Route（`routeType=go-cli`，routePath 为 `smartide k8s init` 式命令链，多级树遍历 + 环防御）；`Flags()/PersistentFlags()` 注册的 flag 提取为 `-T/--type` 徽章；跨包限定子命令（`hostCmd.AddCommand(host.HostGetCmd)`）经 importMap 定位目标包目录归一；声明后从未注册的孤儿命令（如 smartide 被覆盖的 `help`）独立成根，天然暴露死代码
  - **HTTP 路由（Gin / 标准库）**：`router.Group("/api")` 前缀链累积 + `.GET/.POST/.PUT/.DELETE/.PATCH/Any("/path", ...)` → Route（`routeType=go`，apiMethods + `:param`/`*wildcard` 动态段标记）；handler 函数值（`controller.Register`）经 importMap 定位包目录关联到 Method（复用 componentId 机制，viewer 跳转方法签名）；组级 `apiRouter.Use(middleware.Auth())` 中间件按前缀链继承 + 内联中间件合并；`Handle("GET", ...)` 与 `http.HandleFunc` 标准库形式兜底；`NoRoute`/静态托管不产路由
  - **逻辑走向（调用链）**：包级函数跨文件互调（同包无需 import）+ `pkgAlias.Func()` 跨包调用（importMap 定位目标包目录）+ 方法体内调用（接收者变量/参数类型/构造字面量类型推断，`[]*User`/`map[string]T`/`*pkg.T` 归一为基类型）→ Method 的 `calls/calledBy`；Method 死代码候选按包级标识符引用判定
  - **前后端逻辑映射（融合仓库核心价值）**：tsAnalyzer 新增 httpCalls 提取——前端 `API.get/post/put/delete/patch('...')`、`axios.x()`、`fetch()`（含模板串 `` `/api/user/${id}` `` 与 options.method）→ 与 Go 路由路径分段匹配（`:param` 通配任意段、`*wildcard` 吞尾段、去 query、尾斜杠归一；method 不一致仍记录，详情可见）→ `Route.frontendCalls`（文件+行号+method 溯源）；未匹配调用进 `_meta.unmatchedFrontendCalls` 清单（路由地图「未匹配的前端调用」面板，用于发现死接口/路径漂移/外部 API 依赖）
  - **架构层（Go 目录信号）**：`main.go`/`cmd/` → entry，`router/controller/middleware/handler/api` → presentation，`model/dal/dao/repository/relay/service/biz/domain/monitor` → service，其余 → shared
  - **路由地图增强**：Go HTTP 路由（方法徽章 + 中间件链 + 前端调用数徽章与清单）与 Go CLI 命令（路径层级树按命令空格段嵌套，flags 见详情）统一进既有路由地图视图；域取首个业务段（跳过 `api`/`apis`/`v1` 网关前缀）；类型配色 go=天蓝、go-cli=灰蓝
- **README 对象表/框架检测/已知限制同步**：Project framework 枚举与 `goFileCount`、Interface/Class/Method/Route/Dependency 的 Go 语义说明、go.mod 框架检测、Go 已知限制（泛型不解析、调用链静态提取、Run 闭包不实体化、httpCalls 词法近似边界）

### 修复

- **蓝图实体类图语言配色缺 Go（Go 实体回退 TS/JS 蓝）**：`LANG_META` 缺 `go` 条目，Go struct/interface 的 UML 类框描边与头部底色回退为 TS/JS 蓝 `#58a6ff`，与图例语义冲突；语言分布条形图映射与图例均为硬编码四语言，Go 条同样回退蓝色且图例无 Go 说明。修复：`LANG_META` 新增 `go`（gopher 蓝 `#00add8`），CSS 新增 `--go` 变量与 `.bar.go` 类；图例改为**数据驱动**——按 `byLanguage` 实际语言从 `LANG_META` 取色生成，只显示项目内存在的语言（Go 项目不再显示无关的 TS/Vue/Rust 图例项），颜色与类图节点描边单一来源同源

### 验证

- 新增 `test/goAnalyzer.test.mjs` + `test/goFrontendMap.test.mjs`（13 个用例）：struct/interface/接收者方法提取（tag 字段/匿名内嵌/exported 判定）、调用链三类提取（pkg 跨包/local 同包/method 接收者推断）、cobra 命令树（Use/Short/flags/AddCommand 边）、gin 路由（Group 前缀累积/中间件/handler/动态段/标准库兜底）、go.mod 检测 + vendor 跳过、端到端实体入快照（Class/Method/Module/archLayer/依赖）、cobra→Route 命令链、gin→Route handler Method 关联、Go 项目 props 链为空不影响既有管线、tsAnalyzer httpCalls 提取、前端调用匹配（:param 通配/尾斜杠归一/未匹配清单）、viewer 路由地图视图模型（前端调用指标/go 类型分布/命令树字段）、viewer 实体类图 Go 配色（CSS 契约 + 内嵌脚本 mock DOM 渲染：图例 gopher 蓝圆点 / bar go 分布条 / 类框描边 `#00add8` / 不回退 TS 蓝）
- 总计 153 个测试全部通过（既有 140 无回归）；真实项目冒烟：
  - **smartide/cli**（cobra CLI）：161 个 .go 全扫（含根 `main.go` 入口识别），112 struct / 6 interface / 646 Method / 796 条调用边 / 114 个 go.mod 依赖；CLI 命令树 24 条命令链——`smartide` 根 + 16 个一级命令（init/start/new/stop/remove/version/list/get/host/reset/update/config/login/logout/connect/k8s）+ host×4 / k8s×2 子命令（最大深度 3：`smartide k8s init`）+ 孤儿 `help` 命令（声明后从未 AddCommand，真实死代码信号）
  - **leaniss-oneapi**（Gin + GORM + React 三主题融合仓库）：461 文件（222 .go + 239 .js）全扫，244 struct / 4 interface / 1224 Method / 994 条调用边 / 101 个 go 依赖；124 条 gin HTTP 路由（43 条 `:param`/`*target` 动态段、全部携带中间件链如 CriticalRateLimit/TurnstileCheck/AdminAuth）；**前后端映射 45 条路由命中前端调用**（三主题 default/air/berry 的 `API.get('/api/channel/...')` 等散落组件调用全部溯源到文件+行号）；未匹配前端调用 4 条（telegram oauth 登录 + 3 处 GitHub Releases 外部 API——如实暴露外部依赖）；`framework=go` 正确判定；端到端蓝图（snapshot.json 1.6MB + blueprint.html 561KB）
  - **回归**：nice-today-2.0（React）414 PropEdge / 831 Component 与 0.16.0 基线完全一致（tsAnalyzer 新增 httpCalls 不影响既有产出）

## [0.16.0] - 2026-08-22

### 新增

- **Vue2（Options API）props 传递链分析**：Vue SFC 模板绑定与 React JSX 属性同构接入 PropEdge 体系（`prop:A→B` 组件对聚合），「组件数据流」标签页对 Vue2 项目可用
  - **Options API 选项解析**：`export default {}` / `Vue.extend({})` / `defineComponent({})` 提取 `props`（对象/数组/混合形式，含 type）、`data`（对象/函数/方法形式）、`computed`/`methods` 键集、`components` 局部注册表；`mapState/mapGetters/mapActions/mapMutations` spread 展开提取 storeKeys（含 Vuex 模块名：双参 `mapState('app', [...])` 首参与箭头函数体 `state.app.x` 两种来源）
  - **模板绑定七类来源分类**：`:prop` / 静态属性 / 裸属性 / `v-model`（含 `v-model:arg`）/ `.sync` 修饰符剥离 / `@event`（事件回调记 handler，name 形如 `@save`）/ `v-bind="obj"` spread；表达式根标识符按 props → data → store → methods → computed 顺序判定，与 React 版语义对齐
  - **组件标签解析**（统一 helper）：局部 `components` 注册表 → import 索引（local 名 + PascalCase 双键，default 导入取目标文件 primary 组件）→ `main.js` 的 `Vue.component()` 全局注册兜底 → 同文件兜底；kebab-case 标签 / camelCase 导入名 / 文件派生名（`day.vue` ↔ `CrontabDay`）均可对齐
  - **排除规则**：element-ui `el-` 前缀、原生 HTML / Vue 内置标签（router-view/transition 等）不进传递链；`v-if/v-for/ref/key/class/style/slot` 等指令与 DOM 透传属性跳过
- **Vue 组件类视图实体（vclass）**：每个 `.vue` 文件 primary 组件合成为 `kind=component` 的 Class 实体（`vclass:X`，language=vue）——props 为字段（含 type）、computed + methods 为方法实体（`vmethod:X.key`）；组件 renders 组合关系回填为 vclass 间 rendersIds（目标同为 vclass 才成边，保持类图纯净），「实体类图」标签页对 Vue2 项目可用
- **类图 renders 组合边渲染**：UML 类图新增 renders 边（绿色实线箭头 + `arr-rnd` marker），区别于 implements（青色虚线）/ extends（紫色实线）；图例与统计 chips 同步展示 renders 边数；实体构造型标签新增 `«component»`
- **Vuex store 检测（Vue2）**：`/store/` 目录或导入 vuex 的文件，default export（对象字面量 / `new Vuex.Store({})` / RuoYi 风格 shorthand 引用顶层 const）提取 `stateKeys` + `actionKeys`（actions + mutations 合并）为 Store 实体（`providerType=vuex`），「业务数据图」对 Vuex 项目可用
- **router-link 静态导航边**：模板内 `<router-link to="/path">` 静态路径 → 文件所属路由 → 目标路由的 `navigatesToIds`（动态 `:to` 含表达式不可静态解析，跳过）；`this.$router.push('/path')` 调用同步支持
- **`@` 别名解析增强（projectScanner）**：vue.config.js 的 `configureWebpack.resolve.alias`（支持 `resolve('src')` / `path.resolve(__dirname, 'src')` / `'src'` 三种值形式）与 jsconfig.json paths 解析；存在 vue.config.js + `src/` 时兜底 `@/* → src/*`（vue-cli 惯例）
- **`build` 目录源码树豁免**：构建产物目录名 `build` 在 `src/` 源码树内不再跳过（如 RuoYi 的 `src/views/tool/build/` 业务源码目录）；`node_modules`/`.git` 等其余跳过项不受影响

### 验证

- 新增 `test/vuePropsChain.test.mjs`（8 个用例）：Options API 选项提取（props 定义/data/computed/methods/components/storeKeys 模块名）、模板绑定七类来源分类（forward/state/store/handler/computed/literal/spread + v-model/.sync/静态/裸属性 + router-link 导航）、@ 别名解析与 Vuex store 检测、PropEdge 聚合（局部注册 + 全局注册 + renderCount + 出入度 + passesProps）、vclass 类实体（props 字段/computed+methods 方法/renders 组合边）、路由导航边、viewer propFlow + 类视图 renders 渲染（mock DOM 执行内嵌脚本）、Vue 无绑定项目 propFlow 为 null 且 vclass 仍产出
- 总计 140 个测试全部通过（既有 132 无回归）；真实项目冒烟：aise-ui（Vue 2.6 + element-ui + vuex 3 + vue-router 3，268 文件）：unresolvedImports = 0（@ 别名全量解析）、198 条 PropEdge / 519 props（来源分布 state×269 / handler×141 / computed×78 / literal×27 / forward×3）、81 个组件 renders 关系、7 个 Vuex store（providerType=vuex）、162 个 vclass 实体（207 条 renders 组合边）、127 条 vue 路由 + 2 条 router-link 静态导航边；端到端蓝图（snapshot.json 1.6MB + blueprint.html 620KB）核验组件数据流 / 实体类图 / 业务数据图 / 路由地图四 Tab 数据齐备；nice-today-2.0（React）回归：414 PropEdge / 831 组件与 0.15.0 基线完全一致

## [0.15.0] - 2026-08-22

### 新增

- **Props 传递链分析（PropEdge 对象体系，React/Next 组件数据流）**：`.tsx/.jsx` 中 PascalCase JSX 标签的属性传递按**组件对聚合**为 PropEdge 对象（`prop:A→B`，19 种对象类型之一），回答"数据怎么在组件间流动"
  - **来源七类分类**（词法近似：组件声明范围 + 文件级变量表判定）：`forward`（父组件 props 透传）/ `state`（useState 解构）/ `store`（useXxxStore 等非内置 hook，附 storeHook 溯源）/ `handler`（内联或本地函数）/ `literal`（字符串/数字/布尔/裸属性）/ `computed`（其余表达式）/ `spread`（`{...obj}` 整体透传不展开）
  - **聚合规则**：同一组件对多处渲染聚合一条边（`renderCount`）；同名 prop 多来源取优先级最高者（forward > state > store > handler > computed > literal > spread）；路由库组件（Link/Navigate/Outlet 等）与 React 内部属性（key/ref/className/style 等）跳过，自渲染不成边
  - **Component 扩展**：`propsNames`（解构 props 名清单）与 `propOutCount`/`propInCount`（传递出入度）
  - **passesProps 链接**（第 22 种链接类型）：`link passesProps --src comp:X` 正向查传递目标；传 `prop:` 边 ID 返回两端组件
- **overlay 路由 props 工厂注入提取**：路由条目的 `props: (app) => ({ item: app.item })` 工厂函数提取注入键为 `factoryProps`（`hasPropsFactory` 标记），App → 工厂 → 页面组件的主干注入链在路由地图以「工厂 N props」徽章展示
- **蓝图查看器「组件数据流」标签页**（新 Tab，位于路由地图之后）：无 PropEdge 项目自动隐藏
  - **组件数据流总览**：传递边 / 参与组件 / props 总数 / spread 透传统计卡 + props 来源分布条形图（七类固定配色与判定说明）
  - **Props 传递图 SVG**：节点按 BFS 传递层数分层（无入边顶层容器 → 1 层 → 2 层…），节点边框色 = 所属域、顶层加粗，边中点标签 = props 数；悬停高亮相邻边、点击节点查看 props 明细（名称 + 来源 + store hook + 值摘要）与传出/传入清单；域下拉筛选 + 组件名/文件路径搜索（默认渲染连接度 Top 80 组件）
  - **高传出 / 高传入组件 Top 榜**：props 分发枢纽 vs 消费方（出入边数 + props 数 + 所属域）
  - **Props 传递边清单**：来源 → 目标 / props 数 / 渲染处 / props 明细（名称:来源）/ 跨域标记（80 条截断保护）
- **propFlow 视图模型**（`buildViewerModel` 新增第 9 节）：传递边（含来源分类与域归属）/ 参与组件出入度 / 来源分布 / 高传出高传入 Top 榜 / 域选项；`export --format viewmodel` 同步携带
- **Markdown 导出扩展**：项目概览新增「Props 传递边数」指标；路由表新增「工厂 props」列；新增「Props 传递链（PropEdge）」章节（汇总行 + 来源分布 + 传递边清单 + 高扇入组件统计）

### 验证

- 新增 `test/propsChain.test.mjs`（7 个用例）：tsAnalyzer 来源分类（七类全覆盖 + propsNames 声明提取）、PropEdge 跨文件聚合与出入度/passesProps 链接、多处渲染 renderCount 聚合与来源优先级、同文件组件对成边、overlay 工厂 factoryProps 提取、propFlow 模型层与渲染输出（mock DOM 执行内嵌脚本）、无 PropEdge 项目 Tab 隐藏
- 总计 132 个测试全部通过；真实项目冒烟：nice-today-2.0（414 条传递边 / 434 组件 / 1120 props，来源分布 computed×323 / handler×273 / state×184 / forward×150 / literal×151 / store×39；高传出 App(23)/HealingTab(18)，高传入 CopyTextButton(27)；SettingsOverlay→SettingsSection 16 个 forward props 批量透传等典型形态命中）与 next-web-app（3 条传递边，服务端组件为主的项目如实稀疏）

## [0.14.0] - 2026-08-22

### 新增

- **蓝图查看器「路由地图」标签页**（新 Tab，位于业务逻辑流向与实体类图之间）：把 0.13.0 扩展后的全类型路由（overlay / react-router / vue-router / Flutter GoRoute+原生 / Next.js App Router）组织为可视化地图；无路由项目自动隐藏 Tab
  - **路由总览**：路由总数 / 导航边 / 入口路由 / 孤岛路由 / 动态路由 / API 路由统计卡 + 路由类型分布条形图（每种类型固定配色：overlay 紫、react 蓝、vue 绿、flutter 青、next 页面琥珀、next API 红）
  - **路由导航链 SVG 图**：节点按导航跳数 BFS 分层（入度 0 的入口路由为第 0 列 → 1 跳 → 2 跳…，环内/未覆盖节点沉底），节点框两行（路径 + 类型·组件），边框色 = 路由类型、入口加粗；悬停高亮相邻路由与导航边、点击查看路由详情（域 / 动态段 / use client·server / API 方法 / layout 层数 / 组件与文件 / 导航去向）；超过 60 条路由按导航活跃度截断
  - **路径层级树**：路由 path 逐段嵌套的缩进树（每节点独立子段索引，不同分支同名段不合并），静态段在前动态段在后、动态段琥珀色高亮，节点标注类型徽标与主组件名
  - **域分组**：按路由 domain 聚合（每组路由清单 + 组件 + 导航去向）
  - **全量路由清单表**：路径 / 类型 / 域 / 组件 / 导航去向 / 被导航 双向列（150 条截断保护）
- **routeMap 视图模型**（`buildViewerModel` 新增第 8 节）：路由条目（path/routeType/domain/componentRef/componentFile/isDynamic/isClient/apiMethods/layoutCount/navToPaths）、导航边（去重 + 自环剔除）、入口/孤岛路由计数（入度 0 且有出边 = 入口；无出入边 = 孤岛）、类型分布、域分组、路径层级树（maxDepth）；`export --format viewmodel` 同步携带
- **Markdown 导出路由地图扩展**：路由表新增「类型 / 动态 / client / API 方法」四列（Next.js App Router 语义），表头前增加类型分布汇总行；页面导航图章节增加入口路由（无入边）清单

### 验证

- 新增 `test/routeMapView.test.mjs`（3 个用例）：routeMap 模型层契约（清单/导航边去重/入口孤岛计数/类型分布/路径层级树嵌套与动态段排序/域分组）、渲染输出（mock DOM 执行内嵌脚本，断言路由总览/导航链 SVG/层级树/域分组/全量清单与动态段高亮）、无路由项目 routeMap 为 null 且 Tab 隐藏
- 总计 125 个测试全部通过；真实项目冒烟（含内嵌脚本运行时渲染验证）：next-web-app（6 路由/5 导航边/1 入口，六域分组）与 keylol_discourse_app（14 路由/6 导航边含自环剔除/1 入口/7 孤岛，`/space/*` 二级树深）

## [0.13.0] - 2026-08-22

### 新增

- **Next.js App Router 路由提取（`nextAppAnalyzer`，文件约定式路由）**：`framework=next` 且存在含约定文件（`page/route/layout`）的 `app/` 或 `src/app/` 目录（后者优先）时自动提取，Route 对象体系新增 `next` / `next-api` 两个 routeType：
  - **页面路由**：`app/**/page.tsx` → Route（`routeType=next`），URL 按目录约定计算——路由组 `(group)` 与平行路由 `@slot` 段剔除出 URL、`_private` 段整目录不产出路由、`[id]` → `:id`、`[...slug]` → `:slug*`、`[[...slug]]` → `:slug?`（`isDynamic` 标记）；`rawPath` 保留原始目录段
  - **API 路由**：`app/**/route.ts` → Route（`routeType=next-api`），导出的 `GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS` 方法名收集为 `apiMethods`
  - **layout 链**：`layout.tsx` 不单独成路由，而是沿真实目录链（外→内，含路由组层）收集进后代路由的 `layoutFileIds`；`loading/error/not-found/template/global-error` 约定文件记入 `specialFiles`
  - **客户端标记**：page/route 文件头 `'use client'` 指令探测为 `isClient`；组件关联沿用 `componentId`/`componentFileId`，page 组件 kind 自动升级
  - **跳转边**：tsAnalyzer 识别 `next/link` 的 `<Link href>`（字符串或 `{ pathname: '/x' }` 对象形式）计入 overlayOpens → 目标路由的 `navigatesToIds`；导航边仅归属 page 文件（layout/共享组件文件内的 Link 不归属，避免边爆炸）
- **Flutter 原生路由表提取（`dartAnalyzer` 扩展）**：`Map<String, WidgetBuilder> routes = { '/x': (ctx) => const XxxPage() }`（MaterialApp `routes:` 命名路由）条目提取，`routeType=flutter`——与 GoRoute 路由并存合并；深度感知条目扫描（仅 map 体顶层的 `'path':` 视为条目键，builder 体内字符串如 `arguments: {'tid': x}` 不误判），值取最后一个大写构造调用（与 GoRoute builder 一致）
- **Flutter 命名路由跳转边**：`Navigator.pushNamed / pushReplacementNamed / popAndPushNamed / restorablePushNamed`（`Navigator.of(context).pushNamed('/x')` 与 `Navigator.pushNamed(context, '/x')` 两种形式）→ 该文件组件所属路由 → 目标路由（`navigatesToIds`）

### 验证

- 新增 `test/nextRoutes.test.mjs`（4 个用例）：App Router 路由提取（页面/API 路由、动态段/路由组/私有目录归一、layout 链、`'use client'` 探测、apiMethods）、`src/app` 优先定位、Link href 跳转边（字符串 + pathname 对象形式 + 自环剔除）、路由条目字段契约（rawPath/specialFiles/componentFileId）
- 新增 `test/dartNativeRoutes.test.mjs`（3 个用例）：原生 routes Map 条目提取（builder 体内字符串不误判 + 块体 builder）、pushNamed 两种调用形式跳转边、GoRoute 与原生 routes 并存合并
- 总计 122 个测试全部通过；真实项目冒烟：next-web-app（6 条 next 路由 + 5 条导航边，`/` 页面 Link 五向导航全解析）与 keylol_discourse_app（14 条 flutter 路由 + 7 条导航边，含 `/space/friends|threads|posts` 同组件多路由与 `/settings → /log,/about` 二级导航）

## [0.12.0] - 2026-08-22

### 新增

- **`serve` 命令（本地数据源 HTTP 服务）**：把本体快照与蓝图暴露为 CORS 就绪的 HTTP 端点，供 AI agent / 油猴脚本 / 网页跨源拉取——解决油猴脚本在 `file://` 协议下无法读取 `snapshot.json`、以及 AI agent 消费快照需要自起服务的问题
  - 端点：`GET /snapshot.json`（完整快照）、`GET /blueprint.html`（蓝图页面）、`GET /api/status`（目录解析结果 + 快照/蓝图就绪状态 + 端点清单）、`GET /api/stats`（项目名/框架/对象计数/循环依赖/死代码候选）、`GET /`（状态首页 HTML）；全端点 CORS `*`，`OPTIONS` 预检放行
  - 目录解析链：`--dir` → 全局 `--snapshot-dir` → `NICE_AOS_SNAPSHOT_DIR` → `<root>/.nice-aos/data`；`--root` 定位 blueprint.html（默认当前目录）；默认监听 `127.0.0.1:8420`（仅本机，`--host 0.0.0.0` 开放局域网），`--port 0` 自动分配可用端口
  - 就绪状态**每次请求实时探测**：支持"先起服务、后 `refreshRepo` / `export`"工作流（文件随后生成即可读，无需重启服务）；快照缺失返回 404（附生成指引）、JSON 损坏返回 500
  - `snapshot.js` 新增 `getSnapshotDirOverride()`：serve 经其读取全局 `--snapshot-dir`（preAction 钩子写入的覆盖值）对齐约定——不在 serve 上重复定义同名选项（Commander 中子命令选项与全局选项重名时值会被父命令吞掉）
- **`contrib/blueprint-ai-agent`（蓝图页 AI 代码分析助手，油猴脚本，按需集成）**：在 `blueprint.html` 右下角注入浮窗按钮，点击展开对话侧边栏，对项目本体（模块/组件/Store/Service/路由/接口/类/方法/功能域/死代码）自然语言问答；不进入 npm 包分发
  - 架构借鉴 steam-ai-agent：**ToolRegistry + ReAct 文本协议**（`<tool_calls>` 纯文本约定，规避各厂商 function-calling 差异），低成本支持多模型接入：内置 DeepSeek / 智谱GLM / 通义千问 / Kimi / 豆包 / OpenAI 预设 + 自定义（任意 OpenAI 兼容地址）
  - **9 个代码分析工具**：getStats（统计总览）/ queryObjects（按类型查询）/ getNodeDetails（对象详情）/ listLinks（关系与反向引用）/ getDomainDetail（功能域构成）/ analyzeFile（单文件分析）/ getArchLayers（架构分层分布）/ findDeadCode（四级死代码候选）/ getProjectContext（当前页面视图上下文）
  - **双数据源**：优先页面内嵌 `viewer-data`（`export --format html` 自带，零依赖离线可用）；「设置」可配本地快照 HTTP 地址（`GM_xmlhttpRequest` 拉取，推荐 `nice-aos serve` 一行启动）
  - 新建会话 / 会话历史（重命名/删除/清空）、会话导出 JSON（可恢复）/ Markdown、流式打字输出、工具调用可视化、可中断生成；仅在内嵌 viewer-data 或存在 `#viewer` 容器的蓝图页自激活，其它页面无副作用

### 修复

- **蓝图查看器实体类图文字不可读（黑字融深色背景）**：UML 类框样式选择器误写为后代形式 `svg .uml ...`，但 `.uml` 类名挂在 `<svg>` 根元素自身上，选择器永远失配 → 类名/构造型/字段/方法文字回退 SVG 默认**黑色填充**，与深色背景融合不可读（类框边框颜色走内联 `stroke` 属性"看似正常"，列标签走 `svg .col-label` 也正常，问题更隐蔽）。改为复合选择器 `svg.uml ...` 后，文字填充（`--fg`/`--fg-dim`/`--fg-faint`）、类框体填充与分隔线描边全部正确生效
- **蓝图页头「生成于」显示 UTC 标准时间**：快照 `_meta.generatedAt` 存 UTC ISO 串，页头原样 `.replace('T',' ').slice(0,19)` 展示，东八区下与实际生成时间差 8 小时。查看器内嵌脚本新增 `fmtLocalTime`，在浏览器查看时转换为本机时区；Markdown 导出报告的「生成时间」行同步修复（快照数据仍存 UTC ISO 不变，展示层转换，无歧义）

### 验证

- 新增 `test/serve.test.mjs`（3 个用例）：端点契约（默认目录解析 + CORS + 各端点响应 + OPTIONS 预检 + 404 JSON 错误体）、快照后生成实时可见回归（启动无快照 404 → 运行中生成即 200 → 损坏 500 → 蓝图后生成即读）、`--dir` / `--snapshot-dir` 别名显式指定目录
- 新增 `test/viewer.test.mjs` 2 个回归用例：实体类图 CSS 选择器（禁止失配的 `svg .uml ` 后代形式 + 文字填充断言）、页头生成时间本机时区显示（mock DOM 执行内嵌脚本，断言 v-sub 文本含本地时间且不含 UTC 原文，时区无关写法）
- 总计 115 个测试全部通过；默认端口 8420 人工冒烟：全端点响应、CORS 头、启动横幅正常（Windows 系统保留端口段会导致 EACCES 启动失败，撞上时用 `--port` 换端口即可，报错信息已给出指引）；steam-game-library 真实项目重新生成蓝图验证两处修复（旧页头显示 UTC `03:42:11` → 新显示本机时区 `11:42:11` 与系统时间一致，CSS 选择器修复后文字填充生效）

## [0.11.0] - 2026-08-21

### 新增

- **Dart/Flutter 实体分析器（`dartAnalyzer`，lib/ 组件）**：与 tsAnalyzer/vueAnalyzer/userScriptAnalyzer/rustAnalyzer 平级共存的轻量语法级解析器（深度状态机 + 等长噪声剥离 + 注解行剥离，不依赖 dart analyzer），实体映射对齐 TS 语义：
  - `abstract class` → Interface、`class/enum/mixin` → Class（extends/implements/with 关系、字段、方法、构造器不实体化为 Method）；类方法/顶层 fn → Method（含 `@override` 标记、signature 归一）
  - **Widget 基类（StatelessWidget/StatefulWidget/ConsumerWidget 等）→ Component**（kind: page/widget、dartdoc 描述、文件名匹配主组件）；**ChangeNotifier/Notifier 子类与 Riverpod Provider 变量（`final xxxProvider = NotifierProvider<...>.new(X.new)`，含 notifierClass 提取）→ Store**（stateKeys/actionKeys）
  - `GoRoute(path/builder)` → dartRoutes：路径常量引用回填（`path: AppRoutes.dashboard`）、builderWidget 跨文件组件解析；`context.go/push('/path' 或 AppRoutes.xxx 常量引用)` → overlayOpens → 路由导航边（`navigatesToIds`）
  - **方法逻辑调用链**：方法体内调用 → callEdges → `Method.callIds/calledByIds/compCallIds`——本类方法/顶层函数/跨文件静态方法（importMap 解析 + 全仓库唯一名兜底）双向链接，Widget 构造调用 → compCallIds 渲染链
- **Flutter 项目扫描与框架识别**：`pubspec.yaml` + `lib/` 自动发现（monorepo 多包递归发现）并把 `lib` 纳入扫描（`.dart`）；pubspec 依赖解析（`flutter: sdk: flutter` 无值键拼接）；`framework=flutter`（依赖含 flutter sdk）/ `framework=dart`（纯 Dart 包）；`frameworkVariants` 新增 riverpod/provider/bloc/getx/go_router；`Project` 画像新增 `dartFileCount`/`flutterDetected`；SKIP_DIRS 新增 android/ios/.dart_tool/linux/macos/windows
- **导入解析扩展**：`package:` 导入（自身包名 → 项目内 lib/ 路径，其余 → pub 依赖）、`dart:` 内置库跳过、Dart 无 `./` 前缀裸相对导入解析
- **蓝图查看器 Dart 展示**：语言标签/分布新增 Dart（teal 色系）；实体类图节点方法与详情面板新增「方法调用链」（方法 → 调用目标/被调方，Widget 渲染链并入）；Route 一览支持 Flutter GoRoute 展示
- **Markdown 导出 Dart 统计**：项目概览新增 Dart 文件数行、Store/路由/依赖标题含 Riverpod/GoRoute/pub；接口/类表语言列支持 Dart；新增「方法调用链 Top 30」章节（出边数/被调用数/调用目标/调用组件）
- **`action analyzeFile` 支持 .dart**（dartAnalyzer 链，输出 Interface/Class/Method）

### 修复

- dartAnalyzer：`@override` 等注解行破坏块状态机行首分类导致带注解方法（如 build）被吞（stripAnnotations 预处理，方法数显著修复）；类构造器误判为 Method；Riverpod Provider 变量正则转义失效（模板字面量 `\\s` 产生字面反斜杠）；`NotifierProvider<X, Y>.new(X.new)` 形式 notifierClass 提取；`_PrivateWidget(...)` 私有类构造归类为 self 调用；signature 残留 CRLF
- dartAnalyzer：GoRouter 常量引用导航（`context.push(AppRoutes.xxx)` / `context.go(home)`）未解析为导航边（navRe 仅匹配字符串字面量参数；顶层函数的导航调用未进 overlayOpens）——扩展参数形式为字符串/常量引用两种，builder 侧用全仓库路由常量表（常量名 → path）跨文件回填，动态变量（`feature.route`）查不到即忽略

### 验证

- 新增 `test/dartEntities.test.mjs`（12 个用例）：Widget 组件/`@override` 回归/抽象类→Interface/ChangeNotifier→Store/Riverpod Provider 变量/GoRoute 常量回填（含 `context.push(AppRoutes.xxx)` 常量引用导航）/调用链分类/Flutter 框架识别/实体入快照/导航边（字符串 + 跨文件常量回填双向）+调用链/蓝图视图模型/Markdown 导出
- 总计 110 个测试全部通过；真实项目回归：steam-game-flutter（186 文件/89 组件/63 Store/15 路由/1624 方法，175 个方法产生 250 条调用边）与 nice-today-flutter（121 文件/103 组件/12 Store/47 路由/1608 方法，288 个方法产生 364 条调用边、4 条路由导航边含 `AppRouter.xxx` 常量回填）

## [0.10.0] - 2026-08-21

### 新增

- **`update` 命令（版本检测与一键升级）**：`nice-aos update --check` 仅检测（输出 JSON：current / latest / upToDate / installMode / upgradeCommand，供 agent 与 CI 前置校验）；`nice-aos update` 一键升级——npm 全局安装时自动执行 `npm install -g nice-aos@latest`，升级后读回磁盘版本复核
- **安装模式自动判定（`installMode`）**：`global`（npm 全局安装，可一键升级；`npm install -g <本地目录>` 的符号链接形式同样识别，升级时替换为 registry 版本并在消息中说明）/ `npx`（缓存运行 → 指引 `npx nice-aos@latest` 拉新）/ `local`（项目依赖 → 指引宿主项目内升级，不改写 package.json）/ `repo`（仓库源码运行 → 跟随 git）。检测采用双信号互补：调用入口路径（`process.argv[1]`，保留符号链接——覆盖 `npm link` 与本地目录全局安装）+ 模块真实路径布局（`lib/node_modules/nice-aos` 强信号，覆盖 homebrew / nvm 多 prefix 环境，PATH 中 npm prefix 与实际安装 prefix 不一致时仍可正确判定）
- **Skills 版本检测要求**：三个 skill（nice-aos / nice-aos-userscript / nice-aos-deadcode）前置条件统一增加"npm 包方式必须先 `update --check` 确认最新版"约定——`upToDate=false` 且 global 时执行 `nice-aos update`；`update` 命令不存在说明版本 < 0.10.0，先 `npm install -g nice-aos@latest` 一次性升级；网络不可达返回 `ok:false` 时跳过升级不阻塞主流程；仓库内源码方式版本跟随 git 无需检测。核心 skill 的 Agent 行为规范表同步增加版本校验行

### 验证

- 新增 `test/update.test.mjs`（2 个用例）：compareVersions 三段语义版本比较（含 0.9.0 < 0.10.0 非字符串比较）、`update --check` 输出 JSON 契约（离线时容忍 `ok:false` 形状）
- 真实环境回归：仓库源码模式（repo）、npm 全局符号链接安装（global + linkedInstall）、多 prefix 全局布局（`lib/node_modules` 布局模拟 homebrew）、一键升级端到端（0.8.0 → 0.9.0，符号链接替换为 registry 版本且磁盘版本复核一致）
- 总计 98 个测试全部通过

## [0.9.0] - 2026-08-21

### 新增

- **Rust 实体分析器（`rustAnalyzer`，Tauri src-tauri 组件）**：与 tsAnalyzer/vueAnalyzer/userScriptAnalyzer 平级共存的轻量语法级解析器（深度状态机 + 等长噪声剥离，不依赖 rustc），实体映射对齐 TS 语义：
  - `pub struct`/`pub enum` → Class（kind: struct/enum，含 fields/derives/variants）；`pub trait` → Interface（supertrait → extends）；`impl` 块内 `fn` → Method（ownerKind=class，含 trait impl 关联）；模块级 `fn` → Method（ownerKind=module）
  - 跨文件路径解析：`use crate::a::B` 模块路径映射为主（`crate::a::b::Name` → `<crateRoot>/a/b.rs` 或 `a/b/mod.rs`）、`super::` 相对路径、全仓库唯一名匹配兜底；支持 `use a::{B, C}` 花括号组与 `use crate::x::*` 通配（目标文件及同目录整体豁免死代码判定）
  - Rust 类型引用即使用（`Vec<Game>` / `-> Game` / `impl Game` 均计入引用），Interface/Class 同样参与类型级死代码判定
- **客户端组件自动发现（Tauri/Electron）**：显式 roots 之外自动发现桌面客户端组件——`src-tauri/tauri.conf.json` 存在时把 `src-tauri/src` 纳入扫描，`electron/` 目录含 TS/JS 文件时纳入扫描；`Project` 画像新增 `rustFileCount`/`tauriDetected`/`electronDetected`/`language`（如 "TypeScript + Rust"），`frameworkVariants` 携带 tauri/electron；架构层新增 `tauri`（Rust 原生层）与 `electron`（主进程层）路径强信号直判；Java/Go 等后端代码不入扫描范围
- **实体类图（蓝图查看器新 Tab）**：UML 风格 SVG 类图——类框（名称 + 字段/变体 + 方法摘要，Rust struct 含 derives 徽标）、关系边（implements 虚线 / extends 实线 / 接口继承）、按派生层级分列布局；语言（TS/Vue/Rust）/类型/架构层分布条形图与跨语言关系计数；模块/类型/语言/关键词过滤 + 实体清单表格（字段/方法/关系度/实现继承/死代码状态）；图节点选取：关系活跃实体优先 + 各语言代表性实体按成员规模轮转补齐（无继承关系的 Rust struct 也能进入类图）；悬停高亮相邻节点与关系边、点击查看实体详情

### 变更

- 扫描扩展名新增 `.rs`；SKIP_DIRS 新增 `target`（Rust 构建产物）；`.backup` 后缀文件跳过
- Markdown 报告实体表格新增「语言」列（TS/Rust），项目概览新增 Rust 文件计数行
- 本体蓝图对象描述更新：Interface/Class/Method 标注 Rust 同构映射（trait → Interface、struct/enum → Class、impl fn → Method）

### 验证

- 新增 `test/rustEntities.test.mjs`（10 个用例）：struct/enum/trait 提取（derives/字段/变体/方法合并）、use 花括号组解析、crate/super 路径映射、通配 use 豁免、Rust 死代码判定
- 新增实体类图 viewmodel/渲染测试（跨语言 UML 类框 + 关系边 + 内嵌脚本可执行）
- 总计 96 个测试全部通过；真实项目回归：steam-game-hub-2.0（React + Tauri，44 个 .rs 文件 → 151 个 Rust 实体入图）与 steam-stat（Vue + Electron，electron/ 目录 7 文件入 electron 层）

## [0.8.0] - 2026-08-21

### 新增

- **单文件分析（`action analyzeFile`）**：不落盘、不建快照，stdout 直接输出 dataMap 形状 JSON（`_meta.mode === 'single-file'`），可与 jq/findstr 管道组合——独立油猴脚本与单个 TS/JS/Vue 文件的零成本体检入口：
  - 参数：`{"file": "path/to/x.js"}`（相对 cwd 或绝对路径；支持 .ts/.tsx/.js/.jsx/.mjs/.vue 与油猴脚本）
  - 油猴文件自动路由 userScriptAnalyzer 链（输出 UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction 五类），其余走 tsAnalyzer/vueAnalyzer 链（输出 Interface/Class/Method）
  - 单文件模式判定边界：仅"本文件内零引用"的非导出实体判死；导出实体一律不判死（单文件视角无法判定跨文件使用）
- **导出级死代码（unusedExports）**：每文件导出符号 × 全仓库具名导入对照 → `SourceFile.unusedExports[]` + `_meta.deadExportCandidates` 汇总；入口文件、re-export 链、动态 `import()` 引用保守豁免。死代码检测升级为**四级**（文件级 orphanCandidates / 导出级 unusedExports / 类型级 Interface/Class deadCandidate / 函数级 Method/ScriptFunction deadCandidate），`Project.health` 汇总四级计数（orphanFileCount/deadExportCount/deadTypeCount/deadFunctionCount）
- **油猴脚本函数级死代码（ScriptFunction.deadCandidate）**：复用保守引用计数规则——函数名全文出现次数（排除声明处与自身函数体）为 0，且 calledByCount=0、非 topLevelCalls 命中、非 constructor、非事件回调角色、未暴露到 unsafeWindow → `deadCandidate/deadReason`；UserScript 画像新增 deadFunctionCount
- **Skill 拆分（3 个）**：场景工作流从 CLI/Skill 分离——`nice-aos`（核心查询：快照/影响分析/蓝图导出，瘦身重写）、`nice-aos-userscript`（油猴审计：GM 越权/@connect 白名单/XSS 面/风险分级五步工作流 + 实战修复模板）、`nice-aos-deadcode`（四级死代码清理：检测 → 分级复核 → 清理 → 验证）。三者共享同一份 CLI 与快照；CLI 保持原子普适，场景编排全部下沉 Skill
- Markdown 报告「死代码候选」升级为四级章节（文件级 + 导出级 + 类型级 + 函数级，函数级含油猴 ScriptFunction）

### 变更

- 快照目录约定统一为 `<REPO_ROOT>/.nice-aos/data`（CLI 默认回退链第一候选），三个 skill 共享一份快照；`--snapshot-dir` 显式传参与 `NICE_AOS_SNAPSHOT_DIR` 环境变量继续支持任意路径
- package.json `files` 追加 `skills/**/SKILL.md`（npm 包携带三个 skill 文件，`npx nice-aos` 用户可直接取用）

### 验证

- 新增 `test/deadcode.test.mjs`（7 个用例）：导出级命中与豁免（入口文件/本文件使用不误报）、ScriptFunction deadCandidate（零引用死函数命中、事件回调/被调用函数不误报）、analyzeFile 动作（TS 文件与油猴文件输出形状、不落盘）
- 总计 85 个测试全部通过；自举验证（refreshRepo + query Class/Method 定位自身代码）与真实项目回归见发布流程

## [0.7.0] - 2026-08-21

### 新增

- **类型体系实体化（Interface / Class / Method）**：解决"实体关系记录在实现类中、从接口正向 query 不到"的断层，对象类型 15 → 18 种（均归 CodeUnit/L1 单元层）：
  - **Interface（`iface:`）**：接口全量提取（含 `.d.ts`），携带方法签名、extends 继承链、导出标记
  - **Class（`class:`）**：类全量提取，携带 implements/extends 关系、单例标记（`static getInstance`）、方法清单
  - **Method（`method:`）**：类方法、接口方法签名、模块函数（顶层声明 + const 箭头函数）统一为方法实体；ownerKind（class/interface/module）、isStatic/isAsync、展示用签名；ID 约定 `method:<file>#<Owner>#<name>`（模块函数 `method:<file>#<fnName>`）
- **实现/继承/覆盖关系（链接 15 → 21 种）**：
  - `implements` / `implementedBy`：Class ↔ Interface 双向——`link implementedBy --src "iface:src/types/storage.ts#IStorage"` 直接列出接口的全部实现类
  - `extends` / `extendedBy`：接口与类的继承链双向
  - `overrides` / `overriddenBy`：方法级覆盖双向——接口方法 → 全部实现类方法；子类方法 → 被覆盖的父类/接口方法
  - 跨文件解析：本文件声明优先，其次具名导入（含 `import type` type-only 导入与 `IStorage as StorageContract` 别名导入，按 imported 名定位目标文件导出）；解析失败留存原名不报错
  - `contains` 扩展：`file:` 可下钻类型实体，`iface:`/`class:` 可下钻其方法
- **函数级/类型级死代码候选（保守判定）**：在文件级 orphanCandidates 之外新增两级——非导出实体本文件零引用、导出实体全仓库零导入且本文件零引用 → `deadCandidate/deadReason`；引用计数排除声明处与自递归；接口方法为契约声明永不判死；命名空间导入 / `export *` / 动态 `import()` 目标文件整体豁免。健康指标（Project.health）新增 deadTypeCount / deadFunctionCount
- **Markdown 报告新章节**：「接口与实现」（接口清单 + implementedBy 实现类 + 方法覆盖矩阵，契约方法未被覆盖时标 ⚠️）、「类与方法」（类清单含 implements/extends/单例 + 契约热点 Top 30）、「死代码候选」升级为三级（文件级 + 类型级 + 函数级）；修复表格内联合类型 `|` 撑破列的转义问题

### 验证

- 新增 `test/typeEntities.test.mjs`（11 个用例）：tsAnalyzer 事实提取（接口继承/方法签名/类 implements/静态异步方法/模块函数与引用计数）、端到端实体构建与 objectCounts、跨文件 implements（type-only + 别名导入）、类继承与方法级 overrides 双向、blueprint 六种新链接、保守死代码判定（DeadClass/orphanHelper 命中，AliveClass/caller/接口方法不误报，导出未导入函数按导出级判死）、`--where` 过滤（`name~get,ownerKind=class`）
- 总计 78 个测试全部通过

### 变更说明

- query/link 命令为泛型实现（由 OBJECT_TYPES/LINK_TYPES 驱动），本版本零 CLI 命令改动即支持全部新类型/新链接
- 快照新增 Interface/Class/Method 三个 key，向后兼容（老快照/消费方不受影响）；大仓库快照体积约增至 2-3 倍（万级 Method 实体），载入仍在数百毫秒级
- Vue SFC `<script>` 内的 interface/class 本期不提取（Vue 侧已有 Hook/Composable/Store 体系）；TS 方法级调用图（calls/calledBy）未扩展到 Method

## [0.6.3] - 2026-08-21

### 新增

- **蓝图查看器宽屏适配**：内容宽度从固定 1400px 改为分档自适应（1600/1920/2240/2560px 断点逐步扩至 2400px）并居中，超宽屏不再右侧大片空白；脚本调用图 SVG 等比缩放（viewBox + max-width:100%），宽屏完整呈现、窄屏不再右缘截断
- **油猴脚本三视图意图适配（函数意图分析）**：无 React/Vue 结构的纯脚本仓库，领域蓝图/业务数据图/业务逻辑流向三个视图按函数意图（roles）重建，而非显示空壳占位：
  - **意图功能域**（领域蓝图适配）：单文件脚本无目录级功能域时，按函数主角色（渲染注入/数据获取/状态存取/事件监听/元素构建/纯逻辑）聚合为虚拟功能域，卡片展示各意图的行为计数（DOM 注入/网络/监听/GM API），点击下钻函数清单（按重要性排序）；仅单一意图的纯功能增强脚本不生成
  - **脚本存储枢纽**（业务数据图适配）：无 Zustand/Pinia Store 时以浏览器存储（localStorage/sessionStorage/indexedDB）与 GM 存储 API 为数据枢纽，展示各脚本存储信号、状态存取函数、宿主数据读取（unsafeWindow 全局变量）；无任何持久化信号的脚本不生成
  - **函数意图流转矩阵**（业务逻辑流向适配）：单文件无模块导入时，函数调用边按「调用方意图 → 被调方意图」聚合为热力矩阵（事件监听 → 纯逻辑 → 数据获取/状态存取 → 渲染注入），附高扇入函数（变更影响面）清单；调用流转稀疏的扁平脚本不生成
  - **Tab 显隐**：三视图各自独立判定，分析不出有效数据（如纯功能增强脚本）时隐藏对应 Tab，不再显示空壳
- **解析器：localStorage/sessionStorage/indexedDB 归属函数**：存储操作按包含函数归属（storageOpCount），函数角色推断的 state 角色从仅 GM 存储扩展到浏览器存储

### 验证

- Steam-License-Classifier-2.5.0（单文件审核场景）：意图功能域 6 组（纯逻辑 111 / 渲染注入 26 / 事件监听 9 / 数据获取 3 / 状态存取 3 / 元素构建 1）；存储枢纽 localStorage × 21 + indexedDB × 1 + 宿主读取 g_sessionID/g_steamID；意图流转 247 调用边（跨意图 156），Top 流转 渲染注入→纯逻辑 94、事件监听→纯逻辑 20
- steam-tampermonkey-scripts 全仓（混合场景，228 脚本 + 28 目录级功能域）：领域蓝图走正常目录域路径（不重复生成意图域），存储枢纽 228 个（45 个 localStorage 信号 + 140 个 GM 存储信号）、意图流转 73269 调用边正确激活
- DOM stub 渲染验证：三视图适配渲染器（renderScriptDomainList/renderScriptDataMap/renderScriptFlow）在真实快照上执行通过，矩阵热度格子、高扇入函数、Tab 显隐均正确
- 新增 3 个测试（多意图脚本三视图重建 / 纯功能增强脚本三视图隐藏 / 宽屏断点与 SVG 自适应），总计 67 个全部通过

## [0.6.2] - 2026-08-21

### 修复

- **HTML 入口引用盲区（Vite 多页应用）**：扫描器探测扫描根及宿主根顶层 `*.html` 的 `<script src="/src/xxx.tsx">` 根绝对路径引用，作为硬证据入口（`htmlEntryFiles`）；嵌套入口文件（如 `src/managed-agent/main.tsx`）不再被误判为死代码候选（asdm-agentlink/web：死代码候选 20 → 19，剩余经抽查为真实死代码）
- **蓝图架构分层排版压缩换行**：此前层名与描述拼接（如 `状态层（前端状态共享比如（Zustand / Pinia Store））`）挤在 90px 标签列内，被压缩成 3-5 行竖排堆叠、括号双重嵌套；现改为层名单行标签 + 描述作为条形图下方独立副行（与柱条对齐、小字号弱化），标签列加 `white-space: nowrap` 防压缩，窄屏下副行左对齐

### 验证

- asdm-agentlink monorepo 双子包端到端：web（React + Vite，202 文件，HTML 入口修复生效）+ server（Express 后端，254 文件，子包依赖清单正确，2 个未声明依赖均为真实治理点：@jest/globals 未声明、vitest 与 jest 混用残留）
- 新增 2 个测试（HTML 入口探测 / 架构分层排版 DOM stub 渲染验证），总计 64 个全部通过

## [0.6.1] - 2026-08-21

### 新增

- **项目框架识别增强（扫描 src 等子目录场景）**
  - 宿主项目定位：扫描目录自身无 package.json 时，向上查找最近宿主根（上限 4 层、不越过用户 home），用宿主依赖识别框架、回退项目名/版本，宿主依赖全量进入清单（扫描 src/ 时 react 等不再误判为未声明依赖）
  - 框架识别扩展：expo / react-native / next / nuxt 元框架优先识别，宿主 app.json 含 expo 键作旁证；无任何清单时按代码信号兜底（.vue 文件 → vue，tsx/jsx → react）
  - 跨端/构建变体（frameworkVariants）：Capacitor / Electron / Vite / Webpack，组合标签如 "React 单页应用 + Capacitor 跨端（Vite 构建）"，Project 携带 frameworkLabel / hostRoot / hostConfigs 证据
  - 宿主 tsconfig 路径别名重定基：扫描 src/ 时宿主的 `"@/*": "./src/*"` 重定基为 `./*`，`@/` 别名导入恢复解析（此前 600 处 `@/services` 等全部误判为未声明依赖）
  - solution 风格 tsconfig：根文件仅含 references 时递归合并子配置（tsconfig.app.json 等）的 paths（根 paths 优先，含自引用防御），`#/` 等多别名场景恢复解析
  - Node 内置模块（node: 前缀、裸名 fs/path/child_process/readline 等、子路径 fs/promises 与 readline/promises）识别为 builtin；Vite 虚拟模块（virtual:generated-pages / virtual:app-loading 等构建时生成）识别为 virtual，均不再计入依赖清单与未声明依赖
- 真实仓库验证（四类项目）：
  - nice-today-2.0（React + Capacitor + Vite，扫描 src/）：框架从 unknown → 正确识别；未声明依赖 62 → 8（剩余为真实治理点：d3 子包、@capacitor 局部插件）；别名恢复后暴露 1 组此前隐藏的循环依赖（8 → 9）
  - qa-live-healthcare（Vue 3 + Vite）：框架正确识别为 "Vue 单页应用 + Vite 构建"；未声明依赖仅剩真实治理点（@ant-design/icons-vue 导入未声明）
  - steam-stat（Vue 3 + Electron + Vite）：识别为 "Vue 单页应用 + Electron 桌面端（Vite 构建）"；solution tsconfig 的 `@/*` + `#/*` 双别名全部解析；virtual: 模块排除后未声明依赖归零
  - asdm-agentlink-cli（Node CLI，commander）：不误判为前端框架（保持"前端项目"中性标签）；readline 等内置模块子路径修复后未声明依赖归零
- 新增 12 个测试（宿主定位/框架识别/变体/别名重定基/solution tsconfig/builtin 子路径/virtual 模块），总计 62 个全部通过

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
