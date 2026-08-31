---
name: nice-aos-canvas
description: |
  架构图画布技能（canvas-design 制图哲学 × nice-aos 蓝图数据体系）。调用 nice-aos 蓝图快照
  （部署 deploy-snapshot.json / 全景架构 overview-snapshot.json），
  按企业级语义分析生成专业架构图画布——自包含 HTML+SVG（缩放平移 / 图例 / 部署域边界 /
  审计风险徽标 / 零依赖离线打开）。
  程序化入口：
  - `nice-aos deploy export --format canvas --output <file>.html`  生成部署架构画布
  - `nice-aos overview export --format canvas --output <file>.html` 生成多项目全景画布
  - `nice-aos output --format canvas --output <file>.html`         三大核心命令 output 的 canvas 格式（自动检测 deploy / overview 快照）
  核心能力：
  1. 部署架构画布：九层分层泳道 + 部署域边界（Docker 宿主机 / K8s 集群 / Namespace / 外部系统）+
     流量路由边（nginx route / env_ref / depends_on / K8s selector）+ 中间件数据层 + 跨域点划边；
  2. K8s 集群画布：Namespace 泳道 + Workload（Deployment/StatefulSet/DaemonSet/Job）+
     Service 服务发现 + Ingress 入口 + ConfigMap/Secret/PVC 配置存储 + selector 匹配边；
  3. Docker 编排画布：Compose 网络 / 容器 / 端口映射 / 卷挂载 / restart 策略；
  4. 全景架构画布：项目列 × 分层行矩阵 + 跨项目依赖长边 + 按语言/分层的高亮过滤；
  5. 技术栈全景：从镜像与配置语义识别基础设施（MySQL/Redis/ES/MinIO/Nacos…）、运行时
     （JVM/Node/Python/Nginx/Rust/Go/PHP/Kotlin…）、网关与 CI/CD，生成技术栈芯片条与依赖矩阵；
  6. 审计驱动标注：latest 镜像 / 单副本 / 无探针 / 未设 limits / env 多 / 孤儿服务 / 路由未解析 / 中间件无消费方 → 图上风险徽标。
  触发：用户说"生成架构图 / 架构画布 / 部署架构图 / K8s 架构图 / Docker 架构图 / 技术栈图 /
  服务拓扑图 / 架构可视化 / 把部署蓝图画成图 / 画一张部署图 / 输出画布"，
  或已有 nice-aos 蓝图快照需要可视化呈现时。
  不做：部署配置扫描分析本身（用 nice-aos-deployment skill）、代码本体分析（用 nice-aos skill）、
  数据库分析（用 nice-aos-database skill）——本技能消费它们的快照产物。
---

# Nice AOS Canvas Skill — 架构图画布（企业级语义制图）

> 把 nice-aos 蓝图快照转化为**企业级架构图画布**：一张自包含 HTML+SVG 单页，
> 像正式架构评审文档一样可放大、可讲解、可归档。
> **核心理念（继承 canvas-design）**：图是作品不是截图——信息活在空间结构里（边界、泳道、连线、密度），
> 文字只做锚点；每个元素的位置都承载语义（部署域 → 泳道 → 分层三层语义编码）。
> **数据红线（继承 nice-aos）**：图上每一个节点、每一条边都必须来自快照真实数据，禁止编造服务或依赖。

## 数据流

```
nice-aos CLI 扫描                      蓝图快照                          架构图画布
deploy scan ──────────────→ deploy-snapshot.json ─┐
overview scan ─────────────→ overview-snapshot.json├→ canvasBuilder.js ─→ canvas HTML（自包含）
action refreshRepo ────────→ snapshot.json ───────┘   src/canvas/                 ↑ 浏览器打开
                                                       assets/{deploy,overview}-canvas-template.html
```

## 三阶段工作流（程序化版）

### Phase 1 — 数据获取（CLI 出快照，零手读 YAML）

