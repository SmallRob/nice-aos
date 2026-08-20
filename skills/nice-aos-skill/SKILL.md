---
name: nice-aos
description: |
  Nice AOS（Nice Anterior Ontology Service）是通用的 React/Vue 前端项目的代码本体分析组件。
  它将 React/TypeScript 与 Vue 3（SFC/vue-router/Pinia）前端源码（src）预先分析为结构化本体快照，
  把"代码文件"转化为 AI agent 可直接查询的"关系图谱"——包含模块、组件、Hook/Composable、
  Zustand/Pinia Store、Service、路由（Overlay / vue-router）、npm 依赖，以及 import 依赖、
  JSX/template 渲染、页面跳转（navigatesTo）、Store/Hook 使用等 9 种关系。
  基于 TypeScript Compiler API 静态解析，不做类型检查，全量分析约 3.5 秒。
  触发：用户说"分析这个前端项目的结构 / 项目有哪些页面 / overlay 有哪些 / 这个组件在哪个文件 /
  谁渲染了这个组件 / 修改这个 service 会影响哪些代码 / 变更影响分析 / 页面跳转关系 / 导航图 /
  这个 store 被谁用了 / 项目有哪些自定义 Hook / 循环依赖 / 死代码 / 孤儿组件 / 刷新快照 /
  生成代码地图 / 依赖关系图"，或在需要理解前端代码结构但不想 grep 1700+ 文件时，
  或需要做前端变更影响分析（修改 X 会影响谁）但手动追踪引用太耗时时。
  英文触发词：analyze frontend structure, overlay routes, who renders this component,
  change impact analysis, navigation graph, store usage, dead code, circular imports,
  build code map, refresh snapshot。
  不做：代码生成 / 重构建议 / 构建 / 运行测试 / ESLint（用专用工具）；不分析 Java 后端（asdm-aos 负责）。
---

# Nice AOS Skill — 前端代码本体分析

> Nice AOS 参考 asdm-aos（Java 代码本体分析）的设计，针对 React（React 19 + TS + Vite + Zustand + 自研 overlay 路由）
> 与 Vue 3（SFC + vue-router + Pinia + unplugin-vue-router）前端项目重新建模。
> **核心价值**：把"逐文件 grep + LLM 推理"降级为"毫秒级本体查询"，在 1700+ 源文件的项目中保障 agent 的响应速度和结构理解准确度。

## 概述

本 Skill 让 AI agent 通过 `nice-aos` CLI 查询前端代码仓库的结构化本体（模块/组件/Hook/Store/Service/路由/依赖 + 关系图谱），无需全量扫描源码。

**自闭环设计**：CLI 位于仓库的 `nice-aos/` 子项目内（无独立安装步骤），快照存放在本 Skill 目录的 `data/` 子目录中，不污染代码库。

## 触发场景

| 用户意图 | 典型表述 | 命令 |
|---------|---------|------|
| **了解项目结构** | "项目有哪些模块？" / "components 下分多少领域？" | `query Module` + `query Project` |
| **页面/路由清单** | "项目有哪些页面？" / "overlay 有哪些？" / "这个页面的 backTarget 是什么？" | `query Route` / `query Route --where "domain=health"` |
| **页面跳转关系** | "从饮食健康页能跳到哪？" / "页面导航图" | `link navigatesTo --src route:dietary_health` |
| **查找组件定义** | "TalentResultPage 在哪定义？" / "这个组件多少行？" | `query Component --where "name=TalentResultPage"` |
| **谁渲染了这个组件** | "ExerciseReportPage 被谁用了？" | `link renderedBy --src comp:ExerciseReportPage` |
| **这个组件渲染了什么** | "HealthStatsPage 里用了哪些子组件？" | `link renders --src comp:HealthStatsPage` |
| **变更影响分析** | "修改 exerciseService 会影响哪些文件？" | `link importedBy --src file:src/services/exerciseService.ts` |
| **Store 分析** | "项目有哪些 store？" / "useThemeStore 被谁用了？" / "storage key 是什么？" | `query Store` / `link usesStore --src store:useThemeStore` |
| **Hook 分析** | "有哪些自定义 Hook？" / "useEnergySystem 被谁用了？" | `query Hook` / `link usesHook --src hook:useEnergySystem` |
| **页面 ↔ 组件映射** | "steam_dashboard 路由对应哪个组件文件？" | `query Route --where "overlayId=steam_dashboard"` 或 `link registers --src route:xxx` |
| **循环依赖** | "有没有循环依赖？" | 看 `_meta.cycles`（`export --format json` 后 jq）或导出 Markdown 第 8 节 |
| **死代码候选** | "哪些文件没人用？" | 导出 Markdown 第 9 节 `_meta.orphanCandidates` |
| **外部依赖** | "哪些 npm 包用得最多？" / "有没有未声明的导入？" | `query Dependency` |
| **构建/刷新快照** | "刷新快照" / "代码变了重新分析" | `action refreshRepo` |
| **代码 Review 辅助** | "标记这个组件已审查" / "给这个类加备注" | `action markReviewed` / `action addNote` |

