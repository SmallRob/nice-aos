# nice-aos 自身架构评审（risk-quality-reviewer + system-modeler）

> 评审日期: 2026-08-30 | 对象: nice-aos v0.42.1（main @ ceadf02）
> 证据源: 自扫描本体快照 `.nice-aos/data/snapshot.json`（`node src/cli/index.js action refreshRepo`）、
> 报告 `.nice-aos/data/self-report.md`、`duplicates` / `io` 内置体检、`wc -l`、`test/` 目录、`docs/adr/`
> 状态: 全部为 current-state 事实，置信度逐条标注

## 1. 评审目标

判断这个 CLI 工具仓库的架构是否健康、哪里值得优化。关键质量属性：**可维护性**（核心，单人/小团队快速迭代）、**可扩展性**（新语言分析器、新蓝图类型的接入成本）、**正确性护栏**（测试与静态自检）。

## 2. 健康基线（先说好的）

| 指标 | 数值 | 证据 | 置信度 |
| --- | --- | --- | --- |
| 循环依赖 | 0 组 | self-report §19 | high |
| 未解析导入 | 0 | snapshot `unresolvedImports` 全空 | high |
| 解析错误 | 0 | refreshRepo 输出 `analysisErrors: 0` | high |
| 测试文件 | 80 个（78 + storage 2） | `test/` 目录 | high |
| 架构决策记录 | 10 篇 ADR + roadmap | `docs/adr/`、`docs/plan/` | high |
| 外部依赖 | 4 运行时 + 1 可选，全部声明、0 未声明依赖 | self-report §21 | high |
| 总规模 | 115 文件 / 46,904 行 / 883 方法 | `wc -l`、快照 | high |

分层结构清晰：`cli/`（33 文件）→ `analyzers/`（26）→ `ontology/`（19）→ `storage/`（9）+ 4 个领域蓝图域（database/deployment/planning/service），模块间无环。这是本次评审能顺利进行的前提——依赖骨架是健康的。

## 3. 发现清单（按优先级）

### F1 — God file 集中在 ontology 双核（High，置信度 high）

`src/ontology/builder.js` **3,860 行**、`src/ontology/viewer.js` **3,691 行**，两文件合计约 16% 的总代码量。紧随其后的是 `database/dbViewer.js`（1,637）与多个 1,000+ 行的分析器（python 1,523 / ts 1,475 / kotlin 1,117）。

- **影响属性**: 可维护性、可测试性。任何对象类型新增（本仓库迭代最频繁的动作，见近期 commit）都要穿过 builder.js 单文件。
- **证据**: `wc -l`；快照显示 `ontology` 模块被模块外 26 处引用（报告 §6）。
- **缓解因素**: 0 循环依赖说明内部结构尚可，拆分有安全边界。
- **验证**: 拆分后 `npm test` 全绿 + 重新自扫描快照对象计数不变。

### F2 — 21 组结构重复，分析器与 CLI 命令各有成族副本（High，置信度 high）

`duplicates` 体检输出 21 组，代表性三族：

1. **分析器文本工具族**: `lineAt` × 5（dart/go/kotlin/python/rust）、`computeLineStarts` × 5、`analyzeXFileFromDisk` × 4 —— 完全同构。
2. **CLI 命令脚手架族**: `resolveDirs` × 5（deadcode/duplicates/io/mcp/serve）、`loadSnapshot` × 3。
3. **Viewer 族**: `fmtLocalTime` × 3（dbViewer/deployViewer/serviceViewer）。

- **影响属性**: 可扩展性、一致性。修一处漏四处的风险真实存在（`lineAt` 类工具若处理换行边界差异，5 份副本会漂移）。
- **现成落点**: `src/cli/shared.js`（扇入 12）与 `src/analyzers/` 公共目录；`src/paths.js`（扇入 9）证明共享层模式已被接受。
- **验证**: 提取后重跑 `duplicates`，组数应从 21 明显下降；`npm test` 全绿。

### F3 — 六个 HTML Viewer 各自为政，是最大的结构性抽象缺口（Medium，置信度 high）

`ontology/viewer.js`（3,691）、`blueprint.js`（721）、`dbViewer.js`（1,637）、`serviceViewer.js`（933）、`deployViewer.js`（831）、`planning/docsViewer.js`（805）——合计约 8,600 行，均为"快照 → 自包含 HTML"的同构管道（主题注入、Tab 结构、审计区块、时间格式化）。`themes/index.js` 扇入 10 说明主题已共享，但 HTML 骨架与审计区块渲染仍逐份拷贝。

