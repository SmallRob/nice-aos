# AOS 项目级蓝图 AI 助手（油猴脚本 v2）

> nice-aos 蓝图 AI 对话 v2。**接管全部 7 种蓝图**（5 viewer-data + 2 静态聚合），**项目级会话分桶**（同项目共享、跨项目隔离），**跨蓝图数据共享**（getSharedData 工具）。

## 与原脚本 `blueprint-ai-agent` 的关系

| 维度 | 原 `blueprint-ai-agent` v1.1.0 | 本脚本 v1.0.0 |
|---|---|---|
| 页面类型 | 5 种 viewer-data | **全部 7 种**（5 + architecture / summary） |
| 共享粒度 | 全局（所有项目共用 `ba_ai_chats`） | **按 projectId 分桶**（`ba_ai_chats_proj:<projectId>`） |
| 跨蓝图数据 | 不支持 | **支持**（`getSharedData` / `listSharedPages`） |
| 工具集 | 30+ 个 | 通用 4 + 专属 22（精简） |
| 推荐用法 | 禁用 | **单一入口** |

**推荐用法**：禁用原脚本，启用本脚本作为唯一入口。两者并存时 key 完全隔离（不冲突），但用户视角看到的是双脚本各自一套会话，体验割裂。

## 安装

1. 浏览器安装 **Tampermonkey** 扩展
2. 把 `project-blueprint-ai-agent.user.js` 拖入 Tampermonkey（或粘贴保存）
3. 打开任意 nice-aos 蓝图页（5 种 viewer-data 页 + 2 种静态聚合页任一）
4. 右下角出现紫色浮动按钮 → 点击展开侧边栏 → 首次进入设置填 API Key
5. 旧用户：从原 `blueprint-ai-agent` 迁移时，建议先禁用原脚本，启用本脚本；历史会话保留在原 key `ba_ai_chats`，新会话写到 `ba_ai_chats_proj:<projectId>`

## 7 种页面支持

| pageType | 触发条件 | 数据源 | 关键工具 |
|---|---|---|---|
| `code` | `#viewer-data` 或 `#viewer` | 扫描快照 | getStats / queryObjects / getNodeDetails / listLinks |
| `database` | `#db-viewer-data` | DB 快照 | getDbStats / getDbHealth |
| `deploy` | `#deploy-viewer-data` | 部署快照 | getDeployStats / getDeployHealth |
| `service` | `#service-viewer-data` | Java 服务快照 | getServiceStats / getServiceHealth |
| `planning` | `#planning-viewer-data` | 产品规划快照 | getPlanningStats / queryPlanningFeatures / getPlanningHealthAudit |
| `architecture` | URL 路径 `architecture-blueprint.html` + h1 含"架构蓝图" | **DOM 解析** | getArchStats / queryArchServices / queryArchLayers / queryArchTechGroups / queryArchTables / getArchTabContent |
| `summary` | URL 路径 `summary-blueprint.html` + h1 含"总览" | **DOM 解析** | getSummaryStats / querySummaryProjects / getSummaryProjectDetail |

> **关于 architecture / summary 解析**：新版蓝图是 nice-aos 生成的纯静态 HTML（无 viewer-data 嵌入），所以脚本运行 `ArchParser` / `SummaryParser` 从 DOM 提取 `h1`、`.card`、`.svc`、`.layer`、`.techgroup`、`<table>`、`.tab` 等元素。解析失败时回退到 `getSharedData` 从同项目的其他页缓存中查（如果有的话）。

## 项目级会话

```
GM 存储 key 实际值（以 projectId=asdm 为例）：
  ba_ai_settings_proj:asdm       ← 项目级供应商/API Key
  ba_ai_chats_proj:asdm          ← 项目级会话字典
  ba_ai_active_proj:asdm         ← 项目级当前会话
  ba_ai_cache_proj:asdm:code     ← 跨蓝图共享缓存
  ba_ai_cache_proj:asdm:database
  ba_ai_cache_proj:asdm:deploy
  ba_ai_cache_proj:asdm:service
  ba_ai_cache_proj:asdm:planning
  ba_ai_cache_proj:asdm:architecture
  ba_ai_cache_proj:asdm:summary
```

**`projectId` 推断策略**：
1. URL 路径第一段（如 `/asdm/_blueprints/_summary/architecture-blueprint.html` → `asdm`）
2. 降级：`__host__<host>`（如 `__host__127.0.0.1_8420`）
3. 兜底：`__unknown__`

字符过滤：`[^a-zA-Z0-9_.-]` → `_`，最长 80 字符，确保 GM key 合法。

**典型场景**：
- 在 `asdm` 项目下，code 蓝图页开了 AI 问"有哪些 service" → 会话写入 `ba_ai_chats_proj:asdm`
- 切到 `asdm` 项目的 architecture 蓝图页 → 同会话可见、可继续；新会话也写到 `ba_ai_chats_proj:asdm`
- 切到 `nice-aos` 项目的 blueprint.html → 看到的是**另一套会话**（`ba_ai_chats_proj:nice-aos`）

