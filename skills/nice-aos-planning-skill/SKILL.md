---
name: nice-aos-planning
description: |
  产品规划 / PRD 文档蓝图分析技能。扫描"项目规划管理库"（如 asdm-product-management/docs）里的规划与
  过程文档（特性 PRD / 功能模块 / 迭代发布 / ReleasePlan / Roadmap 战略 / GTM 需求），抽取特性(FT)、
  模块、特性间依赖、发布与里程碑、战略主题等关键信息，产出归一化规划模型（planning-snapshot.json）与
  自包含蓝图 HTML（planning-overview.html）。
  规划蓝图含 7 Tab：总览（统计卡 + 状态/优先级/版本分布）／特性（可搜索筛选表格）／模块（模块卡片 +
  特性覆盖）／图谱（力导向：特性×特性依赖 / 特性×模块 双视图）／迭代与发布／Roadmap 与战略／审计
  （四维规划健康：覆盖完整性/状态健康/依赖风险/版本规划）。蓝图内嵌 <script id="planning-viewer-data">
  JSON，配合 contrib/blueprint-ai-agent 油猴脚本可在页面上进行自然语言问答（特性清单/模块构成/依赖/
  发布计划/Roadmap/规划健康度）。
  触发：用户说"分析产品规划/PRD 文档蓝图 / 规划蓝图 / planning blueprint / 有哪些特性 / 各状态多少 /
  特性依赖关系 / 模块构成 / 迭代发布 / Roadmap 战略 / 规划健康度"，
  或拿到一个产品/项目规划管理库文档目录，需要从 PRD 文档提取特性与模块关系、绘制规划图谱时。
  不做：Java 后端源码/服务蓝图分析（用 nice-aos-service skill）、前端代码本体（用 nice-aos skill）、
  数据库分析（用 nice-aos-database skill）、部署配置分析（用 nice-aos-deployment skill）、
  PRD 文案撰写/评审润色（超出蓝图分析范围）。
---

# Nice AOS Planning Skill — 产品规划 / PRD 文档蓝图

> 扫描**项目规划管理库**（特性 PRD、过程文档、迭代发布、Roadmap 战略），从 Markdown 文档提取
> 特性/模块/依赖/发布/里程碑/战略主题，产出规划模型快照（`planning-snapshot.json`）与自包含蓝图
> `planning-overview.html`（7 Tab + 图谱 + 规划健康审计），并内嵌 `planning-viewer-data` 供油猴问答。
> 子系统位于 `src/planning/`（模型 / 扫描器 / 快照 / 审计 / 查看器），CLI 命令位于 `src/cli/commands/planning.js`。

## 概述

**输入**：产品/项目规划管理库的文档目录（`docs/`），典型结构如下：

```
docs/
├── planning/                      # 规划根（planning/ 子目录优先，否则取 docs 根）
│   ├── ASDM-ProductPlanning.md    # 顶层汇聚文档，含「特性清单」表 = 主数据源
│   ├── Feat/FT-xxx-{名}/          # 每个特性一个文件夹
│   │   ├── FT-xxx-{名}-Feature.md # PRD 大纲（§1 概述 / §5 依赖 / §12 风险 / §15 开放问题）
│   │   ├── FT-xxx-{名}-Plan.md
│   │   └── FT-xxx-{名}-特性实现进展报告.md  # 「状态：🟢/🟡/🟣/🟠/🔴」+「总体完成度：X%」
│   ├── Modules/                   # 功能模块文档
│   ├── ReleasePlan/R03/*          # 发布规划
│   ├── Roadmap/*.md               # 战略主题 + 月度里程碑
│   ├── GTM/*                      # FR/NFR 需求
│   └── process/                   # 开发过程指南
```

**输出**（通过 CLI）：
- `planning build` → 规划模型快照 `planning-snapshot.json`
- `planning export` → `json | viewmodel | markdown | html`（蓝图）
- `planning query` → 按对象类型查询特性/模块/发布/里程碑/主题/依赖
- `planning audit health` → 四维规划健康审计（覆盖/状态/依赖/版本）

## 数据流

```
PRD/规划文档目录 ── planning build ──▶ planning-snapshot.json（归一化模型）
                      │
                      ├─▶ planning export --format html ──▶ planning-overview.html（自包含蓝图 + planning-viewer-data）
                      ├─▶ planning export --format json|viewmodel|markdown
                      ├─▶ planning query features --where "status=implementing"
                      └─▶ planning audit health ──▶ { score, level, dimensions[4], issues[] }
                                   ▲
        contrib/blueprint-ai-agent 油猴脚本在 planning-overview.html 上读取 planning-viewer-data 问答
```

