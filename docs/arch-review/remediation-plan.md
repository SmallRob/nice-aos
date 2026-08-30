# nice-aos 修复与优化计划

> 配套 `architecture-review.md`（F1-F7），按 收益/风险/工作量 排序。
> 每项含验收标准；全部完成后应满足：`npm test` 全绿、重新自扫描（`action refreshRepo`）对象计数无意外变化。

## P1 — 本迭代可做（低风险、收益直接）

### 1. 提取分析器共享文本工具（对应 F2-族1）
- **动作**: 新建 `src/analyzers/textUtils.js`，收敛 `lineAt` / `computeLineStarts`（dart/go/kotlin/python/rust 共 10 处副本），并顺带吸收 `analyzeXFileFromDisk` 的读盘骨架（4 处副本）。
- **验收**: `duplicates` 组数减少 ≥ 6 组；相关语言测试（`goAnalyzer.test.mjs` 等 5 个）全绿。

### 2. 提取 CLI 命令脚手架（对应 F2-族2）
- **动作**: `resolveDirs`（5 处）与 `loadSnapshot`（3 处）移入 `src/cli/shared.js`（扇入 12 的既有落点）。
- **验收**: `deadcode` / `duplicates` / `io` / `mcp` / `serve` 的 CLI 测试全绿；`duplicates` 组数再减 ≥ 2。

### 3. 死代码清理（对应 F4）
- **动作**: 逐项确认 34 个未用导出 / 22 个未用函数；`schema.sql` 先确认 `test/storage/schema.test.mjs` 是否读取；`isXCandidate` 类谓词标记 `@deprecated` 而非直删。
- **验收**: 清理后重扫描，导出级死代码候选 < 5；`npm test` 全绿。

### 4. 仓库内自扫描脚本（对应 F7）
- **动作**: 增加 `aos:self` / `aos:self:report` 脚本（快照落 `.nice-aos/data`），不改动既有 `../.codebuddy` 脚本。
- **验收**: 干净克隆后 `npm run aos:self` 直接可用。

## P2 — 下迭代（中风险、收益最大）

### 5. 拆分 `ontology/builder.js`（对应 F1）
- **前置**: 先跑一次覆盖率确认现有测试对 builder 的覆盖路径；以对象类型族（如 analyzers 装配 / 链接构建 / 死代码判定）为界拆分。
- **验收**: 单文件 ≤ 1,000 行；快照对象计数逐项不变；`npm test` 全绿。

### 6. 拆分 `ontology/viewer.js`（对应 F1）
- **动作**: 按 Tab/区块渲染函数族拆分；`renderInteractive` 独立。
- **验收**: 同上；`viewer.test.mjs` / `viewerInteractive.test.mjs` 全绿。

### 7. 高扇入枢纽契约测试（对应 F5）
- **动作**: 对快照格式（`_meta` + 对象类型键集合）与 `shared.js` / `blueprint.js` / `themes/index.js` / `paths.js` / `snapshot.js` 的导出名列表增加断言测试。
- **验收**: 故意改任一导出名时测试失败。

## P3 — 机会性（搭其他改动顺路做）

### 8. Viewer kernel 抽象（对应 F3）
- **前置**: 必须完成 5/6 的 viewer.js 拆分。
- **动作**: 抽取"快照 → 自包含 HTML"共享管道（主题注入、Tab 框架、审计区块、`fmtLocalTime` 等），各域 viewer 降为配置 + 特化区块。
- **验收**: 新增一种蓝图域所需新代码 < 300 行；6 个既有 viewer 测试全绿。

### 9. 产品级误判修复（对应 F6）
- **动作**: `isUserScriptCandidate` 排除"分析器文件内出现 GM API 字符串"的自引用场景；为纯 CLI/工具型项目增加架构风格识别（不再落入"组件应用 + 共享层 93%"）。
- **验收**: 重新自扫描：UserScript 计数归 0，架构风格不再标为"组件应用"。

## 明确不做

- 不引入框架/打包器（当前零构建正是优势）。
- 不动 better-sqlite3 动态降级设计（`--sqlite auto` 工作正常）。
- 不处理 io 体检中 4 处"字符串定时器"误报形态（传入函数引用，无安全问题）。
