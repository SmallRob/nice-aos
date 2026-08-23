---
name: nice-aos-deployment
description: |
  部署配置深度分析技能。扫描项目部署目录（如 ./deploy）中的 Dockerfile / docker-compose / K8s manifest /
  nginx.conf / .env / shell / CI 流水线等部署配置文件，构建结构化部署架构模型——把"部署配置文件"转化为
  AI agent 可直接查询的"部署架构图谱"——包含服务（容器/Workload）、镜像与版本、端口、网关路由
  （nginx location → proxy_pass → upstream → 目标服务）、服务间依赖（depends_on/环境变量引用/路由）、
  中间件（MySQL/Redis/MinIO/ES/Nacos/PostgreSQL 等）及消费方、环境配置（多环境变量漂移）、九层架构分层。
  5 大审计场景：综合健康评分 / 安全审计 / 高可用审计 / 配置一致性审计 / 依赖审计。
  部署蓝图查看器（deployViewer）：deploy export --format html 生成自包含 deployoverview HTML
  （8 Tab：部署拓扑 / 服务清单 / 网关路由 / 依赖关系 / 中间件 / 环境配置 / 部署文件 / 健康审计，零依赖可离线打开）。
  油猴脚本 AI 助手（blueprint-ai-agent）支持部署蓝图页自动识别 + 部署架构问答智能体。
  触发：用户说"分析部署配置 / 部署架构是怎样的 / 有哪些服务 / 镜像版本是什么 / nginx 路由怎么配的 /
  服务依赖关系 / 用了哪些中间件 / 环境变量差异 / 生成部署架构图 / 部署蓝图 / deployoverview /
  部署健康度 / 高可用检查 / 安全审计"，
  或在需要理解项目部署形态但不想逐个读 YAML/nginx.conf 时。
  不做：代码扫描分析（用 nice-aos skill）、数据库脚本分析（用 nice-aos-database skill）、
  死代码清理（用 nice-aos-deadcode skill）、油猴脚本审计（用 nice-aos-userscript skill）。
---

# Nice AOS Deployment Skill — 部署配置深度分析

> 将项目部署目录中的 Dockerfile / docker-compose / K8s manifest / nginx.conf / .env 等配置分析为结构化部署架构模型，
> 产出分析 JSON、部署蓝图 deployoverview HTML（分层拓扑 + SVG 依赖图）、以及 5 大审计场景报告。
> 部署子系统位于 `src/deployment/`（模型 / 解析器 / 构建器 / 审计 / 查看器 / 快照），CLI 命令位于 `src/cli/commands/deploy.js`。
> **核心价值**：把"逐个读部署 YAML + 人肉拼接服务关系"降级为"毫秒级部署查询"，在 130+ 部署文件的项目中
> 保障 agent 对部署拓扑的理解准确度，并提供安全 / 高可用 / 一致性 / 依赖四维审计洞察。
> **分工**：本 Skill 承载部署配置分析；代码本体分析见 `nice-aos` skill；数据库分析见 `nice-aos-database` skill。
> 四者共享同一 CLI 与快照目录体系。

## 概述

本 Skill 让 AI agent 通过 `nice-aos deploy` CLI 命令分析部署配置目录，产出结构化部署架构模型
（服务/路由/上游/依赖/中间件/环境/分层）以及审计报告（健康度/安全/高可用/一致性/依赖），无需逐个阅读配置文件。

**自闭环设计**：配置解析器为纯函数模块（yaml 依赖仅用于 YAML 解析），部署快照独立存储为
`deploy-snapshot.json`（与代码快照 `snapshot.json`、数据库快照 `db-snapshot.json` 分离），
审计模块为纯函数（输入快照 → 输出审计结果）。

**跨文件服务归一化**：同一服务在 docker-compose（本机）与 K8s manifest（集群）中以不同名字定义时，
按归一化服务名合并（小写、下划线转连字符），首个非空定义生效、数组字段并集，`sources` 记录全部出处。

## 触发场景

