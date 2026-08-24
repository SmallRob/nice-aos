---
name: nice-aos-code-review
description: |
  Nice AOS 综合代码评审 Skill（Nice Anterior Ontology Service — Comprehensive Code Review）：
  作为 nice-aos-deadcode-skill 的严格超集，在四级死代码（文件/导出/类型/函数）清理工作流之上，
  整合 nice-aos CLI 的本体快照、asdm-aos 后端服务模型（含五维健康审计：
  complexity / dataHealth / testCoverage / analysisQuality / dependencyHealth）、
  代码/服务蓝图（export --format html|viewmodel）与外部代码扫描 JSON（ESLint/Sonar/Checkstyle/Semgrep/Trivy 等），
  编排"提交评审 → 差异评审 → 领域评审 → 复用评审 → 耦合评审 → 死代码评审 → 端到端综合评审"七步流水线，
  按 ASDM code-review v2.0 的领域驱动模型（ARCH/TYPE/PERF/UX/SEC/STYLE 通用维度 +
  DOMAIN/REUSE/COUPLE/COHESION/DEAD 评审维度 + BACKEND 后端服务专属维度）输出 P0~P3 分级报告。
  两种仓库模式：前端（React/Vue/Flutter/油猴，nice-aos 原生本体）、
  后端（Java/Spring Boot + MySQL/MyBatis/JPA，asdm-aos 快照 → nice-aos service build）。
  单文件模式：analyzeFile 局部评审（独立油猴 / 单 TS/JS / 单 Java 类）。
  评审产物：review-<scope>-<date>.md（结构化报告）+ 联动建议（markReviewed/addNote 跨会话保留）。
  触发：用户说"综合代码评审 / 综合审查这次改动 / 评审某个领域 / 评审这次 commit /
  全栈评审 / 前端+后端一起看 / 评审后端服务 / 服务蓝图评审 / 评审代码健康度 /
  P0/P1 问题清单 / 哪里需要重构 / 哪里有架构问题 / 复用机会 / 耦合度评估 /
  整合 ESLint/Sonar 报告评审 / 跨会话标记审查结论"，
  或在 nice-aos-deadcode 死代码清单之外还想看架构/类型/性能/UX/安全/风格/复用/耦合/后端健康度等维度时。
  英文触发词：comprehensive code review, domain-driven review, multi-dimensional review,
  architecture review, type safety review, performance review, security review,
  coupling review, reuse review, deadcode review, backend service audit,
  frontend + backend review, code blueprint review, severity P0~P3 report。
  不做：代码生成 / 自动改代码 / 自动跑测试 / 自动执行 ESLint（CLI 只出扫描 JSON，
  由 agent 解析后纳入评审报告；执行扫描本身由专用工具完成）；
  不做 React/Vue/Flutter 通用结构查询（用 nice-aos skill）、
  不做油猴安全审计（用 nice-aos-userscript skill）、
  不做死代码清理工作流（继承自 nice-aos-deadcode skill 的清理动作仍由该 skill 承载）、
  不做数据库脚本评审（用 nice-aos-database skill）、
  不做部署配置评审（用 nice-aos-deployment skill）。
---

# Nice AOS Code Review Skill — 综合代码评审（nice-aos-deadcode 超集）

> 以 nice-aos 本体快照为核心数据源，编排"通用 + 领域 + 后端 + 死代码"四组评审维度，
> 联动代码扫描 JSON 与代码/服务蓝图，输出 P0~P3 分级 Markdown 报告。
> **严格超集关系**：本 Skill 完全继承 `nice-aos-deadcode-skill` 的四级清理能力（文件/导出/类型/函数），
> 并在其基础上叠加架构 / 类型 / 性能 / UX / 安全 / 风格 / 边界 / 复用 / 耦合 / 内聚 / 后端服务五维 / 蓝图评审。
> **设计参考**：ASDM `.asdm/toolsets/code-review` v2.0（领域驱动、P0~P3、依赖图、复用检查）。
> **分工**：本 Skill 承载综合评审工作流；通用本体查询 / 蓝图导出见 `nice-aos` skill；
> 死代码清理动作（删实体 / markReviewed）见 `nice-aos-deadcode` skill（共用同一份快照）；
> 后端服务构建 / 后端本体查询见 `asdm-aos` skill；油猴审计见 `nice-aos-userscript` skill；
> 数据库评审见 `nice-aos-database` skill；部署评审见 `nice-aos-deployment` skill。

## 概述

