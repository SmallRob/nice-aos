---
name: nice-aos-service
description: |
  Java 后端服务蓝图分析技能。基于 asdm-aos 工具产出的 Java 后端本体快照（snapshot.json，含包/类/接口/方法/
  调用关系/DDL 表/依赖）构建后端服务模型——把"本体快照"转化为 AI agent 可直接查询的"后端服务蓝图"——
  包含模块（按包前缀动态推导，可配置 service-modules.json）、架构分层（Controller/Service/Repository/Mapper/
  Entity/DTO/Config/Adapter/任务/工具）、API 面（HTTP 方法分布 + 领域前缀）、数据层（表/实体映射/孤儿表/
  外键引用链）、技术栈判定（JPA/MyBatis/Spring Security/JJWT/ShedLock/SpringDoc/Redis/ES/S3/OBS/MinIO 等）、
  代码质量（高复杂度方法热点/测试统计）。五维健康审计：代码复杂度 / 数据层健康 / 测试覆盖率 / 分析质量 /
  依赖健康。服务蓝图查看器（serviceViewer）：service export --format html 生成自包含 service-blueprint HTML
  （9 Tab：总览 / 模块 / 分层 / 图谱 / API 面 / 数据层 / 依赖与集成 / 代码质量 / 健康审计，零依赖可离线打开）。
  图谱 Tab 提供三种力导向关系图：模块图谱（模块依赖+跨模块调用）、分层调用流（Controller→Service→
  Repository→Entity）、模块×技术栈（模块使用技术分类）。
  模块规则不硬编码：首次构建从快照包结构动态推导并写入 service-modules.json，切换后端项目无需改代码。
  与 asdm-aos-skill 串联：先由 asdm-aos-skill（aos action refreshRepo）扫描 Java 后端生成本体快照
  snapshot.json，再由本技能（nice-aos service build/export）转换为服务蓝图。
  触发：用户说"分析 Java 后端 / 后端服务蓝图 / service blueprint / 服务架构是怎样的 / 有哪些模块 /
  技术栈是什么 / API 端点有多少 / 用了 JPA 还是 MyBatis / 有哪些高复杂度方法 / 服务健康度 /
  模块怎么划分 / 模块间依赖关系 / 服务模块图谱 / 分层调用流"，
  或在拿到 asdm-aos 快照（snapshot.json）需要理解整个 Java 后端形态时。
  不做：源码逐文件代码分析（用 nice-aos skill）、数据库脚本分析（用 nice-aos-database skill）、
  部署配置分析（用 nice-aos-deployment skill）、死代码清理（用 nice-aos-deadcode skill）。
---

# Nice AOS Service Skill — Java 后端服务蓝图

> 基于 asdm-aos 工具产出的 Java 后端本体快照（`snapshot.json`）构建**后端服务蓝图**：模块架构 / 分层结构 /
> API 面 / 数据层 / 技术栈 / 代码质量 / 健康审计，产出分析 JSON、自包含服务蓝图 HTML（9 Tab）。
> 服务子系统位于 `src/service/`（模型 / 构建器 / 快照 / 审计 / 查看器），CLI 命令位于 `src/cli/commands/service.js`。
> **核心价值**：企业级超大 Java 仓库（数千文件、2 万+方法）的语义理解，从"逐文件扫描 + LLM 推理"降级为
> "毫秒级蓝图查询"——AOS 预构建本体快照，本 Skill 将其聚合为可直接解读的服务蓝图。
> **分工**：本 Skill 承载 Java 后端本体快照分析；前端代码本体分析见 `nice-aos` skill；
> 数据库脚本分析见 `nice-aos-database` skill；部署配置分析见 `nice-aos-deployment` skill。

## 概述

本 Skill 让 AI agent 通过 `nice-aos service` CLI 命令消费 asdm-aos 本体快照，产出后端服务蓝图
（模块/分层/API/数据层/依赖技术栈/代码质量/健康度），无需逐个阅读 Java 源码。

