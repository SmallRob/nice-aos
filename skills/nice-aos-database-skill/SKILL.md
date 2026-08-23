---
name: nice-aos-database
description: |
  MySQL 数据库脚本深度分析技能。将 Flyway 风格的 MySQL 迁移脚本目录分析为结构化数据库模型，
  把"SQL 文件"转化为 AI agent 可直接查询的"数据库关系图谱"——包含表、列、主键、外键、索引、
  迁移历史、领域分组、模式特征（软删除/审计字段/多租户/自引用/UUID主键/复合主键/JSON列等）。
  7 大审计场景：健康度评估 / 迁移影响 / 领域依赖 / 索引优化 / 模型演进 / 外键链路 / 命名规范。
  数据蓝图查看器（dbViewer）：db export --format html 生成自包含 dataoverview HTML
  （8 Tab：ER 图 / 表清单 / 外键 / 迁移 / 建模特征 / 健康总览 / 演进分析 / 索引优化，零依赖可离线打开）。
  油猴脚本 AI 助手（blueprint-ai-agent）支持双智能体切换：结构分析智能体 + 数据概览智能体。
  触发：用户说"分析数据库迁移脚本 / 数据库有哪些表 / 表结构是什么 / 外键关系 / 生成数据库全览图 /
  数据库蓝图 / ER 图 / 迁移历史 / 哪些表有软删除 / 多租户表有哪些 / 生成 dataoverview /
  数据库健康度 / 索引优化 / 演进分析 / 领域依赖 / 命名规范 / 外键链路"，
  或在需要理解数据库结构但不想逐个读 SQL 文件时。
  不做：代码扫描分析（用 nice-aos skill）、死代码清理（用 nice-aos-deadcode skill）、
  油猴脚本审计（用 nice-aos-userscript skill）。
---

# Nice AOS Database Skill — MySQL 数据库脚本深度分析

> 将 MySQL Flyway 迁移脚本目录分析为结构化数据库模型，产出数据分析 JSON、数据蓝图 dataoverview HTML（含 SVG ER 图）、以及 7 大审计场景报告。
> SQL 分析器（sqlAnalyzer）位于 `src/analyzers/`，与其他语言分析器并列；数据库模型/构建器/审计/查看器/快照位于 `src/database/` 独立子系统。
> **核心价值**：把"逐个读 SQL 文件 + LLM 推理"降级为"毫秒级数据库查询"，在 120+ 迁移文件的项目中保障 agent 的结构理解准确度，并提供深度审计洞察。
> **分工**：本 Skill 承载数据库脚本分析；代码本体分析见 `nice-aos` skill；死代码清理见 `nice-aos-deadcode` skill；油猴审计见 `nice-aos-userscript` skill。四者共享同一 CLI。

## 概述

本 Skill 让 AI agent 通过 `nice-aos db` CLI 命令分析 MySQL 迁移脚本目录，产出结构化数据库模型（表/列/主键/外键/索引/迁移历史/领域/模式特征）以及深度审计报告（健康度/演进/索引优化/领域耦合/命名规范/外键链路/迁移影响），无需逐个阅读 SQL 文件。

**自闭环设计**：SQL 解析器为纯函数模块（零外部依赖），数据库快照独立存储为 `db-snapshot.json`（与代码快照 `snapshot.json` 分离），审计模块为纯函数（输入快照 → 输出审计结果）。

## 触发场景

### 结构查询类

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **扫描数据库脚本** | "分析数据库迁移脚本" / "扫描 SQL 目录" | `db scan --dir <path>` |
| **数据库整体统计** | "数据库有哪些表？" / "有多少外键？" | `db query tables` / 查看 scan 输出 |
| **表结构查询** | "users 表结构是什么？" / "有哪些列？" | `db query tables --where "name~users"` |
| **外键关系** | "哪些表有外键？" / "workspace 表引用了谁？" | `db query foreignKeys --where "fromTable~workspace"` |
| **迁移历史** | "数据库迁移历史" / "V2.1 有哪些迁移？" | `db query migrations --where "version~V2.1"` |
| **领域分组** | "数据库有哪些领域？" / "auth 领域有哪些表？" | `db query domains` |
| **生成数据库全览** | "生成数据库蓝图" / "ER 图" / "dataoverview" | `db export --format html --output overview.html` |
| **模式特征** | "哪些表有软删除？" / "多租户表有哪些？" | `db query tables --where "patterns~soft_delete"` |
| **增量扫描** | "扫描新增的迁移文件" | `db scan --dir <path> --incremental` |
| **视图/触发器/存储过程** | "数据库有视图吗？" | `db query views` / `db query triggers` / `db query procedures` |

