# AOS 蓝图 AI 代码分析助手（油猴脚本）

在 **nice-aos 蓝图页**（`export --format html` 生成的 `blueprint.html`）右下方插入浮动按钮，点击展开 AI 对话侧边栏。除代码蓝图（模块/组件/Hook/Store/Service/路由/接口/类/方法/依赖/功能域/死代码等）外，还自动检测并支持**数据库蓝图（dataoverview）**、**部署蓝图（deployoverview）**、**后端服务蓝图（service-blueprint）** 与 **产品规划蓝图（planning-overview：特性/模块/依赖/发布/里程碑/Roadmap/规划健康审计）**，按页面类型自动切换对应的分析模式与领域工具。

架构借鉴自 [steam-ai-agent](/E:/WorkSource/steam-py/steam-workspace/steam-tampermonkey-scripts/steam-ai-agent/steam-ai-agent-1.8.3.user.js)：采用 **ToolRegistry + ReAct 文本协议**（`<tool_calls>{"name":..,"arguments":{..}}</tool_calls>`），用纯文本规避各厂商 function-calling 差异，从而低成本支持多模型供应商。

---

## 功能

- **多模型接入**：内置 DeepSeek / 智谱GLM / 通义千问 / Kimi / 豆包 / OpenAI 六种供应商预设 + 自定义（任意 OpenAI 兼容地址），可在侧边栏一键切换。
- **ReAct 工具循环**：Agent 能自主判断是否需要调用代码分析工具，多轮迭代直到拿到足够信息再作答。
- **代码分析工具集**（数据源见下）：
  - `getStats` 项目本体统计总览（对象数、循环依赖、死代码候选）
  - `queryObjects` 按类型查询对象（组件/Hook/Service/接口…）
  - `getNodeDetails` 单个对象完整详情
  - `listLinks` 对象关系字段 + 反向引用者
  - `getDomainDetail` 功能域构成
  - `analyzeFile` 单文件分析
  - `getArchLayers` 架构分层分布
  - `findDeadCode` 死代码候选（孤儿文件/未用导出/接口/方法）
  - `getProjectContext` 当前页面视图上下文
- **新建会话 / 会话历史**：左侧会话列表，可重命名、删除、清空。
- **数据导出**：会话可导出 **JSON**（可备份 / 再恢复）或 **Markdown**。
- **流式打字输出**、工具调用可视化、可中断生成。

### 产品规划蓝图工具集（`planning-overview` 页）

在规划蓝图页自动注册以下领域工具：

- `getPlanningStats` 规划整体统计（特性/模块/依赖/发布/里程碑/主题数、状态/优先级/版本分布、健康分）
- `queryPlanningFeatures` 特性清单查询（按 status/priority/version/module/keyword 过滤）
- `getPlanningFeatureDetail` 单个特性详情（描述/开放问题/依赖列表）
- `queryPlanningModules` 功能模块构成与覆盖特性
- `getPlanningFeatureDependencies` 特性间依赖关系（依赖谁 / 被谁依赖）
- `getPlanningReleasePlan` 发布与迭代计划、里程碑
- `getPlanningRoadmap` Roadmap 战略主题与里程碑
- `getPlanningHealthAudit` 规划健康审计（四维评分 + 问题清单）
- `queryPlanningDocs` 产品规划全文关键词搜索

示例问答：*《有哪些处于实现中的特性？》* *《FT-001 依赖了哪些特性？》* *《各模块覆盖哪些特性？》* *《本月发布计划？》* *《规划健康度如何？有什么风险？》*

---

## 双数据源

脚本按以下顺序自动选择数据源（无需后端服务）：

1. **页面内嵌 `viewer-data`**（推荐）：`blueprint.html` 本身内嵌了完整视图模型 JSON（`<script id="viewer-data">`）；数据库/部署/服务/规划蓝图页分别内嵌 `db-viewer-data` / `deploy-viewer-data` / `service-viewer-data` / `planning-viewer-data`，油猴脚本按页面类型自动读取，**零依赖、离线可用**。
   > 注意：需要**重新 export** 一次蓝图页才能拿到最新快照。