代码评审的传统痛点是"维度单一"——只看 Lint / 只看死代码 / 只看风格。本 Skill 通过
**多源数据融合**把代码评审升级为多维诊断：

| 维度 | 数据源 | 工具命令 |
|------|--------|---------|
| 通用架构/类型/性能/UX/安全/风格 | nice-aos 本体快照（Component/Method/Interface/Class/Store/Hook/Route + 21 种关系） | `query` / `link` / `export` |
| 领域边界 / 复用 / 耦合 / 内聚 | 同上 + 路径分析 | `link importedBy` / `link renders` |
| 死代码（4 级） | 同上 + `_meta.orphanCandidates` / `unusedExports` / `deadCandidate` | 继承 nice-aos-deadcode skill 全部命令 |
| 后端服务五维健康度 | asdm-aos 快照 → `nice-aos service build` → `audit` | `nice-aos service audit health/all` |
| 代码扫描（外部） | ESLint / Sonar / Checkstyle / Semgrep / Trivy 输出的 JSON | 人工 `/` agent 解析 |
| 蓝图（视觉评审） | `export --format html` / `service export --format html` | 浏览器打开 |

**核心原则**：

1. **客观**：所有维度都由结构化数据驱动，不靠 agent 通读源代码推断；
2. **分级**：每个发现按 P0~P3 标记（CRITICAL / MAJOR / MINOR / INFO），与 ASDM code-review 工具集对齐；
3. **可追溯**：每个发现都能回到 `file:line` 或 `domain:id` 定位，并支持 `markReviewed` 跨会话保留；
4. **保守**：优先漏报，不误报——所有判定都走 nice-aos CLI 的静态分析与豁免规则。

## 前置条件

- Node.js 18+
- CLI 获取（二选一）：仓库内源码 `node <REPO_ROOT>/nice-aos/src/cli/index.js`（`nice-aos/node_modules` 缺失时先 `cd nice-aos && npm install`，版本跟随 git 无需 npm 版本检测）；或 npm 包 `nice-aos` / `npx nice-aos`
- **版本检测（npm 包方式必须）**：agent 首次调用前先执行 `nice-aos update --check` 确认最新版（多维评审规则随版本演进，旧版审计维度不完整）：
  ```bash
  nice-aos update --check   # 输出 JSON：current / latest / upToDate / installMode
  nice-aos update           # upToDate=false 且 installMode=global 时一键升级
  ```
  - `installMode=npx/local/repo` 时无法自动升级，按输出中的 `upgradeCommand` 指引处理
  - `update` 命令不存在 → 版本过旧（< 0.10.0），先执行一次 `npm install -g nice-aos@latest`
  - 网络不可达时 `--check` 返回 `ok:false`（带 current 版本号），跳过升级继续用当前版本，不要阻塞主流程
- 仓库模式需快照：`.nice-aos/data/snapshot.json`（不存在则 `action refreshRepo`，仓库根目录执行无需 `--snapshot-dir`）；**单文件模式无需快照**
- 后端服务评审需 `service-snapshot.json`（从 asdm-aos 快照构建：先 `asdm-aos action refreshRepo` 生成 Java 本体，再 `nice-aos service build --snapshot <path>`）；蓝图可选：`nice-aos service export --format html --output service-blueprint.html`
- 代码扫描 JSON 路径：用户提供 `eslint.json` / `sonar.json` / `checkstyle.xml` / `semgrep.json` / `trivy.json` 等任意扫描器的结构化输出（agent 应识别格式并提取 P0/P1 等级条目）

## 评审维度模型

本 Skill 把 ASDM code-review v2.0 的维度模型平移到 nice-aos 体系，并扩展为 4 组共 **11 个维度 + 50+ 规则**：

### 1. 通用维度（前端 + 后端均适用）

| 维度 | 规则 ID 前缀 | 规则数 | 核心数据源 |
|------|------------|--------|-----------|
| Architecture（架构）| ARCH-01~05 | 5 | Component.filePath / Module.archLayer / Project.architecture |
| Type Safety（类型安全）| TYPE-01~05 | 5 | Interface/Class/Method + 项目扫描 JSON |
| Performance（性能）| PERF-01~06 | 6 | Component.hooksUsed/stateCount + Route + 扫描 JSON |
| UX（用户体验）| UX-01~05 | 5 | Route / Component.kind + 项目扫描 JSON |
| Security（安全）| SEC-01~04 | 4 | GmApiUsage.declared / Dependency + 扫描 JSON |
| Style（代码风格）| STYLE-01~05 | 5 | 扫描 JSON 主导 |