### 结构查询类

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **扫描部署目录** | "分析部署配置" / "扫描 deploy 目录" | `deploy scan --dir <path>` |
| **部署整体统计** | "部署架构是怎样的？" / "有多少服务？" | `deploy query services` / 查看 scan 输出 |
| **服务查询** | "core 服务的镜像版本？" / "有哪些适配器？" | `deploy query services --where "name~core"` |
| **网关路由** | "nginx 路由怎么配的？" / "/api 转发到哪？" | `deploy query routes --where "path~/api"` |
| **上游后端** | "upstream 都指向谁？" | `deploy query upstreams` |
| **依赖关系** | "服务依赖关系？" / "谁依赖 mysql？" | `deploy query dependencies --where "to~mysql"` |
| **中间件** | "用了哪些中间件？" / "redis 被谁消费？" | `deploy query middleware` |
| **环境配置** | "prod 和 sit 差什么变量？" | `deploy query environments` |
| **部署文件清单** | "部署目录有哪些文件？" | `deploy query files` |
| **架构分层** | "分层架构如何划分？" | `deploy query layers` |
| **生成部署蓝图** | "生成部署架构图" / "deployoverview" | `deploy export --format html --output overview.html` |
| **增量扫描** | "部署配置改了，重新扫" | `deploy scan --dir <path> --incremental` |

### 深度审计类

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **健康度评估** | "部署架构健康吗？" / "总评多少分？" | `deploy audit health` |
| **安全审计** | "有明文密码吗？" / "latest 镜像？" | `deploy audit security` |
| **高可用审计** | "健康检查配了吗？" / "单副本服务？" | `deploy audit resilience` |
| **配置一致性** | "多环境变量漂移？" | `deploy audit consistency` |
| **依赖审计** | "有循环依赖吗？" / "路由断链？" | `deploy audit dependency` |
| **全量审计** | "全面审计部署" / "完整审计报告" | `deploy audit all` |

## CLI 命令参考

### `deploy scan` — 扫描部署配置目录

```bash
# 全量扫描
nice-aos deploy scan --dir /path/to/deploy

# 增量扫描（无文件变化时直接复用快照；有变化则全量重建）
nice-aos deploy scan --dir /path/to/deploy --incremental

# 排除目录（文档/数据目录不参与分析）
nice-aos deploy scan --dir /path/to/deploy --exclude deploy-docs,data,dashboards

# 指定快照目录
nice-aos --deploy-snapshot-dir /path/to/data deploy scan --dir /path/to/deploy
```

默认排除目录：`node_modules` / `.git` / `bundled-plugins` / `data` / `dashboards` / `deploy-docs` / `target` / `dist` / `.nice-aos`

### `deploy query` — 查询快照

```bash
# 查询服务（支持精确/模糊过滤）
nice-aos deploy query services
nice-aos deploy query services --where "type=backend" --pretty
nice-aos deploy query services --where "name~adapter"

# 查询路由 / 上游 / 依赖 / 中间件 / 环境 / 文件 / 分层
nice-aos deploy routes
nice-aos deploy query routes --where "path~/api"
nice-aos deploy query upstreams
nice-aos deploy query dependencies --where "to~mysql"
nice-aos deploy query middleware
nice-aos deploy query environments
nice-aos deploy query files --where "type=k8s"
nice-aos deploy query layers
```

### `deploy audit` — 5 大审计场景

```bash
# 综合健康评分（安全30% + 高可用30% + 一致性20% + 依赖20% → 评分+等级）
nice-aos deploy audit health

# 安全审计（latest 镜像 / 明文敏感值 / 端口暴露 / 无鉴权路由）
nice-aos deploy audit security

# 高可用审计（健康检查 / 就绪探针 / 重启策略 / 副本数 / 资源限额）
nice-aos deploy audit resilience

# 配置一致性审计（多环境变量漂移 / 引用未知服务）
nice-aos deploy audit consistency

# 依赖审计（路由未解析 / 上游断链 / 循环依赖 / 中间件无消费方）
nice-aos deploy audit dependency

# 运行全部审计，输出汇总
nice-aos deploy audit all
```

### `deploy export` — 导出分析结果

```bash
# 导出完整分析 JSON
nice-aos deploy export --format json --output deploy-analysis.json

# 导出部署蓝图 HTML（分层拓扑 + SVG 依赖图，8 Tab）
nice-aos deploy export --format html --output deploy-overview.html

# 导出视图模型 JSON（供 agent 直接消费，含审计数据）
nice-aos deploy export --format viewmodel
```