**自闭环设计**：模型构建器为纯函数（输入快照对象 → 输出 ServiceModel），服务快照独立存储为
`service-snapshot.json`（与代码快照 `snapshot.json`、数据库快照 `db-snapshot.json`、部署快照
`deploy-snapshot.json` 分离）。**模块规则不硬编码**：首次构建从快照包结构动态推导并写入模块配置文件
`service-modules.json`，后续构建自动加载，切换后端项目无需改代码。

## 前置：asdm-aos 扫描（先扫描，后转换）

后端服务蓝图的数据源是 **asdm-aos 本体快照**。本仓库已引入 `skills/asdm-aos-skill/SKILL.md`
（asdm-aos 工具使用说明，CLI：`aos`，版本 >= 0.0.12）。两步工作流：

```bash
# 第 1 步：asdm-aos 扫描 Java 后端 → 生成本体快照 snapshot.json
aos --snapshot-dir <Java仓库>/.asdm/skills/asdm-aos-skill/data action refreshRepo \
  --params '{"repoPath":"<Java仓库>"}'

# 第 2 步：nice-aos service 转换为后端服务蓝图
nice-aos service export --snapshot <Java仓库>/.asdm/skills/asdm-aos-skill/data/snapshot.json \
  --format html --output service-blueprint.html
```

- asdm-aos 扫描自动包含包/类/接口/方法/调用关系/依赖，以及 `.sql` DDL 表与 MyBatis Mapper XML（如有）
- 扫描产出的 `snapshot.json` 即 service 命令的输入；`--module-prefix` / `--module-config` 可定制模块划分
- 无 Java 仓库时可用 `nice-aos --snapshot-dir <dir> action refreshRepo` 扫描前端，其余三个子系统
  （前端/数据库/部署）与 service 相互独立

## 触发场景

### 结构查询类

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **一步生成蓝图** | "从快照生成服务蓝图" / "service blueprint" | `service export --snapshot <path> --format html --output blueprint.html` |
| **构建服务模型** | "分析这个 Java 后端" / "构建服务模型" | `service build --snapshot <path>` |
| **模块架构** | "有哪些模块？" / "模块怎么划分？" | `service query modules` |
| **分层结构** | "Controller/Service 各多少？" / "分层架构" | `service query layers` |
| **API 面** | "有多少 API 端点？" / "哪些 Controller？" | `service query endpoints` / `service query classes --where "isController=true"` |
| **数据层** | "有哪些表？" / "孤儿表？" / "外键关系？" | `service query tables --where "isOrphan=true"` / `service query foreignKeys` |
| **技术栈** | "用了 JPA 还是 MyBatis？" / "技术栈是什么？" | `service query techStack` |
| **代码质量** | "哪些方法复杂度高？" / "重构对象？" | `service query complexityHotspots` |
| **测试** | "有多少测试？" / "测试覆盖？" | `service query testStats` |
| **健康度** | "后端服务健康吗？" / "总评多少分？" | `service audit health` |

### 数据来源与快照

asdm-aos 本体快照由 AOS CLI（`@leansoftx/asdm-aos`）构建，典型存放于
`<Java仓库>/.asdm/skills/asdm-aos-skill/data/snapshot.json`。快照含 `Repository / Package / Class /
Interface / Method / Dependency / Table / Mapper` 八类对象。

```bash
# 指定 asdm-aos 快照路径一步生成服务蓝图
nice-aos service export --snapshot /path/to/.asdm/skills/asdm-aos-skill/data/snapshot.json \
  --format html --output service-blueprint.html
```

## CLI 命令参考

### `service build` — 构建服务模型

```bash
# 从 asdm-aos 快照构建（保存 service-snapshot.json + 动态推导模块配置 service-modules.json）
nice-aos service build --snapshot /path/to/snapshot.json

# 指定快照/模块配置目录
nice-aos --service-snapshot-dir /path/to/data service build --snapshot /path/to/snapshot.json
```

### `service export` — 导出分析结果

```bash
# 导出完整分析 JSON
nice-aos service export --format json --output service-analysis.json

# 导出服务蓝图 HTML（9 Tab；--theme 可选 deep-blue / fresh-green / elegant-purple，默认 elegant-purple）
nice-aos service export --format html --output service-blueprint.html

# 直接指定 asdm-aos 快照路径，一步生成蓝图（不落盘 service-snapshot.json）
nice-aos service export --snapshot /path/to/snapshot.json --format html --output service-blueprint.html

# 导出视图模型 JSON（供 agent 直接消费，含审计数据）
nice-aos service export --format viewmodel
```