### 2. 领域维度（项目级评审）

| 维度 | 规则 ID 前缀 | 规则数 | 核心数据源 |
|------|------------|--------|-----------|
| Domain Boundary（领域边界）| DOMAIN-01~05 | 5 | Component / Module.path 推导领域归属 + `link importedBy` |
| Code Reuse（代码复用）| REUSE-01~05 | 5 | SourceFile.importIds + 全文相似度分析 |
| Coupling（耦合度）| COUPLE-01~05 | 5 | `_meta.cycles` + `link importedBy` 反向图 |
| Cohesion（内聚度）| COHESION-01~05 | 5 | Module.summary + Domain.summary |

### 3. 死代码维度（来自 nice-aos-deadcode skill，完全继承）

| 维度 | 规则 ID 前缀 | 规则数 | 核心数据源 |
|------|------------|--------|-----------|
| Dead File（孤儿文件）| DEAD-FILE-01 | 1 | `_meta.orphanCandidates` |
| Dead Export（未使用导出）| DEAD-EXPORT-01 | 1 | `SourceFile.unusedExports` / `_meta.deadExportCandidates` |
| Dead Type（死接口/死类）| DEAD-TYPE-01 | 1 | `Interface/Class.deadCandidate` |
| Dead Function（死函数）| DEAD-FN-01~04 | 4 | `Method/ScriptFunction.deadCandidate` + 豁免 |

### 4. 后端服务维度（Java 后端项目专属，nice-aos service audit）

| 维度 | 规则 ID 前缀 | 规则数 | 核心数据源 |
|------|------------|--------|-----------|
| Complexity（复杂度）| BACK-CX-01~03 | 3 | `nice-aos service audit all` → `audits.complexity` |
| Data Health（数据层）| BACK-DATA-01~04 | 4 | 同上 → `audits.dataHealth` |
| Test Coverage（测试覆盖）| BACK-TEST-01~03 | 3 | 同上 → `audits.testCoverage` |
| Analysis Quality（分析质量）| BACK-QA-01~02 | 2 | 同上 → `audits.analysisQuality` |
| Dependency Health（依赖健康）| BACK-DEP-01~04 | 4 | 同上 → `audits.dependencyHealth` |

**完整规则定义见** [`spec/review-rules.md`](spec/review-rules.md)（通用 + 领域 + 死代码）与
[`spec/backend-review-rules.md`](spec/backend-review-rules.md)（后端五维）。

## 严重等级

| 等级 | 含义 | 处理要求 |
|------|------|----------|
| **P0 - Critical** | 必须修复，阻塞合并 | 立即修复（OWASP 漏洞、循环依赖、孤儿 entry、解析错误） |
| **P1 - Major** | 强烈建议修复 | 本次迭代内（领域边界、复用机会、复杂度热点、未声明依赖） |
| **P2 - Minor** | 建议优化 | 可排入 backlog（命名、样式、内联对象、复用机会 2 处） |
| **P3 - Info** | 信息 / 建议 | 自行判断（文档、备注、风格统一） |

## 工作流（七步流水线）

```
        ┌─────────── 综合代码评审 ───────────┐
        │                                    │
[Step 1] → 评审范围与数据源装配                │
        │                                    │
[Step 2] → 通用维度评审（ARCH/TYPE/PERF/UX/SEC/STYLE）
        │                                    │
[Step 3] → 领域维度评审（DOMAIN/REUSE/COUPLE/COHESION）
        │                                    │
[Step 4] → 死代码评审（继承 deadcode skill 四级）
        │                                    │
[Step 5] → 后端服务评审（如是 Java 后端）
        │                                    │
[Step 6] → 外部扫描 JSON 融合（ESLint/Sonar/Checkstyle/Semgrep/Trivy）
        │                                    │
[Step 7] → 报告输出与 markReviewed 闭环
```

### Step 1 — 评审范围与数据源装配

确定评审对象与可用数据：

```bash
# 1.1 检测仓库类型（前端 / 后端 / 全栈 / 油猴）
nice-aos query Project | jq '.framework'                  # react/vue/flutter/userscript/unknown
# 后端额外检查
nice-aos service query repositories                          # 仅当存在 service-snapshot.json
# 项目元信息（前端）
nice-aos query Project | jq '{summary, architecture, health}'

# 1.2 校验快照新鲜度（lastBuildAt 距今 > 24h 提醒刷新）
nice-aos query Project | jq '._meta.lastBuildAt'
# 如过期：
nice-aos action refreshRepo --params '{"repoPath":"."}'

# 1.3 收集用户输入的扫描 JSON 路径（如有）
#   - eslint.json / sonar.json / checkstyle.xml / semgrep.json / trivy.json
#   - 蓝图 HTML（代码/服务）路径（如有）
```

