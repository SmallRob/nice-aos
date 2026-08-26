# 0001 — 项目级蓝图 AI 助手（project-blueprint-ai-agent）

> 状态：v1 落地（fork 自 `contrib/blueprint-ai-agent/blueprint-ai-agent.user.js@1.1.0`）
> 范围：nice-aos 生态中的**新版静态蓝图**（架构/总览）+ 同项目下所有蓝图的**项目级会话共享**
> 出品：参考 `asdm/_blueprints/_summary/architecture-blueprint.html` 与 `summary-blueprint.html`

---

## 1. 背景与问题

### 1.1 现有 `blueprint-ai-agent` 的能力与边界

现有脚本 `contrib/blueprint-ai-agent/blueprint-ai-agent.user.js` v1.1.0（3398 行）已经在 nice-aos 生态里覆盖了 5 种蓝图页：

| 页面类型 | DOM 检测标识 | 数据源 | 工具集 |
|---|---|---|---|
| `code` | `#viewer-data` 或 `#viewer` | 扫描快照 | `getStats` / `queryObjects` / `getNodeDetails` / `listLinks` / ... |
| `database` | `#db-viewer-data` | DB 扫描快照 | `getDbStats` / `queryTables` / `queryForeignKeys` / ... |
| `deploy` | `#deploy-viewer-data` | 部署扫描快照 | `getDeployStats` / `queryDeployServices` / ... |
| `service` | `#service-viewer-data` | Java 服务扫描快照 | `getServiceStats` / `queryServiceModules` / ... |
| `planning` | `#planning-viewer-data` | 产品规划文档扫描 | `getPlanningStats` / `queryPlanningFeatures` / ... |

**数据源全是页面内嵌 JSON 快照**（`viewer-data` / `db-viewer-data` / ...），由 nice-aos 各类 `export --format html` 子命令在生成时打入 HTML。

### 1.2 新版蓝图不能被现有脚本识别

`asdm/_blueprints/_summary/architecture-blueprint.html`（项目全景架构蓝图）与 `summary-blueprint.html`（项目代码本体总览）属于 nice-aos 的**新一代静态聚合蓝图**：

- 没有任何 `<script id="*-viewer-data">` 元素
- 是纯 HTML + 内联 CSS（单文件 50KB ~ 200KB），打开即用
- 内容来自 a) 多个子项目扫描快照的二次聚合，b) 部署配置 / 集成关系 / 技术栈 / 分层 等
- 标题里直接包含**项目标识**（"ASDM 18 项目全景架构蓝图"）
- DOM 结构高度可解析：
  - 6 张统计卡（`div.card > div.k / div.v`）
  - 7 个 tab（`div.tab[data-tab="..."]`），内容随 tab 切换
  - 服务列表（`div.svc`，含 role/name/meta/port/tech）
  - 分层（`div.layer`）
  - 技术栈（`div.techgroup`）
  - `<table>` 多张

**结论**：现有脚本在 `architecture-blueprint.html` / `summary-blueprint.html` 上不会自激活（`detectPageType` 返回 `null` 早退）。即便手工绕开 `detectPageType` 触发，也没有可消费的 `viewer-data`。

### 1.3 共享粒度问题

现有脚本的会话存储：

```js
SK: { SETTINGS: 'ba_ai_settings', CHATS: 'ba_ai_chats', ACTIVE: 'ba_ai_active_chat', ... }
```

`ba_ai_chats` 是**全局单 key**——任何 nice-aos 蓝图页（不分类别、不分项目）打开侧栏都看到同一份会话列表。**实际是"跨蓝图共享"**（用户提到"已经支持跨蓝图数据共享"指的就是这个），但**没有项目维度**，跨项目互相污染。

用户要的"项目级共享"= 同项目下不同蓝图共享，不同项目隔离。

---

## 2. 目标

