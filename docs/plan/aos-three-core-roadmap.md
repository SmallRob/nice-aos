# nice-aos 三大核心升级路线（v0.33.0 → v0.36.0+）

> **基准版本**: v0.32.0
> **覆盖范围**: 品牌层 + 全部 P1 + 全部 P2 + 全部已知工程债
> **关联 ADR**: `docs/adr/0003-aos-three-core-roadmap.md`
> **审计来源**: v0.32.0 CLI 现状审核 + 0002-code-review-report.md

任务按 `ask` / `output` / `serve` / 跨命令协同 / 工程债 五部分组织。每条任务含 **目标 / 验收 / 估时 / 涉及文件** 四要素。

---

## 0. 品牌层（v0.33.0 必发）

| 任务 | 目标 | 验收 | 估时 | 涉及文件 |
|------|------|------|------|---------|
| **B-1** | `output` 作为 `export` 顶层别名 | `nice-aos output` 等价 `nice-aos export`；`--help` 显示 `export\|output`；6 个测试通过 | 0.5h | ✅ 已完成（`src/cli/index.js` + `test/output.test.mjs`） |
| **B-2** | README 顶部加 "Three Core Commands" 区块（输入/输出/服务三轴 5 行） | README 第 1-30 行内出现明确的三轴分块 | 0.5h | ✅ 已完成（`README.md`） |
| **B-3** | README 末尾 "Roadmap" 章节重写为按 ask / output / serve 分轴 + P0/P1/P2 优先级 | 5 部分章节清晰、可点击锚 | 1h | ✅ 已完成（`README.md`） |
| **B-4** | `--help` 命令列表标注"★ core"标记三大核心 | 三个核心命令前显示 `★` 或 `[core]` | 0.5h | ✅ 已完成（`src/cli/index.js` `addHelpText('beforeAll')`） |
| **B-5** | `nice-aos` 顶层 description 强调三大核心 | `package.json` description 顶部加"3 个核心命令：ask / output / serve" | 0.2h | ✅ 已完成（`package.json`） |

---

## 1. `ask` 轴（输入）

### P0（v0.33.0）
无 P0 任务（ask 当前完成度 90%）。

### P1（v0.34.0）

| 任务 | 目标 | 验收 | 估时 | 涉及文件 |
|------|------|------|------|---------|
| **ask-1** | `--stream` 流式输出（token 逐字出现） | `--stream` 模式下 stdout 增量输出；非流式模式无变化；3 个测试 | 1.5d | ✅ 已完成（`src/cli/commands/ask.js` + `src/cli/commands/openaiCompat.js`） |
| **ask-2** | `--session <id>` 多轮会话 | 历史折进 prompt；session 存 `~/.nice-aos/sessions/<id>.jsonl`；`ask --session s1` 后再 `--session s1` 能续聊 | 2d | ✅ 已完成（`src/cli/commands/askSession.js` + ask.js `--session / --session-max-turns` + `ask session list/clear` 子命令） |
| **ask-3** | `--tool <name>` 暴露 sub-tool 给 AI | AI 能调 `query / link / export` 自治子任务；JSON-RPC 协议或 ReAct 文本协议 | 3d | `src/cli/commands/ask.js`（tool 调度） + `src/ontology/blueprint.js` |

### P2（v0.35.0+）

| 任务 | 目标 | 验收 | 估时 |
|------|------|------|------|
| **ask-4** | `--save <path>` 把回答落盘为 md/json | 落盘文件含 metadata（agent、durationMs、contextSource） | 0.5d |
| **ask-5** | `--diff <commit>` 对比两次快照回答 | 跨 commit 问答；新旧快照 diff 一并注入 prompt | 2d |
| **ask-6** | `--max-tokens` / `--temperature` 直传模型服务 | 对应参数透传到 `invokeApiChat` | 0.2d |
| **ask-7** | 评测 harness（golden 问题集） | `test/ask-golden.test.mjs` 含 5 个代表性项目 + 8 个问题，回归通过 | 1.5d |

---

## 2. `output` 轴（输出）

### P0（v0.33.0）
无 P0 任务（output 当前完成度 85%，核心能力在位）。

### P1（v0.34.0）

| 任务 | 目标 | 验收 | 估时 | 涉及文件 |
|------|------|------|------|---------|
| **out-1** | `--since <git-ref>` 增量导出（只导出 diff 涉及文件） | git diff 解析 → 过滤对象 → 输出范围 markdown | 2d | ✅ 已完成（`src/analyzers/gitDiff.js` + `src/ontology/exporter.js` 末节 + `--staged` 配套） |
| **out-2** | `--template <path>` 自定义 Markdown 模板 | 占位符 `{{Project.name}}` / `{{Module.summary}}` 等；3 个示例模板 | 2d | 新增 `src/ontology/template.js` + `src/themes/templates/` |
| **out-3** | `--merge <glob>` 多份快照合并 | monorepo 多子项目出一份总览；合并 viewmodel 字段处理冲突 | 2d | 新增 `src/ontology/merge.js` |
| **out-4** | `--include` / `--exclude` 类型过滤 | `output --include Component,Hook --exclude Method` 过滤对象 | 0.5d | `src/cli/commands/export.js` |