```bash
# 1A. 部署蓝图（Docker / K8s / nginx 编排）
nice-aos deploy scan --dir /path/to/deploy

# 1B. 全景架构（多项目聚合）
nice-aos overview scan --projects-dir /path/to/projects

# 快照定位链：--snapshot-dir 覆盖 > NICE_AOS_*_SNAPSHOT_DIR > <root>/.nice-aos/data > ~/.nice-aos/data
```

**数据充分性检查**（不满足时先补扫描）：
- 部署画布 → 需 `services.length ≥ 1` 且含 `kind` 字段（container / Deployment / StatefulSet …）
- 全景画布 → 需 `projects.length ≥ 1`
- 缺什么就跑对应 `scan`，**禁止用记忆或猜测补全节点**

### Phase 2 — 画布生成（一条命令）

```bash
# 路径 A：直接对领域快照出画布
nice-aos deploy export --format canvas --output <project>-deploy-canvas.html
nice-aos overview export --format canvas --output <project>-overview-canvas.html

# 路径 B：三大核心命令 output 的 canvas 格式（自动检测 deploy / overview 快照）
nice-aos output --format canvas --output <project>-canvas.html

# 路径 C：手动（Agent 编排时）— src/canvas/canvasBuilder.js 暴露纯函数 API
# import { buildDeployCanvas, buildOverviewCanvas, buildCanvasAuto } from 'nice-aos/src/canvas/canvasBuilder.js'
```

三条路径都经过同一个 `src/canvas/canvasBuilder.js`：
- `buildDeployCanvas(model)`：消费 deploy 快照 → 部署架构画布
- `buildOverviewCanvas(model)`：消费 overview 快照 → 全景画布
- `buildCanvasAuto({ deployModel, overviewModel, preferKind })`：自动检测可用的快照
- 模板与数据解耦：`assets/deploy-canvas-template.html` / `assets/overview-canvas-template.html` 含 JS 语义分析 + 布局 + 交互，builder 只负责把数据注入 `<script id="canvas-data">__CANVAS_DATA_JSON__</script>` 占位符

### Phase 3 — 验证（浏览器打开单文件）

```bash
open <project>-deploy-canvas.html    # macOS
xdg-open <project>-deploy-canvas.html  # Linux
```

交付前自检清单（模板内置校验）：
- [ ] 画布打开即完整呈现全图（初始缩放自适应）
- [ ] 部署域边界清晰（Docker / K8s / Namespace / 外部系统四类可辨）
- [ ] 每个节点有类型色 + 域徽标 + 镜像行 + 风险徽标（如适用）
- [ ] 流量边（route/Ingress）与依赖边（env_ref/depends_on/selector）线型可区分
- [ ] 跨域边走点划线（8,3,2,3 模式）
- [ ] 图例完整、技术栈芯片条呈现、标题栏含数据源与扫描时间
- [ ] 缩放/平移/节点详情/图例高亮交互正常，单文件离线可用

## 企业级语义分析（模板内置）

#### 部署形态判定（决定画布骨架）

| 判定条件（基于快照） | 形态 | 画布骨架 |
|---|---|---|
| services 中存在 `kind ∈ {Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet}` **且**存在 `kind=container` | **混合云 + 宿主机** | 双域并置：K8s 集群大边界框 + Docker 宿主机边界框并列，层间流量边跨越 |
| 仅存在 K8s workload kinds | **纯 K8s** | 集群边界框内按 Namespace 泳道分列 |
| 仅存在 `kind=container` | **纯 Docker/Compose** | 宿主机边界框内按 compose 网络 / 分层泳道组织 |
| `k8sResources` 存在 Ingress | 集群有 L7 入口 | 顶部加"外部用户 → Ingress → Service"流量入口段 |
| `routes` 中存在 nginx 网关 | 有 nginx L7 网关 | 顶部加"外部用户 → nginx → 服务"流量入口段 |

#### 技术栈语义识别

