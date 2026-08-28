---
name: nice-aos-context-builder
description: |
  Nice AOS Context Builder 是通用的代码上下文文档生成 Skill：把 nice-aos 代码本体快照渲染为
  「三明治结构」的分层 Markdown 文档树（输出到 .nice-aos/context/），供 AI agent 按渐进式披露高效理解项目，
  并通过 serve /docs 提供在线浏览文档站。
  L1 项目顶层索引（index.md，<2KB：一句话定位 + 技术栈 + 架构分层占比 + 功能域 Top 10）启动必读；
  L2 领域索引（domains/<slug>.md，<1KB：职责画像 + 子模块 + 单元构成 + L3 链接）按任务加载；
  L3 领域详情（components.md 组件清单 / routes.md 路由地图 / state.md 状态管理 / services.md 服务与类型，<5KB/文件）按需下钻；
  汇总层 architecture.md（健康度 / 循环依赖 / 依赖 Top）与 modules.md（模块地图，按语义架构层分组）覆盖架构治理场景。
  文档 100% 由快照程序化生成（nice-aos output docs，千文件级项目约 40ms），代码变更后一条命令刷新，永不手写。
  docs.html 为自包含浏览器（目录树侧边栏 + 搜索 + TOC scroll-spy + frontmatter 徽章 + 暗色主题，零依赖），
  nice-aos serve 后访问 /docs 即可在线浏览，/docs/<path> 与 /context/<path> 暴露 md/json 原始资源。
  触发：用户说"生成项目上下文 / 生成 context 文档 / 项目文档树 / 分层文档 / 三明治上下文 /
  输出 docs / output docs / 项目文档站 / 在线浏览项目文档 / md 文档站点 / 文档浏览页 /
  给 AI 准备项目上下文 / 渐进式读取项目 / build context docs / project context docs / docs site"，
  或需要让 agent 快速建立项目全局认知而不想反复 query/grep 时，
  或需要给团队成员一个可浏览的项目文档入口时。
  英文触发词：generate project context, context docs, layered docs, sandwich context,
  output docs, docs viewer, serve docs, progressive disclosure, project docs site。
  不做：结构问答 / 关系遍历 / 变更影响分析（用 nice-aos-skill skill 的 query/link）；
  可视化交互蓝图（用 output --format html）；死代码清理工作流（用 nice-aos-deadcode skill）。
---

# Nice AOS Context Builder Skill — 代码上下文文档生成

> 把"逐文件 grep + 全量喂源码"降级为"读 L1 索引 → 按需下钻 L2/L3"的渐进式披露。
> 文档由本体快照程序化渲染，与代码永远同步；人通过 serve /docs 文档站浏览同一份产物。

## 概述

本 Skill 让 AI agent 用两条命令完成「项目上下文准备」：

1. `nice-aos action refreshRepo` —— 扫描仓库生成本体快照（已有且新鲜则跳过）
2. `nice-aos output docs` —— 把快照渲染为分层 Markdown 文档树到 `.nice-aos/context/`

之后 agent 按渐进式披露读取文档；人通过 `nice-aos serve` 的 `/docs` 在线浏览。

**与 nice-aos-skill 的分工**：本 skill 负责"上下文产出与阅读顺序"，结构细节的毫秒级查询（query/link/影响分析）走 `nice-aos-skill` skill。两者共享同一份快照。

## 触发场景

| 用户意图 | 典型表述 | 动作 |
|---------|---------|------|
| **生成项目上下文** | "生成项目上下文文档" / "给 AI 准备项目认知" | `action refreshRepo` → `output docs` → 读 `index.md` |
| **agent 快速上手陌生仓库** | "先了解这个项目再动手" | 读 `.nice-aos/context/index.md` → 定位领域 → 读对应 L2 |
| **在线文档站** | "起一个项目文档浏览页" / "docs 站点" | `output docs` → `serve` → 告知 `/docs` 地址 |
| **架构治理视角** | "循环依赖 / 死代码 / 健康度汇总" | 读 `architecture.md`（已含健康度表与循环依赖清单） |
| **模块职责地图** | "各目录的职责 / 语义分层" | 读 `modules.md`（按 archLayer 分组的模块表） |
| **领域下钻** | "shop 域有哪些组件 / 路由" | 读 `domains/shop.md` → 按需读 L3 清单 |
| **纯 agent 模式** | "只要 md 不要浏览页" | `output docs --format md`（仍产 tree.json 索引） |
| **文档过期** | "代码变了重新生成" | 重复 `output docs`（全量覆盖刷新） |

**不触发的场景**：写/改代码（agent 自身能力）、单点结构查询（nice-aos-skill 的 query/link）、可视化汇报蓝图（`output --format html`）。

## 前置条件

- Node.js 18+；`nice-aos` CLI（npm 全局 / npx / 仓库内源码任一形态，获取与版本检测方式见 `nice-aos-skill` skill）
- 项目本体快照：`.nice-aos/data/snapshot.json` 不存在或代码已变更时先执行
  `nice-aos action refreshRepo --params '{"repoPath":"."}'`（React/Vue 项目约 3.5s，大型油猴仓库可达数十秒）

## 标准工作流