## 部署架构模型

### 对象类型

| 类型 | 前缀 | 说明 |
|------|------|------|
| Service | `service:` | 部署单元（容器 / K8s workload）：名称、镜像、registry、版本、类型、分层、端口、探针、副本数、来源 |
| Route | `route:` | 网关路由：nginx location → proxy_pass → upstream/直连 的解析结果（含目标服务解析与外部主机识别） |
| Upstream | `upstream:` | nginx upstream 定义与后端服务器列表（含服务名解析） |
| Dependency | `dep:` | 服务间依赖边：depends_on（启动依赖）/ env_ref（环境变量 URL 引用）/ route（网关路由） |
| Middleware | `mw:` | 基础设施组件（MySQL/Redis/MinIO/ES/Nacos/PostgreSQL/MongoDB/RabbitMQ/Kafka）及其消费方 |
| Environment | `env:` | 环境配置文件（.env.prod / .env.sit 等）：变量（敏感值脱敏）与服务引用 |
| DeployFile | `file:` | 源配置文件（compose / k8s / nginx / dockerfile / env / shell / ci / config） |
| Layer | `layer:` | 架构分层（接入层 → 前端层 → 应用服务层 → 适配器层 → 任务层 → 数据层 → 可观测层 → CI/CD 层 → 工具层） |

### 服务类型推断（14 种）

按"角色词优先于技术栈词"的顺序匹配服务名 + 镜像名：

| 类型 | 标签 | 典型匹配 |
|------|------|---------|
| `gateway` | 网关 | nginx / gateway / ingress / traefik |
| `frontend` | 前端 | web / ui / portal / chatui / frontend |
| `adapter` | 适配器 | adapter |
| `job` | 任务 | flyway / migration / init / fixperms / bootstrap |
| `db` | 数据库 | mysql / mariadb / postgres |
| `cache` | 缓存 | redis / memcache |
| `storage` | 对象存储 | minio / oss / s3 |
| `search` | 搜索引擎 | elasticsearch / es / opensearch |
| `registry` | 注册中心 | nacos / consul / eureka |
| `observability` | 可观测 | prometheus / grafana / loki / promtail / alloy / jaeger |
| `cicd` | CI/CD | jenkins / sonar |
| `tool` | 工具 | portainer / pgadmin / docs / adminer |
| `backend` | 后端服务 | service / server / api / core / mcp / auth / scheduler / worker |
| `app` | 应用 | app（兜底） |

### 依赖推断规则

| 边类型 | 推断来源 |
|--------|---------|
| `depends_on` | docker-compose `depends_on` 字段 |
| `env_ref` | 服务/环境变量中的 URL（`http://host:port` / `jdbc:mysql://host:3306` / `redis://host:6379` 等）匹配已知服务名 |
| `route` | nginx upstream server 指向已知服务 |

### 镜像引用解引用

docker-compose 常见 `${VAR:-registry/repo:tag}` 插值：registry 与 tag 提取时自动解引用取默认值
（`${CORE_VERSION:-latest}` → `latest`），`${VAR}` 无默认值时返回 null。

### 敏感值脱敏

- 变量名含 `password / passwd / secret / token / credential / private_key / access_key`（不区分大小写）→ 值替换为 `***(N位)`
- 环境文件、服务环境变量、K8s 容器环境变量统一脱敏，快照与 HTML 中不落明文

## 5 大审计场景详解

### 1. 综合健康评分（health）

四维度加权评分 → 综合得分（0-100）+ 等级（A/B/C/D/E）：

| 维度 | 权重 | 检查项 |
|------|------|--------|
| 安全 | 30% | latest 镜像 / 明文敏感值 / 全网段端口绑定 / 无鉴权 API 路由 |
| 高可用 | 30% | 健康检查缺失 / 就绪探针缺失 / 单副本 / 无资源限额 / 无重启策略 |
| 配置一致性 | 20% | 多环境变量漂移 / 引用未识别服务 |
| 依赖 | 20% | 路由未解析 / 上游断链 / 循环依赖 / 中间件无消费方 / depends_on 未定义服务 |