| 数据来源 | 语义推导 | 画布表达 |
|---|---|---|
| `middleware[]`（kind/label/version） | 基础设施组件及版本 | 数据层节点 + 版本角标 |
| `service.image`（registry/repo:tag） | 运行时家族：JVM / Node.js / Python / Nginx / PHP / .NET / Go / Rust | 技术栈芯片条（顶部） |
| `service.registry` | 镜像仓库集中度（Azure ACR / Harbor / Docker Hub） | 部署域边框注记"镜像源: xxx" |
| `service.kind` | 编排体系（compose container / K8s workload） | 节点域徽标 🐳 / ☸️ |
| `environments[].name` | 多环境矩阵（prod/sit/dt…） | 底部环境注记条 |
| `overview-snapshot.languages` | 多项目语言分布 | 顶部语言芯片条（overview 画布） |

#### 架构分层（泳道纵轴）

- **部署画布** 固定九层顺序自上而下（`layers[]` 快照已推导，缺层自动跳过）：

  ```
  接入层(edge) → 前端层(frontend) → 应用服务层(backend/app) → 适配器层(adapter)
  → 任务层(job) → 数据层(db/cache/storage/search/registry) → 可观测层(observability)
  → CI/CD 层(cicd) → 工具层(tool)
  ```

- **全景画布** 七层（接入 / 前端 / 应用 / 服务 / 数据 / 基础设施 / 工具），按 `applicationServices[].kind` 启发式归层

`service.type → layer` 的映射已内置于快照 `service.layer` 字段，直接使用。

#### 拓扑边语义

| 边类型 | 来源字段 | 画法 |
|---|---|---|
| `route`（L7 流量） | `routes[]` / `upstreams[].servers[].resolvedService` | 实线粗箭头，紫色，网关→目标 |
| `env_ref`（运行时调用） | `dependencies[].type=env_ref` | 实线细箭头，蓝色 |
| `depends_on`（启动依赖） | `dependencies[].type=depends_on` | 虚线箭头，绿色 |
| K8s `selector` 匹配 | `k8sResources`(Service).selector vs workload labels/名称 | 灰色点线，Service→Workload |
| Ingress 规则 | `k8sResources`(Ingress).paths[].serviceName | 橙色粗箭头，Ingress→Service |
| 中间件消费 | `middleware[].consumers` | 细灰线，消费方→中间件 |
| 跨域边（Docker ↔ K8s） | 源/目标 `_dom` 不一致 | 点划线（8,3,2,3） |
| 跨项目依赖 | `overview-snapshot.architecture.crossMatrix` | 紫色虚线长边，列间绕行 |

#### 审计风险徽标（企业级评审要点，v0.43 新增 6 类）

从服务字段直接推导，图上以角标呈现（不必先跑 audit）：

| 条件 | 徽标 | k 键 |
|---|---|---|
| `imageVersion === 'latest'` 或无 tag | 🏷️ latest 镜像（生产禁用） | `latest` |
| `replicas === 1` 或 null（K8s workload） | ×1 单副本（无 HA） | `single` |
| 无 `healthcheck/readinessProbe/livenessProbe`（业务服务） | 无 HC | `nohc` |
| K8s workload 无 `resources.limits` | 未设资源限额 | `nolimit` |
| 环境变量数 > 30 | env 多（配置膨胀） | `envlots` |
| 镜像含 `${VAR:-default}` 兜底 | env 兜底 | `envfallback` |
| 业务服务无入度/出度（孤儿） | 孤儿服务 | `orphan` |
| 路由未解析 | 路由未解析 | `unresolved` |
| 中间件无消费方 | 中间件无消费 | `mwNoConsumer` |

标题栏右侧会按"latest × 3 / 单副本 × 5 / …"的形态聚合每个徽标的命中数；图例项可点击高亮对应的节点子集。

## 模板与 builder 接口契约

模板 (`assets/{deploy,overview}-canvas-template.html`) 必须满足：