- **影响属性**: 可扩展性（每加一种蓝图 = 再造一个 800+ 行 viewer）、可维护性。
- **验证**: 抽取共享 viewer kernel 后，单域 viewer 行数应降至百行级；`viewer.test.mjs` / `dbViewer.test.mjs` / `serviceViewer.test.mjs` 全绿。
- **注意**: 这是收益最大但风险也最大的一项，应在 F1 拆分 viewer.js 之后、以增量方式做。

### F4 — 死代码存量：34 导出 + 22 函数 + 1 文件（Medium，置信度 high，删除需人工确认）

报告 §20 全量列出。典型项：`hasSnapshot`、`runAllDeployAudits`、`validateActionDef`、`detectAgent`、`analyzeSingleSqlFile`。两点保留：

- `src/storage/schema.sql` 被判"未被导入"，但 `test/storage/schema.test.mjs` 存在，**很可能被测试读取**——删前必须确认（文件类数据不是 import 边能覆盖的）。
- 部分 `isXCandidate` 谓词（`isGoCandidate`/`isRustCandidate`）形态上是公共 API，虽然当前仅 bin 暴露，仍建议先标记 `@deprecated` 一个版本。

- **验证**: 逐项 `grep -r <name>` 确认无动态引用后删除；`npm test` 全绿。

### F5 — 高扇入枢纽需要接口纪律（Medium，置信度 medium）

扇入 Top：`src/cli/shared.js`（12）、`src/ontology/blueprint.js`（11）、`src/themes/index.js`（10）、`src/paths.js`（9）、`src/ontology/snapshot.js`（7）。这些文件的签名变更影响面 7~12 个文件。当前没有契约测试专门锁定它们的导出形状（快照格式是事实上的公共契约——`_meta` + 39 种对象类型的键集合）。

- **建议**: 为快照格式与上述 5 个枢纽补一个"契约快照测试"（对导出名列表做断言），作为回归护栏。
- **验证**: 新增测试通过，且故意改签名时能捕获。

### F6 — 自扫描暴露的两个产品级误判（Low，置信度 high，属于 dogfooding 收益）

本次自扫描本身产出了两个对 nice-aos **产品**有价值的信号：

1. **架构风格误分类**: Node.js CLI 工具被标为"组件应用"，93% 文件落入"共享层"（报告 §2-§3）——语义分层启发式是面向前端项目设计的，对纯 CLI/工具型项目区分度不足。
2. **UserScript 误报**: `src/analyzers/userScriptAnalyzer.js`（899 行）自身被判为一个 900 行的"油猴脚本"（报告 §13）——因为文件内含大量 GM API 字符串，`isUserScriptCandidate` 未能排除"分析器自身"这类语义。

- **影响**: 不是本仓库的债务，而是产品待改进项；顺带说明 `isUserScriptCandidate` 同时出现在函数级死代码清单里（自引用缺失）。
- **验证**: 加入"工具型项目"风格识别与自引用排除后重扫，风格与 UserScript 计数应修正。

### F7 — npm scripts 指向仓库外路径（Low，置信度 high）

`package.json` 的 `aos` / `aos:build` / `aos:report` 三条脚本硬编码 `../.codebuddy/skills/nice-aos-skill/data`，并扫描 `..`（父目录）——换一台机器或克隆到不同目录结构即失效。本次自扫描实际是手工用 `--snapshot-dir` 默认值完成的。

- **建议**: 增加 `aos:self`（扫描自身到 `.nice-aos/data`）并让既有脚本回退到仓库内路径。
- **验证**: `npm run aos:self` 在干净克隆下可用。

## 4. 已核查但不构成风险

- **better-sqlite3 静态导入数为 0**: 属 optionalDependency 动态降级设计（`--sqlite auto`），静态计数为 0 是预期，非断链（io/serve 相关测试覆盖）。置信度 medium。
- **io 体检的 6 处调用**: 2 处 `fetch`（viewer 内联资源加载、notifyServe）与 4 处定时器均为合法用途；"字符串 setTimeout"为正则误报形态（传入的是函数引用）。无安全项。

## 5. 证据缺口 / 下一步核查

- `ontology/builder.js` 的测试覆盖路径未逐条核对（推测经 `blueprintEngine`/`semantics` 测试间接覆盖）——拆分前应先用覆盖率工具确认。
- 未做运行时性能画像（扫描 115 文件耗时 1.16s，目前无性能风险迹象）。
- F4 删除清单中动态引用（`import()` / 字符串拼接模块名）未穷举。

配套产物：风险关系图 `risk-map.dot`，修复排序 `remediation-plan.md`。
