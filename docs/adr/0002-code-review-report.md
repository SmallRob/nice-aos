# ADR 0002 代码审核报告

> **审核对象**: v0.31.0 未提交代码（蓝图引擎 + 项目根检测 + 增量解析）
> **审核基准**: ADR 0001 + ADR 0002 计划文档
> **审核日期**: 2026-08-26
> **审核范围**: 6 个修改文件 + 10 个新文件

---

## 一、总体结论

| 模块 | ADR 计划符合度 | 测试通过 | 风险等级 | 核心结论 |
|---|---|---|---|---|
| 蓝图引擎 V2 | ~85% | 30/30 ✅ | 中 | 核心架构到位，viewer.js 缺 1 个动作 + 动作定义三处重复 |
| 项目根检测 | ~95% | 26/26 ✅ | 低 | P0: Gradle marker 逻辑错误（every 应为 some） |
| 增量解析 | ~90% | 28/28 ✅ | 中低 | LRU 实为 FIFO、路径字段匹配不全 |
| 蓝图交互控件 | ~75% | 23/23 ✅ | 中 | 前端渲染能力不完整（缺 enum/objectRef） |
| **整体** | **~87%** | **107/107 ✅** | **中低** | **Phase 0 主体交付合格，有 1 个 P0 + 若干 P1 需修复** |

**测试总览**: 429/429 全部通过，0 失败，0 跳过。

---

## 二、按优先级问题清单

### 🔴 P0 — 必须修复（2 个）

| # | 问题 | 文件 | 影响 |
|---|---|---|---|
| P0-1 | **Gradle marker 逻辑错误**：`files: ['build.gradle', 'build.gradle.kts']` 用 `every` 语义要求两个文件都存在，但 Gradle 项目只有其中一个，导致 Gradle 项目永远无法命中，只能 fallback 到 `.git` | `src/analyzers/projectRootDetector.js` 第 43 行 | Gradle 项目根检测降级为 git 兜底，marker 和 description 信息不准确 |
| P0-2 | **viewer.js 缺少 analyzeFile 动作**：ADR 明确要求 4 张动作卡片（markReviewed / addNote / refreshRepo / analyzeFile），但 `interactive.actionDefs` 只有 3 个 | `src/ontology/viewer.js` 第 1217-1242 行 | 与 ADR 直接不符，蓝图 UI 缺少文件级分析入口 |

### 🟡 P1 — 建议修复（6 个）

| # | 问题 | 文件 | 影响 |
|---|---|---|---|
| P1-1 | **动作定义三处重复**：`blueprint.js` 的 `ACTION_PARAM_DEFS` + `blueprintActions.js` 的 `ACTION_DEFS` + `viewer.js` 的内联 `interactive.actionDefs`，内容高度重叠但各有扩展，维护成本高 | 三个文件 | 修改时容易不同步，已有不一致（viewer.js 少 analyzeFile） |
| P1-2 | **V2 linkImpl 适配层忽略 ctx**：ADR 约定 linkImpl 接收 `(src, ctx)`，ctx 暴露 `byId/byType/snapshot`，但 V2 适配层完全委托给 legacy link，ctx 参数被忽略 | `src/ontology/blueprint.js` 第 595 行 | 未来 linkImpl 需跨类型查询时无法利用引擎 ctx |
| P1-3 | **refreshRepo / analyzeFile 只有 paramDefs 没有 actionImpl**：V2 引擎的 actionImpls 中只实现了 markReviewed 和 addNote，另外两个调用会返回"未知动作" | `src/ontology/blueprint.js` 第 608-631 行 | 引擎层面动作能力不完整 |
| P1-4 | **LRU 实为 FIFO，注释有误导**：注释声称"delete + re-set 实现 LRU 更新"，但缓存命中时未做 re-set 操作，实际是 FIFO 淘汰。ADR 已允许"不严格 LRU 简化实现"，但注释需修正 | `src/analyzers/incrementalParser.js` | 误导维护者，以为是 LRU 策略 |
| P1-5 | **mergeSnapshotByFiles 路径字段匹配不全**：仅匹配 `filePath / path / relPath`，若某些对象类型用 `sourceFile` 等其他字段名，增量更新时旧对象不会被清理 | `src/analyzers/incrementalParser.js` | snapshot 残留脏数据 |
| P1-6 | **前端渲染能力与后端 ParamDef 不匹配**：viewer.js 前端 `renderActionCardHtml` 只处理了 boolean / number / text 三种，缺少 enum / objectRef / objectRefMulti | `src/ontology/viewer.js` 第 3647-3654 行 | 有参数的动作在前端无法完整渲染表单 |

### 🟢 P2 — 优化建议（6 个）