1. **支持新版蓝图**：`architecture-blueprint.html` + `summary-blueprint.html` 直接能用 AI 对话
2. **项目级会话共享**：URL 推断 `projectId`，同一 `projectId` 下所有蓝图（code / db / deploy / service / planning / architecture / summary）共享同一份会话历史
3. **跨项目隔离**：不同 `projectId` 的会话互不可见
4. **沿用现有架构**：ReAct + ToolRegistry + 多模型 + 流式 + 导出全部继承

---

## 3. 设计决策

### 3.1 存储：GM API → 降级 localStorage

| 候选 | 评估 |
|---|---|
| `GM_setValue` / `GM_getValue` | ✅ Tampermonkey 原生，**跨域跨 file:// 全局共享**，容量充足（多数实现 ≥5MB），写同步、读同步、易封装 |
| `localStorage` | ⚠️ 受同源限制：`file:///A/...html` 与 `file:///B/...html` 视作不同源（且部分浏览器对 `file://` 的 localStorage 行为不稳定）。`http://` 下同源则 OK |
| `sessionStorage` | ❌ 标签级，会话结束就丢 |
| `IndexedDB` | ⚠️ API 异步 + 复杂；跨域/同源都能用但收益不抵成本 |
| `Cookie` | ❌ 容量小，同源限制更强 |

**决策**：沿用 `Store` 封装（`GM_*` 优先，降级 `localStorage`）。这是 nice-aos 用户已经验证的存储层，重用最低风险。**项目分桶通过 key 前缀实现**，与存储层无关。

### 3.2 项目识别：`projectId` 推断策略

| 来源 | 提取方式 | 示例 |
|---|---|---|
| URL 路径第一段 | `location.pathname.split('/').filter(Boolean)[0]` | `/asdm/_blueprints/_summary/architecture-blueprint.html` → `asdm` |
| URL 路径 `/_summary/` 段 | 上一级的 `..` 父目录（如 `_summary`） | 不直接使用，仅用于页面类型识别 |
| 降级 1 | `location.host`（如 `127.0.0.1:8420`） | `__host__127.0.0.1_8420` |
| 降级 2 | 字面量 `__unknown__` | 所有兜底失败 |

**关键约束**：
- `projectId` 仅含 `[a-zA-Z0-9_.-]`，其他字符替换为 `_`，避免 GM key 非法
- 不读取 DOM 标题（h1 里"ASDM 18"含空格 + 数字，**不稳定**），URL 是确定性的

### 3.3 会话 / 缓存分桶

| 用途 | 旧 key | 新 key | 备注 |
|---|---|---|---|
| 设置 | `ba_ai_settings` | `ba_ai_settings_proj:<projectId>` | **也按项目分桶**：项目可独立配置供应商/快照地址 |
| 会话字典 | `ba_ai_chats` | `ba_ai_chats_proj:<projectId>` | 会话 dict，key=convId |
| 当前会话 | `ba_ai_active_chat` | `ba_ai_active_proj:<projectId>` | 当前选中会话 id |
| 数据缓存 | `ba_ai_cache` | `ba_ai_cache_proj:<projectId>:<pageType>` | 同一项目下 7 种页面的解析结果可互查（**真正的跨蓝图数据共享**） |
| 快照地址 | `ba_ai_snap` | `ba_ai_snap_proj:<projectId>` | 项目级本地快照地址 |
| 版本号 | `ba_ai_ver` | `ba_ai_ver_proj:<projectId>` | 数据迁移用 |

> **数据缓存跨页面共享的实例**：在 `asdm` 项目下，code 蓝图页把解析出的 `services / modules / hooks` 写入 `ba_ai_cache_proj:asdm:code`；当用户切到 `architecture` 蓝图页时，AI 可用 `getSharedData(pageType, query)` 工具主动拉取 code 页的 services 列表，结合架构页的 layer/tech 给出"该项目的服务在分层里如何分布"这种**跨蓝图**回答。

### 3.4 页面识别扩展

`detectPageType` 现状：

```js
if (planning-viewer-data) → 'planning'
if (service-viewer-data)  → 'service'
if (deploy-viewer-data)   → 'deploy'
if (db-viewer-data)       → 'database'
if (viewer-data)          → 'code'
return null
```