### Step 2 — 通用维度评审（前端 + 后端）

按通用规则对所有变更文件 / 模块执行 ARCH / TYPE / PERF / UX / SEC / STYLE 六维评审。

```bash
# ARCH：单文件体量 + 模块边界 + 依赖方向 + Store 职责
nice-aos query SourceFile --where "lineCount>500"
nice-aos query Module --all | jq '.[] | {name, archLayer, summary}'
nice-aos query Store | jq '.[] | {name, actionKeys, hasPersist}'

# TYPE：禁止裸 any、类型断言最小化、泛型约束、Props 类型
#   本体仅产出 Interface/Class（覆盖率约 70%），其余依赖外部扫描 JSON 补全
nice-aos query Interface --where "name=any" --pretty        # 误用 any 的接口名（粗筛）
nice-aos query Method --where "ownerKind=module" --pretty   # 模块函数签名体检

# PERF：懒加载、useMemo、列表 key、useEffect 依赖
nice-aos query Component --where "kind=page" --pretty       # 页面组件规模（lazy 候选）
nice-aos query Route | jq '.[] | {overlayId, routeType, isLazy}'  # isLazy 字段直接判定

# UX：安全区 / 错误态 / 加载态（前端特有）
#   本体不直接产出 UX 字段，需要结合 Component.kind 与项目约定（safe-area-top 等）
#   建议配合 ESLint 规则 `nice-tailwindcss-safe-area` 扫描 JSON

# SEC：API Key 不暴露 / 依赖漏洞 / GM API 越权
nice-aos query Dependency | jq '.[] | {name, version}'      # 配合 npm audit / Trivy 扫描 JSON
nice-aos query GmApiUsage --where "declared=false"          # 仅油猴项目

# STYLE：命名规范 + 动态 Tailwind + import 排序
#   完全依赖 ESLint/Prettier 扫描 JSON，本体仅做辅助定位
```

输出形态（写入报告）：

```markdown
### P0 - Critical
#### [ARCH-04] App.tsx 与 utils/format.ts 存在循环依赖
- **文件**: `App.tsx:1`, `src/utils/format.ts:1`
- **证据**: `_meta.cycles = [{from: "App.tsx", to: "utils/format.ts", ...}]`
- **建议**: 提取 `utils/format.ts` 的被引用部分到独立模块

### P1 - Major
#### [PERF-01] EnergyTreePage.tsx (1647 行) 未做 lazy import
- **文件**: `src/pages/EnergyTreePage.tsx`
- **证据**: `lineCount=1647` 且 `isLazy=false`
- **建议**: 改用 `lazy(() => import('./EnergyTreePage'))`

#### [SEC-01] 检测到硬编码 API Key
- **文件**: `src/services/gemini/client.ts:42`
- **证据**: 外部扫描 JSON `eslint.json` 中 `no-secrets` 规则 1 处 P0 命中
- **建议**: 改为环境变量 + 服务端代理
```

### Step 3 — 领域维度评审

按领域驱动模型评估项目结构健康度。

```bash
# 3.1 自动推导领域归属（基于路径与路由）
nice-aos query Domain --pretty | jq '.[] | {name, capability, fileCount, summary}'

# 3.2 跨领域依赖分析（DOMAIN-01/02/05）
#   检查每个 Component 路径是否合理引用了本领域 service
nice-aos query Component --pretty | jq 'group_by(.domainIds[0]) | ...'

# 3.3 复用机会（REUSE-01~05）
#   本体不直接计算代码相似度，依赖：
#   (a) Service.usesService / Component.usesComponent 关系图
#   (b) 外部 cpd / jscpd 扫描 JSON
nice-aos link usesService --src "comp:HealthStatsPage" | jq '.[]'

# 3.4 耦合度（COUPLE-01~05）
nice-aos export --format json | jq '._meta.cycles'                  # 循环依赖 = P0
nice-aos link importedBy --src "file:src/services/order.ts"        # 反向影响面

# 3.5 内聚度（COHESION-01~05）
nice-aos query Module --where "archLayer=presentation" --pretty    # 展示层模块职责
```

