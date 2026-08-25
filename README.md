# nice-aos — 通用前端代码本体 / 数据库脚本 / 部署配置分析 CLI（React / Vue 2+3 / Flutter / Go / 油猴脚本 / MySQL 迁移脚本 / Docker+K8s+nginx 部署配置）

> 把任意 React、Vue 2 / Vue 3、Flutter（Dart）前端仓库、Go（CLI / agent 代理 / Gin 后端）仓库或 Tampermonkey 油猴脚本仓库预先分析为**结构化本体快照**（语义架构分层/功能域/模块/文件/组件/Hook/Composable/Zustand/Pinia/Vuex/Riverpod Store/Service/**接口/类/方法**/路由/依赖 + import/render/**props 传递链**/导航/**implements/extends/renders/overrides/方法调用链** 关系图谱；油猴脚本额外产出 GM API 使用/DOM 注入点/网络端点/脚本函数 + 调用图；Go 项目额外产出 **CLI 命令树 / HTTP 路由 / 前后端调用映射**），供 AI agent 与开发者通过 CLI 毫秒级查询，替代逐文件 grep。
> 参考 [asdm-aos](https://www.npmjs.com/package/@leansoftx/asdm-aos)（Java 代码本体分析）的架构，针对前端生态重新建模：React（React 19 + TypeScript + Vite + Zustand + overlay 路由 / react-router）、Vue 2（Options API + Vuex + element-ui，RuoYi 类中后台）/ Vue 3（SFC + vue-router + Pinia）、Flutter（Dart Widget + GoRouter + Riverpod，轻量语法级解析）、Go（cobra CLI 命令树 + Gin/标准库 HTTP 路由 + 包级调用链 + 前后端融合仓库映射，轻量语法级解析）与油猴脚本（UserScript 元数据 + GM API + 注入/请求审计）。
> 语义本体引擎：对象按概念范畴与抽象层级（L3 架构 / L2 结构 / L1 单元 / L0 事实）组织；架构分层按内容信号推断（非目录名直译）；Module/Domain/Project 自动生成职责画像与自然语言总结。
> 本体查看器（viewer）：`export --format html` 一键生成**自包含蓝图 HTML**（零依赖可离线打开，宽屏分档适配），含领域蓝图 / 业务数据图 / 业务逻辑流向 / **脚本蓝图（油猴函数调用图 + DOM 注入锚点 + 网络端点一图呈现）**五个视图；纯脚本仓库三视图自动按**函数意图分析**重建（意图功能域 / 存储枢纽 / 意图流转矩阵），分析不出业务结构时自动隐藏；`--format viewmodel` 输出聚合视图模型 JSON 供 agent 直接消费。

## 为什么需要它

在 1000+ 源文件的前端项目中，让 AI agent 直接 grep 全量源码，响应慢且结构理解易出错。nice-aos 将"文件"升维为"关系图谱"：

| 传统方式 | nice-aos |
|---------|----------|
| grep 谁导入了 ai.ts（遍历全部文件） | `link importedBy --src file:src/services/ai.ts`（毫秒） |
| 人工追页面跳转关系 | `link navigatesTo --src route:dietary_health` |
| 不知道哪些文件是死代码 | 快照内置四级死代码（文件/导出/类型/函数级） |
| 单个独立脚本/文件想快速体检（不建快照） | `action analyzeFile` 不落盘直接输出本体 JSON |
| 循环依赖靠运气发现 | 快照内置 Tarjan SCC（`_meta.cycles`） |
| 不知道 store 被谁用了 | `link usesStore --src store:useThemeStore` |
| 接口方法有哪些实现类（实现关系记录在实现类里，正向查不到） | `link implementedBy --src "iface:src/types/storage.ts#IStorage"` |
| 找某个方法的所有声明与实现 | `query Method --where "name~createinterface"`（一次命中签名+实现） |
| 审计油猴脚本是否越权调 GM API | `query GmApiUsage --where "declared=false"` |
| 不知道油猴脚本往页面哪里注入了 DOM | `link injectsInto --src us:demo.user.js` |
| 说不清项目架构和功能划分 | `query Project` 看 summary/architecture（分层画像 + 功能域清单 + 健康度） |
| 不知道某目录的职责 | `query Module --where "archLayer=state"` 看职责画像 |
| 想按功能域浏览代码 | `link belongsTo --src dom:health` 列出该域全部成员 |
| 想要一张可交互的项目蓝图给人看 | `export --format html --output blueprint.html`（浏览器直接打开，无需服务） |
| 想给 AI agent / 油猴脚本一个 HTTP 数据源 | `nice-aos serve`（一行启动，CORS 就绪，暴露快照与蓝图） |

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

# 5. 生成可交互蓝图 HTML（浏览器直接打开，离线可用；--theme 可选 deep-blue / fresh-green）
nice-aos export --format html --output blueprint.html

# 6. 单文件分析（不建快照，stdout 直接输出本体 JSON，可与 jq/findstr 管道组合）
nice-aos action analyzeFile --params '{"file":"Steam-License-Classifier.js"}' | jq '.ScriptFunction[] | select(.deadCandidate)'

# 7. 升级到最新版（全局安装时一键升级；--check 仅检测）
nice-aos update

# 8. 启动本地数据源服务（供 AI agent / 油猴脚本跨源拉取快照与蓝图）
nice-aos serve
```

> **快照目录解析优先级**：`--snapshot-dir` 参数 > `NICE_AOS_SNAPSHOT_DIR` 环境变量 > `cwd/.nice-aos/data` > `~/.nice-aos/data`。

### 多根目录项目（monorepo / 多包仓库）

默认扫描 `src/`（不存在则扫描项目根）。多根目录通过 `roots` 参数显式指定：

```bash
nice-aos action refreshRepo --params '{"repoPath":".","roots":["src","packages/ui/src","packages/core/src"]}'
```

### 项目根识别（定位任意目录均可分析）

CLI 对项目根的识别是多向的——用户定位到代码子目录、子项目目录或融合仓库根，周边的项目信息都会被识别并处理：

- **上级宿主**：定位 `src/` 等代码子目录时向上定位宿主项目根（package.json / pubspec.yaml / go.mod，上限 4 层），读取宿主依赖清单、tsconfig 路径别名与构建配置（`hostRoot` / `hostConfigs` 字段）
- **子项目（subProjects）**：定位仓库根时发现一级子目录中的子项目（如 gin-vue-admin 的 `server/` + `web/`），npm 子项目依赖并入画像辅助框架判定；防误吸附——无 `.git`、无根清单且子项目超过 4 个的「代码集合目录」只报告不并入
- **兄弟项目（siblingProjects）**：定位子项目目录（`web/`）或代码子目录（`web/src`）时，向上定位仓库根（`.git` / `go.work` / `pnpm-workspace.yaml` / `lerna.json` / `nx.json`）后识别同级项目；只报告不并入扫描范围与依赖（显式定位仍是用户意图边界）
- **Go module 上级发现**：定位 Go module 子目录（如 `server/api`）时向上发现 go.mod（`goModule.dir` 以 `..` 相对形态表达），import 路径经折叠解析仍能正确建立 internal 文件边、路由 handler 关联与跨包调用链
- **子目录 go.mod**：融合仓库（`server/go.mod` + 前端 `web/`）从 `.go` 文件所在目录逐级向上发现全部 go.mod，多模块并存时全部依赖并入、主模块取源码最多者

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

### MySQL 数据库迁移脚本分析

支持 Flyway 风格的 MySQL 迁移脚本目录（`.sql` 文件）分析，产出独立的数据库模型和数据蓝图：

```bash
# 1. 扫描迁移脚本目录（产出 db-snapshot.json，与代码快照分离）
nice-aos db scan --dir /path/to/migrations

# 2. 查询数据库结构
nice-aos db query tables                              # 所有表
nice-aos db query tables --where "domain=auth"        # 按领域过滤
nice-aos db query tables --where "patterns~soft_delete"  # 按模式过滤
nice-aos db query foreignKeys                         # 外键关系
nice-aos db query migrations --where "version~V2.1"  # 迁移历史
nice-aos db query domains                             # 领域分组

# 3. 生成数据蓝图 HTML（自包含，含 SVG ER 关系图，5 Tab；默认 fresh-green 淡绿主题）
nice-aos db export --format html --output db-overview.html
nice-aos db export --format html --theme deep-blue --output db-overview.html  # 切换深蓝暗色主题

# 4. 增量扫描（仅处理新增/修改的迁移文件）
nice-aos db scan --dir /path/to/migrations --incremental
```

数据库模型对象：表（Table）/列（Column）/外键（ForeignKey）/索引（Index）/迁移（Migration）/领域（DbDomain）/视图（View）/触发器（Trigger）/存储过程（Procedure），自动检测模式特征（软删除/审计字段/多租户/自引用/UUID主键）和领域分组。

数据蓝图 HTML 内嵌 `<script id="db-viewer-data">` JSON 数据，蓝图 AI 助手（Tampermonkey 脚本）自动检测并切换至数据库分析模式。

### 部署配置目录分析

扫描项目部署目录（如 `./deploy`），解析 docker-compose / K8s manifest / Dockerfile / nginx.conf / .env / 部署脚本，产出独立的部署架构模型和部署蓝图：

```bash
# 1. 扫描部署配置目录（产出 deploy-snapshot.json，与代码/数据库快照分离）
nice-aos deploy scan --dir /path/to/deploy

# 2. 查询部署架构
nice-aos deploy query services                              # 所有服务
nice-aos deploy query services --where "type=gateway"       # 按类型过滤
nice-aos deploy query routes                                # nginx 路由
nice-aos deploy query upstreams                             # nginx upstream
nice-aos deploy query dependencies                          # 服务依赖关系
nice-aos deploy query middleware                            # 中间件（MySQL/Redis/...）
nice-aos deploy query environments                          # 环境配置文件
nice-aos deploy query layers                                # 部署分层

# 3. 部署架构审计（5 大场景）
nice-aos deploy audit health          # 综合健康评分（安全/高可用/一致性/依赖 加权）
nice-aos deploy audit security        # 安全：latest 镜像/明文敏感值/端口暴露
nice-aos deploy audit resilience      # 高可用：健康检查/探针/副本/资源限额
nice-aos deploy audit consistency     # 配置一致性：环境漂移
nice-aos deploy audit dependency      # 依赖：断链/循环依赖

# 4. 生成部署蓝图 HTML（自包含，8 Tab，分层拓扑 + SVG 依赖图；默认 deep-blue 深蓝主题）
nice-aos deploy export --format html --output deploy-overview.html
nice-aos deploy export --format html --theme fresh-green --output deploy-overview.html  # 切换淡绿浅色主题

# 5. 增量扫描（无文件变化时直接复用快照）
nice-aos deploy scan --dir /path/to/deploy --incremental
```

部署模型对象：服务（Service，12 类：网关/前端/后端/适配器/任务/数据库/缓存/对象存储/搜索引擎/注册中心/可观测/CI-CD/工具）/路由（Route，nginx location → proxy_pass）/上游（Upstream）/依赖（Dependency，depends_on + 环境引用 + 路由推导）/中间件（Middleware，含版本与消费方）/环境（Environment，敏感值自动脱敏）/分层（Layer，9 层部署拓扑）。跨文件同名服务自动归一化合并，`${VAR:-default}` 镜像插值解引用。

部署蓝图 HTML 内嵌 `<script id="deploy-viewer-data">` JSON 数据，蓝图 AI 助手（Tampermonkey 脚本）自动检测并切换至「部署蓝图」智能体（12 个专属工具）。

### Java 后端服务蓝图（asdm-aos 快照）

基于 asdm-aos 工具产出的 Java 后端本体快照（`snapshot.json`，含包/类/接口/方法/调用关系/DDL 表/依赖）生成**后端服务蓝图**：模块架构 / 分层结构 / API 面 / 数据层 / 技术栈 / 代码质量 / 健康审计。模块规则**不硬编码**——首次构建从快照包结构动态推导并写入模块配置文件（`service-modules.json`），后续构建自动加载，切换后端项目无需改代码。本仓库已引入 `skills/asdm-aos-skill/SKILL.md`（asdm-aos 工具说明，CLI `aos`），**先扫描后转换**两步工作流：

```bash
# 0. asdm-aos 扫描 Java 后端 → 生成本体快照
aos --snapshot-dir <Java仓库>/.asdm/skills/asdm-aos-skill/data action refreshRepo \
  --params '{"repoPath":"<Java仓库>"}'

# 1. 一步出图（指定 asdm-aos 快照 json 路径直接生成服务蓝图 HTML）
nice-aos service export --snapshot <Java仓库>/.asdm/skills/asdm-aos-skill/data/snapshot.json --format html --output service-blueprint.html

# 2. 两步式：构建服务模型（保存 service-snapshot.json + 动态推导模块配置）
nice-aos service build --snapshot /path/to/snapshot.json

# 3. 查询后端服务模型
nice-aos service query modules                             # 模块（包/类/接口/方法/端点/职责）
nice-aos service query layers --where "key=controller"     # 分层
nice-aos service query endpoints --where "httpMethod=GET"  # API 端点
nice-aos service query tables --where "isOrphan=true"      # 孤儿表
nice-aos service query complexityHotspots                  # 高复杂度方法 TOP
nice-aos service query techStack                           # 技术栈判定

# 4. 健康审计（五维加权）
nice-aos service audit health        # 综合评分（复杂度/数据层/测试/分析质量/依赖）
nice-aos service audit all

# 5. 自定义模块规则（--module-prefix 临时覆盖 / --module-config 指定配置文件）
nice-aos service export --snapshot /path/to/snapshot.json --format html \
  --module-prefix '{"core":{"label":"核心","prefixes":["ai.asdm.admin.core"]}}'
```

服务模型对象：模块（Module）/分层（Layer，Controller/Service/Repository/Mapper/Entity/DTO/Config/Adapter/任务/工具）/图谱（ModuleGraph，模块依赖 + 分层调用流 + 模块×技术栈三类力导向图）/端点（Endpoint，HTTP 方法分布 + 领域前缀）/表（Table，实体映射/孤儿表/FK 链）/依赖（Dependency，技术栈分类）/复杂度热点（ComplexityHotspot）/数据模型（DataModel）/测试统计（TestStats）。

服务蓝图 HTML 内嵌 `<script id="service-viewer-data">` JSON 数据（9 Tab：总览/模块/分层/**图谱**/API 面/数据层/依赖与集成/代码质量/健康审计），图谱 Tab 含三种力导向视图——**模块图谱**（节点=服务模块，边=包依赖+跨模块调用）、**分层调用流**（节点=架构分层，边=跨层方法调用，如 Controller→Service→Repository→Entity）、**模块×技术栈**（节点=模块+技术分类，边=模块使用该技术）。模块配置 `service-modules.json` 与 `service-snapshot.json` 均落在服务快照目录（默认 `.nice-aos/data`）。蓝图 AI 助手（Tampermonkey 脚本）自动检测 `service-viewer-data` 并切换至「服务蓝图」智能体（10 个专属工具：概览/模块/分层/端点/表/依赖技术栈/代码质量/健康审计/审计明细/图谱查询）。