### 深度审计类

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **健康度评估** | "数据库健康度如何？" / "有什么质量问题？" | `db audit health` |
| **迁移影响分析** | "这个版本影响哪些表？" / "V2.5 有什么风险？" | `db audit impact --version V2.5` |
| **领域依赖分析** | "领域之间依赖关系如何？" / "哪些领域耦合度高？" | `db audit domains` |
| **索引优化** | "索引设计合理吗？" / "有哪些索引优化点？" | `db audit indexes` |
| **模型演进** | "数据库是如何演进的？" / "哪个版本变化最大？" | `db audit evolution` |
| **外键链路** | "users 表上下游有哪些依赖？" / "删某表影响谁？" | `db audit fkchain --table users` |
| **命名规范** | "命名规范怎么样？" / "有哪些命名不统一？" | `db audit naming` |
| **全量审计** | "全面审计数据库" / "生成完整审计报告" | `db audit all` |

## CLI 命令参考

### `db scan` — 扫描迁移脚本目录

```bash
# 全量扫描
nice-aos db scan --dir /path/to/migrations

# 增量扫描（仅处理新增/修改的迁移文件）
nice-aos db scan --dir /path/to/migrations --incremental

# 指定快照目录
nice-aos --db-snapshot-dir /path/to/data db scan --dir /path/to/migrations
```

### `db audit` — 7 大审计场景

```bash
# Schema 健康度总审计（完整性/一致性/索引质量/模式健康 → 综合评分+等级）
nice-aos db audit health

# 迁移影响分析（指定版本 → 受影响表/级联影响/风险等级）
nice-aos db audit impact --target-version V2.1.0

# 领域依赖图谱（依赖矩阵/耦合度排名/核心领域/循环依赖）
nice-aos db audit domains

# 索引优化分析（FK索引覆盖率/冗余索引/宽索引/主键类型分布）
nice-aos db audit indexes

# 模型演进分析（表数增长曲线/操作类型分布/里程碑/领域首版）
nice-aos db audit evolution

# 外键链路分析（上下游依赖链/级联删除路径/循环引用/扇入扇出）
nice-aos db audit fkchain --table users

# 命名规范审计（表名/主键/外键列/时间戳/软删除/索引命名）
nice-aos db audit naming

# 运行全部审计，输出汇总
nice-aos db audit all --table users --target-version V2.1.0
```

### `db export` — 导出分析结果

```bash
# 导出完整分析 JSON
nice-aos db export --format json --output db-analysis.json

# 导出数据蓝图 HTML（含 SVG ER 图，8 Tab；默认 fresh-green 淡绿主题，--theme 可选 deep-blue / elegant-purple）
nice-aos db export --format html --output db-overview.html

# 导出视图模型 JSON（供 agent 直接消费，含审计数据）
nice-aos db export --format viewmodel
```

### `db query` — 查询快照

```bash
# 查询所有表 / 按领域过滤 / 模糊匹配
nice-aos db query tables
nice-aos db query tables --where "domain=auth"
nice-aos db query tables --where "name~user" --pretty

# 查询外键 / 索引 / 迁移 / 领域
nice-aos db query foreignKeys
nice-aos db query migrations --where "version~V2.1"
nice-aos db query domains

# 查询视图/触发器/存储过程
nice-aos db query views
nice-aos db query triggers
nice-aos db query procedures
```

## 数据库模型

### 对象类型

