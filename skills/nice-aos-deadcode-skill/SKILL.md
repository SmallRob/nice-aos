---
name: nice-aos-deadcode
description: |
  Nice AOS 死代码清理 Skill（Nice Anterior Ontology Service — Dead Code Cleanup）：
  基于 nice-aos CLI 的四级死代码检测（文件级 orphanCandidates / 导出级 unusedExports /
  类型级 Interface/Class deadCandidate / 函数级 Method/ScriptFunction deadCandidate），
  编排"检测 → 分级复核 → 清理 → 验证"的完整工作流。
  支持两种模式：仓库模式（refreshRepo 快照 + query --where "deadCandidate=true" 毫秒级查询，
  Project.health 汇总 deadFunctionCount/deadTypeCount/deadExportCount/orphanFileCount）
  与单文件模式（action analyzeFile 不落盘，jq 过滤单文件死函数/死类型，
  适合独立油猴脚本与单个 TS/JS 文件）。
  判定为保守策略：非导出实体本文件零引用（排除声明处与自递归）；导出实体全仓库零导入且本文件零使用；
  接口方法为契约声明永不判死；命名空间导入 / export * / 动态 import() 目标整体豁免——宁可漏报不误报。
  触发：用户说"哪些文件没人用 / 死代码 / 孤儿文件 / 未使用的导出 / unused exports /
  哪些函数没人调用 / 死函数 / 哪些类/接口没人用了 / 清理死代码 / 给项目瘦身 /
  这个文件能删吗 / 这个函数能删吗 / 这个独立脚本里有没有死函数"，
  或需要清理冗余代码但不知道从何查起时。
  英文触发词：dead code, unused exports, orphan files, dead functions, unused classes,
  unused interfaces, code cleanup, find unreferenced code, single file dead code analysis。
  不做：通用项目结构查询（用 nice-aos skill）、油猴安全审计（用 nice-aos-userscript skill，
  死代码仅是审计附带项）、自动删除代码（只产出候选与证据，删除由 agent/用户确认后执行）、
  构建 / 测试 / ESLint（用专用工具）。
---

# Nice AOS Deadcode Skill — 死代码清理

> 基于 nice-aos CLI 的四级死代码检测能力，编排完整的清理工作流。
> **分工**：本 Skill 承载死代码清理工作流；通用查询/快照/影响分析/蓝图导出见 `nice-aos` skill；
> 油猴安全审计见 `nice-aos-userscript` skill。三者共享同一份 CLI 与快照。

## 概述

死代码检测是 CLI 的原子能力（deadCandidate 字段 + orphanCandidates/unusedExports 汇总），本 Skill 编排"检测 → 复核 → 清理 → 验证"场景流程。**CLI 从不自动删代码**——所有候选都是"建议人工复核的证据清单"。

## 前置条件

- Node.js 18+
- CLI 获取（二选一）：仓库内源码 `node <REPO_ROOT>/nice-aos/src/cli/index.js`（`nice-aos/node_modules` 缺失时先 `cd nice-aos && npm install`）；或 npm 包 `nice-aos` / `npx nice-aos`
- 仓库模式需快照：`.nice-aos/data/snapshot.json`（不存在则 `action refreshRepo`，仓库根目录执行无需 `--snapshot-dir`）；**单文件模式无需快照**

## 四级死代码模型

| 级别 | 数据位置 | 判定规则 | 保守豁免 |
|------|---------|---------|---------|
| **文件级**（孤儿文件） | `_meta.orphanCandidates` + `Project.health.orphanFileCount` | 全仓库零导入引用的源文件 | 测试文件、入口文件（main/index/App 等）、路由注册组件、lazy 动态引用 |
| **导出级**（unused exports） | `SourceFile.unusedExports[]` + `_meta.deadExportCandidates` + `Project.health.deadExportCount` | 导出符号全仓库零具名导入且本文件零使用 | 入口文件、re-export 链（`export {x} from ...`）、动态 `import()` 引用 |
| **类型级**（死接口/死类） | `Interface/Class.deadCandidate` + `deadReason` + `Project.health.deadTypeCount` | 非导出：本文件零引用；导出：全仓库零导入且本文件零引用 | 命名空间导入 / `export *` / 动态 import 的目标文件整体豁免 |
| **函数级**（死函数） | `Method/ScriptFunction.deadCandidate` + `deadReason` + `Project.health.deadFunctionCount` | 引用计数为零（排除声明处、自身函数体自引用、事件回调、constructor） | 接口方法永不判死（契约声明）；导出模块函数不在函数级判死（由导出级覆盖）；油猴 ScriptFunction 额外排除 topLevelCalls 命中与 unsafeWindow 暴露 |

**设计原则：宁可漏报不误报**。每级都有明确豁免规则；`deadReason` 字段给出判定依据，复核时可直接引用。

## 仓库模式：四级清理工作流

### Step 1 — 总览健康度

```bash
$AOS query Project          # health: deadFunctionCount / deadTypeCount / deadExportCount / orphanFileCount
```

### Step 2 — 按级提取候选