## 使用流程

### 第 1 步：构建规划模型快照

```bash
nice-aos planning build --docs <产品规划管理库/docs 或 docs/planning 目录>
```

扫描产出 `_meta`（文件数/特性数/模块数/依赖数/发布数/里程碑数/主题数）。主数据源是顶层文档的
「特性清单」表（`FT-id | 模块 | 特性链接 | 优先级 | 目标版本 | 负责人 | 状态 | 描述`），
特性文档/进展报告作为增强（描述 / 状态 / 完成度 / 依赖引用 / 开放问题数）。

### 第 2 步：导出蓝图 HTML

```bash
nice-aos planning export --format html --output planning-overview.html
# 默认读快照；也可 --docs <dir> 一步构建，或 --snapshot <json> 指定快照
# --theme deep-blue 可选（listThemeNames 查看全部）
```

在浏览器打开 `planning-overview.html`：暗色统计卡 + 7 Tab + 力导向图谱，页面内嵌
`<script id="planning-viewer-data" type="application/json">`。

### 第 3 步：查询与分析（可选）

```bash
nice-aos planning query features --pretty --where "status=implementing"
nice-aos planning query modules --all
nice-aos planning query dependencies --limit 20
nice-aos planning audit health
```

### 第 4 步：蓝图问答（可选，需油猴脚本）

安装 `contrib/blueprint-ai-agent/blueprint-ai-agent.user.js`（Tampermonkey，开启文件访问），
在 `planning-overview.html` 右下角浮窗提问。脚本自动检测 `planning-viewer-data` → 进入
「产品规划分析智能体」，注册 `getPlanningStats` / `queryPlanningFeatures` /
`getPlanningFeatureDetail` / `queryPlanningModules` / `getPlanningFeatureDependencies` /
`getPlanningReleasePlan` / `getPlanningRoadmap` / `getPlanningHealthAudit` / `queryPlanningDocs` 工具。
示例：《有哪些处于实现中的特性？》《FT-001 依赖了哪些特性？》《各模块覆盖哪些特性？》《本月发布计划？》《规划健康度如何？》

## 触发场景

| 用户意图 | 建议命令 |
|---|---|
| 整体规划形态 / 有多少特性 / 各状态 | `planning build` → `planning export --format html`（或 `query features`） |
| 有哪些特性 / 按状态 / 优先级 / 版本 / 模块过滤 | `planning query features --where "status=implementing"` |
| 特性 X 详情 / 依赖谁 / 被谁依赖 | 蓝图问答（`getPlanningFeatureDetail` / `getPlanningFeatureDependencies`） |
| 模块构成 / 各模块覆盖哪些特性 | `planning query modules --all` |
| 迭代 / 发布 / 里程碑 / Roadmap 战略 | `planning query releases|milestones|themes` |
| 规划健康度 / 风险问题 | `planning audit health` |
| 在蓝图页自然语言问答 | 油猴脚本（planning 模式） |

## 与其它 Skill 分工

| Skill | 负责 |
|---|---|
| `nice-aos-planning`（本） | PRD/产品/特性/模块/发布/依赖层面的规划蓝图 |
| `nice-aos-service` | Java 后端服务蓝图（包/类/分层/API/表/技术栈） |
| `nice-aos`（asdm-aos） | 前端/通用代码本体快照扫描 |
| `nice-aos-database` | 数据库脚本 / Schema 蓝图 |
| `nice-aos-deployment` | 部署配置 / 服务拓扑蓝图 |
| `nice-aos-deadcode` | 死代码候选清理 |

## 模型形状（viewer-data / 问答索引）

顶层字段：`meta`（name/sourceDir/scannedAt/durationMs/fileCount/featureCount/moduleCount/dependencyCount）、
`stats`、`distribution`（status/priority/targetVersion 计数）、`features[]`（id/title/module/priority/
targetVersion/owner/status/statusEmoji/description/openQuestionCount/completion/depIds/docPath）、
`modules[]`（key/label/description/featureIds）、`releases[]`、`milestones[]`、`themes[]`、
`dependencies[]`（source/target/kind）、`audit`（score/level/dimensions[4]/issues[]）。
状态映射：🟢已完成 / 🟡实现中 / 🟣澄清中 / 🟠设计中 / 🔴阻塞风险 / ⚪未知。

## 版本检查

若使用 npm 全局安装的 `nice-aos`，先 `nice-aos update --check`；`update` 命令缺失说明版本过旧，
先执行一次 `npm install -g nice-aos@latest`。离线（`ok:false`）不阻断分析主流程。