新副本（`project-blueprint-ai-agent.user.js`）扩展：

```js
// 1) 原 5 种：有 viewer-data 元素 → 让出给原脚本（避免双脚本同时工作）
if (planning-viewer-data || service-viewer-data || deploy-viewer-data || db-viewer-data || viewer-data) return;
// 2) 新增 2 种：基于 URL + 标题 + DOM
if (path 含 /_blueprints/_summary/architecture-blueprint.html) → 'architecture'
if (path 含 /_blueprints/_summary/summary-blueprint.html)     → 'summary'
return null
```

> **并存约定**：原脚本（v1.1.0）与新副本可以同时启用。新副本检测到原 5 种页面时立即 `return`（避免 UI 重复），原脚本继续工作；新副本只接管 `architecture` / `summary` 2 种页面。**会话 key 完全隔离**，不会互踩。

### 3.5 数据源：DOM 解析（无 JSON 快照可读）

新版蓝图无 `viewer-data`，所有数据需运行时从 DOM 提取。新副本**复用 `DataSource` 双源架构**，但 `_buildXxxIndex` 用 DOM 解析版本：

#### architecture 页

- `project`：从 `<h1>` 解析（去掉"项目全景架构蓝图"前后缀）
- `meta`：从 `.meta` 元素（`asdm-portal 80 | React 19 + Vite 8`）
- `stats`：从 `.cards > .card` 列表（k/v 对）
- `tabs`：从 `.tab`（data-tab + text）→ 各 tab 面板 `.panel[data-tab=...]`
- `services`：从 `.svc` 列表（role / name / meta / port / tech / 链接到子项目 blueprint.html）
- `layers`：从 `.layer` 列表（title / 包含的 svc 列表）
- `techGroups`：从 `.techgroup` 列表（tgv / tgt / items）
- `tables`：从 `<table>`（h2 + table），按 h2 关联标题

#### summary 页

- `project`：从 `<h1>` 解析
- `stats`：从 `.cards > .card`
- `projects`：从 `<table>` 中每行（项目名 / 框架 / 文件数 / 行数 / 占比 / 链接到 `../<project>/blueprint.html`）
- `links`：从开头 `<a href="architecture-blueprint.html">` 跨链接

### 3.6 工具集

`architecture` 页工具集（v1）：

| 工具 | 用途 | 数据来源 |
|---|---|---|
| `getArchStats` | 6 张统计卡概览 | `data.stats` |
| `queryArchServices` | 服务清单（按 role/keyword 过滤） | `data.services` |
| `getArchServiceDetails` | 单个服务详情（name → 找 `.svc`） | `data.services[i]` |
| `queryArchLayers` | 分层架构 | `data.layers` |
| `queryArchTechGroups` | 技术栈 | `data.techGroups` |
| `queryArchTables` | 表格查询（Java 后端 / 文档配置 / ...） | `data.tables` |
| `getArchTabContent` | 读指定 tab 文本（整体/服务/技术栈/分层/集成/部署/部署架构） | `data.tabs[tabKey]` |
| `getSharedData` | 跨蓝图数据共享入口 | `Store` 缓存（其他 pageType 解析结果） |

`summary` 页工具集（v1）：

| 工具 | 用途 |
|---|---|
| `getSummaryStats` | 5 张统计卡概览 |
| `querySummaryProjects` | 项目清单（按规模/语言过滤） |
| `getSummaryProjectDetail` | 单个项目详情（行数 / 链接到 blueprint.html / architecture-blueprint.html） |
| `getSharedData` | 同上 |

`getSharedData` 是项目级共享的"招牌工具"——它让 AI 显式告诉用户："我可以跨蓝图查，例如问你项目里某 service 在 code 蓝图的细节"。

---

## 4. 架构速览

