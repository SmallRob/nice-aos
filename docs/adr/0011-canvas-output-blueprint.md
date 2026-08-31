# ADR 0011 — 画布作为 output 的第五种格式：架构图与蓝图产出的同构

- 状态：已接受
- 日期：2026-08-31
- 影响：v0.43.0
- 相关：nice-aos-canvas-skill（v0.42 新增）、src/canvas/（v0.43 新增）

## 背景

v0.42 在 `skills/nice-aos-canvas-skill/` 新增了架构图画布技能：
- `assets/deploy-canvas-template.html`：自包含 HTML+SVG 部署架构画布（含语义分析 + 布局 + 交互）
- `SKILL.md`：四阶段工作流（Phase 1 数据获取 → Phase 2 语义分析 → Phase 3 画布生成 → Phase 4 质量校验）
- 两条路径：模板驱动（手动复制粘贴）+ Agent 手工绘制

但 v0.42 的实现有两个关键缺陷：

1. **CLI 不可达**：画布是 Agent 视角的产物，没有 `nice-aos ... --format canvas` 的程序化入口；
   用户要么用 Agent 跑，要么手动复制模板替换 `<script id="canvas-data">` 数据块（~20 步）
2. **范围仅限 deploy**：overview / db / service / planning 四类蓝图都未被画布覆盖

同时，三大核心命令的 output（即 export 的别名）在 nice-aos 内部被定义为"对应用户视角的'产出报告'"，
但实际上它只产出 markdown / json / html / viewmodel / all 五种文本格式，缺少"画"这一维度。

## 决策

**v0.43.0 将画布作为 output 的第六种格式（`--format canvas`）**，由 `src/canvas/canvasBuilder.js`
提供纯函数 API，让 CLI、Agent、第三方工具用同一条路径消费蓝图快照出画布。

### 核心设计

```
┌────────────────────┐  ┌────────────────────┐
│  nice-aos deploy   │  │  nice-aos overview │   ... 蓝图扫描
│  scan / export     │  │  scan / export     │
└────────┬───────────┘  └─────────┬──────────┘
         │                        │
         ▼                        ▼
   deploy-snapshot.json    overview-snapshot.json
         │                        │
         └────────┬───────────────┘
                  ▼
        src/canvas/canvasBuilder.js   ← 纯函数 API
        ├ buildDeployCanvas(model)
        ├ buildOverviewCanvas(model)
        └ buildCanvasAuto({deploy, overview, preferKind})
                  │
                  ▼
      自包含 HTML+SVG 画布（浏览器离线打开）
```

### 三个消费入口（同一条管线）

1. **`nice-aos deploy export --format canvas --output x.html`**：直接对 deploy 快照出画布
2. **`nice-aos overview export --format canvas --output x.html`**：对 overview 快照出画布
3. **`nice-aos output --format canvas --output x.html`**：三大核心命令 output 的 canvas 格式，
   自动检测可用的 deploy / overview 快照，**用户视角的"一键出画布"**

### 模板契约

`assets/{deploy,overview}-canvas-template.html` 必须满足：

1. 数据块占位符 `<script id="canvas-data" type="application/json">__CANVAS_DATA_JSON__</script>`
   - 占位符 token 是源码字面量（不能是 HTML 注释 / 模板字符串），保证 `String.replace` 干净替换
2. 模板内启动脚本检测 raw text 是否含 `__CANVAS_DATA_JSON__`，未注入时降级到使用提示
   （不抛错，让用户能看到提示而不是空白页）
3. 零外部依赖（CSS / JS 全内联）
4. 含 `cvZoom / cvReset / ovZoom / ovReset` 缩放/重置接口

### builder 接口契约

`src/canvas/canvasBuilder.js` 公开四个函数：

| 函数 | 输入 | 输出 |
|---|---|---|
| `buildCanvas({ kind, snapshot, title })` | 通用入口 | `{ html, kind, stats }` |
| `buildDeployCanvas(deployModel, opts)` | deploy 快照 | `{ html, kind:'deploy', stats }` |
| `buildOverviewCanvas(overviewModel, opts)` | overview 快照 | `{ html, kind:'overview', stats }` |
| `buildCanvasAuto({ deployModel, overviewModel, preferKind })` | 任一 | `{ html, kind, stats, source }` |

错误前置：缺 `services` / `projects` 时在 builder 内抛明确错误，不产出半残的 HTML。

## 影响

### 正面