```bash
# 1. 快照就绪（缺失或过期时）
nice-aos action refreshRepo --params '{"repoPath":"."}'

# 2. 生成分层上下文文档（默认输出 .nice-aos/context/）
nice-aos output docs
# stdout 返回 JSON 摘要：
# { "ok": true, "outputDir": ".../.nice-aos/context", "format": "all",
#   "mdFiles": 46, "domains": 20, "treeFiles": 46, "elapsedMs": 74,
#   "browse": "nice-aos serve  # 启动后访问 /docs 在线浏览" }

# 3.（可选）在线浏览
nice-aos serve    # http://127.0.0.1:8420/docs
```

变体：

```bash
nice-aos output docs --format md            # 纯 md 树 + tree.json（无 docs.html）
nice-aos output docs --output my-ctx        # 自定义输出目录
nice-aos serve --docs-dir my-ctx            # serve 指向自定义文档目录
```

## 渐进式披露阅读顺序（agent 核心规范）

```
1. 读 .nice-aos/context/index.md            # L1 <2KB：全局认知 + 领域导航（必读，禁止跳过直接读源码）
2. 按任务定位领域 → 读 domains/<slug>.md     # L2 <1KB：领域结构 + 成员构成
3. 需要清单级细节 → 读 domains/<slug>/*.md   # L3 <5KB：组件/路由/状态/服务清单
4. 仍需精查（关系遍历/影响分析）→ nice-aos query / link（nice-aos-skill skill）
```

**单次加载总量 < 50KB**：不要一次性读全树；`architecture.md` / `modules.md` / `domains/_index.md` 属汇总层，仅在架构治理、跨域规划类任务时加载。

## 输出结构

```
.nice-aos/context/
├── index.md              # L1：一句话定位 + 技术栈 + 架构分层占比 + 功能域 Top 10 + 入口
├── architecture.md       # 汇总：语义分层表 / 健康度表 / 循环依赖 Top / 依赖 Top
├── modules.md            # 汇总：模块地图（按 archLayer 分组：模块/文件数/组件数/职责）
├── domains/
│   ├── _index.md         # 领域地图一览表
│   ├── <slug>.md         # L2：领域画像 + 成员统计 + 子模块 Top5 + 单元构成 + L3 链接
│   └── <slug>/
│       ├── components.md # L3：组件清单（名称/文件/类型/Props/行数，按行数热力排序）
│       ├── routes.md     # L3：路由地图（路径/类型/返回目标/跳转数）
│       ├── state.md      # L3：Store（storageKey/持久化/键数）+ Hook 清单
│       └── services.md   # L3：Service + 接口 + 类（按领域文件集圈定）
├── tree.json             # 目录树索引（viewer 侧边栏数据；path 相对 context 根）
└── docs.html             # 自包含浏览器（--format all 时生成）
```

- 粒度预算由生成器保证（超出 TopN 自动截断并注明"共 X"，完整数据回溯 `query`/`export --format json`）
- 仅非空内容生成；无 Domain 的仓库/纯脚本仓库自动降级（领域地图注明，结构见 modules.md）
- 每个 md 带轻 frontmatter（title/layer/generated），浏览器渲染为徽章卡片

## 在线浏览（serve /docs）

| 端点 | 说明 |
|------|------|
| `GET /docs` | 302 → `/docs/` 浏览器入口 |
| `GET /docs/<path>` / `GET /context/<path>` | md（text/markdown）/ json 原始资源；路径穿越防护 |
| `serve --docs-dir <path>` | 自定义文档目录 |

浏览器特性：左侧目录树（搜索 + 统计）、正文 md 渲染（表格对齐/代码围栏/frontmatter 徽章）、右侧 TOC scroll-spy、站内 .md 链接无刷新跳转、`?doc=<路径>` 可分享链接、暗色主题、移动端抽屉侧栏。`output docs` 完成后向运行中的 serve 广播 `docs:changed`。

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 任务开始需要项目认知 | 优先读已有的 `.nice-aos/context/index.md`（存在且 generated 较新时直接用）；无则走标准工作流生成 |
| 快照缺失 / 代码已变更 | 先 `action refreshRepo` 再 `output docs`（无需用户确认） |
| 用户要"文档站 / 在线浏览" | `output docs` 后 `serve`，告知 `http://127.0.0.1:<port>/docs`（serve 默认 8420，`--port 0` 自动分配，从 stdout 横幅读取实际端口） |
| 需要关系级精查（谁引用/影响面） | 本 skill 文档不含关系图——切 `nice-aos-skill` 的 `link` 命令 |
| 需要完整未截断数据 | `nice-aos query <Type> --all` 或 `output --format json` 后 jq |
| CI / 无头环境 | `--format md` 即可（tree.json 供程序化遍历，无需浏览器） |
| 文档与代码不一致 | 文档是快照的投影：重跑 `refreshRepo` + `output docs`，不要手改 `.nice-aos/context/` |

## 技术限制

- 文档内容上限 = 快照内容：快照未覆盖的信息（运行时行为、动态路由等）不在文档中
- L2/L3 成员清单为 TopN 截断视图（预算见 README「粒度控制黄金数字」），不是全量清单
- 接口/类无领域归属属性，按领域 fileIds 路径集合圈定——跨领域共享的类型文件可能出现在多个领域
- docs.html 为零依赖手写 md 渲染：覆盖表格/嵌套列表/任务列表/代码围栏/引用/图片，不渲染 mermaid 与公式
- 中文/特殊字符路径在浏览器内按段 encodeURIComponent，`tree.json` 中为解码后的原始相对路径