2. **本地 `snapshot.json`**（可选配置）：在「设置」中填写快照 HTTP 地址，脚本会用 `GM_xmlhttpRequest` 拉取。适合不希望重新 export、或想直接消费 `.nice-aos/data/snapshot.json` 的场景。推荐用 aos 自带的 `serve` 命令一行启动（同时暴露快照与蓝图，CORS 就绪）：
   ```bash
   nice-aos serve                     # 默认 http://127.0.0.1:8420
   ```
   然后在设置里填写 `http://127.0.0.1:8420/snapshot.json`，点「保存并刷新数据源」即可。（等价替代：`cd <项目根目录>/.nice-aos/data && python -m http.server 8080` 等任意静态服务）

---

## 安装

1. 浏览器安装 **Tampermonkey**（油猴）扩展。
2. 将 [blueprint-ai-agent.user.js](./blueprint-ai-agent.user.js) 拖入 Tampermonkey，或在扩展管理面板中**新建脚本**并粘贴内容，保存并启用。
3. **重要——开放本地文件访问**（若用 `file://` 打开蓝图）：
   - Chrome：点击 Tampermonkey 图标 → 管理面板（仪表盘）→ 设置 → 滚动到底部 → 打开「**允许脚本访问文件网址**」（Allow access to file URLs）。
   - 或在浏览器地址栏访问 `chrome://settings/content/pdfDocuments` 无关 —— 正确入口是 Tampermonkey 设置面板中的文件访问开关。
4. 打开蓝图页 `blueprint.html`（`file://` 双击，或经 `http` 静态服务访问均可）。
   > 首次加载时若提示「数据源未加载」，是因为页面内嵌数据为空或未配置快照地址，按上面「双数据源」处理。

---

## 使用

- 点击右下角紫色浮动按钮展开侧边栏。
- 直接从输入框提问，例如：
  - 《这个项目整体结构怎样？有多少源文件和组件？》
  - 《有哪些 Service 和 Store？分别负责什么？》
  - 《Query 相关的组件有哪些？》
  - 《这个项目的架构分层是怎样的？》
  - 《存在循环依赖吗？有哪些死代码候选？》
  - 《dataExporter 服务被哪些文件引用？》
  - 《导出/Import 功能域包含哪些模块？》
- 设置：右上 ⚙ → 设置，配置模型供应商 / API Key / 本地快照地址等。
- 更多：右上 ⚙ → 更多菜单，新建 / 重命名 / 删除会话、导出 JSON/MD、清空历史、刷新数据源。

---

## 目录

```
blueprint-ai-agent/
├── blueprint-ai-agent.user.js   # 油猴脚本（唯一交付物，可直接安装）
└── README.md                    # 本说明
```

---

## 架构速览（src 逻辑，仅一个自包含脚本）

| 模块 | 职责 |
|---|---|
| `MODEL_PROVIDERS` | 多供应商预设 + custom，参考 steam-ai-agent |
| `DataSource` | 双源归一化：`_typeArrays`/`_buildIndex` 兼容 `viewer-data` 与 `snapshot.json` 差异，产出统一的 `byId/byType` 索引 |
| `ToolRegistry` | 工具注册/描述/执行（含超时），输出给 Agent 的 ReAct 协议 |
| `runAgentLoop` | ReAct 迭代循环：prompt → 调用 AI → 解析 `<tool_calls>` → 执行工具回灌 → 直到最终回答 |
| `callAiApi` / `fetchStream` | 流式 SSE（优先页面 `fetch`）与一次性 `GM_xmlhttpRequest` 兜底，均兼容 OpenAI 格式 |
| `ChatManager` | 会话 CRUD + 历史持久化（`GM_setValue`/降级 `localStorage`） |
| UI | 浮窗按钮 / 侧边栏 / 会话列表 / 模型切换 / 设置面板 / 导出 |

---

## 已知限制与说明

- 数据来自 aos 扫描的**本体快照**（结构性元数据），不包含源码全文；回答基于结构关系而非逐行源码。如需源码级分析请配合 aos 的 `query/link` CLI 或本地文件。
- API Key 经 `GM_xmlhttpRequest` 直接发往所选模型厂商，未存服务器，仅存于本机油猴存储。
- 流式输出依赖 AI API 的 **SSE (Server-Sent Events)** 与 CORS 支持（主流厂商 OpenAI 兼容接口均支持）；`file://` 下如遇 CORS 限制会自动降级为一次性请求。
- 默认 `@match file/http/https` 全局匹配，但脚本运行时**仅在内嵌 `viewer-data` 或存在 `#viewer` 容器的蓝图页自激活**，其它页面无副作用。