1. **数据块契约**：`<script id="canvas-data" type="application/json">__CANVAS_DATA_JSON__</script>`
   - `canvasPaths.CANVAS_DATA_PLACEHOLDER` 即 `__CANVAS_DATA_JSON__`
   - `canvasPaths.injectCanvasData(tpl, snapshot)` 在 CLI / builder 路径下替换为合法 JSON
2. **优雅降级**：未注入数据时打开单文件，模板内 JS 检测占位符并展示"请用 nice-aos ... --format canvas 生成"的提示（而非抛错）
3. **零外部依赖**：所有 CSS / JS 内联；不引用 CDN
4. **可缩放可平移**：滚轮缩放 + 空白处拖拽 + 重置按钮（实现参考 `cvZoom / cvReset / ovZoom / ovReset`）

`src/canvas/canvasBuilder.js` 公开 API：

```js
buildCanvas({ kind, snapshot, title })          // 通用入口（kind ∈ {deploy, overview}）
buildDeployCanvas(deployModel, opts)            // 部署画布快捷入口
buildOverviewCanvas(overviewModel, opts)        // 全景画布快捷入口
buildCanvasAuto({ deployModel, overviewModel, preferKind })  // 自动检测
// 返回 { html, kind, stats, source? }
```

## 定制路径 B（Agent 手工绘制）

当模板布局不满足需求（如按业务域重组、嵌入到既有汇报材料）时，按 Phase 2 的语义结论 +
下文"设计语言规范"从头构建 SVG。**输出仍是自包含 HTML**，数据块模式与模板一致
（`<script id="canvas-data">`），保证可被 builder 与手动模式双向消费。

## 企业级设计语言规范

### 视觉系统

- **配色语义**（与 nice-aos 蓝图 SERVICE_TYPE_COLORS 对齐）：gateway `#f472b6` / frontend `#38bdf8` / backend `#4ade80` / adapter `#a78bfa` / job `#fbbf24` / db `#fb923c` / cache `#f87171` / storage `#22d3ee` / search `#e879f9` / registry `#c084fc` / observability `#facc15` / cicd `#60a5fa` / tool `#94a3b8`
- **边框层级**（由外到内递减视觉重量）：页面画布 → 部署域边界框（2px 虚线圆角，左上角域名标签）→ Namespace/网络子框（1px 虚线）→ 节点（1px 实线 + 类型色左描边 3px）
- **泳道**：分层行用极淡底色交替（`color-mix(type-color 3%, transparent)`），行首竖排层名
- **风险徽标**：节点右上角 10px 圆点或角标，琥珀=风险 / 灰=提示，汇总进图例
- **字体**：节点名 `SF Mono/Menlo monospace 12px 600`；注记 11px；层名/域名 13px 600
- **图例必备**：服务类型色 / 边类型线型 / 部署域徽标 / 风险徽标，右下角固定面板
- **标题栏**：项目名 · 画布类型 · 数据源快照 · 扫描时间 · 服务/路由/依赖计数 + 风险徽标汇总

### 布局算法要点

- 部署画布：节点尺寸 160×44（含镜像行 160×58），水平间距 14px，分层行高 = 最高节点 + 56px
- 同层节点超过 8 个 → 该层内按部署域再分组换行
- 边路由：同层/邻层用垂直贝塞尔（C 曲线，控制点取中点）；跨多层的依赖边沿画布右侧"高速公路"通道绕行
- K8s 集群图：Namespace 列泳道（左→右），列内按 Workload / Service / 配置存储 三个水平段分区
- 全景画布：项目列 × 分层行矩阵，跨项目依赖边走列间紫色虚线长边
- 溢出防护：节点数 > 60 时默认折叠 Job/tool 类节点为聚合框"×N 任务类服务"，点击展开

### 交互

- 滚轮缩放（0.3~3.0）+ 空白处拖拽平移 + 重置按钮
- 节点点击 → 右侧详情抽屉（镜像/端口/探针/资源/环境变量脱敏/来源文件）
- 图例项点击 → 高亮对应类型节点/边（其余降透明度到 0.08）