评分规则：100 起步，error 扣 10 分 / warn 扣 4 分 / info 不扣分，下限 0。

### 2. 安全审计（security）

- latest / 无 tag 镜像 → 部署不可复现风险
- 服务 env / 环境文件中的明文敏感值 → 建议密钥管理
- 端口绑定 `0.0.0.0` 等非回环地址 → 确认暴露面
- API 前缀路由（/api /auth /admin 等）无 auth_request → 确认鉴权位置

### 3. 高可用审计（resilience）

- 业务服务（backend/frontend/adapter/app/gateway）无 healthcheck / 探针 → 故障不可自愈
- Deployment 无 readinessProbe → 滚动更新流量错切
- 核心服务单副本 → 单点故障
- Deployment 有 resources 但无 limits → 资源争抢
- compose 服务无 restart 策略 → 退出不拉起

### 4. 配置一致性审计（configConsistency）

- 多环境（≥2 个 .env 文件）变量键集合差异 → 漂移清单（哪个变量缺失于哪个环境）
- 环境文件 / 服务变量 URL 引用未识别服务 → 命名不一致或未部署

### 5. 依赖审计（dependency）

- 路由 proxy_pass 无法解析到服务（且非外部主机）→ 断链
- upstream server 未匹配部署服务 → 断链
- depends_on / env_ref / route 边构成的循环依赖 → DFS 检测
- 中间件无任何消费方 → 未使用或引用方式未识别（如 Nacos 配置中心外置）

## 部署蓝图 HTML（deployoverview，8 Tab）

`deploy export --format html` 生成自包含 HTML，内嵌完整模型 + 审计数据：

| Tab | 内容 | 亮点 |
|-----|------|------|
| **部署拓扑** | 九层架构分层堆叠图，层间箭头标注流量语义 | 服务盒按类型着色，含端口/副本/路由数/健康检查徽标 |
| **服务清单** | 搜索 + 分层过滤 + 服务卡片 | 展开查看镜像/端口/探针/资源/依赖/环境变量（脱敏） |
| **网关路由** | 按网关分组的路由表 + upstream 后端表 | 目标服务解析状态着色（绿=已解析/红=断链/橙=外部） |
| **依赖关系** | SVG 依赖图（按分层分列布局）+ 依赖清单表 | 三色边（depends_on/env_ref/route），点击节点高亮关联边，缩放平移 |
| **中间件** | 指标卡 + 中间件卡片 | 版本/镜像/端口/消费方清单 |
| **环境配置** | 环境文件卡片 | 变量数/敏感数/服务引用，变量值脱敏展示 |
| **部署文件** | 按类型分组的源文件表 + K8s 资源统计 | compose 服务数 / k8s kinds / nginx 路由数等摘要 |
| **健康审计** | 评分环 + 四维得分卡 + 问题清单 + 审计明细 | 等级配色 + error/warn/info 分级 |

HTML 内嵌 `<script id="deploy-viewer-data">` JSON 数据（含 `audits` 字段），可供 blueprint-ai-agent
油猴脚本自动检测并启用部署架构 AI 问答。

## 增量扫描

```bash
# 首次全量扫描
nice-aos deploy scan --dir /path/to/deploy

# 修改部署配置后增量扫描
nice-aos deploy scan --dir /path/to/deploy --incremental
```

增量策略（与数据库不同）：
- 部署配置是**声明式最终态**（无时序语义），任何文件变化 → 全量重建（确保正确性）
- 无文件变化 → 直接复用已有模型，毫秒级返回
- 文件 manifest 记录 SHA-256 hash 用于变更检测
- 快照文件：`deploy-snapshot.json`，含完整模型 + manifest

## 油猴 AI 助手（blueprint-ai-agent）

`contrib/blueprint-ai-agent/blueprint-ai-agent.user.js` 支持部署蓝图页 AI 问答。

### 部署架构智能体（deploy 页面自动启用）