### Step 4 — 死代码评审（继承 nice-aos-deadcode skill 完整工作流）

**本节为 nice-aos-deadcode-skill 的严格超集实现**。所有命令、判定规则、复核流程均与该 skill 一致。

#### 4.1 总览健康度

```bash
nice-aos query Project | jq '.health'    # deadFunctionCount / deadTypeCount / deadExportCount / orphanFileCount
```

#### 4.2 按级提取候选

```bash
# 文件级（孤儿文件）
nice-aos export --format json | jq '._meta.orphanCandidates'

# 导出级（unused exports）
nice-aos export --format json | jq '._meta.deadExportCandidates'

# 类型级（死接口/死类，含 deadReason）
nice-aos query Interface --where "deadCandidate=true" --pretty
nice-aos query Class --where "deadCandidate=true" --pretty

# 函数级（死函数：TS 方法/模块函数 + 油猴脚本函数）
nice-aos query Method --where "deadCandidate=true" --pretty
nice-aos query ScriptFunction --where "deadCandidate=true" --pretty
```

#### 4.3 复核清单（按误报风险从高到低）

1. **测试引用**：测试文件不入扫描范围——仅被测试使用的导出符号会被判候选。删前 `grep -r "符号名" --include="*.test.*"`
2. **动态引用**：字符串拼装 import、`import(变量)`、全局注册（window.xxx = fn）、事件总线等运行时引用无法静态追踪
3. **re-export 链**：被 `export *` / `export {x} from` 传递暴露的符号已豁免，但二次转售（barrel file 的 barrel）建议再看一眼
4. **接口实现类方法**：函数级候选中的类方法若所属类被 implements 契约约束，删除可能破坏契约（`link implementedBy --src "iface:..."` 交叉核对）

#### 4.4 清理动作委派

> **本 Skill 不直接执行清理动作**——仅在评审报告中输出死代码清单与复核建议。
> 清理（删除 / `markReviewed` / `addNote`）由 `nice-aos-deadcode-skill` 承载，避免评审流被破坏性操作污染。

```bash
# 评审报告输出后，用户/agent 切换到 nice-aos-deadcode skill 执行：
#   nice-aos action markReviewed --params '{"objectId":"file:src/utils/legacy.ts"}'
#   nice-aos action addNote --params '{"objectId":"file:src/utils/legacy.ts","note":"综合评审结论：保留，仅测试引用"}'
```

#### 4.5 死代码规则矩阵（与 nice-aos-deadcode-skill 完全一致）

| 级别 | 数据位置 | 判定规则 | 保守豁免 |
|------|---------|---------|---------|
| **文件级**（孤儿文件） | `_meta.orphanCandidates` + `Project.health.orphanFileCount` | 全仓库零导入引用的源文件 | 测试文件、入口文件（main/index/App 等）、路由注册组件、lazy 动态引用 |
| **导出级**（unused exports） | `SourceFile.unusedExports[]` + `_meta.deadExportCandidates` + `Project.health.deadExportCount` | 导出符号全仓库零具名导入且本文件零使用 | 入口文件、re-export 链（`export {x} from ...`）、动态 `import()` 引用 |
| **类型级**（死接口/死类） | `Interface/Class.deadCandidate` + `deadReason` + `Project.health.deadTypeCount` | 非导出：本文件零引用；导出：全仓库零导入且本文件零引用 | 命名空间导入 / `export *` / 动态 import 的目标文件整体豁免 |
| **函数级**（死函数） | `Method/ScriptFunction.deadCandidate` + `deadReason` + `Project.health.deadFunctionCount` | 引用计数为零（排除声明处、自身函数体自引用、事件回调、constructor） | 接口方法永不判死（契约声明）；导出模块函数不在函数级判死（由导出级覆盖）；油猴 ScriptFunction 额外排除 topLevelCalls 命中与 unsafeWindow 暴露 |

### Step 5 — 后端服务评审（仅 Java 后端项目）

#### 5.1 构建服务快照（前置）

```bash
# 5.1.1 由 asdm-aos 生成 Java 本体快照（如未生成）
asdm-aos action refreshRepo --params '{"repoPath":".","roots":["src/main"]}'

# 5.1.2 由 nice-aos 从 asdm-aos 快照构建 service-snapshot
nice-aos service build \
  --snapshot .codebuddy/skills/asdm-aos-skill/data/snapshot.json \
  --module-prefix '{"core":{"label":"核心","prefixes":["ai.asdm.admin.core"]}}'

# 5.1.3 （可选）导出服务蓝图 HTML，供评审时视觉化对照
nice-aos service export --format html --theme elegant-purple \
  --snapshot .codebuddy/skills/asdm-aos-skill/data/snapshot.json \
  --output reports/service-blueprint-<date>.html
```