### `service query` — 查询服务模型

```bash
nice-aos service query repositories                  # 仓库信息
nice-aos service query modules                       # 模块（包/类/接口/方法/端点/职责）
nice-aos service query modules --where "key~core"    # 按模块过滤
nice-aos service query layers --where "key=controller"
nice-aos service query classes --where "isDataModel=true"
nice-aos service query endpoints --where "httpMethod=GET" --pretty
nice-aos service query endpoints --where "domainPrefix~users"
nice-aos service query tables --where "isOrphan=true"   # 孤儿表
nice-aos service query foreignKeys                       # 外键明细
nice-aos service query dependencies --where "category=jpa"
nice-aos service query techStack                         # 技术栈判定
nice-aos service query dataModels --where "dataModelType=JPA Entity"
nice-aos service query complexityHotspots                # 高复杂度方法 TOP50
nice-aos service query testStats
```

### `service audit` — 五维健康审计

```bash
# 综合健康评分（复杂度30% + 数据层20% + 测试20% + 分析质量10% + 依赖20%）
nice-aos service audit health

# 运行全部五个维度，输出汇总
nice-aos service audit all
```

### 模块规则定制

模块规则**不硬编码**：首次构建从快照包结构动态推导并写入 `service-modules.json`，可人工编辑
`label` / `prefixes` 后自动加载。

```bash
# 查看推导出的模块配置
cat <service-snapshot-dir>/service-modules.json

# 临时用自定义规则覆盖（--module-prefix 优先于配置文件）
nice-aos service export --snapshot /path/to/snapshot.json --format html \
  --module-prefix '{"core":{"label":"核心","prefixes":["ai.asdm.admin.core"]}}'

# 指定模块配置文件（存在则加载，不存在则动态推导并写入）
nice-aos service build --snapshot /path/to/snapshot.json --module-config /path/to/service-modules.json
```

## 服务模型

### 对象类型

| 类型 | 说明 |
|------|------|
| Repository | 仓库元信息：名称/语言/分支/commit/文件数/类数/分析错误 |
| Module | 模块（按包前缀动态推导）：包数/类/接口/方法/端点/职责（分层占比） |
| Layer | 架构分层：Controller/Service/Repository/Mapper/Entity/DTO/Config/Adapter/任务/工具/其他 |
| Class | 类/枚举摘要：注解（isController/isService/isRepository/isEntity/isConfig/isMapper）、数据模型类型、所属模块与分层、复杂度 |
| Interface | 接口摘要：方法签名数、所属模块 |
| Method | 方法摘要：复杂度（圈复杂度/嵌套深度/分支/循环）、测试标识（isTest/testType）、API 端点信息 |
| Endpoint | API 端点：HTTP 方法/路径/框架/Controller/领域前缀/路径参数 |
| Table | 数据库表：列数/主键/外键数/实体映射/孤儿表标记（无实体且无 FK） |
| ForeignKey | 外键明细：表.列 → 引用表.列 |
| Dependency | 外部依赖：版本/scope/来源/技术栈分类 |
| Mapper | MyBatis Mapper：namespace/映射表/POJO/resultMap |
| DataModel | 数据模型：JPA Entity / MongoDB Document / Record / Immutable / Lombok Data / MyBatis POJO |
| ComplexityHotspot | 高复杂度方法（圈复杂度 ≥15，TOP50 降序） |
| ModuleGraph | 图谱：moduleView（模块依赖）/ layerView（分层调用流）/ techView（模块×技术栈）三类力导向图数据 |

### 模块动态推导（`deriveModuleRules`）

1. 找"项目基础包"= 覆盖大多数包的**最深**公共前缀（默认阈值 80%）
2. 每个包取基础包之后的首段为模块 key；未落入基础包的包（如 `ai.asdm.portal.*`）取与基础包分叉处的首段
3. 分层关键词守门员：若某深度前缀大多是 controller/service/entity 等分层词，停止下钻
4. 单模块仓库坍缩：全部模块都是分层关键词时，以基础包末段为唯一模块
5. 推导结果写入 `service-modules.json`，后续构建自动加载；`--module-prefix` / `--module-config` 可定制