### P2（v0.35.0+）

| 任务 | 目标 | 验收 | 估时 |
|------|------|------|------|
| **out-5** | 主题 API：`registerTheme(name, css)` | 用户可注册自定义主题；`src/themes/index.js` 暴露 register | 0.5d |
| **out-6** | `--format all` 同时输出 md+html+viewmodel | 一条命令出全套报告 | 0.3d |
| **out-7** | HTML 蓝图内嵌"分章节导出"按钮 | 在 blueprint.html 加"导出当前 Tab 为 md"按钮 | 1d |
| **out-8** | 报告 PDF 输出（基于 puppeteer-core 或 playwright） | `output --format pdf` 复用现有 HTML；可选依赖 | 1.5d |

---

## 3. `serve` 轴（服务）

### P0（v0.33.0）
无 P0 任务（serve 当前完成度 85%）。

### P1（v0.34.0）

| 任务 | 目标 | 验收 | 估时 | 涉及文件 |
|------|------|------|------|---------|
| **srv-1** | `--token <secret>` Bearer 鉴权 | `/api/*` 受保护；static 端点（`/snapshot.json` / `/blueprint.html`）可选豁免；`Authorization: Bearer <token>` 校验 | 1d | ✅ 已完成（`src/cli/commands/serve.js` — `checkAuth` + `timingSafeEqual` SHA-256 + `?token=` fallback + `WWW-Authenticate` 头 + `NICE_AOS_SERVE_TOKEN` env 覆盖 + banner 展示） |
| **srv-2** | `/ws/snapshot` WebSocket 推送 | snapshot 变更时广播 `{kind, hash, ts}`；客户端用 `ws` 库订阅 | 2d | 新增 `src/cli/commands/serveWebSocket.js` |
| **srv-3** | `/openapi.json` 自动生成端点描述 | 描述与 `/api/status` 一致；spec v3.0；含 7 个现有端点 + 未来端点 | 1d | 新增 `src/cli/commands/serveOpenApi.js` |
| **srv-4** | `--rate-limit <n>` 限流（防滥用） | 滑动窗口 / IP 维度；超限返回 429 | 1d | `src/cli/commands/serve.js` |

### P2（v0.35.0+）

| 任务 | 目标 | 验收 | 估时 |
|------|------|------|------|
| **srv-5** | `/api/ask` POST 端点直连模型服务 | 前端直接 POST 问题拿回答；serve 内部触发 `invokeApiChat`；不依赖本地 CLI | 1.5d |
| **srv-6** | 端点分级（read / write / admin） | `/api/objects/:type` 为 read；`/api/action/:name` 为 write；管理端点为 admin | 0.5d |
| **srv-7** | 跨域 Cookie 共享（`credentials: 'include'`） | 鉴权与 CORS 协同；测试多 origin 场景 | 0.5d |
| **srv-8** | OpenTelemetry 埋点（可选） | `/api/*` 响应带 `traceparent` 头；otel SDK 启动 | 1d |

---

## 4. 跨命令协同（P2，v0.35.0+）

| 任务 | 目标 | 验收 | 估时 |
|------|------|------|------|
| **x-1** | ask `--tool-call` 让 AI 调 sub-command | AI 自主选 query/link/export 工具；ReAct 循环 ≤ 5 步 | 3d |
| **x-2** | ask `--save` 结果落盘后回看 | 落盘文件可被再次 `ask <file>` 做"AI 读图" | 0.5d |
| **x-3** | output 完成后通知 serve 广播 | output 写文件后调 `serve WS` 广播（仅当 serve 在跑） | 0.5d |
| **x-4** | serve 集成 ask（`/api/ask` POST） | 单一进程暴露数据 + 推理能力 | 1.5d（与 srv-5 合并） |
| **x-5** | storage 镜像变化触发 serve 推送 | `refreshRepo` 完成后 broadcast 通知 agent | 0.5d |

---

## 5. 已知工程债（v0.33.0 起滚动消化）

### P0（v0.33.0 必发）

| ID | 描述 | 文件 | 估时 |
|----|------|------|------|
| **E-1** | viewer.js 缺 `analyzeFile` 动作 | `src/ontology/viewer.js:1217-1242` | ✅ 已完成（实际 v0.32.0 修复；新增 7 回归测试 — `test/viewerInteractive.test.mjs`） |
| **E-7**（新增） | `output` 别名未在 help 列表以外的位置体现（如 banner） | `src/cli/index.js` | ✅ 已完成（`addHelpText('beforeAll')`） |

### P1（v0.34.0）

