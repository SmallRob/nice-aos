# nice-aos — 让 AI 与开发者毫秒级读懂任意代码仓库

> 把 **React / Vue 2+3 / Flutter(Dart) / Go / Python / PHP / Kotlin / 油猴脚本** 仓库，以及 **MySQL 迁移脚本、Docker+K8s+nginx 部署配置、Java 后端本体快照、产品规划 PRD 文档**，扫描为可查询的**结构化本体快照**——架构分层、功能域、组件/Store/路由、接口与调用链、四级死代码、健康度画像，一应俱全。一条命令建快照，之后每个结构问题都是一次毫秒级查询，替代逐文件 grep。
>
> 本体按概念范畴与抽象层级组织（L3 架构 → L0 审计事实），架构分层以内容信号推断而非目录名直译；聚合节点自动生成职责画像与自然语言总结。底层借鉴 [asdm-aos](https://www.npmjs.com/package/@leansoftx/asdm-aos)（Java 本体分析）并针对前端生态重新建模。

## 30 秒上手

```bash
npm install -g nice-aos          # Node.js >= 18；免安装用 npx nice-aos ...
cd /path/to/your-project

# 1. 一条命令建快照（1000+ 文件约 3.5s → ./.nice-aos/data/snapshot.json）
nice-aos action refreshRepo --params '{"repoPath":"."}'

# 2. 用问题直接查答案
nice-aos query Project                                        # 项目画像 + 架构分层 + 健康度
nice-aos link importedBy --src "file:src/services/ai.ts"      # 谁导入了我（变更影响面）
nice-aos query Method --where "deadCandidate=true"            # 函数级死代码候选

# 3. 出一张给人看、给 AI 用的图与答案
nice-aos export --format html --output blueprint.html         # 离线可开的交互蓝图
nice-aos ask "这个项目的架构分层和功能域划分？"                # AI 自动带着全仓上下文回答
```

这只是 React 单页应用的冰山一角——Vue 2/3 中后台、Flutter App、Go CLI/Gin 后端与前后端融合仓库、PHP（zentaopms 类）与 Kotlin（Android/JVM）后端、油猴脚本安全审计、MySQL ER 图、部署拓扑各有专属章节，见 [解析能力](#解析能力)。

## 四个入口：问 / 出 / 服务 / 协议

nice-aos 的 13 个子命令收敛为 **4 个面向"人与 AI agent"的入口 + N 个领域型命令**：

| 命令 | 角色 | 一句话 |
|------|------|--------|
| `ask` | **输入** | 基于本体快照向 AI CLI 或模型服务提问；上下文 SQLite 预过滤毫秒级构建，CLI 超时自动降级到模型服务 |
| `output` | **输出** | Markdown 全景报告 / JSON / 自包含 HTML 蓝图 / viewmodel 视图模型 / **分层上下文文档树**（`output docs` → `.nice-aos/context/`，三明治 L1/L2/L3 md + docs.html 浏览器）（`output` 是 `export` 别名，两名等价） |
| `serve` | **服务** | 一行启动本地 HTTP 数据源（CORS `*`）：快照 JSON、蓝图 HTML、**`/docs` 项目文档在线浏览**与 `/api/*` 端点，供 agent / 油猴脚本 / 网页跨源拉取 |
| `mcp` | **协议** | 以 [MCP server](https://modelcontextprotocol.io) 把 7 个能力暴露为 tools，Claude Code / Cursor 等客户端**直接调用**——零上下文复制 |

领域型命令：`db`（数据库）/ `deploy`（部署）/ `service`（Java 后端）/ `planning`（PRD 规划）/ `overview`（多项目全景）；原子型：`query` / `link` / `action`；运维：`update` / `storage`。详见 `nice-aos --help`。

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
| 想让 codebuddy / opencode 带着项目上下文回答问题 | `nice-aos ask "这个项目有哪些功能域？"`（自动注入快照上下文） |

## 核心能力速览

- **多栈语义解析** —— React 19 / Vue 2 Options API（RuoYi 类中后台）/ Vue 3 SFC + Pinia / Flutter Widget + Riverpod / Go cobra+Gin 融合仓库 / Python FastAPI/Flask / PHP（zentaopms 类）/ Kotlin（Android/JVM）/ 油猴脚本，提取组件、Store（Zustand/Pinia/Vuex/Riverpod）、接口/类/Trait/方法、路由与 props 传递链等 **20 种对象、26 种关系**
- **关系图谱查询** —— `link importedBy / renders / navigatesTo / implements / calls ...` 双向遍历：变更影响分析、导航图、方法"声明+实现"一次命中
- **四级死代码 + 健康审计** —— 文件/导出/类型/函数级候选（保守判定宁漏报不误报）、Tarjan 循环依赖、未声明依赖治理，`deadcode` / `duplicates` / `io` 三个独立检测器开箱即用
- **五套领域审计器** —— 油猴安全（GM 越权/XSS 面/@connect）、数据库（7 大审计 + ER 图）、部署（安全/高可用/一致性/依赖/健康）、Java 服务（复杂度/数据层/测试/质量/依赖）、产品规划（PRD 四维健康）
- **自包含蓝图 HTML** —— `export --format html` 一键产出零依赖可离线打开的可视化蓝图：领域蓝图、业务数据图、逻辑流向矩阵、路由导航链 SVG、Props 数据流图、UML 类图；三套主题随心切换
- **AI agent 原生友好** —— `ask` 注入上下文问答（SQLite 预过滤 <50ms）、`serve` 开箱即用的 CORS 数据源、`mcp` 让 Claude Code/Cursor 直接调用，`export --format viewmodel` 输出聚合 JSON 供 agent 直接消费

## 更多上手姿势

```bash
# 单文件体检（不建快照，stdout 输出本体 JSON，可与 jq 管道组合）
nice-aos action analyzeFile --params '{"file":"Steam-License-Classifier.js"}' | jq '.ScriptFunction[] | select(.deadCandidate)'

# 结构完全相同的重复函数（AST fingerprint 分组）
nice-aos duplicates --min-size 20

# 敏感 API 使用扫描（fetch / eval / localStorage ...，数据驱动注册表）
nice-aos io --min-danger medium

# 版本升级（全局安装一键升级；--check 仅检测）
nice-aos update

# 本地数据源服务（AI agent / 油猴脚本跨源拉取）
nice-aos serve
```

> **快照目录解析优先级**：`--snapshot-dir` 参数 > `NICE_AOS_SNAPSHOT_DIR` 环境变量 > `cwd/.nice-aos/data` > `~/.nice-aos/data`。

## 深入

- 场景、本体、CLI、解析能力与已知限制：[docs/guide.md](docs/guide.md)
- 路线图（历史，0.33–0.36）：[docs/plan/aos-three-core-roadmap.md](docs/plan/aos-three-core-roadmap.md)
- 现行行为以 `nice-aos --help` 为准

体检不进日常入口：`nice-aos check deadcode|duplicates|io`。顶层 `deadcode` / `duplicates` / `io` 仍可用。

## 开发

```bash
npm install
npm test
node src/cli/index.js --help
```
