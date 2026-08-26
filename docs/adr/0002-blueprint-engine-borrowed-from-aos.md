# ADR 0002: 借鉴 asdm-aos 蓝图引擎 + 项目根检测 + 增量解析

> **Status**: Accepted (v0.31.0, 2026-08-26)
> **Authors**: nice-aos team
> **Related**: asdm-aos v0.0.12 (https://www.npmjs.com/package/@leansoftx/asdm-aos)
> **Reference**: `/Users/healer2027/workprojetcs/asdm/asdm-ontology-research/aos`
> **Predecessor**: [ADR 0001](./0001-asdm-aos-borrowed-capabilities.md) — 借鉴方法健康度 / 外部调用 / API 端点 / 数据模型

## Context

`asdm-aos` (aos) v0.0.12 的核心架构是 **BlueprintRuntime + createEngine 元模型**：
- 把元模型（schema）/ 数据（dataMap）/ 链接解析（linkImpls）/ 动作实现（actionImpls）四层解耦
- 引擎只认通用契约，不知道任何具体业务字段
- 链接解析接收 `(src, ctx)`，ctx 暴露 `byId/byType/snapshot`
- 动作通过 `(ctx, input) => ActionResult` 统一返回 `{ok, message}`，支持守卫语义
- 写回不污染种子：engine.data 是 seedData 的深拷贝副本
- 抽象类型支持：`ObjectTypeDef.kind = "object" | "interface"`（参考 Foundry Ontology InterfaceDefinition）

`nice-aos` 0.30.0 已经在架构上大量借鉴 aos（`src/cli/shared.js` 注释明确"与 asdm-aos 对齐"`BLUEPRINT_SCHEMA`），但实现仍是"数据驱动单蓝图"路线：`createBlueprint(dataMap)` 返回 `{ link, find }` 闭包，链接解析函数全部 closure 形式。问题：
1. 写回时无法做到 seed/data 隔离（action 写穿 seed）
2. 链接实现与数据耦合，难测试
3. 跨蓝图（service/planning/db/deploy）复用成本高
4. `/api/schema` 已经能暴露元数据，但缺少统一的 schema+impls 配置入口

本 ADR 记录 **蓝图引擎重构 + 项目根检测 + 增量解析** 三大借鉴决策，遵循 ADR 0001 既定原则：仅借鉴工程模式，不复制源码/品牌/文档原文。

## 决策

### 决策 1: 蓝图引擎解耦为 BlueprintRuntime + createEngine

**aos 模式**：`BlueprintRuntime` interface 含 `objectTypes / linkTypes / actions / createData / linkImpls / actionImpls`，`createEngine(bp)` 一次性构造并暴露 `find / where / link / action / snapshot / schema` API。

**nice-aos 模式**：
- 新增 `src/ontology/blueprintEngine.js`（~250 行）：`createBlueprintEngine({ objectTypes, linkTypes, actionDefs, linkImpls, actionImpls, createData })` 
- 暴露与 aos 同构的 6 个方法 + 内部 byId/byType Map 索引
- 写回不污染 seed：深拷贝 `{...seedData[key]}` + 数组元素 `{...r}`（与 aos 同构）
- 异常捕获：`action(name, input)` 捕获 actionImpl 异常，返回 `{ok:false, message}` 而非抛错

**兼容策略**：
- 既有 `createBlueprint(dataMap)` 保持完全不变（`src/ontology/blueprint.js` 第 484 行）
- 新增 `createBlueprintV2(dataMap, opts)`：
  - 复用既有 linkImpls 闭包（24 个 link 函数零重写）
  - 内置 markReviewed / addNote 动作（与 `src/cli/commands/action.js` 同语义）
  - 通过 `extraActions` 参数允许 service/planning/db/deploy 蓝图扩展动作
  - 既有 `query / link / action` CLI 走 V1 路径，零迁移

**理由**：
- 蓝图 UI（HTML 蓝图）能直接走 `engine.schema()` 自描述（无需重复维护元数据）
- 跨蓝图复用：service / planning / db / deploy 后续可走 V2 路径
- 测试隔离：linkImpls 接收 ctx，便于 mock 与 fixture 注入

### 决策 2: 项目根自动检测（不依赖显式传参）

**aos 模式**：`projectDetector.ts` 从任意路径向上递归查找 `pom.xml / build.gradle / .git / package.json / Cargo.toml / go.mod` 等项目 marker。

**nice-aos 适配**：
- 新增 `src/analyzers/projectRootDetector.js`（~200 行）：
  - 多语言 marker 优先级表（Flutter pair 强信号 → Node → Rust → Go → Python → Java → Git 兜底）
  - Flutter pair 联合判定（`pubspec.yaml + lib/` 同时存在才算 Flutter；只有 `pubspec.yaml` 视为 Dart 包）
  - 软链解析（realpath 防死循环）
  - maxDepth 上限（默认 10）
  - monorepo 子包发现（命中 `package.json` 时自动探查 `apps/* / packages/*`）
- 集成到 `src/cli/commands/action.js` `refreshRepo` 处理器：
  - 显式 `repoPath` → 若是文件路径则向上找根；若是目录路径则用 detectProjectRoot
  - 不传 `repoPath` → 从 `process.cwd()` 向上找根
  - 输出 JSON 新增 `projectRoot: { path, source, marker, description }` 字段，agent 复盘时一目了然

**理由**：
- agent 自闭环场景：传 "我刚改的文件路径" 即可，无需知道项目根
- 油猴脚本仓库（无 `package.json`）：fallback 仍走显式路径
- monorepo：apps/* 子包可独立扫（v0.32.0 后续接入）

### 决策 3: 蓝图交互控件（HTML 蓝图可内嵌）

**aos 模式**：`ActionPanel.tsx` + `DependencyGraph.tsx` 是 React 组件，按 ParamDef 自动渲染表单 + SVG 图。

**nice-aos 适配（不引入 React 运行时）**：
- 新增 `src/ontology/blueprintActions.js`（~250 行）：`buildActionCards / renderActionCardHtml / renderActionCardsHtml`
- ParamDef 形态化（aos 4 种 + 扩展 number/boolean）：
  - text / number / boolean / enum / objectRef / objectRefMulti
- 蓝图 UI 自动渲染契约（前端按 ParamDef.kind 生成对应 HTML 控件）
- viewer.js 集成：新增 `interactive` 字段输出到 viewer model + 蓝图报告新增"交互操作"Tab
- 蓝图内嵌 JS：对象选择器（按 id/name/path 搜索 + 类型筛选）+ 4 张动作卡片（markReviewed / addNote / refreshRepo / analyzeFile）
- 提交走 `fetch('/action', ...)` 调 `nice-aos serve` 端点（v0.32.0 增加 `POST /action` 端点）

**理由**：
- aos 的 React UI 强依赖 React 运行时（不适合 nice-aos 的"自包含 HTML 蓝图"路线）
- 蓝图报告的"自包含零依赖可离线打开"约束 → 用纯 HTML + 内联 JS
- 油猴脚本（`contrib/blueprint-ai-agent`）能直接消费 `interactive.actionDefs` JSON 渲染交互

### 决策 4: 增量解析（无 tree-sitter）

**aos 模式**：`IncrementalParser` 类 + LRU 缓存 + `tree.edit() + parser.parse(newCode, oldTree)` 增量 tree-sitter 解析。

**nice-aos 适配（不引入 tree-sitter）**：
- 新增 `src/analyzers/incrementalParser.js`（~300 行）：
  - `IncrementalParser` 类：LRU 缓存 `Map<filePath, {code, result}>`，默认容量 1000
  - `parse(filePath, code, analyzer)` 三态：缓存未命中 → 全量；命中且 code 未变 → 复用；code 变更 → 重算
  - 单例缓存（按 analyzer 类型隔离）：`getParser('ts')` / `getParser('vue')` / ...
  - `cachedAnalyze(analyzerName, analyzer)` 包装函数：零侵入集成到现有 analyzer
  - 关键设计：nice-aos 的多语言并行（ts/vue/dart/go/rust/python/userScript）需要"按 analyzer 维度缓存"
- Git 集成：
  - `listChangedFiles(repoRoot, since)`：git diff 列变更文件
  - `listStagedFiles / listUntrackedFiles`：staged 与 untracked 补充
  - 非 git 仓库 / git 不可达：返回空数组（调用方按全量处理）
- 合并策略：
  - `mergeSnapshotByFiles(oldSnapshot, changedFiles, newFileAnalyses)`：by-id 替换（保留既有对象，更新变更文件的对象）
  - 跨 type 引用（Component → Module）由 builder 在 buildSingleFile* 中处理
  - 同 id 跨文件去重（防止 ID 冲突）

**重要约束**：
- 增量模式**默认关闭**（保持向后兼容），需 `--incremental` 或 `--since <ref>` 显式开启
- 油猴脚本（无 AST，纯文本扫描）**不**走增量（直接全量）
- 失败回退全量：增量异常 → 退到全量重算，不抛错

**理由**：
- 1000 文件项目，10 个变更场景下，增量 < 全量 30%（实测见 `test/incrementalParser.test.mjs` 第 415 行）
- LRU 1000 默认容量足够覆盖中型项目；超出时按 FIFO 淘汰（不严格 LRU 简化实现）
- 单例缓存 + 按 analyzer 隔离避免重复构造

## 实施路线

### Phase 0 (v0.31.0, 本次提交)

- [x] `src/ontology/blueprintEngine.js` —— BlueprintRuntime + createEngine 移植
- [x] `src/ontology/blueprint.js` —— 拆为 `BLUEPRINT_SCHEMA` + `createBlueprint`（兼容层） + `createBlueprintV2`
- [x] `src/ontology/paramDefs.js` —— ParamDef 形态 + 蓝图 UI 自动渲染契约
- [x] `src/ontology/blueprintActions.js` —— markReviewed / addNote / refreshRepo / analyzeFile 表单 schema
- [x] `src/analyzers/projectRootDetector.js` —— 多语言 marker + Flutter pair + monorepo
- [x] `src/analyzers/incrementalParser.js` —— LRU 缓存 + git diff + mergeSnapshotByFiles
- [x] `src/cli/commands/action.js` —— `refreshRepo` 接受 `repoPath` 可选（自动 project root）
- [x] `src/ontology/viewer.js` —— 新增 `interactive` 字段 + 蓝图"交互操作"Tab
- [x] `test/blueprintEngine.test.mjs` —— 30 个单测（find/where/link/action/snapshot/schema）
- [x] `test/projectRootDetector.test.mjs` —— 26 个单测（8 类场景）
- [x] `test/blueprintActions.test.mjs` —— 23 个单测（按类型过滤 / HTML 渲染 / 守卫）
- [x] `test/incrementalParser.test.mjs` —— 28 个单测（缓存 / LRU / git / 合并策略 / 性能）
- [x] 全部 429 个测试通过（既有 322 + P0 30 + P1 26 + P2 23 + P3 28）

### Phase 1+ (后续版本)

- 0.32.0：`POST /action` 端点（蓝图内嵌 ActionPanel 提交目标）+ `serve` 增加交互端点
- 0.33.0：`service / planning / db / deploy` 走 `createBlueprintEngine` 重构 query 命令
- 0.34.0：`refreshRepo --params '{"since":"HEAD~1"}'` 集成到 CLI（默认关闭）
- 0.35.0+：外部库虚拟对象（`ext:` 前缀，参考 aos）按需实施

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| P0 引擎重构破坏既有 CLI 行为 | 高 | 兼容层 + 完整回归测试（322 个）+ V1/V2 双路径 |
| P1 项目根误判（多 marker 冲突） | 中 | 优先级表 + 显式 `--repoPath` 兜底 + 报错信息精确 |
| P2 蓝图 HTML 体积膨胀 | 低 | 增量加载 + 主题 lazy；体积监控 |
| P3 增量合并 bug 导致 snapshot 错乱 | 中 | by-id 替换 + 失败回退全量 + 冲突检测 |
| 借鉴过度导致维护负担 | 低 | 仅借鉴工程模式（BlueprintRuntime / projectDetector / IncrementalParser 三处）；不复制具体 analyzer 实现 |

## 验证

- 既有 322 个测试 + 新增 107 个测试 = 429 个测试全通过
- `nice-aos action refreshRepo` 接受 `repoPath` 可选：自动从 cwd 向上找项目根
- `nice-aos export --format html` 蓝图报告新增"交互操作"Tab，含对象选择器 + 4 张动作卡片
- 性能基准：1000 文件项目，10 个文件变更场景下，增量解析 < 全量 30%（实测 2-3ms vs 5-10ms）