```bash
# 文件级（孤儿文件）
$AOS export --format json | jq '._meta.orphanCandidates'

# 导出级（unused exports，汇总形式 [{file, names[]}]）
$AOS export --format json | jq '._meta.deadExportCandidates'

# 类型级（死接口/死类，含 deadReason）
$AOS query Interface --where "deadCandidate=true" --pretty
$AOS query Class --where "deadCandidate=true" --pretty

# 函数级（死函数：TS 方法/模块函数 + 油猴脚本函数）
$AOS query Method --where "deadCandidate=true" --pretty
$AOS query ScriptFunction --where "deadCandidate=true" --pretty
```

一键全景：`export --format markdown --output report.md` 的「死代码候选（文件级 + 导出级 + 类型级 + 函数级）」章节。

### Step 3 — 逐项复核（必须人工确认，不自动删）

复核清单（按误报风险从高到低）：

1. **测试引用**：测试文件不入扫描范围——仅被测试使用的导出符号会被判候选。删前 `grep -r "符号名" --include="*.test.*"`
2. **动态引用**：字符串拼装 import、`import(变量)`、全局注册（window.xxx = fn）、事件总线等运行时引用无法静态追踪
3. **re-export 链**：被 `export *` / `export {x} from` 传递暴露的符号已豁免，但二次转售（barrel file 的 barrel）建议再看一眼
4. **接口实现类方法**：函数级候选中的类方法若所属类被 implements 契约约束，删除可能破坏契约（`link implementedBy --src "iface:..."` 交叉核对）

### Step 4 — 清理与验证

```bash
# 每删除一批后刷新快照并复查（候选数应单调下降，无新增误报）
$AOS action refreshRepo --params '{"repoPath":"."}'
$AOS query Project        # health 死代码计数对比

# 复核结论回写（跨会话保留）
$AOS action markReviewed --params '{"objectId":"file:src/utils/legacy.ts"}'
$AOS action addNote --params '{"objectId":"file:src/utils/legacy.ts","note":"确认仅测试引用，已删"}'
```

建议按"导出级 → 函数级 → 类型级 → 文件级"顺序清理（先摘叶子再砍枝干，避免删文件后级联误判）。

## 单文件模式：独立文件死代码查询

适合不属于任何仓库的独立文件（油猴脚本、单文件工具），或只想快速体检一个文件：

```bash
$AOS action analyzeFile --params '{"file":"Steam-License-Classifier.js"}'

# 油猴文件：死函数
... | jq '.ScriptFunction[] | select(.deadCandidate) | {name, line, lineCount, deadReason}'
# TS/JS 文件：死函数/死类型
... | jq '.Method[] | select(.deadCandidate) | {name, ownerKind, line, deadReason}'
... | jq '.Interface[] | select(.deadCandidate)'
... | jq '.Class[] | select(.deadCandidate)'
# 画像摘要：_meta.objectCounts 一览
```

Windows 无 jq 时：`| findstr "deadCandidate"` 整行匹配后人工确认。

**单文件模式判定边界**：只有"本文件内零引用"的非导出实体才判死；**导出实体一律 `deadCandidate=false`**（单文件视角无法判定跨文件使用，`deadReason` 注明 exported）。跨文件判定必须走仓库模式。

## 判定规则细则（复核对答用）

- **引用计数**：标识符/属性名在本文件全文出现次数，排除实体声明位置与函数自身函数体内的自引用（防"仅自递归"误判为被使用）
- **导出实体**：导出 + 全仓库零具名导入 + 本文件零引用 → 类型级候选；导出的模块函数不进函数级（无法区分"库公开 API"与"真死"，由导出级统一覆盖）
- **接口方法**：`ownerKind=interface` 的 Method 永不判死——契约声明可能被未来的实现类覆盖
- **油猴 ScriptFunction**：额外要求"全文零引用 + calledByCount=0 + 非 topLevelCalls 命中 + 非 constructor + 非 event 角色 + 未暴露到 unsafeWindow"
- **豁免整文件**：命名空间导入（`import * as X`）、`export *` 的目标、动态 `import()` 的目标——这些场景按名追踪不可靠，整体不判死

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 用户要死代码清单 | 先 `query Project` 看四级计数，再按级提取候选 |
| 用户问"这个文件/函数能删吗" | `query Method/Class --where "name~xxx"` 查 deadCandidate + `link importedBy/calledBy` 双向确认引用，再给结论 |
| 独立单文件（不在仓库） | `action analyzeFile` + jq 过滤，不建快照 |
| 候选项命中 | **永远不自动删除**；列证据（deadReason + 行号 + 引用计数）交用户/agent 决策 |
| 清理后 | refreshRepo 刷新 + query Project 对比计数验证 + markReviewed 回写 |
| 用户要油猴脚本的安全审计 | 切换到 `nice-aos-userscript` skill（死函数仅是审计附带项） |

## 技术限制

- 语法级静态分析：运行时动态引用（字符串拼装、事件总线、全局注册）无法追踪 → 依赖人工复核
- 测试文件不入扫描范围 → "仅测试使用"的导出符号会被判候选（复核第 1 条）
- 类型实体覆盖 `.ts/.tsx/.js/.jsx` 与 `.d.ts`；Vue SFC `<script>` 内的 interface/class 不提取
- 导出级判定基于具名导入对照：`import * as ns` 的成员使用（`ns.deadFn()`）会使该文件整体豁免（保守）
- 油猴仓库 `query ScriptFunction --all` 可能数万条，必须 `--where` 过滤后再看
- `--where` 为全表扫描，不支持数值比较（数值过滤用 jq）