### 分层判定（`detectLayer`）

优先级：注解（`@RestController`/`@Service`/`@Repository`/`@Entity`/`@Configuration`/`@Mapper`）
→ 类名后缀（`Controller`/`Service`/`Repository`/`DTO`/`VO`/`Config`/`Adapter`/`Client`/`Job`…）
→ 包名关键词（controller/service/repository/entity/dto/config/adapter/client/job/util…）。

### 技术栈判定（`TECH_STACK_RULES`）

33 条依赖名正则，具体 starter（`data-jpa`/`data-redis`/`security`/`webflux`…）优先于泛型 `spring-boot`。
识别：Spring Boot / JPA (Hibernate) / MyBatis / JDBC / Flyway / Spring Security / JJWT / ShedLock / Quartz /
SpringDoc (OpenAPI) / Micrometer / Prometheus / Logstash / Zipkin / Redis / Kafka / RabbitMQ / Elasticsearch /
AWS S3 / 华为云 OBS / MinIO / OkHttp / Apache HttpClient / OpenFeign / MySQL / PostgreSQL / MongoDB /
Bean Validation / Lombok / MapStruct / 测试框架。

## 五维健康审计详解

| 维度 | 权重 | 评分公式 | 发现 |
|------|------|---------|------|
| 代码复杂度 | 30% | 热点占比（cc≥15）→ `100 - ratio*400` | 高复杂度方法（TOP20，定位 Class#method）、深层嵌套（≥8） |
| 数据层健康 | 20% | 孤儿表占比 → `100 - ratio*300` | 孤儿表清单、无实体映射表 |
| 测试覆盖率 | 20% | 测试方法占比 → `min(100, ratio*1000)` | 覆盖率 <5% 警告、零测试错误、无测试业务类 |
| 分析质量 | 10% | 分析错误数 → `100 - errors*25` | 仓库分析错误、非 Java 仓库提示 |
| 依赖健康 | 20% | 重复版本 → `-10/个`，无版本 → `-1/个` | 多版本重复、无版本依赖、system scope |

综合评分：五维加权（0-100）+ 等级（A/B/C/D/E）。错误 / 警告 / 提示分级。

## 服务蓝图 HTML（service-blueprint，9 Tab）

`service export --format html` 生成自包含 HTML，内嵌完整模型 + 审计数据：

| Tab | 内容 | 亮点 |
|-----|------|------|
| **总览** | 统计卡片（文件/包/类/接口/方法/端点/表/测试）+ 技术栈 chips + 仓库信息 | 技术栈绿点标记，绿色=检测到 |
| **模块** | 模块表（包/类/接口/方法/端点/职责）+ 模块规模条形图 | 职责描述自动生成（分层占比 TOP2） |
| **分层** | 分层卡片（类/接口/方法/端点 + 横向条形图） | 分层按注解/类名/包名判定，配色区分 |
| **图谱** | 力导向图三视图（模块图谱 / 分层调用流 / 模块×技术栈） | 拖拽/缩放/平移/点击聚焦；蓝=包依赖，绿=跨模块调用，紫=技术分类 |
| **API 面** | HTTP 方法分布条 + 端点表（搜索过滤） | 方法徽章按 HTTP 方法着色，领域前缀徽章 |
| **数据层** | 表网格 + 外键引用链 + 孤儿表清单 | 实体映射绿色标记、孤儿表琥珀标记 |
| **依赖与集成** | 技术栈摘要 chips + 按分类分组的依赖表 | 无版本依赖琥珀标记 |
| **代码质量** | 高复杂度方法 TOP（cc 徽章红/橙/琥珀）+ 测试统计 | 与报告重构建议对齐（cc>50 标红） |
| **健康审计** | 评分环 + 五维得分卡 + 问题清单 + 审计明细 | 炫彩 SVG 能量环，等级配色 |

### 图谱三视图（关系图谱）