- **零摩擦画布产出**：从"手动复制模板替换数据块"→"`nice-aos output --format canvas` 一行命令"
- **画布与 markdown / html / viewmodel 同列**：output 真正成为"对应用户视角的产出报告"命令
- **画布技能的程序化入口**：SKILL.md 描述的四阶段工作流现在可以被 CLI 完整执行（Phase 2 = CLI 命令）
- **多蓝图覆盖**：v0.43 落地 deploy + overview 两种，后续 db / service / planning 可平滑扩展
- **离线可用**：模板零依赖，产出的 HTML 可直接归档 / 邮件 / CI 制品

### 风险与缓解

- **模板被破坏的风险**：`assets/*.html` 是 CLI 运行时读取的资产，发布时遗漏 → 画布命令 fail
  - 缓解：测试 `模板 SPA 路径: assets 目录确实随包发布` + `canvasPaths: 模板文件存在且非空`
  - `package.json` 的 `files` 字段已声明 `skills/**/assets/**`
- **HTML 体积膨胀**：53 服务 + 87 K8s 资源 + 55 依赖的 asdm-admin 部署画布 ~280 KB（自包含）
  - 可接受（架构评审场景通常 < 1 MB）；未来超 500 服务时考虑分片 / 折叠
- **画布与 markdown / html 蓝图重复**：viewmodel / markdown / html / canvas 四种格式本质都是
  "用不同方式呈现同一份快照"
  - 这是 nice-aos 的一贯设计（同一数据多种表达），用户按场景选择；画布补的是"图"这个空白
- **overview 画布 v0.43 较简**：项目 × 分层矩阵 + 跨项目长边，覆盖最常见需求
  - 暂未实现 overview 节点的 force-layout / 服务间通信边矩阵；
  - 后续 v0.44+ 可加 service-to-service 通信矩阵 / 资源配额热力图

### 已锁定的 8 个决策

- **D1** 画布作为 output 的第 6 种格式（`--format canvas`）
- **D2** 模板与数据解耦，模板只负责"画"，builder 负责"装"
- **D3** 模板占位符 `__CANVAS_DATA_JSON__` 是源码字面量（不用 `{{ var }}` 风格）
- **D4** builder 暴露纯函数 API，CLI / Agent / 第三方工具共享
- **D5** 错误前置：缺关键字段时抛明确错误而非产出半残图
- **D6** 数据自动检测：output --format canvas 按 deploy → overview 顺序探测
- **D7** 模板启动脚本检测占位符，未注入时降级到使用提示（不抛错）
- **D8** 模板 JS 注入 JSON 时转义 `</script` 字符串，避免被浏览器提前关闭 data 块

## 落地清单（v0.43.0）

- [x] `src/canvas/canvasPaths.js` — 模板路径 + 占位符注入（11 个测试）
- [x] `src/canvas/canvasBuilder.js` — 4 个公开 API（19 个测试）
- [x] `skills/nice-aos-canvas-skill/assets/deploy-canvas-template.html` — 增强 6 类风险徽标 + 跨域点划边 + 优雅降级
- [x] `skills/nice-aos-canvas-skill/assets/overview-canvas-template.html` — 新增全景画布（项目列 × 分层行矩阵）
- [x] `src/cli/commands/deploy.js` — `deploy export --format canvas` 接入
- [x] `src/cli/commands/overview.js` — `overview export --format canvas` 接入
- [x] `src/cli/commands/export.js` — `output --format canvas` 接入（自动检测）
- [x] `src/deployment/deploySnapshot.js` — 补 `hasDeploySnapshot` 导出
- [x] `skills/nice-aos-canvas-skill/SKILL.md` — 三阶段教学（程序化版）+ 9 类风险徽标
- [x] `test/canvasBuilder.test.mjs` — 19 个单测
- [x] `test/canvasExportCli.test.mjs` — 5 个端到端 CLI 测试
- [x] `CHANGELOG.md` v0.43.0 条目
- [x] `package.json` 版本 → 0.43.0

## 后续候选（v0.44+）

1. **db / service / planning 三种画布** — 复用同一 builder 接口，扩展模板即可
2. **overview 画布增强** — 服务间通信矩阵 / 资源配额热力图 / 强制布局
3. **画布对照模式** — 同一项目产出 v1 / v2 画布，diff 节点/边/徽标
4. **画布嵌入 markdown** — 评审报告里内联 SVG 片段（而非外链 HTML）
5. **画布审计** — 直接在画布上叠加 `nice-aos deploy audit` 的红/黄/绿评级
6. **画布主题联动** — 与现有 `--theme` 参数打通（目前画布是内置深色主题）