| 类型 | 前缀 | 说明 |
|------|------|------|
| Table | `table:` | 数据库表（含列/主键/外键/索引/注释/迁移版本/模式特征/引擎/字符集） |
| Column | `col:` | 表列（名称/类型/可空/默认值/约束/注释/自增） |
| ForeignKey | `fk:` | 外键约束（源表/源列 → 目标表/目标列 + ON DELETE/UPDATE） |
| Index | `idx:` | 索引（名称/列/唯一性/索引类型：NORMAL/UNIQUE/FULLTEXT/SPATIAL） |
| Migration | `mig:` | 迁移脚本（版本/描述/文件名/操作统计/涉及表） |
| DbDomain | `dbdom:` | 数据库领域（按表名前缀自动分组 + 颜色 + 表数） |
| View | `view:` | 数据库视图 |
| Trigger | `trig:` | 数据库触发器 |
| Procedure | `proc:` | 存储过程/函数 |

### 模式特征（10 种）

| 特征 | 说明 | 检测规则 |
|------|------|---------|
| `soft_delete` | 软删除 | 表含 `deleted_at` / `delete_flag` / `is_deleted` 列 |
| `audit_columns` | 审计字段 | 表含 `created_at` + `updated_at`（或 `create_time` + `update_time`） |
| `self_reference` | 自引用外键 | 外键引用自身表 |
| `multi_tenant` | 多租户 | 表含 `org_id` 或 `collection_id` 列 |
| `uuid_primary` | UUID 主键 | 主键列类型包含 CHAR（通常为 CHAR(36)） |
| `composite_pk` | 复合主键 | 主键列数 > 1 |
| `json_columns` | JSON 列 | 存在 JSON 类型列 |
| `enum_columns` | 枚举列 | 存在 ENUM 类型列 |
| `no_primary_key` | 无主键 | 表无主键定义 |
| `large_table` | 宽表(>20列) | 列数超过 20 |

### 领域自动检测（13 个预置领域）

| 领域 key | 标签 | 前缀匹配规则 |
|----------|------|-------------|
| `auth` | 用户与权限 | `user*`, `role*`, `personal_access*`, `invitation*`, `notification*`, `org_create*`, `org_inheritance*`, `org_audit*`, `super_admin*`, `sso_user*`, `bank_user*`, `user_managed*` |
| `proj` | 项目与仓库 | `project*`, `project_collection*`, `global_repositor*`, `asset_repositor*`, `pipeline*` |
| `ws` | 工作空间 | `workspace*` |
| `ctx` | 上下文空间 | `library_context*`, `context_*`, `context_sync*` |
| `file` | 文件服务 | `asdm_file*`, `business_file*` |
| `agent` | Agent / AI | `agentorbit*`, `mcp_*`, `reporting_*`, `collection_agent*`, `project_agent*`, `organization_agent*`, `user_agent*` |
| `asset` | 资产注册 | `asset_*` |
| `intg` | 集成 | `adapter_*`, `integration_*`, `repository_project*` |
| `portal` | Portal 门户 | `article*`, `categor*`, `browse_history*`, `sync_failure*` |
| `ff` | Feature Flag | `feature_flag*` |
| `log` | 日志审计 | `log_*`, `audit_log*` |
| `job` | 任务调度 | `job_*`, `task_*`, `schedule_*` |
| `config` | 系统配置 | `config_*` |
| `sys` | 系统工具 | `sys_*`, `flyway_*`, `cli_*`, `install_*`, `shedlock*`, `one_time*`, `controlled_resource*`, `digidev*` |

> 领域规则定义在 `src/database/dbModel.js` 的 `DOMAIN_RULES`，可按需扩展。

## 7 大审计场景详解

### 1. 健康度审计（health）

四维度加权评分 → 综合得分（0-100）+ 等级（A/B/C/D）：

| 维度 | 权重 | 检查项 |
|------|------|--------|
| 完整性 | 30% | 无主键表 / 悬挂外键 |
| 一致性 | 25% | 命名风格混合 / 表注释覆盖率 / 列注释覆盖率 |
| 索引质量 | 30% | FK索引覆盖率 / 冗余索引 / 无二级索引表 |
| 模式健康 | 15% | 软删除命名一致性 / 审计字段一致性 |

输出：综合评分、等级、各维度得分+问题清单、Top 15 问题（按严重程度）、优化建议。