**不触发的场景**：写/改代码（agent 自身能力）、构建/测试（npm scripts）、Lint（ESLint）。

## 前置条件

- Node.js 18+
- CLI 获取方式（二选一）：
  - **仓库内源码**（默认）：`nice-aos/` 子项目，无需全局安装；`nice-aos/node_modules` 需已安装（若缺失，执行 `cd nice-aos && npm install`）
  - **npm 包安装**：`npm install -g nice-aos`（全局安装）或 `npx nice-aos`（按需拉取，包已发布至 npm.org，详见 [npm 页面](https://www.npmjs.com/package/nice-aos)）

## CLI 调用方式

所有命令统一通过以下方式调用（agent 将 `<REPO_ROOT>` 替换为仓库根目录绝对路径）：

```bash
NICE_AOS="node <REPO_ROOT>/nice-aos/src/cli/index.js"
SNAPSHOT_DIR="<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data"

# 查询示例
$NICE_AOS --snapshot-dir "$SNAPSHOT_DIR" query Route --where "domain=steam"
```

若通过 npm 包方式获取 CLI，将 `$NICE_AOS` 替换为 `nice-aos`（全局安装）或 `npx nice-aos` 即可，其余参数不变：

```bash
nice-aos --snapshot-dir "$SNAPSHOT_DIR" query Route --where "domain=steam"
npx nice-aos --snapshot-dir "$SNAPSHOT_DIR" link importedBy --src "file:src/services/ai.ts"
```

> 快照目录仍建议显式传 `--snapshot-dir` 指向本 Skill 的 `data/` 目录（npm 包默认回退链为 `./.nice-aos/data` → `~/.nice-aos/data`，不会自动定位本 Skill 目录）。

也可使用根 package.json 提供的快捷脚本：

```bash
npm run aos -- query Route --all
npm run aos -- link importedBy --src "file:src/services/ai.ts"
npm run aos -- action refreshRepo --params '{"repoPath":".","roots":["src","nicekit/src","nice-steam/src"]}'
```

## 首次使用：构建快照

```bash
# 快照目录约定：本 Skill 的 data/ 子目录
mkdir -p "<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data"
node <REPO_ROOT>/nice-aos/src/cli/index.js \
  --snapshot-dir "<REPO_ROOT>/.codebuddy/skills/nice-aos-skill/data" \
  action refreshRepo --params '{"repoPath":"<REPO_ROOT>","roots":["src","nicekit/src","nice-steam/src"]}'
```

**预期输出**（JSON）：
```json
{
  "ok": true,
  "message": "已成功导入 nice-today-2.0（1761 个源文件，3500ms）",
  "stats": { "Module": 256, "SourceFile": 1761, "Component": 851, "Hook": 71,
             "Store": 17, "Service": 407, "Route": 296, "Dependency": 86 },
  "cycles": 8, "orphanCandidates": 352, "analysisErrors": 0
}
```

构建完成后 `data/snapshot.json` 即为所有查询的数据源。**代码有变动后需重新执行 refreshRepo 刷新**。

## 本体模型

### 对象类型（9 种）

| 类型 | 说明 | 典型属性 | ID 前缀 |
|------|------|---------|---------|
| Project | 代码仓库 | name, framework(react/vue/unknown), fileCount, tsxFileCount, vueFileCount, commitHash, branch, analysisErrors | `proj:` |
| Module | 目录模块（领域/分层） | name, path, layer, fileCount, parentId | `mod:` |
| SourceFile | 源文件 | path, ext(ts/tsx/js/jsx/vue), layer, lineCount, isTest, isEntry, importIds, exportNames, opensOverlayIds | `file:` |
| Component | 前端组件（React / Vue SFC） | name, filePath, kind(page/modal/card/...), isDefaultExport, propsCount, hooksUsed, stateCount, lineCount, rendersIds, routeIds, description | `comp:` |
| Hook | 自定义 Hook / Composable | name, filePath, lineCount, description | `hook:` |
| Store | Zustand / Pinia Store | name, stateKeys, actionKeys, hasPersist, storageKey, location(store/services/other) | `store:` |
| Service | 服务/引擎模块 | name, pattern(singleton/class/functions), exportsCount, lineCount | `svc:` |
| Route | 路由条目（Overlay / vue-router） | overlayId(path), routePath, backTarget, hidesNav, domain, routeType(overlay/vue), componentFileId, navigatesToIds, description | `route:` |
| Dependency | npm 依赖 | name, version, scope, source(npm/workspace/undeclared), importCount | `dep:` |

### 链接（9 种）

| 链接 | 语义 | 方向 |
|------|------|------|
| contains | 层次包含 | Project→Module→SourceFile→Component/Hook/Store/Service |
| imports | 模块导入 | SourceFile→SourceFile / Dependency |
| importedBy | 被导入（反向） | 谁导入了这个文件 |
| renders | JSX 渲染 | Component→Component |
| renderedBy | 被渲染（反向） | 谁渲染了这个组件 |
| navigatesTo | 页面跳转 | Route→Route（来自 setActiveOverlay('x') 调用） |
| registers | 路由注册 | Route↔Component（双向：src 为 route: 给组件，src 为 comp:/file: 给路由） |
| usesStore | Store 使用 | file:/comp:→Store 或 store:→反向使用方 |
| usesHook | Hook 使用 | file:/comp:→Hook 或 hook:→反向使用方 |

### 动作（3 种）

| 动作 | 用途 | 守卫 |
|------|------|------|
| refreshRepo | 重新分析仓库（全量，约 3.5s） | repoPath 必须含 package.json |
| markReviewed | 标记对象已 review（持久化到快照） | objectId 必须存在 |
| addNote | 给对象加注释（持久化） | objectId 存在且 note 非空 |

## CLI 命令参考

### query — 查询对象

```bash
# 按类型查询（默认前 50 条，--all 全量）
query Route --all
query Component --where "kind=page" --pretty
query SourceFile --where "layer=services,isTest=false"
query Route --where "domain=health,backTarget=home"
query Component --where "name~steam"                  # ~ 模糊匹配（子串包含，忽略大小写）
query SourceFile --where "path~steam,layer=components" # 模糊可与精确条件 AND 混用
query Dependency --where "source=undeclared"      # 未声明依赖（治理点）
query Store --where "hasPersist=true"             # 持久化 store（核对 storageKey 命名）
query Module --where "layer=components" --all | <统计>
```

`--where` 语法：逗号分隔多条件 AND；`k=v`（或 `k:v`）精确相等，`k~v` 模糊匹配（子串包含，忽略大小写）；值为数组时精确做成员包含、模糊做任一成员包含（如 `hooksUsed=useEffect`）。

### link — 遍历关系

```bash
# 变更影响分析（谁导入了这个文件）
link importedBy --src "file:src/services/exerciseService.ts"

# 组件被渲染关系
link renderedBy --src "comp:ExerciseReportPage"
link renders --src "comp:HealthStatsPage"

# 页面导航图
link navigatesTo --src "route:dietary_health"

# 页面 → 组件 / 组件 → 页面
link registers --src "route:talent_result"
link registers --src "comp:TalentResultPage"

# Store / Hook 使用关系（src 传 store:/hook: 得反向使用者）
link usesStore --src "store:useThemeStore"
link usesHook --src "hook:useUserProfile"

# 层次下钻
link contains --src "mod:src/components/health"
link contains --src "file:src/components/health/HealthStatsPage.tsx"
```

### action — 受控动作

```bash
action refreshRepo --params '{"repoPath":"."}'
action markReviewed --params '{"objectId":"comp:TalentResultPage"}'
action addNote --params '{"objectId":"comp:TalentResultPage","note":"核心页面"}'
```

### export — 导出

```bash
# Markdown 全景报告（含路由地图、导航图、循环依赖、死代码候选、Store 一览）
export --format markdown --output "$SNAPSHOT_DIR/report.md"

# JSON 供 jq 聚合
export --format json | jq '._meta.orphanCandidates | length'
```

## 使用建议

### 通用工作流

1. **检查快照**：`data/snapshot.json` 不存在或代码大改后 → `action refreshRepo`
2. **概览**：`query Project` + `query Module`
3. **定位**：`query Component/Route/Store --where ...` 拿到 ID
4. **下钻关系**：`link renders/importedBy/navigatesTo/usesStore ...`
5. **回写结论**：`action markReviewed` + `action addNote`（跨会话保留在快照中）

### 变更影响分析（核心场景）

修改某文件前，反查所有受影响方：

```bash
link importedBy --src "file:src/services/ai.ts"          # 直接导入方
# 结果中每个文件再递归 importedBy，即得传递影响面
link renderedBy --src "comp:XXXPage"                     # UI 层影响
```

### 大文件策略

- `query SourceFile --all` 会输出约 1760 条，避免直接全量；先 `--where "layer=xxx"` 缩小
- 导航全图较大时，用单路由 `link navigatesTo` 或导出 Markdown 第 5 节

### 与项目现有检查工具的分工

- `npm run check:overlay-hides-nav` / `check:overlay-coverage`：合规校验（CI 用）
- `.codegraph/codegraph.db`：SQLite 代码图（另一个体系）
- **nice-aos**：面向 agent 的结构化本体查询（本 Skill），擅长关系问答与影响分析

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 首次执行 nice-aos 命令 | 检查 `nice-aos/node_modules` 存在，缺失则 `cd nice-aos && npm install` |
| 查询返回"未找到本体快照" | 提示后直接执行 `action refreshRepo`（约 4 秒，无需用户确认） |
| 用户报"查询结果不对/过期" | 代码可能已变更 → 重新 refreshRepo |
| 回答结构类问题 | 优先用 nice-aos 查询，而不是 grep 1700+ 文件 |
| markReviewed/addNote | 执行 review 类任务后主动回写，下次会话可恢复上下文 |

## 输出格式

- 默认 stdout 输出 JSON（agent 直接解析）
- `--pretty` 人类可读表格
- 退出码：0 成功，1 失败
- 快照单文件 `snapshot.json`（本仓库约 2-4MB）

## 技术限制

- 基于 TypeScript Compiler API 的**语法级**解析（不跑类型检查），个别动态引用（变量拼接的 import、字符串组件名）无法解析
- `renders` 归属到文件的主组件（default export 优先）；同文件多组件的内部渲染关系不细分
- 跳转边来自 `setActiveOverlay/openOverlay('id')` 字面量调用；`onOpenOverlay: app.setActiveOverlay` 这类函数透传无法静态追踪
- App.tsx 内部跳转（Tab 级）不计入 navigatesTo（仅 overlay→overlay）
- Vue 适配范围：Vue 3 SFC（`<script setup>`/`<template>`/`<route lang="yaml">`）、vue-router RouteRecordRaw 显式路由、
  views/pages 目录文件路由推导、Pinia `defineStore`（setup/options 两种写法）、composables（导出 `useXxx`）；
  模板渲染关系支持 PascalCase/kebab-case 标签与 `:is` 动态组件（不含动态变量拼装）；
  导航边来自 `router.push('/path')`/`replace('/path')` 字面量调用（解构 `const { push } = useRouter()` 同样支持）
- 每次查询全量加载 JSON（1760 文件规模毫秒级；无并发写保护）
- `--where` 为全表扫描：`=`/`:` 精确相等、`~` 模糊包含（不支持数值比较，数值过滤请配合 jq）
