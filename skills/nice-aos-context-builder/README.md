# Nice AOS Context Builder — 通用代码上下文生成 Skill

skill-id: nice-aos-context-builder
version: 0.4.0
updated-date: 2026-08-28
description: 面向任意代码仓库的上下文文档生成——由 nice-aos 本体快照程序化产出「三明治结构」的分层 Markdown 文档树（.nice-aos/context/），并配套 serve 在线浏览（/docs）。AI agent 按渐进式披露读取，人通过文档站浏览。

---

## 1. 概述

### 1.1 核心设计理念

**传统方案的痛点**：

| 问题 | 原因 |
|------|------|
| 全量喂源码 | 大型仓库一次性分析，AI 注意力分散、token 爆炸 |
| 逐文件 grep | 每个结构问题都要重新扫描，慢且易漏 |
| 手写文档 | 项目演进后迅速过期，维护成本高 |

**Context Builder 的解法**：

> 不是让 AI "知道一切"，而是把**代码本体快照**程序化渲染为**分层导航文档**——L1 轻索引启动必读、L2 领域索引按任务加载、L3 领域详情按需下钻。文档由快照生成，代码变更后一条命令刷新，永不手写。

### 1.2 三明治架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    三明治上下文架构                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  L1: 项目顶层索引（index.md，< 2KB）                       │  │
│  │  - 一句话定位 + 技术栈 + 架构分层占比                       │  │
│  │  - 功能域列表（Top 10）+ 入口链接                           │  │
│  │  → AI 启动时必读，建立全局认知                              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  L2: 领域索引（domains/<slug>.md，< 1KB/领域）              │  │
│  │  - 领域职责画像 + 成员统计表                                 │  │
│  │  - 子模块 Top N + 单元构成 + L3 详情链接                    │  │
│  │  → 任务涉及某领域时加载                                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  L3: 领域详情（domains/<slug>/*.md，< 5KB/文件）            │  │
│  │  - components.md 组件清单 / routes.md 路由地图              │  │
│  │  - state.md 状态管理 / services.md 服务与类型               │  │
│  │  → 遇到具体实现细节时加载                                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  汇总层：architecture.md（分层/健康度/循环依赖/依赖 Top）        │
│          modules.md（模块地图，按语义架构层分组）                 │
│          domains/_index.md（领域地图一览表）                      │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 渐进式披露机制

```
AI 启动 / 接到任务
     ↓
[读取 L1: index.md]  →  建立全局认知，找到领域导航
     ↓
定位任务所属领域（如：修改购物车逻辑 → shop 域）
     ↓
[读取 L2: domains/shop.md]  →  了解领域结构与子模块
     ↓
遇到具体实现细节
     ↓
[按需读取 L3: domains/shop/components.md 等]  →  获取清单级细节
```

---

## 2. 核心原则

### 2.1 粒度控制黄金数字

| 指标 | 预算 | 实现方式 |
|------|------|----------|
| L1 顶层索引 | < 2KB | 功能域只列 Top 10 |
| L2 领域索引 | < 1KB/领域 | 子模块 Top 5 + 成员名 Top 5 |
| L3 详细内容 | < 5KB/文件 | 表格行数 Top 25 |
| 单次加载总量 | < 50KB | 渐进式披露，禁止一次读全树 |
| 领域数量 | 5-10 个 | 快照 Domain 对象天然聚合 |

超出预算时自动截断并注明"仅列出前 N，共 X"——完整数据永远可回溯本体快照（`nice-aos query` / `export --format json`）。

### 2.2 数据源是本体快照，不是源码

文档内容 100% 由 `.nice-aos/data/snapshot.json` 渲染而来（`src/ontology/contextDocs.js` 纯函数，约 40ms/千文件级项目）：

- **L1** ← Project（summary/architecture/health）+ Domain 清单
- **L2/L3** ← Domain 的成员 IDs（组件/路由/Store/Hook/Service/模块）+ 成员对象属性
- **接口/类**（无领域归属）按领域 fileIds 路径集合圈定

快照语义（20+ 种对象、26 种链接、语义架构层 archLayer、功能域 Domain 聚合）见 `nice-aos-skill` skill。

### 2.3 任务粒度与上下文粒度匹配

| 任务类型 | 需要加载的上下文 |
|----------|------------------|
| 理解项目全貌 | L1 index.md |
| 规划新功能 | L1 + 相关领域 L2 |
| 修改单个组件 | L1 + L2 + 相关 L3 |
| 修改跨域逻辑 | L1 + 多个 L2 + architecture.md |
| 重构 / 架构治理 | architecture.md（健康度/循环依赖/死代码）+ modules.md |

---

## 3. 使用方式

### 3.1 前置条件

- Node.js 18+，`nice-aos` CLI（npm 全局 / npx / 仓库内源码任一形态）
- 项目已有本体快照（没有则先 `nice-aos action refreshRepo`，React/Vue 项目约 3.5s）

### 3.2 标准工作流

```bash
# 步骤 1：确保快照新鲜（已有且代码未变可跳过）
nice-aos action refreshRepo --params '{"repoPath":"."}'

# 步骤 2：生成分层上下文文档（默认 .nice-aos/context/，md 树 + tree.json + docs.html）
nice-aos output docs

# 步骤 2'：纯 agent 模式（不产 docs.html 浏览器）
nice-aos output docs --format md
nice-aos output docs --output .nice-aos/context --format all   # 显式指定

# 步骤 3：在线浏览（给人看）
nice-aos serve          # 访问 http://127.0.0.1:8420/docs
```

代码变更后重复步骤 1-2 即可全量刷新（文档为生成物，`.nice-aos/` 已在 .gitignore，不入库）。

### 3.3 输出目录结构

```
.nice-aos/context/
├── index.md                    # L1: 项目顶层索引（<2KB）
├── architecture.md             # 汇总: 语义分层 / 健康度 / 循环依赖 / 依赖 Top
├── modules.md                  # 汇总: 模块地图（按 archLayer 分组）
├── domains/
│   ├── _index.md               # 领域地图（每域一行：文件/组件/路由/Store/概要）
│   ├── <slug>.md               # L2: 领域索引（<1KB：画像 + 子模块 + 单元构成 + L3 链接）
│   └── <slug>/
│       ├── components.md       # L3: 组件清单（名称/文件/类型/Props/行数，按行数热力排序）
│       ├── routes.md           # L3: 路由地图（路径/类型/返回目标/跳转数）
│       ├── state.md            # L3: 状态管理（Store 持久化键 + Hook 清单）
│       └── services.md         # L3: 服务与类型（Service/接口/类，按领域文件集圈定）
├── tree.json                   # 目录树索引（浏览侧边栏数据源；path 统一相对 context 根）
└── docs.html                   # 自包含文档浏览器（零依赖，任意静态服务器可跑）
```

仅非空内容生成（无路由的领域不产 routes.md；无领域的仓库/纯脚本仓库自动降级为汇总层文档并在领域地图注明）。

---

## 4. 在线浏览（serve /docs）

`docs.html` 借鉴静态知识库模式（离线生成索引 JSON + 运行时按需 fetch md 正文）：

- 左侧目录树侧边栏（搜索过滤 + 文档统计）
- 正文 Markdown 渲染（表格对齐 / 代码围栏 / frontmatter 徽章卡片）
- 右侧浮动 TOC（scroll-spy 高亮）
- 站内 `.md` 链接无刷新跳转；`?doc=<路径>` 可分享、可前进后退
- 暗色科技风主题，移动端抽屉式侧栏

serve 端点：

| 端点 | 说明 |
|------|------|
| `GET /docs` | 302 → `/docs/`（浏览器入口） |
| `GET /docs/` | docs.html 浏览器页 |
| `GET /docs/<path>` / `GET /context/<path>` | 文档静态资源（md → text/markdown、json → application/json），逐段解码 + 路径穿越防护 |
| `serve --docs-dir <path>` | 文档目录不在默认位置时显式指定 |

`output docs` 写盘完成后自动向运行中的 serve 广播 `docs:changed`（WebSocket `/ws/snapshot`）。

---

## 5. 与其他 Skill / 命令的分工

| 能力 | 入口 | 定位 |
|------|------|------|
| 结构问答 / 影响分析 / 关系遍历 | `nice-aos-skill` skill（query/link） | 毫秒级单点查询 |
| **分层上下文文档产出（本 skill）** | `output docs` | 一次生成，agent 渐进式读取 |
| 交互蓝图（可视化汇报） | `output --format html` | 自包含 HTML，浏览器直接打开 |
| 单文件全景报告 | `output --format markdown` | 单一大 md（30+ 节），人读 |
| ask 上下文注入 | `ask` | 问答时自动浓缩快照上下文 |

**推荐组合**：agent 任务开始时读 `.nice-aos/context/index.md` 建立认知（替代重复 query），下钻细节用 query/link 精查，交接给人时 `serve` 开文档站。

---

## 6. 版本历史

| 版本 | 日期 | 修改内容 |
|------|------|----------|
| v0.4.0 | 2026-08-28 | 通用化：剥离 ASDM 专属设定，落点 nice-aos 快照 + `output docs` 命令闭环；新增 serve /docs 在线浏览（docs.html 三栏浏览器 + tree.json 索引） |
| v0.3.0 | 2026-04-14 | 适配大型代码库，采用三明治架构（ASDM Toolset 设计稿） |
| v0.2.0 | 2026-01-19 | 支持多语言、增加渐进式加载 |
| v0.0.2 | 2026-01-19 | 初始版本 |

---

## Copyright & License

Copyright (c) 2026 LeansoftX.com & iSoftStone. All rights reserved.

Licensed under the PROPRIETARY SOFTWARE LICENSE. See [LICENSE](LICENSE) in the project root for license information.