### 2. 迁移影响分析（impact）

指定迁移版本 → 输出：
- 受影响表（CREATE/ALTER/DROP 操作涉及的表）
- 级联影响（外键引用了被修改表的其他表）
- 风险等级（high / medium / low，基于操作类型权重）
- 操作类型汇总

### 3. 领域依赖图谱（domains）

- 领域依赖矩阵（N×N，出度 → 入度）
- 耦合度排名（按总耦合度排序，含出度/入度/表数）
- 核心领域（被依赖最多的 Top 3）
- 循环依赖检测（双向依赖的领域对）
- 桑基图数据（可用于可视化）

### 4. 索引优化分析（indexes）

- 索引总数 / 表均索引数
- 外键索引覆盖率（百分比 + 未建索引 FK 清单）
- 冗余索引检测（左前缀包含关系）
- 宽索引告警（>4 列的索引）
- 主键类型分布（自增 INT / UUID / 复合 / 其他）
- 优化建议清单

### 5. 模型演进分析（evolution）

- 表数增长曲线（按版本累计表数）
- 操作类型分布堆叠柱状图（CREATE/ALTER/INDEX/DROP/DML）
- 重大里程碑版本（表数变化较大的版本）
- 领域首版出现时间
- 演进趋势描述（早期建表 vs 后期调整）

### 6. 外键链路分析（fkchain）

- 下游影响链（BFS，哪些表引用了它）
- 上游依赖链（BFS，它引用了哪些表）
- 级联删除路径（ON DELETE CASCADE 的链路）
- 循环引用检测
- 扇入 / 扇出统计

### 7. 命名规范审计（naming）

检查项：
- 表名：全小写下划线风格
- 主键：统一命名为 `id`
- 外键列：以 `_id` 结尾
- 时间戳：统一 `created_at` / `updated_at`
- 软删除：统一 `deleted_at`（DATETIME）
- 索引命名：`idx_` / `uk_` 前缀

输出：问题列表（按严重程度排序）+ 优化建议。

## 数据蓝图 HTML（dataoverview，8 Tab）

`db export --format html` 生成自包含 HTML，内嵌完整模型 + 审计数据：

| Tab | 内容 | 亮点 |
|-----|------|------|
| **ER 关系图** | SVG 渲染表节点和外键边，按领域分组着色 | 缩放 / 平移 / 点击高亮关联边 |
| **表清单** | 搜索 + 领域过滤 + 表卡片 | 展开查看列/索引/外键/模式特征 |
| **外键关系** | 源表 → 目标表引用卡片 | ON DELETE/UPDATE 行为颜色标注 |
| **迁移时间线** | 版本排序的操作统计时间线 | 操作类型标签 |
| **建模特征** | 模式统计卡片 + 幂等 DDL 统计 + 里程碑 | 10 种模式特征分布 |
| **健康总览** | 评分仪表盘 + 维度得分 + Top 问题 + 建议 | 等级 A/B/C/D 配色 |
| **演进分析** | 表数增长曲线 + 操作类型堆叠柱图 + 领域首版 + 趋势 | 纯 SVG 图表，零依赖 |
| **索引优化** | 指标卡 + 主键类型分布 + 未建索引FK + 冗余索引 + 领域耦合 | 优化建议清单 |

HTML 内嵌 `<script id="db-viewer-data">` JSON 数据（含 `audits` 字段），可供 blueprint-ai-agent 油猴脚本自动检测并启用数据库场景 AI 问答。

## 增量扫描

```bash
# 首次全量扫描
nice-aos db scan --dir /path/to/migrations

# 添加新迁移文件后增量扫描
nice-aos db scan --dir /path/to/migrations --incremental
```

增量策略：
- 末尾追加的新迁移文件 → 增量 apply（保留已有表状态，只 apply 新操作）
- 中间文件修改 → 全量重建（确保正确性）
- 文件 manifest 记录 SHA-256 hash 用于变更检测
- 快照文件：`db-snapshot.json`，含完整模型 + manifest

## 油猴 AI 助手（blueprint-ai-agent）

`contrib/blueprint-ai-agent/blueprint-ai-agent.user.js` 支持数据库蓝图页 AI 问答，**双智能体切换**：