#### 5.2 运行五维审计

```bash
# 一键全维度
nice-aos service audit all --snapshot <asdm-aos-snapshot.json> > reports/audit-all.json

# 单维度详情（用于报告引用）
nice-aos service audit health --snapshot <asdm-aos-snapshot.json> | jq '.dimensions[]'
```

#### 5.3 维度解读（每维 0~100 分，越低越差）

| 维度 | 关键 findings 字段 | 报告提取规则 |
|------|------------------|--------------|
| **Complexity** | `complexityHotspots`（圈复杂度 ≥ 15）/ `hotspotRatio` | hotspotRatio > 30% → P1；> 50% → P0 |
| **Data Health** | 无主键表 / 无 Mapper 表 / FK 悬空 / 列名冲突 | 任意维度 ≥ 1 → P1；≥ 5 → P0 |
| **Test Coverage** | testMethodCount / totalMethodCount（覆盖率） | < 30% → P1；< 10% → P0 |
| **Analysis Quality** | `analysisErrors[]` / `unparsedMethods[]` | 任意 1 项 → P2；> 10 → P0 |
| **Dependency Health** | `duplicateDependencies[]` / `unscopedDependencies[]` | duplicate ≥ 1 → P1；Maven 属性占位符不计入 |

完整规则见 [`spec/backend-review-rules.md`](spec/backend-review-rules.md)。

#### 5.4 后端评审输出

```markdown
### P0 - Critical（后端）

#### [BACK-CX-01] 圈复杂度热点占比 47.2%（已超 30% 阈值）
- **证据**: `service audit all.audits.complexity.stats.hotspotRatio = 47.2`
- **热点 TOP3**: `Helper.parseComplex(cc=20,depth=8)` / `OrderService.calc(cc=18)` / `UserService.find(cc=15)`
- **建议**: 拆分 `Helper.parseComplex` 为 parseToken / parseGroup / merge 三步

#### [BACK-DEP-01] 检测到依赖多版本 `io.jsonwebtoken:jjwt-api` (0.11.5 / 0.12.3)
- **证据**: `service audit all.audits.dependencyHealth.findings` 命中 1 条
- **建议**: 在 `pom.xml` 统一 `<jjwt.version>` 属性并强制覆盖

### P1 - Major（后端）

#### [BACK-DATA-02] 12 张表无对应 Mapper
- **证据**: `service query tables --where "mapperCount=0"`
- **建议**: 补齐 Mapper 或在表注释中标注"纯静态表"
```

### Step 6 — 外部扫描 JSON 融合

外部扫描器（ESLint / Sonar / Checkstyle / Semgrep / Trivy / npm audit / SpotBugs）输出的结构化 JSON
是评审的"第六感"——本 Skill 不直接调用扫描器，但负责解析与融合。

#### 6.1 扫描 JSON 格式识别表

| 扫描器 | 文件特征 | 严重度字段 | 本 Skill 映射 |
|--------|---------|----------|-------------|
| **ESLint** | `[].filePath, [].messages[].ruleId, [].messages[].severity` | 0/1/2 | 0→P3 1→P2 2→P1（disable 后） |
| **SonarQube** | `issues[].severity, issues[].type, issues[].rule` | BLOCKER/CRITICAL/MAJOR/MINOR/INFO | BLOCKER→P0 CRITICAL→P1 MAJOR→P2 MINOR→P3 |
| **Checkstyle** | `<file><error severity="..." line="..."/></file>` | error/warning/info | error→P1 warning→P2 info→P3 |
| **Semgrep** | `results[].extra.severity` | ERROR/WARNING/INFO | ERROR→P0 WARNING→P2 INFO→P3 |
| **Trivy** | `Results[].Vulnerabilities[].Severity` | CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN | CRITICAL→P0 HIGH→P1 MEDIUM→P2 LOW→P3 |
| **npm audit** | `vulnerabilities[].severity` | critical/high/moderate/low | 同 Trivy |

#### 6.2 融合策略