| ID | 描述 | 文件 | 估时 |
|----|------|------|------|
| **E-2** | 动作定义三处重复（blueprint.js + blueprintActions.js + viewer.js） | 三文件统一到 `src/ontology/actionDefs.js` | 1.5d |
| **E-3** | `refreshRepo` / `analyzeFile` 缺 actionImpl（引擎层只实现 markReviewed + addNote） | `src/ontology/blueprint.js:608-631` | 1d |
| **E-4** | 前端 `renderActionCardHtml` 缺 enum/objectRef 渲染 | `src/ontology/viewer.js:3647` | 0.5d |
| **E-5** | 增量解析 LRU 注释误称 FIFO | `src/analyzers/incrementalParser.js` | 0.1d |
| **E-8**（新增） | ask `--serve` 后台端口解析脆弱（regex `http://127\.0\.0\.1:(\d+)` 仅匹配首个 URL） | `src/cli/commands/ask.js:48` | 0.2d |
| **E-9**（新增） | serve `--dir` 与全局 `--snapshot-dir` 在子命令层重名（Commander 行为陷阱） | `src/cli/commands/serve.js:89` | 已加注释说明，非阻塞 |

### P2（v0.35.0+）

| ID | 描述 | 文件 | 估时 |
|----|------|------|------|
| **E-6** | 深拷贝只做一层 | `src/ontology/blueprintEngine.js:154` | 0.3d |
| **E-10**（新增） | 软链解析不完整（仅对起始路径 realpath，向上递归遇软链目录可能回环） | `src/analyzers/projectRootDetector.js` | 0.5d |
| **E-11**（新增） | `mergeSnapshotByFiles` 路径字段匹配不全（仅 filePath / path / relPath） | `src/analyzers/incrementalParser.js` | 0.3d |
| **E-12**（新增） | `findObjectByPrefix` 占位实现（`typeName` 始终返回 'Unknown'） | `src/ontology/blueprintEngine.js:289` | 0.3d |
| **E-13**（新增） | 对象搜索结果截断 200 条无提示 | `src/ontology/viewer.js:3669` | 0.2d |
| **E-14**（新增） | `prefixOf` fallback 取类型名前 4 字符（与 nice-aos 实际 prefix 体系不符） | `src/ontology/blueprintEngine.js:305` | 0.3d |

---

## 6. 文档与可观测

| 任务 | 目标 | 估时 |
|------|------|------|
| **D-1** | 每条新能力同时更新 README + CHANGELOG | 持续 |
| **D-2** | CHANGELOG.md 严格遵循 Keep a Changelog 1.1.0 | 0.2d |
| **D-3** | `output --help` / `ask --help` / `serve --help` 选项 block 标准化 | 0.3d |
| **D-4** | 端到端 demo 视频 / 截图（README 加 GIF） | 1d |

---

## 7. 验收与发布节奏

| 版本 | 范围 | 验收门槛 |
|------|------|---------|
| **v0.33.0** | 品牌层（0）+ 工程债 P0（E-1, E-7） | ✅ 已完成：测试 511/511；output 别名 6/6；viewer interactive 7/7；README 三轴分块 |
| **v0.34.0** | output 模板/合并/过滤（out-2/3/4）+ serve WS/OpenAPI/限流（srv-2/3/4）+ 工程债 P1（E-2/3/4/5/8/9） | 测试 600+/600+；3 个端点演示；ask-1 / ask-2 / out-1 / srv-1 已先行交付 |
| **v0.35.0** | ask sub-tool（ask-3）+ output 主题 API（out-5/6）+ serve /api/ask（srv-5/6/7）+ 跨命令协同（x-1/2/3/4/5）+ 工程债 P2（E-6/10/11/12/13/14） | 测试 700+/700+；golden 集通过 |
| **v0.36.0+** | PDF 导出（out-8）+ OpenTelemetry（srv-8）+ 持续可观测 | 端到端 demo |

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 流式输出与 commander 异步流程冲突 | 中 | spawn child_process 而非 execFileSync；或改用 async iterator |
| WebSocket 与现有 HTTP server 端口冲突 | 低 | 同 server 上 upgrade；不另开端口 |
| action 三处统一可能引入回归 | 中 | 先在 `src/ontology/actionDefs.js` 单文件落定；旧三处并行保留 1 个版本再切 |
| 鉴权实现错误暴露敏感端点 | 高 | 鉴权走默认拒绝；`/api/schema` 等元模型端点可选豁免；新增 `test/serve-auth.test.mjs` 覆盖 |
| sub-tool 死循环（AI 反复调 query） | 中 | 工具循环上限 5 步；时间预算 60s 截断 |

---

## 9. 关联文档

- `docs/adr/0003-aos-three-core-roadmap.md` — 决策记录
- `docs/adr/0002-code-review-report.md` — 已知工程债来源
- `docs/adr/0001-asdm-aos-borrowed-capabilities.md` — 借鉴工程模式
- `docs/adr/0002-blueprint-engine-borrowed-from-aos.md` — V2 引擎基线
- `README.md` — 用户入口文档
- `CHANGELOG.md` — 变更历史