### 结构分析智能体（默认）

- 专长：表结构、列定义、外键关系、索引、迁移历史、领域分组、模式特征
- 工具：`getDbStats` / `queryTables` / `getTableDetails` / `queryForeignKeys` / `queryMigrations` / `queryDomains` / `getDbPatterns`
- 适合："users 表有哪些列？" / "外键关系如何？" / "auth 领域有哪些表？"

### 数据概览智能体（新增）

- 专长：健康度评估、演进趋势、索引优化、领域耦合、命名规范、外键链路
- 工具：`getDbHealth` / `getDbIndexAnalysis` / `getDbDomainCoupling` / `getDbEvolution` / `getDbNamingAudit` / `getDbFkChain`
- 适合："数据库健康度如何？" / "索引有什么优化建议？" / "演进趋势怎样？"

### 使用方式

1. 安装油猴脚本（Tampermonkey / Greasemonkey）
2. 打开数据蓝图 HTML 页面
3. 右下角浮窗按钮打开 AI 对话面板
4. 点击顶部智能体标签（"结构分析" / "数据概览"）切换智能体
5. 配置 API Key（支持 DeepSeek / GLM / Qwen / Kimi / 豆包 / OpenAI / 自定义）

## Agent 行为规则

### 结构查询场景

- 优先调用 `db query` 工具获取真实数据，禁止凭记忆编造数据库不存在的信息
- 工具返回的结构化数据，用清晰的中文 Markdown 表格汇总，保持简洁
- 涉及"表结构"时用 `db query tables --where "name~xxx"`，涉及"外键关系"时用 `db query foreignKeys`
- 生成可视化时用 `db export --format html`

### 审计分析场景

- 用户问健康度 / 质量 / 问题 → 用 `db audit health`
- 用户问索引优化 / 冗余索引 → 用 `db audit indexes`
- 用户问领域依赖 / 耦合度 → 用 `db audit domains`
- 用户问演进 / 历史 / 里程碑 → 用 `db audit evolution`
- 用户问命名规范 / 命名一致性 → 用 `db audit naming`
- 用户问表的上下游依赖 / 影响范围 → 用 `db audit fkchain --table <name>`
- 用户问某版本影响 / 风险 → 用 `db audit impact --version <ver>`
- 给出评分时附带解读（A=优秀, B=良好, C=一般, D=待改进），给出问题时附带改进建议

## 与代码扫描技能的区分

| 维度 | nice-aos（代码） | nice-aos-database（数据库） |
|------|------------------|--------------------------|
| 命令 | `action refreshRepo` / `query` / `export` | `db scan` / `db query` / `db audit` / `db export` |
| 快照 | `snapshot.json` | `db-snapshot.json` |
| HTML | 代码蓝图（`#viewer-data`） | 数据蓝图 dataoverview（`#db-viewer-data`） |
| 分析对象 | TS/Vue/Go/Dart/Rust 源码 | MySQL SQL 迁移脚本 |
| 智能体 | 本体蓝图智能体 | 结构分析智能体 + 数据概览智能体 |
| 审计能力 | 死代码 / 循环依赖 / 依赖治理 | 健康度 / 索引优化 / 演进 / 领域耦合 / 命名规范 |

## 文件结构

```
src/
├── analyzers/
│   └── sqlAnalyzer.js          # SQL 迁移脚本解析器（纯函数）
├── database/
│   ├── dbModel.js              # 模型定义 + 领域规则 + 模式检测
│   ├── dbSnapshot.js           # 快照持久化 + 增量 manifest
│   ├── dbBuilder.js            # 模型构建器（全量 + 增量）
│   ├── dbAuditor.js            # 7 大审计场景纯函数
│   └── dbViewer.js             # 数据蓝图 HTML 生成器（8 Tab）
└── cli/commands/
    └── db.js                   # db CLI 命令（scan/query/audit/export）

skills/
└── nice-aos-database-skill/
    └── SKILL.md                # 本文件

contrib/blueprint-ai-agent/
    └── blueprint-ai-agent.user.js  # 油猴 AI 助手（双智能体）
```