| # | 问题 | 文件 |
|---|---|---|
| P2-1 | **深拷贝只做一层**：`{...r}` 浅拷贝对嵌套对象（如 `sqlQueries` 数组）不生效，action 修改嵌套字段仍可能影响 seed | `src/ontology/blueprintEngine.js` 第 154-158 行 |
| P2-2 | **软链解析不完整**：仅对起始路径做 realpath，向上递归中遇软链目录可能回环或漏检 | `src/analyzers/projectRootDetector.js` |
| P2-3 | **maxDepth 边界语义不明确**：实际为 11 层（起始目录 + 向上 10 层），注释与行为需对齐 | `src/analyzers/projectRootDetector.js` |
| P2-4 | **findObjectByPrefix 是占位实现**：`typeName` 始终返回 `'Unknown'`，未从 objectTypes 中真正推断类型 | `src/ontology/blueprintEngine.js` 第 289-296 行 |
| P2-5 | **`prefixOf` 推断策略与实际 prefix 体系不匹配**：fallback 取类型名前 4 字符，但 nice-aos 实际 prefix 如 `proj:` `svc:` 不符合此规则 | `src/ontology/blueprintEngine.js` 第 305-310 行 |
| P2-6 | **对象搜索结果截断 200 条无提示**：用户可能以为只有 200 个对象 | `src/ontology/viewer.js` 第 3669 行 |

---

## 三、逐模块详细审核

### 3.1 蓝图引擎 V2（决策 1）

**符合度: ~85%**

#### 已实现

- ✅ `createBlueprintEngine(bp)` 接受完整 BlueprintRuntime 配置
- ✅ 暴露 6 个方法：find / where / link / action / snapshot / schema
- ✅ 内部 byId / byType Map 索引
- ✅ 写回不污染 seed（一层深拷贝）
- ✅ action 异常捕获返回 `{ok:false, message}`
- ✅ V1 `createBlueprint` 零修改，完全兼容
- ✅ 新增 `createBlueprintV2(dataMap, opts)`
- ✅ 24 个 link 函数零重写（通过 legacy 适配层复用）
- ✅ 内置 markReviewed / addNote 动作
- ✅ `extraActions` 参数支持扩展
- ✅ `BLUEPRINT_SCHEMA` 静态元数据

#### 主要问题

1. **linkImpls 适配层走了"二次 createBlueprint"策略**，不是真正的轻量包装，多了一次完整索引构建开销
2. **linkImpl 签名不一致**：引擎传 `(src, ctx)`，适配层忽略 ctx，完全走闭包 dataMap
3. **OBJECT_TYPES 转 ObjectTypeDef 时丢失 prefix/category/level 信息**，导致 `prefixOf()` 无法正确工作

---

### 3.2 项目根自动检测（决策 2）

**符合度: ~95%**

#### 已实现