```bash
# 6.2.1 收集所有扫描 JSON
SCAN_FILES="reports/scan/eslint.json reports/scan/sonar.json reports/scan/trivy.json"

# 6.2.2 提取每个扫描器的 P0/P1 命中（jq 模板按格式调整）
jq '[.[] | .messages[] | select(.severity==2) | {file: .filePath, rule: .ruleId, message, line: .line}]' \
   reports/scan/eslint.json > reports/scan/eslint-p0p1.json

# 6.2.3 关联到 nice-aos 本体对象（优先用 SourceFile.id 锚定）
#   - 同一文件可被多扫描器命中 → 累加严重度（Trivy CRITICAL + ESLint P1 → 仍按最高级 P0 报告）
#   - 同一规则被多文件触发 → 不去重，全量报告

# 6.2.4 把扫描 JSON 的 findings 追加到评审报告的"## 外部扫描发现"章节
```

#### 6.3 报告融合段（示例）

```markdown
### 外部扫描发现（融合 ESLint + Sonar + Trivy）

| 文件 | 规则 | 工具 | 等级 | 描述 |
|------|------|------|------|------|
| src/api/client.ts | no-secrets | ESLint | P0 | 硬编码 API Key |
| pom.xml | java-sqid:S5131 | Sonar | P1 | XSS 漏洞（服务端反射） |
| pom.xml | CVE-2023-20860 | Trivy | P0 | spring-core 6.0.5 漏洞 |
| src/utils/legacy.ts | no-unused-vars | ESLint | P2 | 3 个未使用变量（已纳入死代码评审） |
```

### Step 7 — 报告输出与 markReviewed 闭环

#### 7.1 报告输出

评审报告统一写入 `reports/review-<scope>-<date>.md`（scope: commit-<short> / domain-<name> / service / comprehensive）。

```bash
mkdir -p reports
# 报告路径示例
reports/review-comprehensive-2026-08-24.md        # 综合评审
reports/review-commit-a1b2c3d-2026-08-24.md       # commit 评审
reports/review-domain-health-2026-08-24.md        # 领域评审
reports/review-service-backend-2026-08-24.md      # 后端服务评审
```

完整报告模板见 [`spec/review-template.md`](spec/review-template.md)。

#### 7.2 markReviewed 跨会话保留

评审结论（保留 / 修复 / 误报 / 待定）通过 nice-aos 的 `markReviewed` / `addNote` 落地，下次评审自动加载：

```bash
# 标记已评审（不参与下次候选列表）
nice-aos action markReviewed --params '{"objectId":"file:src/utils/legacy.ts"}'

# 加评审备注（保存到 _meta.notes，跨会话保留）
nice-aos action addNote --params '{
  "objectId": "file:src/utils/legacy.ts",
  "note": "综合评审 2026-08-24：保留（仅测试引用 + 动态注册双豁免）"
}'
```

## 数据源优先级与冲突处理

| 优先级 | 数据源 | 适用维度 | 处理 |
|--------|--------|---------|------|
| **1（最高）** | nice-aos 本体快照（结构化、零误判） | 死代码、依赖图、循环依赖、Store/Route | 直接采用 |
| **2** | asdm-aos + nice-aos service 五维审计（结构化） | 后端专属五维 | 直接采用 |
| **3** | 蓝图 HTML / viewmodel（视觉 + 数据） | 评审上下文、可视化引用 | 引用截图/链接 |
| **4** | 外部扫描 JSON（半结构化） | 类型/性能/UX/安全/风格 | 解析后融合 |
| **5（最低）** | agent 通读源代码（推断） | 仅当结构化数据未覆盖 | 标注 "需人工确认" |

**冲突处理**：

- 本体判定 vs 扫描器判定冲突（如本体判定孤儿但扫描器报"动态引用"）→ **以本体为准**（扫描器不知道动态引用），但标记 `[需人工确认]`
- 多扫描器同文件冲突 → 取最高等级，附"被 X 个扫描器命中"备注
- 后端审计 vs 前端死代码冲突（如某 Java 类被本体判 dead 但被 service 审计列入热点）→ **以 service 审计为准**（热点优先于死代码），标记 `[保留-热点]`

## 评审场景清单（按用户意图路由）