- 页面检测：存在 `#deploy-viewer-data` 元素 → 部署蓝图模式（agent key: `deploy_architecture`，标签"部署蓝图"）
- 专长：部署拓扑、服务清单、镜像版本、网关路由、upstream、依赖关系、中间件、环境配置、分层、部署健康度审计
- 工具（12 个）：`getDeployStats` / `queryDeployServices` / `getServiceDeployDetails` / `queryDeployRoutes` /
  `queryDeployUpstreams` / `queryDeployDeps` / `queryMiddleware` / `queryDeployEnvs` / `queryDeployFiles` /
  `queryDeployLayers` / `getDeployHealth` / `getDeployAudit`
- 适合："部署架构是怎样的？" / "nginx 路由怎么配的？" / "哪些服务缺健康检查？" / "用了哪些中间件？"

### 使用方式

1. 安装油猴脚本（Tampermonkey / Greasemonkey）
2. 打开部署蓝图 HTML 页面（自动检测 deploy-viewer-data）
3. 右下角浮窗按钮打开 AI 对话面板
4. 配置 API Key（支持 DeepSeek / GLM / Qwen / Kimi / 豆包 / OpenAI / 自定义）

## Agent 行为规则

### 结构查询场景

- 优先调用 `deploy query` 工具获取真实数据，禁止凭记忆编造部署不存在的信息
- 工具返回的结构化数据，用清晰的中文 Markdown 表格汇总，保持简洁
- 涉及"服务详情"时用 `deploy query services --where "name~xxx"`，涉及"路由"时用 `deploy query routes`
- 涉及"中间件版本"时用 `deploy query middleware`，涉及"环境变量差异"时用 `deploy query environments`
- 生成可视化时用 `deploy export --format html`

### 审计分析场景

- 用户问健康度 / 质量 / 风险 → 用 `deploy audit health`
- 用户问安全 / 密码 / 暴露 → 用 `deploy audit security`
- 用户问高可用 / 单点 / 探针 → 用 `deploy audit resilience`
- 用户问环境差异 / 漂移 → 用 `deploy audit consistency`
- 用户问循环依赖 / 断链 → 用 `deploy audit dependency`
- 给出评分时附带解读（A=优秀, B=良好, C=一般, D=待改进, E=较差），给出问题时附带改进建议

## 与其他技能的区分

| 维度 | nice-aos（代码） | nice-aos-database（数据库） | nice-aos-deployment（部署） |
|------|------------------|--------------------------|---------------------------|
| 命令 | `action refreshRepo` / `query` | `db scan` / `db query` / `db audit` | `deploy scan` / `deploy query` / `deploy audit` |
| 快照 | `snapshot.json` | `db-snapshot.json` | `deploy-snapshot.json` |
| HTML | 代码蓝图（`#viewer-data`） | 数据蓝图（`#db-viewer-data`） | 部署蓝图（`#deploy-viewer-data`） |
| 分析对象 | TS/Vue/Go/Dart/Rust 源码 | MySQL SQL 迁移脚本 | Dockerfile/compose/K8s/nginx/.env |
| 智能体 | 本体蓝图智能体 | 结构 + 数据概览智能体 | 部署架构智能体 |
| 审计能力 | 死代码 / 循环依赖 | 健康度 / 索引 / 演进 / 领域 | 安全 / 高可用 / 一致性 / 依赖 |

## 文件结构

```
src/
├── deployment/
│   ├── deployModel.js          # 模型定义 + 服务类型规则 + 分层规则 + 中间件识别 + 脱敏
│   ├── deployAnalyzer.js       # 配置解析器（Dockerfile/compose/K8s/nginx/env/shell，纯函数）
│   ├── deploySnapshot.js       # 快照持久化 + SHA-256 manifest
│   ├── deployBuilder.js        # 模型构建器（文件扫描 + 服务归一化 + 依赖/路由推导）
│   ├── deployAuditor.js        # 5 大审计场景纯函数
│   └── deployViewer.js         # 部署蓝图 HTML 生成器（8 Tab）
└── cli/commands/
    └── deploy.js               # deploy CLI 命令（scan/query/audit/export）

skills/
└── nice-aos-deployment-skill/
    └── SKILL.md                # 本文件

contrib/blueprint-ai-agent/
└── blueprint-ai-agent.user.js  # 油猴 AI 助手（多智能体：代码/数据库/部署）
```