侧边栏顶部会显示当前 `projectId` 徽章（紫色），便于用户校对。

## 跨蓝图数据共享

每个页面打开后，解析结果会写入 `ba_ai_cache_proj:<projectId>:<pageType>`（TTL = 30 分钟）。AI 可用 `listSharedPages` / `getSharedData` 主动查询同项目下其他页面的解析结果。

**示例**：

> 场景：在 `asdm` 项目的 `architecture-blueprint.html` 页，AI 收到问题"code 蓝图里有哪些 service"？
> 1. AI 调用 `listSharedPages` → 看到 code 页已缓存
> 2. AI 调用 `getSharedData(pageType="code", query="service")` → 拿到 code 页的 service 列表
> 3. AI 综合 architecture 的分层 + code 的 service，给出"该 service 落在 application 层"等跨蓝图回答

**为什么用 GM 存储而不是 localStorage**：
- `GM_setValue` / `GM_getValue` 在 Tampermonkey 中是**跨域跨 file:// 全局共享**的
- `localStorage` 受同源限制：`file:///A/_summary/arch.html` 与 `file:///B/_summary/arch.html` 视作不同源
- 跨蓝图共享要求脚本看到同一份缓存，必须用 GM API
- 本脚本已封装好 `Store`（GM 优先 → 降级 localStorage），符合原脚本约定

## 双数据源

与原脚本一致，**双源归一化**：
1. **本项目下同 pageType 的共享缓存**（如果同项目下其他浏览器标签此前打开过本页类型，缓存命中，**毫秒级可用**）
2. **页面解析**（viewer-data 元素 / DOM 结构）

回退链：缓存 → 解析 → 报错。报错信息会通过 toast 提示，建议检查页面是否真的在 nice-aos 蓝图页（且 nice-aos 扫描器版本 ≥ v0.29.0）。

## 架构速览

```
project-blueprint-ai-agent.user.js  (单文件 self-contained, ~1360 行)
├── computeProjectId()                  URL → projectId（带降级链）
├── detectPageType()                    7 种页面：5 viewer-data + 2 静态聚合
├── CONFIG + Store                      key 前缀 ba_ai_*_proj:<projectId>
├── ViewerParsers                       5 种 viewer-data 的 JSON 解析（_buildCodeIndex / Db / Deploy / Service / Planning）
├── ArchParser / SummaryParser          2 种静态聚合的 DOM 解析
├── DataSource                          双源：共享缓存 → 解析 → 写缓存
├── ToolRegistry + 25 个工具            通用 4 + 7 种页面专属 21
├── ChatManager                         项目级分桶（CHATS / ACTIVE / projectId 标签）
├── AGENT_DEFS                          7 种 pageType 的 system prompt
├── ReAct 引擎（runAgentLoop）          多模型 + 流式 + 工具循环 + 停止
└── UI                                  浮窗 / 侧栏 / 会话列表 / 设置 / 导出 JSON+MD
```

## 已知限制

- **架构 / 总览页的解析依赖 DOM 结构稳定**：nice-aos 升级导致 class 名变更会破坏解析。失败时回退到 `getSharedData`（同项目下其他页面的缓存）。完整 7 种 viewer-data 工具集为精简版（约 22 个），原脚本约 30+ 个有更细的领域工具（迁移影响面小，可按需在 v1.1.0 补齐）
- **API Key 直发模型厂商**，未存服务器，仅存于本机油猴存储
- **GM 存储容量**：Tampermonkey 默认 5MB，单项目缓存 + 会话远低于上限
- **DOM 解析有性能开销**：单次解析 < 50ms（实测），不影响页面渲染
- **原脚本 `ba_ai_chats` 不会自动迁移**：v1.0.0 不做历史迁移（v1.1.0 计划提供一次性迁移工具）

## 路线图

- **v1.0.0**（当前）：接管 7 种页面 + 项目级会话 + 跨蓝图共享工具
- **v1.1.0**：历史会话迁移工具（从原 `ba_ai_chats` 按 URL 推断 projectId 拆桶）；补齐原 30+ 个工具集中缺失的部分
- **v1.2.0**：项目列表侧栏（快速切换 projectId）+ 跨标签 storage 事件监听（多标签同步）
- **v2.0.0**（如果需要）：把 7 种页面工具集拆分成独立子脚本（按需加载），主脚本只做项目级会话/跨蓝图共享

## 目录

```
project-blueprint-ai-agent/
├── project-blueprint-ai-agent.user.js   # 主脚本（唯一交付物）
├── README.md                            # 本说明
└── docs/plan/0001-project-level-blueprint-ai-agent.md   # 实现计划
```