### 蓝图主题风格

四类蓝图（代码 blueprint / 数据 dataoverview / 部署 deployoverview / 服务 service-blueprint）的 CSS 已拆分为「主题 token + 共享骨架 + 查看器专属布局」：布局骨架固定，视觉风格经 `--theme` 切换（主题注册表 `src/themes/index.js` 可扩展）。健康审计评分为炫彩 SVG 能量环——渐变弧 + 辉光滤镜 + 加载动画，环配色随主题（深蓝:紫→绿 / 淡绿:淡绿→深绿 / 典雅紫:紫→粉）。

| 蓝图 | 默认主题 | 命令 |
|------|---------|------|
| 部署 deployoverview | deep-blue | `deploy export --theme <name>` |
| 数据 dataoverview | fresh-green | `db export --theme <name>` |
| 代码 blueprint | deep-blue | `export --theme <name>` |
| 服务 service-blueprint | elegant-purple | `service export --theme <name>` |

可用主题：`deep-blue`（深蓝暗色）/ `fresh-green`（淡绿清新）/ `elegant-purple`（典雅紫）。

## 本体模型

### 概念分类体系（taxonomy）

18 种对象类型按「概念范畴」（is-a 族）与「抽象层级」（L0-L3）双维组织，而非平铺罗列：

| 抽象层级 | 名称 | 说明 | 类型 |
|---|---|---|---|
| L3 | 架构层 | 产品级聚合：整体架构画像与功能域划分 | Project, Domain |
| L2 | 结构层 | 代码组织结构：模块、文件、路由、脚本与运行环境 | Module, SourceFile, Route, UserScript, Dependency |
| L1 | 单元层 | 可独立理解的代码单元（CodeUnit 概念族） | Component, Hook, Store, Service, Interface, Class, Method, ScriptFunction, PropEdge |
| L0 | 事实层 | 审计事实（AuditFact 概念族）：从代码提取的行为证据 | GmApiUsage, InjectionPoint, NetworkEndpoint |

概念范畴：**Container**（Project/Domain/Module/SourceFile，按结构聚合）、**CodeUnit**（Component/Hook/Store/Service/Interface/Class/Method/ScriptFunction/PropEdge，可独立理解的逻辑单元与单元间关系边）、**EntryPoint**（Route，用户可触达的行为入口）、**Script**（UserScript，独立于宿主应用的脚本形态）、**Environment**（Dependency，外部环境要素）、**AuditFact**（GmApiUsage/InjectionPoint/NetworkEndpoint，安全审计原子事实）。

聚合节点（Project/Domain/Module）自动生成**职责画像与自然语言总结**（summary/architecture/health），避免"只罗列事实、没有抽象"。

### 对象（19 种）