## Docker vs K8s 语义映射表（画布表达差异）

| 概念 | Docker/Compose 表达 | K8s 表达 |
|---|---|---|
| 部署单元 | 容器节点（🐳 徽标） | Workload 节点（☸️ 徽标 + kind 角标） |
| 编排边界 | Docker Host 边界框（compose networks 注记） | K8s Cluster 边界框 → Namespace 子框 |
| 服务发现 | compose 服务名 DNS（依赖边即发现关系） | Service 节点 + selector 点线 |
| L7 入口 | nginx 网关节点 + route 实线 | Ingress 节点 + 橙色规则边 |
| 配置 | .env 文件注记条 | ConfigMap/Secret 节点（Secret 键名隐藏） |
| 持久化 | volumes 挂载角标 | PVC 节点（容量注记） |
| 弹性 | `restart: always` 角标 | `replicas ×N` 角标 + 探针徽标 |
| 混合形态 | 两域并列，跨域依赖边用点划线（8,3,2,3） | 同左 |

## 快照字段 → 画布元素速查

| 快照字段 | 画布元素 |
|---|---|
| `services[].name/type/layer` | 节点 + 类型色 + 泳道位置 |
| `services[].kind/namespace` | 部署域归属 + 🐳/☸️ 徽标 |
| `services[].image/imageVersion/registry` | 节点第二行镜像 + latest 徽标 |
| `services[].replicas/readinessProbe/resources` | ×N / 探针 / 限额徽标 |
| `services[].middleware` | 数据层中间件节点（去重，用 `middleware[]` 更准） |
| `routes[]` / `upstreams[]` | 流量边 + 入口段 |
| `dependencies[]` | env_ref/depends_on 边 |
| `middleware[]`（label/version/consumers） | 数据层组件节点 + 消费边 |
| `k8sResources[]`（全部 kind） | K8s 集群画布节点与边 |
| `environments[]`（name/secretCount） | 底部环境矩阵注记 |
| `layers[]` | 泳道标题与顺序 |
| `_meta`（sourceDir/scannedAt/计数） | 标题栏元信息 |
| `overview.projects[]` | 全景画布列头 |
| `overview.applicationServices[]` | 全景画布矩阵节点（按 kind 归层） |
| `overview.architecture.crossMatrix` | 跨项目依赖长边 |
| `overview.languages` | 顶部语言芯片条 |

## Agent 行为规则

1. **先扫描后画图**：快照缺失或过期（部署目录有改动）→ 先跑 `deploy scan`，禁止直接画
2. **数据忠实**：所有节点/边/徽标必须可追溯到快照字段；发现快照外的"应该存在"的服务 → 提示用户而非画上去
3. **优先程序化**：日常部署架构图用 `deploy export --format canvas` 一行命令；仅当用户明确要求定制风格才走定制路径 B
4. **输出位置**：默认写到被分析项目的 `docs/` 或用户指定目录，文件名含项目与日期（如 `asdm-deploy-canvas-2026-08-31.html`）
5. **交付说明**：交付时附 3~5 句架构摘要（形态判定结论 + 技术栈要点 + 风险徽标汇总 + 审计建议入口 `deploy audit all`）

## 验收清单

- [ ] 画布打开即完整呈现全图（初始缩放自适应）
- [ ] 部署域边界清晰：Docker 宿主机 / K8s 集群 / Namespace / 外部系统四类边界可辨
- [ ] 每个节点有类型色 + 域徽标 + 镜像行 + 风险徽标（如适用）
- [ ] 流量边（route/Ingress）与依赖边（env_ref/depends_on/selector）线型可区分
- [ ] 跨域边用点划线（8,3,2,3）
- [ ] 图例完整、技术栈芯片条呈现、标题栏含数据源与扫描时间
- [ ] 缩放/平移/节点详情/图例高亮交互正常，单文件离线可用