- ✅ 多语言 marker 优先级表（Flutter pair → Node → Rust → Go → Python → Java → Git）
- ✅ Flutter pair 联合判定（pubspec.yaml + lib/ 才是 Flutter）
- ✅ Dart 包单独判定（只有 pubspec.yaml）
- ✅ 软链解析（realpath）
- ✅ maxDepth=10 限制
- ✅ monorepo 子包发现（apps/* / packages/*，增强为 6 个目录模式）
- ✅ 任意路径向上递归查找
- ✅ 返回 `{ path, source, marker, description }` 完整结构
- ✅ action.js 集成：文件路径向上 / 目录直接检测 / cwd 默认
- ✅ 友好错误提示

#### 主要问题

1. **🔴 P0: Gradle marker 用 `every` 是错误的** — 应改为 `some`
2. 软链解析仅覆盖起始路径，递归过程中未做 realpath
3. maxDepth 语义需文档化（起始目录 + 向上 N 层）

---

### 3.3 蓝图交互控件（决策 3）

**符合度: ~75%**

#### 已实现

- ✅ `buildActionCards / renderActionCardHtml / renderActionCardsHtml` 三函数
- ✅ 6 种 ParamDef 形态后端完整支持（text / number / boolean / enum / objectRef / objectRefMulti）
- ✅ 按对象类型过滤可用动作（`applicableTypes`）
- ✅ viewer.js 增加 `interactive` 字段
- ✅ 蓝图报告新增"交互操作"Tab
- ✅ 对象选择器（按 id/name/path 搜索 + 类型筛选）
- ✅ 提交走 `fetch('/action', ...)` 端点
- ✅ XSS 转义防护

#### 主要问题

1. **🔴 P0: viewer.js 缺 analyzeFile 动作** — 只有 3 张卡片，ADR 要求 4 张
2. **P1: 前端只支持 3 种 ParamDef kind**，enum / objectRef / objectRefMulti 未实现
3. **P1: 动作定义三处重复** — blueprint.js / blueprintActions.js / viewer.js 各维护一份
4. **P2: 未复用 blueprintActions.js 的渲染逻辑**，前端内联了独立实现

---

### 3.4 增量解析（决策 4）

**符合度: ~90%**

#### 已实现

- ✅ `IncrementalParser` 类 + LRU/FIFO 缓存
- ✅ 默认容量 1000
- ✅ parse 三态逻辑（未命中→全量 / 命中且未变→复用 / 变更→重算）
- ✅ 单例缓存（按 analyzer 隔离）：`getParser('ts')` 等
- ✅ `cachedAnalyze` 零侵入包装函数
- ✅ Git 集成：`listChangedFiles / listStagedFiles / listUntrackedFiles`
- ✅ 非 git 仓库返回空数组（全量 fallback）
- ✅ `mergeSnapshotByFiles`：by-id 替换 + 新增追加 + 删除清除 + 同 id 去重
- ✅ 自定义 keyExtractor
- ✅ 统计信息接口
- ✅ 增量模式默认关闭（符合 ADR）

#### 主要问题

1. **P1: LRU 注释误导** — 实际是 FIFO，ADR 允许但注释需修正
2. **P1: 路径字段匹配不全** — 只匹配 filePath/path/relPath，缺少 sourceFile 等
3. **P2: mergeSnapshotByFiles 无顶层异常捕获** — "失败回退全量"仅在 Git 层落实
4. **P2: `niceAosKeyExtractor` 为空实现** — 预留接口但暂无实际逻辑

---

## 四、测试审核

**结论: 全部通过，质量良好 ✅**

| 测试文件 | ADR 要求 | 实际数量 | 结果 |
|---|---|---|---|
| `test/blueprintEngine.test.mjs` | 30 | 30 | ✅ |
| `test/projectRootDetector.test.mjs` | 26 | 26 | ✅ |
| `test/blueprintActions.test.mjs` | 23 | 23 | ✅ |
| `test/incrementalParser.test.mjs` | 28 | 28 | ✅ |
| **新增合计** | **107** | **107** | **✅** |
| 项目总计 | 429 | 429 | ✅ 全部通过 |

### 测试质量亮点

- **边界充分**：空快照、不存在的 id/link/action、maxDepth 边界、深层嵌套
- **异常到位**：action 守卫、analyzer 抛错、XSS 转义、未知类型
- **隔离良好**：临时目录 + finally 清理、单例重置、Git 独立仓库
- **断言精确**：严格相等 + 正则匹配错误信息 + 计数器验证调用次数

---

## 五、Phase 0 交付物核对

| ADR 计划项 | 状态 | 备注 |
|---|---|---|
| `src/ontology/blueprintEngine.js` | ✅ 已交付 | BlueprintRuntime + createEngine |
| `src/ontology/blueprint.js` V2 兼容层 | ✅ 已交付 | V1 不变 + V2 新增 |
| `src/ontology/paramDefs.js` | ✅ 已交付 | 6 种形态 + 校验 |
| `src/ontology/blueprintActions.js` | ✅ 已交付 | 4 动作卡片 + HTML 渲染 |
| `src/analyzers/projectRootDetector.js` | ✅ 已交付 | 含 P0 bug 需修复 |
| `src/analyzers/incrementalParser.js` | ✅ 已交付 | LRU→FIFO 注释需修正 |
| `src/cli/commands/action.js` 集成 | ✅ 已交付 | projectRoot 输出字段 |
| `src/ontology/viewer.js` interactive | ⚠️ 部分交付 | 缺 analyzeFile 动作 + 前端 enum/objectRef 渲染 |
| 30+26+23+28 = 107 个单测 | ✅ 已交付 | 全部通过 |
| 429 测试全通过 | ✅ 已验证 | 0 失败 0 跳过 |

---

## 六、建议修复顺序

```
立即修复 (P0):
  1. projectRootDetector.js: Gradle marker every → some
  2. viewer.js: 补充 analyzeFile 动作卡片

尽快修复 (P1):
  3. 统一动作定义数据源（消除三处重复）
  4. viewer.js 前端: 补齐 enum / objectRef / objectRefMulti 渲染
  5. incrementalParser.js: 修正 LRU 注释为 FIFO
  6. incrementalParser.js: 扩展路径字段匹配列表
  7. blueprint.js V2: 明确 refreshRepo/analyzeFile 的实现策略

后续优化 (P2):
  8. 深拷贝层度确认 / 增强
  9. 软链递归解析
  10. findObjectByPrefix 真正实现
  11. 搜索结果 200 条截断提示
```

---

## 七、整体评价

**Phase 0 (v0.31.0) 交付质量：良好**

核心架构决策全部落地，测试覆盖完整且全部通过。主要问题集中在：
1. 前端 viewer.js 交付不完整（缺 1 个动作 + 渲染能力不足）
2. 动作定义数据管理分散（三处重复）
3. 个别实现细节 bug（Gradle marker、LRU 命名）

修复 P0 的 2 个问题后，可视为 Phase 0 合格交付。P1 问题建议在 v0.32.0 之前修复，避免技术债务累积。