```
project-blueprint-ai-agent.user.js  (单文件 self-contained, ~3500 行)
├── @namespace / @version / @grant    沿用原脚本
├── detectPageType()                  扩展：识别 architecture / summary
├── computeProjectId()                URL → projectId（带降级链）
├── Store                             沿用：GM_* 优先 → localStorage
│   └── 新 key：<base>_proj:<projectId>[:<sub>]
├── DataSource                        双源：模式A DOM 解析 / 模式B GM 缓存命中
│   ├── readInjected()                优先读 GM 缓存（其他页面已解析并写入）
│   ├── readDom()                     DOM 解析 architecture / summary
│   └── load()                        协调：缓存 → DOM → 写缓存
├── ToolRegistry + ReAct              沿用
├── AGENTS                            新增 arch_overview / summary_overview
├── ChatManager                       项目级分桶
│   ├── _keyChats()                   → ba_ai_chats_proj:<projectId>
│   ├── _keyActive()                  → ba_ai_active_proj:<projectId>
│   └── ensureActive()                项目级独立 active
├── UI                                沿用（侧栏 / 浮窗 / 设置 / 导出）
└── 写入策略                          解析完成 → 写共享缓存（其他页面下次可直接读）
```

---

## 5. 实施步骤

### Phase 1：骨架（最小可用）—— 当前落地

- [x] 写实现计划
- [ ] 创建 `project-blueprint-ai-agent.user.js`：
  - [ ] header + 页面检测（detectPageType 扩展）
  - [ ] computeProjectId（URL 推断 + 降级）
  - [ ] Store 封装（含项目分桶 key）
  - [ ] DataSource（DOM 解析 architecture / summary）
  - [ ] ToolRegistry + arch / summary 两套工具
  - [ ] ChatManager（项目级分桶）
  - [ ] UI shell（沿用原脚本样式 + 面板 + 浮窗 + 设置）
  - [ ] Agent 引擎（ReAct + 多模型 + 流式 + 导出）
  - [ ] getSharedData 工具（跨蓝图数据共享入口）
  - [ ] 写入共享缓存（解析完成自动写）
- [ ] 写 README（与原脚本并存说明 + 项目级会话说明）

### Phase 2：跨蓝图数据共享试点（待 Phase 1 跑通后）

- [ ] 在 `asdm` 项目里实际验证：从 `blueprint.html` 打开 AI → 切到 `architecture-blueprint.html` → 能继续会话 / 看到对方缓存的 services
- [ ] 在 `_summary/summary-blueprint.html` 验证项目列表 → 点击跳到子项目 blueprint.html

### Phase 3：可选增强

- [ ] 项目列表侧栏（让用户快速切换 projectId）
- [ ] 跨标签同步（监听 storage 事件）
- [ ] 数据迁移工具（从 `ba_ai_chats` 老 key 读历史 → 按 `projectId` 拆桶写入，仅一次）

---

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 原 5 种页面与新副本并存时双 UI 冲突 | 新副本检测到 5 种 viewer-data 立即 `return`，让原脚本独占 |
| URL 推断 projectId 不可靠（如放在根目录） | 降级到 host；最后兜底 `__unknown__`；UI 角标显示当前 projectId 便于用户校对 |
| `file://` 下 localStorage 不同源 | GM 存储优先（已经过验证）；localStorage 仅在 GM 不可用时降级 |
| DOM 结构改版（nice-aos 升级） | DOM 解析采用**多重 fallback**（class 选择器失败 → tagName + textContent 模糊匹配）；解析失败仅影响当前页面的工具集，不影响会话/其他页面 |
| 解析结果写入 GM 缓存体积过大 | 5MB 容量对单项目足够；超出时降级到 localStorage + 压缩（v1 不做） |

---

## 7. 不做

- 不修改 `contrib/blueprint-ai-agent/blueprint-ai-agent.user.js`（用户明确要求副本实现）
- 不引入 zod / 任何运行时依赖（与原脚本一致）
- 不做 Tauri 侧迁移（v1 只做用户态/浏览器侧）
- 不做服务端转发（API Key 仍直发模型厂商，与原脚本一致）
- 不做 OAuth（v1 不引入新的鉴权流）