| 视图 | 节点 | 边 | 数据来源 |
|------|------|-----|---------|
| 模块图谱 | 服务模块（大小 ∝ 类数） | 模块间关系：包依赖（蓝）+ 跨模块方法调用（绿），排除 other 噪声模块 | `Package.dependsOnPackageIds` + `Method.callsMethodIds` |
| 分层调用流 | 架构分层 | 跨层方法调用（宽度 ∝ 调用次数），如 Controller→Service→Repository→Entity | `Method.callsMethodIds`（排除测试与外部库调用） |
| 模块×技术栈 | 服务模块 + 技术分类（紫） | 模块使用该技术（宽度 ∝ 依赖引用数） | `Package.dependencyIds` → 技术栈分类 |

交互：拖拽节点 / 滚轮缩放 / 拖空白平移 / 点击节点聚焦并高亮邻接边。力导向布局由内联力模拟（库仑斥力 + 弹簧引力 + 向心重力 + 速度阻尼，320 步冷却）实时计算。

HTML 内嵌 `<script id="service-viewer-data">` JSON 数据（含 `audits` 与 `moduleGraph` 字段）。蓝图 AI 助手（`contrib/blueprint-ai-agent`，油猴脚本）自动检测 `#service-viewer-data` 并切换至「服务蓝图」智能体（10 个专属工具：getServiceStats / queryServiceModules / queryServiceLayers / queryServiceEndpoints / queryServiceTables / queryServiceDeps / getServiceQuality / getServiceHealth / getServiceAudit / queryServiceGraph）。

## Agent 行为规则

- 拿到 asdm-aos 快照路径后，优先用 `service export --snapshot <path> --format html` 一步出图，
  再用 `service query` / `service audit` 下钻回答具体问题
- 涉及"模块"用 `service query modules`，涉及"技术栈"用 `service query techStack`
- 涉及"高复杂度方法/重构对象"用 `service query complexityHotspots`（与报告 TOP 对齐）
- 涉及"健康度/风险"用 `service audit health`，给出评分时附带解读（A=优秀 … E=较差）与改进建议
- 模块规则需要定制时：编辑 `service-modules.json` 或传 `--module-prefix`，不要改代码
- 禁止凭记忆编造快照中不存在的模块/端点/依赖，一律以 `service query` 返回为准

## 与其他技能的区分

| 维度 | nice-aos（前端代码） | nice-aos-database（数据库） | nice-aos-deployment（部署） | **nice-aos-service（Java 后端）** |
|------|------------------|--------------------------|---------------------------|--------------------------------|
| 命令 | `action refreshRepo` / `query` | `db scan` / `db query` / `db audit` | `deploy scan` / `deploy query` / `deploy audit` | `service build` / `service query` / `service audit` |
| 输入 | TS/Vue/Go/Dart/Rust 源码 | MySQL SQL 迁移脚本 | Dockerfile/compose/K8s/nginx/.env | **asdm-aos 本体快照 snapshot.json** |
| 快照 | `snapshot.json` | `db-snapshot.json` | `deploy-snapshot.json` | `service-snapshot.json` + `service-modules.json` |
| HTML | 代码蓝图（`#viewer-data`） | 数据蓝图（`#db-viewer-data`） | 部署蓝图（`#deploy-viewer-data`） | 服务蓝图（`#service-viewer-data`） |
| 审计 | 死代码 / 循环依赖 | 健康度 / 索引 / 演进 / 领域 | 安全 / 高可用 / 一致性 / 依赖 | 复杂度 / 数据层 / 测试 / 分析质量 / 依赖 |

## 文件结构

```
src/
├── service/
│   ├── serviceModel.js        # 模型定义 + 模块动态推导 + 分层规则 + 技术栈规则
│   ├── serviceBuilder.js      # 模型构建器（asdm-aos 快照 → ServiceModel 单遍聚合）
│   ├── serviceSnapshot.js     # 快照持久化（service-snapshot.json / service-modules.json）
│   ├── serviceAuditor.js      # 五维健康审计纯函数
│   └── serviceViewer.js       # 服务蓝图 HTML 生成器（9 Tab）
└── cli/commands/
    └── service.js             # service CLI 命令（build/export/query/audit）

skills/
└── nice-aos-service-skill/
    └── SKILL.md               # 本文件
```