| 类型 | ID 前缀 | 层级/范畴 | 关键属性 |
|---|---|---|---|
| Project | `proj:` | L3 Container | framework（flutter/dart/expo/react-native/next/nuxt/vue/react/**go**/userscript）, frameworkVariants（tauri/electron/capacitor/vite/riverpod/go_router 等变体）, frameworkLabel（组合标签）, language（TypeScript / TypeScript + Rust 等）, hostRoot/hostConfigs（宿主定位证据，扫描子目录场景）, **goModule**（module 名/Go 版本/所在目录，含子目录与上级形态）, **subProjects**（一级子目录中的子项目清单：path + kind go/npm/dart）, **siblingProjects**（定位子项目或代码子目录时的兄弟项目清单）, fileCount, tsxFileCount, vueFileCount, **rustFileCount/dartFileCount/goFileCount**, **tauriDetected/electronDetected/flutterDetected**, userScriptFileCount, commitHash, branch, **summary**（框架定位 + 分层画像 + 功能域清单）, **architecture**（语义分层占比）, **health**（循环依赖/死代码四级/未声明依赖/高风险脚本/解析错误）, analysisErrors |
| Domain | `dom:` | L3 Container | **name, sources**（route/module）, routeCount, componentCount, storeCount, scriptCount, fileCount, lineCount, **capability**（路由能力描述）, **summary**（职责画像） |
| Module | `mod:` | L2 Container | path, **archLayer**（语义架构层）, **layerComposition**（子树层构成）, fileCount, **subtreeFileCount**, parentId, **unitCounts**, **routeCount**, **summary**（职责画像） |
| SourceFile | `file:` | L2 Container | path, **archLayer**, lineCount, isTest, isEntry, importIds, exportNames, **unusedExports**（导出级死代码候选） |
| Component | `comp:` | L1 CodeUnit | kind（page/modal/card/…）, propsCount, **propsNames**（解构 props 名清单）, hooksUsed, stateCount, rendersIds, routeIds, **propOutCount/propInCount**（props 传递出入度）, **archLayer**, **domainIds** |
| Hook | `hook:` | L1 CodeUnit | name, filePath, lineCount, description（React Hook 与 Vue composable 统一归属）, **archLayer**, **domainIds** |
| Store | `store:` | L1 CodeUnit | stateKeys, actionKeys, hasPersist, storageKey, **providerType**（zustand/pinia/vuex/riverpod 状态库类型）, location, **archLayer**, **domainIds** |
| Service | `svc:` | L1 CodeUnit | pattern（singleton/class/functions）, exportsCount, **archLayer**, **domainIds** |
| Interface | `iface:` | L1 CodeUnit | exported, **language**（ts/vue/rust/dart/**go**）, methodIds, extendsIds/extendsNames（接口继承，跨文件解析；Rust trait 的 supertrait → extends）, **isDataModel/dataModelType**（借鉴 asdm-aos：DTO/Model/Entity/Schema/Request/Response/Params/Input/Output/Form/Payload 后缀启发式 + `@Entity/@ObjectType/@InputType` 装饰器识别 → `orm-decorated`）, **deadCandidate/deadReason** |
| Class | `class:` | L1 CodeUnit | exported, **language**（ts/vue/rust/dart/**go**）, isSingleton, methodIds, implementsIds/implementsNames, extendsId/extendsName（跨文件解析，含 type-only 与别名导入；Rust struct/enum → kind 区分，含 fields/derives/variants；Dart Widget → **isWidget/widgetBase**，Dart Store → **isStore/withNames**；Vue 组件 → **`vclass:` kind=component**，props 为 fields、computed/methods 为 methods；**Go struct → kind=struct，字段含 json/yaml tag**）, **rendersIds**（组件组合）, **isDataModel/dataModelType**（同 Interface 的启发式 + 装饰器识别）, **deadCandidate/deadReason** |
| Method | `method:` | L1 CodeUnit | ownerKind（class/interface/module）, ownerName, isStatic/isAsync, signature（仅展示）, overridesId/overriddenByIds（接口/父类方法 ↔ 实现类方法双向）, **callIds/calledByIds/compCallIds**（Dart 方法逻辑调用链：方法间双向 + Widget 构造渲染链；**Go 包级/跨包/方法调用同构映射**）, exported（Rust impl fn 与模块级 fn 同构映射；**Go 首字母大写 = 导出**）, **deadCandidate/deadReason**（函数级死代码候选）, **health**（方法级健康度子对象：`complexity.cyclomatic/branches/maxNesting/throws/awaits/earlyReturns` + `lambdas.count/maxNesting/inJsx` + `testInfo.isTest/testType/testFramework/callsExpect/usesMock` + 派生 `risk` 评级 low/medium/high/critical —— 借鉴 asdm-aos 整合为统一画像）, **externalCalls**（识别函数体内 React Hooks / DOM API / 状态管理 API 的 `[{name, kind, framework, line}]`，不进 calls 链接）, **endpointInfo**（API 端点装饰器级识别 Next.js App Router / Pages Router / Nuxt 3：`{framework, method, path}`）, **sqlQueries**（从函数体提取的 SQL 表名 `[{kind, table, dynamic}]`，供 mapsToTable 链接） |
| ScriptFunction | `fn:` | L1 CodeUnit | kind（function/arrow/class/object/method）, lineCount, callCount, calledByCount, gmApiCalls, callIds/calledByIds, **deadCandidate/deadReason**（函数级死代码候选）, **archLayer=script** |
| Route | `route:` | L2 EntryPoint | overlayId, routePath, routeType（overlay/react/vue/flutter/**next/next-api/go/go-cli**）, domain, **domainIds**, componentFileId, navigatesToIds, **rawPath/layoutFileIds/specialFiles/isDynamic/isClient/apiMethods**（Next.js App Router 路由）, **hasPropsFactory/factoryProps**（overlay 路由 props 工厂注入键）, **middlewares/frontendCalls**（Go HTTP 路由中间件链 + 前端调用方溯源；go-cli 命令链与 flags 复用 specialFiles） |
| PropEdge | `prop:` | L1 CodeUnit | fromComponentId/toComponentId, fromFileId/toFileId, props（名称 + 来源分类 + valueText + storeHook）, renderCount（该组件对的渲染处数） |
| UserScript | `us:` | L2 Script | name, version, matches, grants, connects, hostFramework（vue/react/unknown）, riskLevel, isIife, usesStrict, unsafeWindowReads/Writes, **deadFunctionCount**, **archLayer=script**, **domainIds** |
| Dependency | `dep:` | L2 Environment | version, scope, source（npm/workspace/undeclared/pub/**go**）, importCount, **isTypeDefinition**（`@types/*` / `typescript` 类型定义包标记，借鉴 asdm-aos dependsOn 去噪；仅标记不隐藏） |
| GmApiUsage | `gm:` | L0 AuditFact | name, category（network/storage/style/…）, callCount, declared（与 @grant 比对） |
| InjectionPoint | `inject:` | L0 AuditFact | kind（mount/inner-html/insert-adjacent/document-write/style-gm/style-element/shadow-dom）, target, interpolated（动态插值 XSS 面） |
| NetworkEndpoint | `net:` | L0 AuditFact | kind（gm-xhr/fetch/xhr/websocket/beacon）, domain, urls, methods, allowedByConnect（与 @connect 比对） |

Method ID 约定：类/接口方法 `method:<file>#<Owner>#<name>`，模块函数 `method:<file>#<fnName>`；`query Method --where "name~xxx"` 一次命中接口签名、类实现与模块函数。

### 语义架构层（archLayer）

每个文件/模块推断一个语义架构层，**以内容信号为准**（单元构成、路由归属、引用结构），目录名仅作弱信号回退：

`entry`（入口）→ `presentation`（表现）→ `state`（状态）→ `service`（业务）→ `integration`（集成）→ `shared`（共享）→ `types`（类型）→ `config`（配置）→ `tauri`（Tauri 原生层，src-tauri Rust 代码强信号直判）→ `electron`（Electron 主进程，electron/ 目录强信号直判）→ `script`（油猴脚本）→ `test`（测试）→ `mixed`（混合，单一模块内构成分散、主导层 < 60% 时如实标记）

功能域（Domain）与架构层**正交**：架构层是纵向技术切片，功能域是横向业务切片（由路由域段 + 业务命名目录聚合而成）。

### 链接（22 种）

```
contains     Project → Domain/Module → SourceFile → Component/Hook/Store/Service/Interface/Class/Method/UserScript（类型实体也可从 iface:/class: 下钻其方法）
imports / importedBy    文件级依赖（含 dep: 外部包）— 变更影响分析主链路
renders / renderedBy    组件 JSX/template 渲染关系
passesProps  Component → Component / PropEdge → 两端组件（props 传递链：正向查某组件把 props 传给了谁；传 prop: 边 ID 返回两端组件）
navigatesTo  Route → Route（React 的 Navigate/overlay 跳转、Vue 的 router.push/replace、Flutter 的 context.go/push GoRouter 导航边）
registers    Route ↔ Component（路由注册）
usesStore / usesHook    Store/Hook 使用关系（src 传 store:/hook: 反查使用者）
implements / implementedBy    Class ↔ Interface 实现关系（双向：正向查类实现了哪些接口；反向查接口被哪些类实现 — 解决"实现关系记录在实现类里、从接口正向查不到"的断层）
extends / extendedBy    Interface/Class 继承关系（双向）
overrides / overriddenBy    Method 方法覆盖关系（双向：类方法 → 所实现的接口/父类方法；接口方法 → 全部实现）
usesGmApi    UserScript ↔ GmApiUsage（src 传 gm: 反查所属脚本）
injectsInto  UserScript ↔ InjectionPoint（DOM 注入点；src 传 inject: 反查所属脚本）
requestsTo   UserScript ↔ NetworkEndpoint（网络端点；src 传 net: 反查所属脚本）
calls / calledBy    ScriptFunction 调用图（脚本内函数间静态调用关系，双向）与 Dart Method 逻辑调用链（method: 前缀，含 Widget 构造渲染链）
belongsTo    功能域归属（双向：src 传 dom: 列出域全部成员；src 传 mod:/comp:/store:/hook:/route: 反查所属功能域）
```

## CLI 参考

### query — 查询对象

```bash
query Project                                        # 项目画像（summary/architecture/health）
query Domain --pretty                                # 功能域地图（横向业务切片）
query Route --all                                   # 全部路由
query Component --where "kind=page" --pretty        # 页面类组件，表格输出
query SourceFile --where "layer=services,isTest=false"
query Component --where "name~steam"                # ~ 模糊匹配（忽略大小写子串）
query Module --where "archLayer=state" --pretty     # 按语义架构层过滤模块
query Component --where "domainIds=dom:health"      # 按功能域过滤成员
query Dependency --where "source=undeclared"        # 未声明依赖（治理点）
query Store --where "hasPersist=true"               # 持久化 store
query UserScript --where "hostFramework=vue"        # Vue 宿主页面的油猴脚本
query UserScript --where "riskLevel=high"           # 高风险脚本
query GmApiUsage --where "declared=false"           # 未在 @grant 声明的 GM 调用（越权面）
query InjectionPoint --where "interpolated=true"    # 动态插值 HTML 注入（XSS 面）
query ScriptFunction --where "kind=class" --pretty  # 脚本内类（逻辑分布）
query Method --where "name~createinterface"          # 按名找方法：一次命中接口签名/类实现/模块函数
query Method --where "ownerKind=interface" --pretty  # 全部接口方法签名
query Interface --where "exported=true"              # 导出接口清单
query Class --where "isSingleton=true"               # 单例类
query Method --where "deadCandidate=true"            # 函数级死代码候选（保守判定）
query Interface --where "deadCandidate=true"         # 死接口（类型级）
query Class --where "deadCandidate=true"             # 死类（类型级）
query ScriptFunction --where "deadCandidate=true"    # 油猴死函数（函数级）
query PropEdge --where "id~SettingsOverlay" --pretty # 按组件名查 props 传递边（含来源分类）
```

`--where` 语法：逗号分隔多条件 AND；`k=v`（或 `k:v`）精确相等，`k~v` 模糊包含；值为数组时精确做成员包含、模糊做任一成员包含（如 `hooksUsed=useEffect`）。默认返回前 50 条，`--all` 全量、`--limit <n>` 限制。

### link — 遍历关系

```bash
link importedBy --src "file:src/services/exerciseService.ts"   # 变更影响分析
link renderedBy --src "comp:ExerciseReportPage"
link passesProps --src "comp:SettingsOverlay"        # 该组件把 props 传给了谁（数据流正向）
link passesProps --src "prop:SettingsOverlay→SettingsSection"   # 传递边两端组件
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
link belongsTo --src "dom:health"                              # 功能域 → 全部成员
link belongsTo --src "comp:HealthStatsPage"                    # 反查组件所属功能域
link implements --src "class:src/impl/localStorage.ts#LocalStorage"    # 类实现了哪些接口
link implementedBy --src "iface:src/types/storage.ts#IStorage"         # 接口被哪些类实现（反向）
link extends --src "class:src/core/repo.ts#UserRepo"           # 类继承的父类
link overriddenBy --src "method:src/types/storage.ts#IStorage#get"    # 接口方法的全部实现
link overrides --src "method:src/impl/localStorage.ts#LocalStorage#get"  # 实现方法覆盖的契约方法
link contains --src "iface:src/types/storage.ts#IStorage"      # 接口下钻其方法签名
```

### action — 受控动作

```bash
action refreshRepo --params '{"repoPath":"."}'
action refreshRepo --params '{"repoPath":".","silent":false}'   # 步骤化进度(scan:start/done / parse:done / resolve:done / build:done 5 步耗时,默认 silent=true 保持 JSON 单一输出)
action analyzeFile --params '{"file":"Steam-License-Classifier.js"}'   # 单文件分析（不落盘，stdout 输出本体 JSON）
action markReviewed --params '{"objectId":"comp:TalentResultPage"}'
action addNote --params '{"objectId":"comp:TalentResultPage","note":"核心页面"}'
```

`analyzeFile` 支持 .ts/.tsx/.js/.jsx/.mjs/.vue/.rs/.dart 与油猴脚本（相对 cwd 或绝对路径）；油猴文件输出 UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction 五类，其余文件输出 Interface/Class/Method；单文件模式下仅"本文件内零引用"的非导出实体判死（导出实体无法判定跨文件使用，一律不判死）。

### export — 导出

```bash
export --format markdown --output report.md     # Markdown 全景报告
export --format json | jq '._meta.cycles'       # JSON 供 jq 聚合
export --format html --output blueprint.html    # 自包含蓝图 HTML（本体查看器）
export --format viewmodel                       # 视图模型 JSON（聚合数据，供 agent 消费）
```

Markdown 报告含**执行摘要**（项目总结句 + 健康指标表）、**架构总览（语义分层）**（层/定位/文件数/占比）、**功能域地图（Domain）**（域/来源/路由/组件/Store/脚本/职责画像）、**接口与实现**（接口清单 + implementedBy 实现类 + 方法覆盖矩阵）、**类与方法**（类清单含 implements/extends/单例 + 契约热点 Top 30）与**死代码候选四级**（文件级 + 导出级 + 类型级 + 函数级）等章节，以及模块 Top 30（语义层 + 层构成 + 职责画像）。

### update — 版本检测与一键升级

```bash
nice-aos update --check   # 仅检测：输出 JSON（current / latest / upToDate / installMode）
nice-aos update           # 一键升级：全局安装时自动 npm install -g nice-aos@latest
```

安装模式自动判定（`installMode` 字段）：`global`（npm 全局安装，可直接一键升级；含 `npm install -g <本地目录>` 的符号链接形式，升级会替换为 registry 版本）/ `npx`（缓存运行，指引 `npx nice-aos@latest` 拉新）/ `local`（项目依赖，指引宿主项目内升级）/ `repo`（仓库源码运行，跟随 git）。检测用两个互补信号：调用入口路径（保留符号链接，`process.argv[1]`）+ 模块真实路径布局（`lib/node_modules/nice-aos` 强信号，覆盖 homebrew/nvm 多 prefix 环境）。

**Agent 前置校验约定**（三个 skill 的前置条件均要求）：npm 包方式（全局/npx）首次调用前先 `update --check` 确认最新版——分析能力随版本演进，旧版会缺失新对象类型/字段/命令；`update` 命令不存在说明版本 < 0.10.0，先执行一次 `npm install -g nice-aos@latest`；网络不可达时返回 `ok:false`（带 current 版本号），跳过升级不阻塞主流程。仓库内源码方式版本跟随 git，无需检测。

### serve — 本地数据源服务

```bash
nice-aos serve                          # 默认 http://127.0.0.1:8420，服务 <root>/.nice-aos/data 与 <root>/blueprint.html
nice-aos serve --port 39481             # 指定端口（传 0 自动分配可用端口）
nice-aos serve --dir path/to/data       # 显式指定快照目录（等价全局 --snapshot-dir / NICE_AOS_SNAPSHOT_DIR）
nice-aos serve --host 0.0.0.0           # 需要局域网访问时（默认仅本机 127.0.0.1）
```

为 AI agent / 油猴脚本 / 网页提供跨源 HTTP 数据源（全端点 CORS `*`）：

| 端点 | 内容 |
|------|------|
| `GET /snapshot.json` | 完整本体快照 JSON（`refreshRepo` 产物） |
| `GET /blueprint.html` | 蓝图页面（可直接浏览器打开） |
| `GET /api/status` | 服务状态：目录解析结果、快照/蓝图就绪状态、端点清单 |
| `GET /api/stats` | 快照统计摘要：项目名/框架/对象计数/循环依赖/死代码候选 |
| `GET /api/schema` | 本体元模型：`OBJECT_TYPES`（19 个）/ `LINK_TYPES`（24 个）/ `ACTION_NAMES`（4 个）+ 概念范畴与抽象层级（abstractionLevels / categories）+ prefix → type 反查映射，供 agent 自动发现能力 |
| `GET /` | 状态首页（HTML） |

就绪状态**每次请求实时探测**——"先起服务、后 `refreshRepo` / `export`"的工作流无需重启；快照缺失返回 404（附生成指引）、JSON 损坏返回 500。目录解析链：`--dir` → 全局 `--snapshot-dir` → `NICE_AOS_SNAPSHOT_DIR` → `<root>/.nice-aos/data`。典型配套用法见 [contrib/blueprint-ai-agent](./contrib/blueprint-ai-agent)。

### 本体查看器（blueprint HTML / viewmodel）

`src/ontology/viewer.js` 是本体体系的使用者视图层，数据流为：快照 DataMap → `buildViewerModel()`（数据聚合）→ `renderViewerHtml()`（视图渲染）。视图模型（JSON）独立于渲染，可被 AI agent 与其他前端直接消费：

| 视图 | 内容 | 回答的问题 |
|------|------|-----------|
| **总览** | 项目画像、本体蓝图（taxonomy 概念分类体系 + 15 种对象/链接类型 + 实例计数）、健康度 | 这个仓库是什么、本体里都有什么 |
| **领域蓝图** | 每个功能域的业务层级构成（script/presentation/service/…）、代码组织（模块清单）、单元清单（组件/Store/Hook/Service/脚本）与职责画像；纯脚本仓库自动切换为**意图功能域**（按函数意图分组：渲染注入/数据获取/状态存取/事件监听/元素构建/纯逻辑） | 各业务领域的层级关系与代码组织关系 |
| **业务数据图** | Store 数据枢纽（state/action 键、持久化、被哪些域使用）、跨域数据依赖、持久化状态汇总；无 Store 时自动切换为**脚本存储枢纽**（localStorage/sessionStorage/indexedDB/GM 存储信号 + 状态存取函数 + 宿主数据读取） | 业务数据在哪、谁依赖谁 |
| **业务逻辑流向** | 架构层间导入流向矩阵（行=来源层，列=目标层）、跨域依赖边、高扇入 Service/Store 枢纽；无模块导入时自动切换为**函数意图流转矩阵**（调用边按「调用方意图 → 被调方意图」聚合）+ 高扇入函数 | 业务逻辑怎么流、哪些节点是枢纽 |
| **路由地图** | **路由导航链 SVG 图**（节点按导航跳数分层：入口 → 1 跳 → 2 跳…，边框色 = 路由类型，悬停高亮相邻路由、点击查看详情含 use client/layout 链/API 方法）、路径层级树（动态段琥珀色高亮）、域分组、类型分布与入口/孤岛路由统计、全量路由清单表（导航去向/被导航双向）；覆盖 overlay / react-router / vue-router / Flutter GoRoute+原生 / Next.js App Router 全类型 | 页面怎么组织、怎么互相跳转：入口在哪、哪些路由是孤岛 |
| **组件数据流** | **Props 传递图 SVG**（BFS 分层：顶层容器 → 子组件，边标签 = props 数，节点边框色 = 所属域，悬停高亮相邻边、点击查看 props 明细含来源与 store hook）、props 来源分布（forward/state/store/handler/computed/literal/spread 七类）、高传出/高传入组件 Top 榜（props 分发枢纽 vs 消费方）、Props 传递边清单（含跨域标记与渲染处数）；域筛选与组件名/文件路径搜索；React JSX 与 Vue 模板绑定同构接入 | 数据怎么在组件间流动：谁分发 props、谁消费 props、某个 prop 从哪来 |
| **脚本蓝图** | 每个油猴脚本的**函数调用关系图**（SVG，从左到右为调用深度）、DOM 注入锚点、网络端点、函数业务角色分布（render/data/state/event/ui/logic） | 这个脚本怎么注入页面的：谁调谁、注入到哪个页面锚点、请求哪些域 |
| **实体类图** | **UML 风格类图**（SVG）：类框（名称 + 字段/变体 + 方法摘要，Rust struct 含 derives）、关系边（implements 虚线 / extends 实线 / renders 绿色实线（Vue 组件组合）/ 接口继承）、按派生层级分列布局；语言/类型/架构层分布条形图；模块/类型/语言/关键词过滤与实体清单表格；Vue 组件合成为 `«component»` 实体（props 为字段、computed/methods 为方法） | 类型体系长什么样：谁实现谁、谁继承谁、跨语言（TS ↔ Rust ↔ Vue 组件）实体各占多少、Vue 组件组合谁 |

生成的 HTML 自包含零依赖（数据内嵌为 JSON，无外链），可直接离线打开分享；大仓库单元清单带截断保护（计数保留全量）；**宽屏分档适配**（1600/1920/2240/2560px 断点扩展内容宽度并居中，SVG 图等比缩放不截断）；**油猴意图适配**：无 React/Vue 结构的纯脚本仓库三视图按函数意图重建，分析不出有效数据（纯功能增强脚本：单一意图/无调用流转/无持久化）时对应 Tab 自动隐藏，不显示空壳。

**脚本蓝图（逻辑注入链）**是油猴脚本开发者的核心视图：函数节点按调用深度分层布局，实线为函数调用、青色虚线为 DOM 注入（指向还原后的页面锚点如 `querySelector('#app')`）、紫色点线为网络请求（指向域名端点）；悬停高亮相邻节点、点击查看函数详情（角色/行号/调用关系/注入目标）。注入点与网络端点均携带**归属函数**（`fns`/`fnIds`），配合函数业务角色（按函数内行为推断：innerHTML/挂载 → render，网络请求 → data，GM 存储/localStorage → state，监听/观察/定时 → event，createElement → ui），一图直读"入口函数 → 调用链 → 注入锚点/网络域"的完整逻辑注入链。

## 解析能力

- **导入解析**：tsconfig `paths` 别名（`@/*` → `src/*`）、vue.config.js `configureWebpack.resolve.alias`、jsconfig.json paths、子路径别名、相对路径 + 扩展名探测（.ts/.tsx/.js/.jsx/.vue/.dart/index.*）、`.js` → `.ts` 回退；vue-cli 项目（vue.config.js + `src/`）自动兜底 `@/* → src/*`；Dart `package:/dart:` 导入（`package:自身包名/...` → 项目内 lib/ 路径，其余 → pub 依赖；`dart:` 内置库跳过；无 `./` 前缀的裸相对导入同样解析）；资产后缀（css/png/svg…）跳过；tsconfig.json 含 `//`/`/* */` 注释也能解析（自动剥离）
- **组件识别（React）**：`.tsx` 导出的 PascalCase 符号；支持 `export default function X`、`export const X: React.FC`、分离式 `export default X`、`memo()/forwardRef()` 包装；kind 按名称后缀推断（Page/Modal/Card/…），`pages/` 目录下被路由直接引用的组件自动升级为 page
- **组件识别（Vue）**：`.vue` SFC 整文件即组件；`defineOptions({ name })` 与 `<script setup name="X">` 属性优先，否则文件名派生（`index.vue` → 目录名）；`defineProps` 数组/对象形式计数；template 标签（kebab/PascalCase 统一）供 renders 关系
- **Hook/Composable 识别**：导出的 `useXxx` 符号（含 React Hook 与 Vue composable），含 JSDoc 描述提取
- **Store 识别**：Zustand `create(...)`（含 `create<T>()(...)`、`persist(...)` 包装）、Pinia `defineStore(...)`（setup 写法 + options 写法，含 `persist` 插件第三参数）与 Vuex 模块（对象字面量 / `new Vuex.Store({})` / shorthand 引用），统一提取 state/action 键与 storageKey，并携带 `providerType`（zustand/pinia/vuex）区分状态库
- **Service 识别**：`/services/` 目录或名称含 Service/Engine/Manager/Repository/Factory 后缀
- **类型实体（Interface/Class/Method）**：接口/类/方法/模块函数全量提取；跨文件 `implements`/`extends` 解析（本文件声明优先，其次具名导入——含 `import type` 与 `IStorage as StorageContract` 别名导入，解析失败留存原名不报错）；方法级 `overrides`/`overriddenBy` 双向链接（实现类方法与接口/父类方法按名匹配）；`query Method --where "name~xxx"` 一次命中声明与实现
- **Rust 实体（Tauri src-tauri，独立解析器）**：`rustAnalyzer` 与 tsAnalyzer/vueAnalyzer 平级共存——`pub struct`/`pub enum` → Class（kind: struct/enum，含 fields/derives/variants）、`pub trait` → Interface（supertrait → extends）、`impl` 块内 `fn` → Method（ownerKind=class）、模块级 `fn` → Method（ownerKind=module）、`use` → imports；跨文件路径解析以 `use crate::a::B` 模块路径映射为主、全仓库唯一名匹配兜底（含 `use a::{B, C}` 花括号组与 `super::` 相对路径）；Rust 类型引用即使用（`Vec<Game>` / `-> Game` / `impl Game` 均计入引用），同样参与类型级死代码判定
- **Dart/Flutter 实体（lib/ 组件，独立解析器）**：`dartAnalyzer` 轻量语法级解析（深度状态机 + 等长噪声剥离）——`abstract class` → Interface、`class/enum/mixin` → Class（extends/implements/with 关系、字段、方法）、类方法/顶层 fn → Method；**Widget 基类（StatelessWidget/StatefulWidget/ConsumerWidget 等）→ Component（kind: page/widget，dartdoc 描述提取，文件名匹配主组件）**；**ChangeNotifier/Notifier 子类与 Riverpod Provider 变量（`final xxxProvider = NotifierProvider<...>.new(...)`，含 notifierClass 提取）→ Store（stateKeys/actionKeys）**；`GoRoute(path/builder)` → dartRoutes（路径常量引用回填，builderWidget 跨文件组件解析）；`context.go/push('/path')` → overlayOpens → 路由导航边；方法体内调用 → callEdges → **Method 逻辑调用链**（本类方法/顶层函数/跨文件静态方法双向链接 + Widget 构造 → compCallIds 渲染链）
- **客户端组件自动发现（Tauri/Electron/Flutter）**：显式 roots 之外自动发现项目内的客户端组件——`src-tauri/tauri.conf.json` 存在时把 `src-tauri/src` 纳入扫描（.rs 文件），`electron/` 目录含 TS/JS 文件时纳入扫描，`pubspec.yaml` + `lib/` 存在时把 `lib` 纳入扫描（.dart 文件，monorepo 多包递归发现）；`tauriDetected`/`electronDetected`/`flutterDetected` 落到 Project 画像，架构层新增 `tauri`（Rust 原生层）与 `electron`（主进程层）强信号直判；`.rs` 仅在 Tauri 组件语境下扫描，Go 代码见下方「Go 适配」章节（Java 等其他后端暂不在扫描范围）
- **死代码候选（四级）**：文件级（零引用 + 非入口 + 非测试 + 非路由组件，`_meta.orphanCandidates`）+ 导出级（导出符号全仓库零导入且本文件零使用 → `SourceFile.unusedExports` / `_meta.deadExportCandidates`，入口/re-export/动态 import 豁免）+ 类型级/函数级（保守引用计数：非导出实体本文件零引用、导出实体全仓库零导入且本文件零引用 → `deadCandidate/deadReason`；接口方法为契约声明永不判死；排除声明处与自递归，宁可漏报不误报）；油猴 ScriptFunction 同样判函数级死代码（额外排除事件回调与 unsafeWindow 暴露）
- **依赖治理**：package.json / pubspec.yaml 声明 vs 实际导入交叉比对，产出 `source=undeclared`（导入未声明）与 `used=false`（声明未使用）
- **循环依赖**：Tarjan SCC 算法（`_meta.cycles`）
- **框架检测**：package.json 依赖优先（expo / react-native / next / nuxt / vue / react，元框架优先于基座框架）；`pubspec.yaml` + `lib/` → Flutter（依赖含 `flutter` sdk 时为 `framework=flutter`，纯 Dart 包为 `framework=dart`）；`go.mod` 存在且有 `.go` 源码 → `framework=go`（混合仓库前端文件仍各自解析）；扫描子目录（如 `src/`）时自动向上定位宿主项目根（上限 4 层、不越过用户 home），用宿主依赖识别框架并回退项目名，宿主配置文件（capacitor.config / app.json(expo 键) / vite.config / electron 等）作旁证；跨端/构建变体（Capacitor/Electron/Vite/Webpack/Riverpod/GoRouter 等）组合为 `frameworkLabel`（如 "Flutter 应用 + Riverpod 状态管理（GoRouter 路由）"）；无任何清单时按代码信号兜底（.vue → vue，tsx/jsx → react）；存在油猴脚本且无前端框架 → `framework=userscript`

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

### React Router 数据路由（6.4+ createBrowserRouter，自动探测）

项目若使用 `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` 数据路由（如 steam-game-library 的 `router/index.tsx`），对象树 `[{ path, element, index, children }]` 自动提取：

- 路由条目：`index: true` 以父路径产出；子级相对 path 与父路径拼接（`'/'` 布局 + `'games/:id'` → `/games/:id`）；有 `children` 的布局对象自身不产出（与 JSX 无 path 布局同语义）
- 组件解析三级：import 引用 → `lazy(() => import('../pages/X'))` / `React.lazy` 包装变量（含 `.then((m) => ...)` 命名导出链）→ 本地包装函数（return JSX 最深组件递归展开）；`element: (<Suspense>...</Suspense>)` 括号包裹多行 JSX 正常解析；**包装函数调用** `element: withSuspense(X)` / `withPlatformGuard(X, 'platform')` 取第一个组件参数递归解析（steam-game-hub-2.0 惯例）
- 重定向路由：element 内直接 `<Navigate to="/x" replace />`（index 兜底 / catch-all `*` → `/*`）产出导航边，无组件关联
- 跳转边：`<NavLink to="/x">`（字符串或 `{ pathname }` 对象）字面量；数据驱动侧边栏 `to={item.path}` 动态引用时提取同文件常量表（NAV_ITEMS 数组）中全部 `path` 值；**常量成员引用** `{ path: ROUTES.DASHBOARD }`——同文件 `const X = { KEY: '/value' }` 对象表 + named import 跨文件轻量解析；**布局外壳导航闭包**——布局 componentFile 及其直接 import 的内部文件（如 Sidebar.tsx）的导航调用并入全部子路由（侧边栏对所有子页面可达）

### Next.js App Router 路由（文件约定式，自动探测）

`framework=next` 且存在含约定文件（`page/route/layout`）的 `app/` 或 `src/app/` 目录（后者优先）时自动提取：

- **页面路由**：`app/**/page.tsx` → Route（`routeType=next`），URL 按目录约定计算——路由组 `(group)` 与平行路由 `@slot` 段剔除出 URL、`_private` 段整目录不产出路由、`[id]` → `:id`、`[...slug]` → `:slug*`、`[[...slug]]` → `:slug?`（`isDynamic` 标记）
- **API 路由**：`app/**/route.ts` → Route（`routeType=next-api`），导出的 `GET/POST/PUT/...` 方法名收集为 `apiMethods`
- **layout 链**：`layout.tsx` 不单独成路由，而是沿真实目录链（外→内，含路由组层）收集进后代路由的 `layoutFileIds`；`loading/error/not-found/template/global-error` 记入 `specialFiles`
- **客户端标记**：page/route 文件头 `'use client'` 指令探测为 `isClient`（读不到文件时为 null）
- **跳转边**：page 文件内 `<Link href="/x">`（`next/link`，字符串或 `{ pathname: '/x' }` 对象形式）→ 目标路由的 `navigatesToIds`；layout/共享组件文件内的 Link 不归属路由（避免边爆炸），动态变量 href 不解析

### Vue 路由（vue-router + 文件路由，自动探测）

- **显式声明**：`router/modules/*.ts` 中 `RouteRecordRaw` 对象（path/name/meta.title/component 动态 import/Layout 函数包装/children 拼接），`component: () => import('@/views/x.vue')` 经别名解析到具体文件
- **文件路由**：`src/views|pages/**/*.vue` 未被显式声明时自动推导（`index.vue` → 父级路径，`[...all].vue` → catch-all）；`<route lang="yaml">` 的 meta（title/name/path）作为路由描述
- **跳转边**：`router.push('/path')` / 解构 `push` / `router.replace` 字面量调用（数组 push 不误报）

### Flutter 路由（GoRouter + 原生 routes Map，自动探测）

- **GoRoute 路由条目**：`GoRoute(path: '/x', builder: (context, state) => const XxxPage())` 全量提取；`path: AppRoutes.dashboard` 常量引用自动回填（`static const String dashboard = '/dashboard'`）；builder/pageBuilder 目标 Widget 支持直接形式、块形式与包装函数形式
- **原生路由表**：`Map<String, WidgetBuilder> routes = { '/x': (ctx) => const XxxPage() }`（MaterialApp `routes:` 命名路由）条目提取，深度感知扫描——builder 体内字符串（如 `arguments: {'tid': x}`）不误判为条目键，值取最后一个大写构造调用（`routeType=flutter`）
- **组件解析链**：builderWidget 经具名/通配导入解析到具体组件文件，回退本文件组件；Route 关联 `componentId`/`componentFileId`
- **跳转边**：任意 .dart 文件内 `context.go/push/replace('/path')` 与 `Navigator.pushNamed/pushReplacementNamed/popAndPushNamed`（`Navigator.of(context).pushNamed(...)` / `Navigator.pushNamed(context, ...)` 两种形式）字面量导航调用 → 该文件组件所属路由 → 目标路由（`navigatesToIds`）

### Props 传递链（React / Vue 组件数据流，自动探测）

`.tsx/.jsx` 中 PascalCase JSX 标签、`.vue` 模板中的组件标签（`:prop` 绑定 / 静态属性 / `v-model` / `.sync` / `@event` / `v-bind="obj"`），属性传递按**组件对聚合**为 PropEdge 对象（`prop:A→B`），每个 prop 携带**来源分类**（词法近似：组件声明范围 + 文件级变量表判定，非作用域精确分析）：

| 来源 | 判定（React） | 判定（Vue） | 说明 |
|------|------|------|------|
| `forward` | 标识符命中父组件解构 props 名 | 标识符命中本组件 props 声明（Options API `props` / setup `defineProps`） | 父组件 props 透传（设置面板批量下发的 state/setter 对典型形态） |
| `state` | 标识符为组件内 `useState` 解构首元素 | 标识符命中 data() 键或 setup 内 `ref/reactive` 声明变量 | 本地状态下发 |
| `store` | 标识符为非 builtin hook 变量（`useXxxStore`/`useQuery` 等） | 标识符命中 mapState/mapGetters 提取键、setup 内 store 变量或 `storeToRefs` 解构名 | 状态库数据源，附 `storeHook` 溯源（Vue2 为 Vuex 模块名、Vue3 为 Pinia store 变量） |
| `handler` | 内联函数或本地函数引用 | 标识符命中 methods 键或 setup 函数声明（含 `@event` 回调） | 事件回调 |
| `literal` | 字符串/数字/布尔/裸属性（`disabled` = true） | 静态属性 `max="10"` / 裸属性 `clearable` | 常量配置 |
| `computed` | 其余表达式 | 标识符命中 computed 键或 setup `computed()` 声明，其余表达式 | 计算值 |
| `spread` | `{...obj}` 整体透传 | `v-bind="obj"` 整体透传 | 不展开成员，单条 spread 边 |

- **聚合规则**：同一组件对的多处渲染聚合为一条边（`renderCount` 计渲染处数）；同名 prop 出现多种来源时取优先级最高者（forward > state > store > handler > computed > literal > spread）
- **组件出入度**：Component 附 `propOutCount`/`propInCount`（传出/传入边数），配合 viewer「组件数据流」视图识别 props 分发枢纽与消费方
- **路由工厂注入**：overlay 路由的 `props: (app) => ({ item: app.item })` 工厂函数提取注入键为 `factoryProps`（App → 工厂 → 页面组件的主干注入链，在路由地图以「工厂 N props」徽章展示，不计入组件间 PropEdge）
- **Vue 组件标签解析**（Options API 与 setup 通用）：局部 `components` 注册表 → import 索引（local 名 + PascalCase 双键，default 导入取目标文件 primary 组件；`defineAsyncComponent(() => import(...))` 与 React.lazy 包装的 const 变量同样进索引）→ `main.js` 的 `Vue.component()` 全局注册兜底 → 同文件兜底；kebab-case 标签 / camelCase 导入名 / 文件派生名（`day.vue` ↔ `CrontabDay`）均可对齐
- **边界**：路由库组件（Link/Navigate/Outlet/router-link 等）、element-ui `el-` 前缀、Ant Design Vue `a-` 前缀、原生 HTML / Vue 内置标签与指令属性（v-if/v-for/ref/class/style 等）跳过；自渲染（递归组件）不成边；Dart 组件暂不采集

### Vue 2 适配（Options API，RuoYi 类中后台）

- **Options API 解析**：`export default {}` / `Vue.extend({})` / `defineComponent({})` 提取 props（对象/数组/混合形式，含 type）、data（对象/函数/方法形式）、computed/methods 键集、components 局部注册表
- **Vuex store**：`/store/` 目录或导入 vuex 的文件，default export（对象字面量 / `new Vuex.Store({})` / shorthand 引用顶层 const）提取 stateKeys + actionKeys（actions + mutations 合并）为 Store 实体（`providerType=vuex`）
- **类视图实体（vclass）**：每个 `.vue` 文件 primary 组件合成为 `kind=component` 的 Class 实体——props 为字段（含 type）、computed + methods 为方法实体；组件组合关系回填为 vclass 间 renders 边，在「实体类图」以绿色实线箭头呈现
- **导航**：`<router-link to="/path">` 静态路径与 `this.$router.push('/path')` 产出路由导航边（动态 `:to` 表达式不可静态解析，跳过）
- **别名解析**：vue.config.js `configureWebpack.resolve.alias` 与 jsconfig.json paths；vue-cli 项目（存在 vue.config.js + `src/`）自动兜底 `@/* → src/*`

### Vue 3 适配（SFC + `<script setup>` + Pinia，Snowy 类中后台）

- **script setup 变量域**：`<script setup>` 内 `ref/shallowRef/reactive/shallowReactive/customRef/toRef` → state 键、`computed()` → computed 键、函数声明与 const 函数 → method 键、`storeToRefs(...)` 解构名与 store 实例变量 → store 键（附 Pinia store 名溯源；hook 命名兼容 `useXxxStore` 与 `xxxStore` 双形态，`storeToRefs(store)` 变量参数同样溯源），变量域统一进入模板绑定的 props 来源分类与 vclass 类视图实体输入
- **组件命名**：`<script setup name="X">` 属性（vite-plugin-vue-setup-extend）与 `defineOptions({ name })` 均优先于文件名派生
- **Pinia store**：`defineStore('name', setup/options)` 两种写法统一提取 stateKeys/actionKeys，Store 实体携带 `providerType=pinia`（Zustand 同理 `zustand`），蓝图「业务数据图」与「Store 一览」展示 provider 类型徽章
- **异步组件**：`const X = defineAsyncComponent(() => import('./x.vue'))` 与路由 `const X = () => import(...)` 顶层 const 懒加载包装统一进组件解析索引，模板标签 `<X />` 正常建立 renders 关系与 Props 传递边
- **Vite 动态注册豁免（死代码防误报）**：`import.meta.glob(['/src/views/**.vue', '!/src/views/auth/**.vue'])` 模式采集（含 `!` 排除段、相对路径模式），命中文件豁免孤儿候选；vite.config.mjs 的 `unplugin-vue-components` `dirs`（自动注册组件目录）与 `unplugin-auto-import` `dirs` 同样豁免
- **Ant Design Vue 排除**：`a-` 前缀标签（a-table/a-button 等）不进组件标签集与传递链，与 element-ui `el-` 前缀同规则

### Go 适配（CLI / agent 代理 / Gin 后端 + 前后端融合仓库）

独立的 `goAnalyzer` 轻量语法级解析器（深度状态机 + 大括号配对，不依赖 gopls/tree-sitter），适合 cobra CLI、agent 代理类小程序与「Go 后端 + 前端」融合仓库（如 one-api 类项目）：

- **项目识别**：`go.mod` 存在且有 `.go` 源码 → framework=`go`；`require` 段（分组块与单行）解析为 Dependency（`source=go`）；`vendor/`、`testdata/`、`bin/` 自动跳过
- **实体映射**：`struct` → Class（`kind=struct`，字段含 `json/yaml` tag 与匿名内嵌）、`interface` → Interface（含嵌入接口 extends）、方法/顶层函数 → Method（大写导出判定 exported）、package 目录 → Module、Go 包 = 目录（同包跨文件方法合并，如接收者在另一文件声明的 `goOrphanMethods` 回填）
- **CLI 命令树（cobra）**：`var xxxCmd = &cobra.Command{Use/Short}` + `rootCmd.AddCommand(xxxCmd)` 边 → Route（`routeType=go-cli`，routePath 为 `smartide k8s init` 式命令链）；`Flags()/PersistentFlags()` 注册的 flag 提取为 `-T/--type` 徽章；跨包限定子命令（`hostCmd.AddCommand(host.HostGetCmd)`）经 import 定位目标包目录归一
- **HTTP 路由（Gin / 标准库）**：`router.Group("/api")` 前缀累积 + `.GET/.POST/.PUT/.DELETE/.PATCH/Any("/path", ...)` → Route（`routeType=go`，apiMethods + `:param`/`*wildcard` 动态段标记）；handler 函数值（`controller.GetSelf`）经 importMap 定位包目录关联到 Method；组级 `apiRouter.Use(middleware.Auth())` 中间件按前缀链继承 + 内联中间件合并；`Handle("GET", ...)` 与 `http.HandleFunc` 标准库形式兜底
- **逻辑走向（调用链）**：包级函数跨文件互调（同包无需 import）+ `pkgAlias.Func()` 跨包调用（importMap 定位）+ 方法体内调用（接收者/参数/构造字面量类型推断，词法近似）→ Method 的 `calls/calledBy`；Method 死代码候选按包级标识符引用判定
- **前后端逻辑映射（融合仓库核心价值）**：tsAnalyzer 提取前端 `API.get/post/put/delete('/api/...')`、`axios.x()`、`fetch()`（含模板串 `` `/api/user/${id}` ``）调用 → 与 Go 路由路径匹配（`:param` 通配任意段、`*wildcard` 吞尾段、去 query、尾斜杠归一）→ Route.frontendCalls（文件+行号+method 溯源）；未匹配调用进 `_meta.unmatchedFrontendCalls` 清单（路由地图「未匹配的前端调用」面板，用于发现死接口/路径漂移/外部 API）
- **架构层**：`main.go`/`cmd/` → entry，`router/controller/middleware/handler/api` → presentation，`model/dal/dao/repository/relay/service/biz/domain` → service，其余 → shared
- **路由地图增强**：Go HTTP 路由（方法徽章 + 中间件链 + 前端调用数）与 Go CLI 命令（路径层级树按命令段嵌套，flags 见详情）统一进既有路由地图视图；域取首个业务段（跳过 `api/v1` 网关前缀）

### 油猴脚本（Tampermonkey UserScript，自动探测）

独立的 `userScriptAnalyzer` 解析器，与 React/Vue 解析器平级共存、逻辑互不干扰：油猴文件不产出 Component/Store/Route，而是产出 UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction 五类对象（React/Vue 项目内混入的油猴脚本同样被识别，framework 仍以宿主框架为准）。

- **脚本识别**：`.user.js` 扩展名（强信号），或 `.js` 文件头部 4KB 内含 `// ==UserScript==` 元数据块（如 `steam-friend-manager-1.3.12.js`）
- **元数据解析**：`@name/@version/@match/@include/@exclude/@grant/@connect/@require/@resource/@run-at/@noframes` 等字段全量提取（`@grant none` 归零处理）
- **函数使用与逻辑分布**：IIFE 体内顶层函数/箭头函数/类（含 `constructor`）/常量对象（含对象方法 `storage.get`、类方法 `Xxx.render`）作为逻辑单元；每个函数统计行数、GM 调用、DOM 操作、网络调用、监听器、定时器；建立函数间静态调用图（`calls`/`calledBy` 双向，覆盖直调 / `this.method()` 类内互调 / `const app = new Xxx(); app.method()` 实例变量调用 / `new Xxx()` 构造入口）与 IIFE 顶层调用链；按函数内行为推断**业务角色**（innerHTML/挂载 → render，网络请求 → data，GM 存储 → state，监听/观察/定时 → event，createElement → ui，其余 → logic）
- **GM API 审计**：`GM_*` 与 `GM.*`（GM4 风格）两种调用风格统一归一；调用次数/行号统计，并与 `@grant` 声明交叉比对（未声明 → `declared=false`，`@grant none` 下任何调用均标记风险）
- **DOM 注入**：`innerHTML/outerHTML/insertAdjacentHTML/document.write`（含动态插值标记 → XSS 面；receiver 为 `querySelector/getElementById` 变量时还原为页面锚点选择器）、`appendChild/insertBefore` 等挂载（同样做变量锚点还原）、`GM_addStyle`、`document.createElement('style')`、`attachShadow` Shadow DOM；每个注入点/网络端点记录**归属函数**（`fns`/`fnIds`），构成"函数 → 页面锚点/请求域"的逻辑注入链
- **请求与劫持**：`GM_xmlhttpRequest`（URL/method 提取 + `@connect` 域名白名单比对）、`fetch`/`XHR.open`/`WebSocket`/`sendBeacon` 调用域名；`window.fetch`、`XMLHttpRequest.prototype.open/send`、`EventTarget.prototype.addEventListener`、`WebSocket`、`history.pushState/replaceState` 原型/全局重写识别为请求劫持
- **沙箱与宿主交互**：`unsafeWindow` 读/写属性区分（写 → 中风险）、`window.X = ...` 全局暴露、`Object.defineProperty(window, ...)`；`__vue__`/`__reactContainer$` 等标记推断宿主框架（vue/react/mixed/unknown）
- **风险清单**：请求劫持、eval/new Function 动态执行、cookie 读写、unsafeWindow 读写、动态插值 HTML 注入、未声明 GM API、未列入 @connect 的请求域名 —— 按 high/medium/low 汇总为脚本级 `riskLevel`

## 已知限制

- 基于 TypeScript Compiler API 的**语法级**解析（不跑类型检查）；动态拼接的 import 与动态 `navigate(path)` 变量导航无法解析
- 类型实体提取覆盖 `.ts/.tsx/.js/.jsx` 与 `.d.ts`；Vue 组件以 `vclass` 类视图实体呈现（props/computed/methods 同构映射）；**Vue SFC `<script>` 内声明的 interface/class 本期不提取**；TS 方法级调用图（calls/calledBy）未扩展到 Method（调用图仅油猴 ScriptFunction 与 Dart Method 有）
- Rust 解析为轻量语法级（深度状态机 + 等长噪声剥离，不依赖 rustc）：泛型约束 / 关联类型 / macro 生成代码不解析；`mod` 声明文件树按目录约定映射（`mod models;` → `models.rs` 或 `models/mod.rs`）；`.rs` 文件仅在 Tauri 组件语境下扫描，独立 Rust 工程（纯后端 crate）不纳入
- Dart 解析为轻量语法级（深度状态机 + 等长噪声剥离，不依赖 analyzer）：泛型方法/闭包体内声明、动态拼接路由 path、`Navigator.push(MaterialPageRoute(...))` 导航不解析；构造器不实体化为 Method；调用链为静态提取（变量间接调用/回调透传不解析）
- Go 解析为轻量语法级（深度状态机 + 双通道噪声剥离，不依赖 gopls）：泛型（type parameters）不解析（两参考项目均为 Go 1.17/1.18 前风格）；调用链为静态提取（变量间接调用/回调透传/goroutine 内闭包捕获不解析）；cobra `Run` 内联闭包不实体化为 Method；前端 httpCalls 限定 `API.x/axios.x/fetch` 标识符 + 字符串字面量首参（变量拼接 URL 取静态前缀，完整外链 URL 进未匹配清单）；Java/Python 后端不在扫描范围
- 跨文件 implements/extends 按具名导入静态解析；命名空间导入、`export *` 再导出与动态 `import()` 的目标文件整体豁免死代码判定（无法按名追踪，保守不误报）；仅被测试文件使用的导出符号会被判为死代码候选（测试文件不入扫描范围，删除前请人工确认）
- `renders` 归属文件主组件（default export 优先），同文件多组件不细分
- 函数透传式导航（`onOpenOverlay: app.setActiveOverlay`）不产生跳转边
- Vue 适配覆盖 Vue 3 SFC（`<script setup>` 变量域 / Pinia setup 与 options 写法 / defineAsyncComponent / import.meta.glob 与 unplugin 目录豁免）、vue-router、unplugin-vue-router 文件路由与 unplugin-auto-import 隐式导入；Vue 2 Options API（props/data/computed/methods/components、Vuex 模块、Vue.component 全局注册、element-ui 排除、@ 别名）已支持；Nuxt 专属约定仅部分支持；Vue 模板动态 `:to` 导航与作用域插槽透传不解析；`import.meta.glob` 高阶用法（函数形式 `{ eager: true }` 的具名导出、多变量别名）不展开
- 油猴脚本：调用图为脚本内静态调用（变量间接调用/回调透传不解析）；动态拼接的请求 URL 域名记为 `(dynamic)`，不做 @connect 比对；宿主框架仅按代码内 `__vue__`/`__reactContainer$` 等标记推断，未触碰宿主内部的脚本记为 unknown
- 快照为全量重建（无增量）；多进程并发写快照无保护；方法级实体化后大仓库（1000+ 文件）快照体积约增至 2-3 倍（万级 Method 实体），全量 JSON 载入仍在数百毫秒级
- `--where` 为全表扫描：`=`/`:` 精确相等、`~` 模糊包含（不支持数值比较，数值过滤请配合 jq）

## Skills（AI agent 场景工作流）

CLI 保持原子普适（只提供对象/链接/字段/动作级通用能力），场景工作流下沉到 Skill。npm 包携带五个 SKILL.md（`skills/**`），随包分发：

| Skill | 职责 | 典型场景 |
|-------|------|---------|
| `nice-aos`（核心查询） | 快照构建、通用本体查询、变更影响分析、接口/类/方法导航、蓝图导出 | "项目架构是什么样" / "IStorage 被谁实现" / "修改这个 service 影响谁" |
| `nice-aos-userscript`（油猴审计） | GM API 越权 / @connect 白名单 / XSS 面 / 风险分级五步审计 + 修复模板；单文件与仓库双模式 | "这个油猴脚本安全吗" / "@connect 齐不齐" / "哪里有 XSS 面" |
| `nice-aos-deadcode`（死代码清理） | 四级死代码（文件/导出/类型/函数）检测 → 分级复核 → 清理 → 验证工作流；单文件死函数查询 | "哪些文件没人用" / "哪些函数没人调用" / "这个文件能删吗" |
| `nice-aos-database`（数据库分析） | MySQL 迁移脚本扫描 → 表/列/外键/索引/迁移/领域/模式特征查询 + 7 大审计（健康度/影响/领域耦合/索引优化/演进/外键链路/命名）+ dataoverview 蓝图 | "数据库有哪些表" / "外键关系" / "索引优化建议" / "哪个版本变化最大" |
| `nice-aos-deployment`（部署分析） | 部署配置目录扫描（compose/K8s/Dockerfile/nginx/.env）→ 服务/路由/依赖/中间件/环境/分层查询 + 5 大审计（安全/高可用/一致性/依赖/健康度）+ deployoverview 蓝图 | "部署架构是什么样" / "nginx 路由怎么配的" / "哪些服务缺健康检查" / "用了哪些中间件" |
| `nice-aos-service`（Java 后端服务蓝图） | 基于 asdm-aos Java 后端本体快照（snapshot.json）→ 模块/分层/API 面/数据层/技术栈/代码质量查询 + 五维健康审计（复杂度/数据层/测试/分析质量/依赖）+ service-blueprint 蓝图（模块规则动态推导，切换项目免配置） | "这个 Java 后端有哪些模块" / "技术栈是什么" / "有多少 API 端点" / "哪些方法复杂度高" / "服务健康吗" |

五者共享同一份 CLI 与快照根目录（`<REPO_ROOT>/.nice-aos/data`：`snapshot.json` / `db-snapshot.json` / `deploy-snapshot.json` / `service-snapshot.json`），无独立安装步骤。

## Contrib（按需集成）

不进入 npm 包分发的可选周边，按需取用：

| 目录 | 说明 |
|------|------|
| [`contrib/blueprint-ai-agent`](./contrib/blueprint-ai-agent) | **蓝图页 AI 分析助手**（油猴脚本，Tampermonkey 安装）：在蓝图 HTML 右下角注入浮窗按钮展开对话侧边栏，按页面类型自动切换智能体——代码蓝图（模块/组件/Store/Service/路由/接口/方法/功能域/死代码，9 工具）、数据库蓝图（表/外键/索引/迁移/领域/模式特征 + 7 审计，双智能体）、部署蓝图（服务/镜像/路由/依赖/中间件/环境/分层 + 5 审计，12 工具）、后端服务蓝图（模块/分层/API 面/表/技术栈/代码质量/健康审计/图谱 + 五维审计，10 工具）。双数据源（页面内嵌 viewer-data / db-viewer-data / deploy-viewer-data / service-viewer-data 零依赖，或 `nice-aos serve` 本地快照地址），ReAct 文本协议工具循环驱动，支持多模型接入（DeepSeek/GLM/千问/Kimi/豆包/OpenAI/自定义）、新建会话、会话历史与 JSON/Markdown 导出 |

## 开发

```bash
npm install
npm test          # node --test 单元测试
node src/cli/index.js --help
```

## Roadmap（候选）

- `--where` 数值比较（`lineCount>500`）与索引
- 增量刷新（按 git diff 重新解析变更文件）
- Python 后端解析（Flask/FastAPI 路由，如 oneapi-service 类微服务，与前后端映射打通）
- Go 泛型（type parameters）解析与 TS 方法级调用图（calls/calledBy 扩展到 Method）
- 更新日志见 [CHANGELOG.md](./CHANGELOG.md)