| 用户表述 | 触发的评审流 | 跳过维度 |
|---------|------------|---------|
| "评审这次 commit / 评审最新提交" | Step 2-3-4 | 后端 |
| "评审 X 领域 / 评审 health 域" | Step 3-4 | 通用（部分） |
| "检查复用机会 / 找重复代码" | Step 3.3 + 外部扫描 cpd | 其他 |
| "检查耦合度 / 找循环依赖" | Step 3.4 | 其他 |
| "综合代码评审 / 全栈评审 / 前端+后端一起看" | **Step 1-7 全开** | 无 |
| "评审这个后端服务 / 服务健康度" | Step 1 + 5 | 前端通用 |
| "评审这次提交带 ESLint/Sonar" | Step 1 + 2-4 + 6 | 后端 |
| "死代码清单" | Step 4（继承 nice-aos-deadcode skill） | 其他维度 |
| "分析单个文件" | `analyzeFile` 单文件模式（无快照） | Step 3-5 |

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 用户要求"综合代码评审" | 默认按 Step 1-7 全开；如缺快照先 `action refreshRepo`；如缺服务快照问用户是否要评审后端 |
| 用户只问"死代码清单" | 直接切换到 `nice-aos-deadcode-skill`，不展开其他维度（避免越界） |
| 用户问"这个文件能删吗" | Step 4 + `link importedBy/calledBy` 双向确认 + 报告"删除风险 / 保留理由" |
| 用户给扫描 JSON + 评审请求 | Step 6 优先，按 JSON 格式自动识别扫描器类型 |
| 评审产物超 100 行 | 强制折叠到 P0/P1 章节，P2/P3 章节收尾；明细写报告文件 |
| 跨会话延续评审 | 先 `query Project` 看 `_meta.notes` / `_meta.reviewed`，与上次结论对比 |
| 后端项目 | 必须 `service build` 后再评审；纯前端项目跳过 Step 5 |
| 油猴项目 | Step 4 函数级评审必须加 `unsafeWindow` / `topLevelCalls` 豁免清单 |

## 与 nice-aos 系列其他 skill 的边界

| Skill | 关系 | 触发关键词 |
|-------|------|----------|
| `nice-aos`（核心查询） | 本 Skill 调用其 `query` / `link` / `export` 命令 | 查 Project/Component/Interface/Route 等 |
| `nice-aos-deadcode`（死代码清理） | 本 Skill Step 4 严格继承其四级工作流；清理动作仍由该 skill 执行 | 死代码清单 / unused exports / 孤儿文件 |
| `nice-aos-userscript`（油猴审计） | 本 Skill Step 2 SEC 维度委托其 GM API 越权判定 | GM API 越权 / @grant 缺失 / XSS 注入 |
| `nice-aos-database`（数据库脚本） | 本 Skill Step 5 DATA 维度协同（Service build 已包含表分析） | Flyway / 表结构 / FK 关系 |
| `nice-aos-deployment`（部署配置） | 本 Skill Step 5 DEP 维度协同（Service audit 已包含依赖审计） | Docker / K8s / nginx 配置 |
| `asdm-aos`（Java 本体） | 本 Skill Step 5 的输入数据源 | Java 后端本体 / MyBatis Mapper / JPA Entity |

## 技术限制与免责

- **静态扫描边界**：运行时动态引用（事件总线、全局注册、字符串拼装 import）无法追踪 → 依赖人工复核 + 标记 `[需人工确认]`
- **后端依赖审计盲区**：Maven 属性占位符 `${xxx.version}` 与空版本不参与多版本判定（避免误报），但用户需自行确认 BOM 一致
- **扫描 JSON 时间戳**：外部扫描结果可能在快照之后生成 → 报告末尾标注"扫描时间 vs 快照时间差异"，差异 > 24h 提示重扫
- **大仓库方法级扫描**：Method 数 > 10000 时 `Method --where "deadCandidate=true" --pretty` 可能慢（建议加 `--limit 500` 后分页）
- **油猴审计仅限**：本 Skill Step 2 SEC 维度仅做 GM API 越权浅扫描，深审计（XSS 面 / @connect 白名单 / 注入点）由 `nice-aos-userscript-skill` 承载
- **AI 评审结论边界**：本 Skill 输出 P0~P3 报告，但所有"修复建议"均为辅助，最终决策权在开发者

## 输出形态

综合评审通常输出三类文件：

1. **`reports/review-<scope>-<date>.md`**（主报告，结构化 Markdown，按 spec/review-template.md）
2. **`reports/scan-merged.json`**（外部扫描融合结果，便于后续 diff）
3. **`reports/service-blueprint-<date>.html`**（后端蓝图，仅 Java 后端评审时）

---

*Skill version: 1.0.0 · 基于 nice-aos-deadcode-skill 严格超集 · 设计参考 ASDM code-review v2.0*