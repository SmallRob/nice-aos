# ADR 0004: 借鉴 code-graph-rag 的知识图谱范式

> **Status**: Proposed (v0.33.0 候选, 2026-08-26)
> **Authors**: nice-aos team
> **Related**: [ADR 0001](./0001-asdm-aos-borrowed-capabilities.md) · [ADR 0002](./0002-blueprint-engine-borrowed-from-aos.md) · [ADR 0003](./0003-aos-three-core-roadmap.md)
> **Reference**: <https://github.com/vitali87/code-graph-rag> (MIT, ~4.8k★, ~638 forks)
> **Predecessor**: ADR 0002 借鉴了 asdm-aos 的 BlueprintRuntime 模式，本 ADR 把视野扩大到"通用代码 RAG"领域

## Context

nice-aos 当前是"代码本体生成器"路线：扫描 → 出蓝图（HTML/MD/JSON）给人和 AI 看。code-graph-rag 走的是"代码知识图谱 + RAG"路线：扫描 → 入图（Memgraph） → 自然语言 → Cypher → 回答。

二者**正交可组合**：nice-aos 的快照（`snapshot.json` / `viewmodel`）就是 code-graph-rag 想要的数据源。

本 ADR 调研 code-graph-rag 的设计范式，识别可借鉴的部分、明确不可借鉴的部分、给出**分阶段实施建议**。遵循 ADR 0001 / 0002 既定原则：**仅借鉴工程模式，不复制源码/品牌/文档原文**。

## 调研对象速览

code-graph-rag v 主分支（2026-08 调研）核心能力：

| 维度 | code-graph-rag | nice-aos |
|---|---|---|
| 目标 | 代码 RAG + 自然语言查询 + AST 编辑 | 代码本体生成 + 7 种蓝图（code/db/deploy/service/planning/arch/summary） |
| 语言栈 | Python + Tree-sitter + Memgraph + Qdrant | Node.js + 自写各语言 analyzer + TypeScript Compiler API（仅 TS） |
| 部署 | 需 Docker（Memgraph + Qdrant 容器） | 零外部依赖，单文件 Node CLI |
| AI 集成 | MCP server（Claude Code 原生） | 油猴 AI agent（项目级会话 + 跨蓝图共享） |
| 多语言 | 12 full + 8 via ast-grep | 7 自写（TS/Vue/Flutter/Go/Rust/Python/油猴） |
| 节点数 | 21 节点 / 27 关系 | 19 节点 / 24+ 关系 / 4 action |
| 死代码 | 图遍历（entry-point BFS over CALLS/REFERENCES） | "本文件零引用"启发式 |
| 重复代码 | **AST fingerprint**（ast_fingerprint_nodes / ast_branch_fingerprints） | **无** |
| 数据流 | `READS_FROM / WRITES_TO / FLOWS_TO` 三 kind（taint analysis） | **无** |
| 动态追踪 | eBPF + 9 种 runtime 适配器 | **无** |
| 增量 | realtime-updates（Git hooks + watchdog） | `--incremental` + git diff |
| 唯一项目多实例 | 多 project 共享一个 Memgraph | per-snapshot-dir 隔离 |

## 详细对比

### 1. Schema 对比（最高借鉴价值）

**code-graph-rag 的 21 节点 / 27 关系**：
```
节点: Project / Package / Folder / File / Module / Class / Function / Method /
      Interface / Enum / Type / Union / ModuleInterface / ModuleImplementation /
      ExternalPackage / ExternalModule / Resource / Section /
      Pattern / CodeSmell / SecurityIssue

关系: CONTAINS_PACKAGE / CONTAINS_FOLDER / CONTAINS_FILE / CONTAINS_MODULE /
      CONTAINS_SECTION / DEFINES / DEFINES_METHOD / IMPORTS / EXPORTS / EXPORTS_MODULE /
      IMPLEMENTS_MODULE / INHERITS / IMPLEMENTS / OVERRIDES / DEPENDS_ON_EXTERNAL /
      CALLS / REFERENCES / INSTANTIATES / READS_FROM / WRITES_TO / FLOWS_TO /
      IMPLEMENTS_PATTERN / HAS_SMELL / HAS_VULNERABILITY
```

**nice-aos 的 19 节点 / 24+ 关系**（参见 `src/ontology/blueprint.js`）：
```
节点: Project / Domain / Module / SourceFile / Component / Hook / Store / Service /
      Interface / Class / Method / PropEdge / ScriptFunction / Route / UserScript /
      Dependency / GmApiUsage / InjectionPoint / NetworkEndpoint

关系: contains / imports / importedBy / renders / renderedBy / passesProps /
      navigatesTo / registers / usesStore / usesHook /
      implements / implementedBy / extends / extendedBy / overrides / overriddenBy /
      usesGmApi / injectsInto / requestsTo / calls / calledBy / belongsTo /
      mapsToTable / mappedFromCode
```

| 维度 | code-graph-rag | nice-aos | 评估 |
|---|---|---|---|
| **代码实体** | 重（Module/Function/Class/Method/Interface/Enum/Type/Union） | 重 + **前端专用**（Component/Hook/Store/Service/PropEdge/ScriptFunction） | nice-aos 更"前端 + 审计"导向，code-graph-rag 更"通用 RAG"导向 |
| **容器建模** | 轻（Package/Folder/File） | 重（Project/Domain/Module/SourceFile） | nice-aos 的 Domain 概念有特色（横向功能切片） |
| **资源建模** | **Resource 节点**（8 种 kind: FILE/NETWORK/DATABASE/STDIN/STDOUT/STDERR/ENV/SOCKET） | 独立类型（NetworkEndpoint/InjectionPoint） | Resource 抽象更优雅，建议借鉴 |
| **多态建模** | `ModuleInterface` / `ModuleImplementation` 节点 + `IMPLEMENTS_MODULE` 边 | `implements/extends` 边（数据挂在节点上） | nice-aos 的更紧凑 |
| **数据流追踪** | **FLOWS_TO** 三 kind（`resource / arg / return`）+ `via` 边属性 | **无** | **高价值借鉴点** |
| **审计事实** | 统一的 `Pattern / CodeSmell / SecurityIssue` 节点（ast-grep findings） | 5 个独立类型 | code-graph-rag 模式更通用，可收敛为 `AuditFact` 抽象 |
| **文档章节** | `Section` 节点（CONTAINS_SECTION，heading 1-6 嵌套） | **无**（但 planning 蓝图有文档） | 可借鉴用于 PRD 章节建模 |
| **External 节点** | `ExternalPackage / ExternalModule` 显式 | `dep:` 前缀 + Dependency 类型 | 思路一致，code-graph-rag 更显式 |

### 2. 数据流追踪机制（高价值）

code-graph-rag 的 `FLOWS_TO` 边借鉴了 taint analysis：

```
FLOWS_TO 三种 kind:
  - resource → resource (kind=resource): 同函数体内读→写
  - caller → callee  (kind=arg, via=arg:<index>|kw:<name>): 参数传递
  - callee → caller (kind=return, via=return): 返回值回流

关键设计:
  - 单 forward pass（不反向 BFS）
  - 传播规则: b = a 复制 a 的 taint; x = getenv(...) 重新绑定
  - 杀除规则: x = "safe" 清除 taint
  - scope attribution: 嵌套函数内的 IO 只归属于嵌套函数，不外溢
  - handle 解析: self.conn = sqlite3.connect(...) 跨方法可见
  - 14 种语言全支持
```

**对 nice-aos 的价值**：
- 当前 `gmApiCalls` / `domOpCount` / `networkCallCount` 都是计数，**没追踪数据流**
- 安全审计场景（油猴脚本）里这是杀手锏：`GM_getValue('user_token')` → `fetch('/api/login')` 这种
- 蓝图 AI agent 可以回答"X 是否会泄露到 Y"

**怎么落**（阶段 2）：
- 新增 `FlowEdge` 节点类型（前缀 `flow:`）
- 在 `src/analyzers/userScriptAnalyzer.js` 实现 intra-procedural taint walk
- 蓝图加 `dataFlow` 字段，UI 加 "Data Flow" 视图

### 3. 死代码检测算法（高价值）

code-graph-rag 的 `cgr dead-code` 核心：

```
1. Roots: 导出/公开符号 + tests + decorated handlers + dunder/lifecycle
2. Reachability: BFS over CALLS + REFERENCES from every root
3. Report: 不可达节点 - --exclude glob

关键设计:
  - 装饰器视为入口: --decorator-root celery_app.task
  - --include-tests 默认开启
  - --fail-on-found 集成 CI
  - REFERENCES 包含函数作为值/回调的场景（避免误报）
```

**nice-aos 现状**（`src/ontology/builder.js:237-340`）：
- 仅"本文件内零引用"启发式
- 注释承认"全仓库零导入检测在调用方统一做"
- 没有 entry-point BFS

**怎么落**（阶段 1，最易实现）：
- 新增 `src/analyzers/deadCode.js`（~100 行）
- 输入：dataMap + entry files（已有 `ENTRY_BASENAMES` + `isEntryFile`）
- 算法：构建反向可达集（BFS from entries over calls/imports/usesStore/usesHook/extends/implements/overrides）
- 不可达 + 导出 = dead candidate（升级现有 `deadCandidate/deadReason`）

### 4. AST fingerprint 重复代码检测（高价值）

code-graph-rag 在每个 Function/Method 节点携带：
```
ast_fingerprint: string          # 规范化 AST 的 hash
ast_fingerprint_nodes: int       # 节点数
ast_branch_fingerprints: list    # 分支 hash
```

**怎么落**（阶段 1）：
- 在 `tsAnalyzer.js` / `vueAnalyzer.js` / `goAnalyzer.js` 等的每个方法上，规范化后做 SHA-1
- 规范化：去标识符名 / 去字面量 / 去注释
- 蓝图加一个 "Duplicate Code" Tab：按 fingerprint 分组，列出所有出现

### 5. MCP server 集成（高价值，立即可做）

code-graph-rag 的 MCP server 暴露 19 个工具（`docs/guide/mcp-server.md`）：

```
- list_projects / delete_project / wipe_database
- index_repository / update_repository
- query_code_graph / get_code_snippet / surgical_replace_code
- read_file / write_file / list_directory
- semantic_search / structural_search / structural_replace
- ask_agent
- flow_verdict / explain_traceback / rank_root_causes
```

**对 nice-aos 的价值**：
- 已经有 `/api/*` 7 个端点（`src/cli/commands/serve.js`）+ 油猴 AI agent
- **没有暴露为 MCP server** → Claude Code / Cursor / Continue 用户无法直接用
- 油猴 agent 的 25 个工具天然就是 MCP tools

**怎么落**（阶段 1，最高 ROI）：
- 新增 `src/cli/commands/mcp.js`（依赖 `@modelcontextprotocol/sdk`）
- 把 `/api/*` 端点 + blueprint 工具映射为 MCP tools
- 用户：`claude mcp add nice-aos -- npx nice-aos mcp`

### 6. Capture groups 配置化（可借鉴）

code-graph-rag 的 capture groups 模式：

```bash
# 默认 capture: definitions, calls
# 显式启用 IO 追踪:
cgr start --capture io

# 显式启用 findings:
cgr start --capture findings
```

**对 nice-aos 的价值**：
- 现在 link 边是固定 24+ 种，所有蓝图都生成
- 可以学 capture group：让"数据流追踪" / "死代码" / "重复代码"等"高级分析"作为可选
- 配置驱动：用户可关闭不需要的能力以加速扫描

### 7. multi-project 共享图（不借鉴）

code-graph-rag 一个 Memgraph 可存多个 project（`list_projects` / `delete_project`），共享图但 per-project 隔离。

**对 nice-aos 的价值**：低 —— nice-aos 是 per-snapshot-dir 隔离，已经够用。共享图反而会破坏"零依赖单文件"原则。

## 不可借鉴的部分（明确避坑）

| code-graph-rag 特性 | 为什么不借鉴 |
|---|---|
| **Memgraph + Docker** | 破坏 nice-aos "零外部依赖" 原则。Node 单文件 CLI 是核心定位。 |
| **Qdrant 向量库** | nice-aos 不做 RAG 检索，只产快照。语义检索由消费方（agent）负责。 |
| **Python + 全部 Tree-sitter grammars** | grammars 体积 200MB+。nice-aos 用 TypeScript Compiler API（仅 TS 部分）+ 自写 parser。 |
| **eBPF 动态追踪** | 前端/油猴场景无 eBPF 等价物。Performance API trace 可考虑但 ROI 低。 |
| **ModuleInterface / ModuleImplementation 节点** | 现有 `implements/extends` 边已够用，引入新节点增加复杂度。 |
| **ast-grep 全语言 fallback** | 已有 7 种语言自写 parser，覆盖度足够。 |
| **多 project 共享图** | 与 per-snapshot-dir 隔离原则冲突。 |
| **cypher 自动生成** | 需要图数据库。阶段 2 的 `queryGraph` 工具是更轻量替代。 |
| **CLI 交互查询 (Repl + rich)** | nice-aos 走"CLI 出快照 → 消费方查"路线，不做交互查询。 |

## 实施路线图

### 阶段 1（v0.33.0，2-3 周）— 立即可做

| # | 项目 | 价值 | 改动范围 |
|---|---|---|---|
| 1 | **MCP server 暴露 7 蓝图** | 让 Claude Code / Cursor 用户直接用 nice-aos | `src/cli/commands/mcp.js`（新增 ~150 行）+ 复用 `/api/*` + 加 `@modelcontextprotocol/sdk` 依赖 |
| 2 | **死代码图遍历** | 替换现有"零引用启发式"，准确度大幅提升 | `src/analyzers/deadCode.js`（新增 ~120 行） |
| 3 | **AST fingerprint 重复代码** | 补 nice-aos 缺的能力，跨项目复用友好 | 各 analyzer 加 `astFingerprint` 字段 + 新 Tab |

### 阶段 2（v0.34.0，1-2 月）— 中期

| # | 项目 | 价值 | 改动范围 |
|---|---|---|---|
| 4 | **数据流追踪**（FLOWS_TO 三 kind） | 油猴脚本安全审计杀手锏 | `src/analyzers/userScriptAnalyzer.js` 加 taint walk + 新 linkType + 新蓝图视图 |
| 5 | **Cypher-like 查询语法** | agent 一次查询跨多关系，无需 4-5 次工具调用 | 加 `queryGraph` 工具（不引入图数据库，走现有 link 索引） |
| 6 | **ast-grep 集成** | 审计规则外部化，用户可写规则 | 加 `ast-grep` 可选依赖 + 蓝图加 "Pattern" Tab |
| 7 | **Resource 节点统一抽象** | 收敛 NetworkEndpoint/InjectionPoint/Dependency | 新 nodeType `Resource(kind:FILE/NETWORK/ENV/...)` + 迁移辅助 |

### 阶段 3（路线图，>3 月）— 远期

| # | 项目 | 价值 | 改动范围 |
|---|---|---|---|
| 8 | **Capture groups 配置化** | 高级分析可选化，加速扫描 | `nice-aos.config.json` + capture group 枚举 |
| 9 | **实时增量（Git hooks）** | 替代现有 `--incremental` 显式调用 | `.git/hooks/post-commit` 集成 + watchdog |
| 10 | **完整知识图谱化（Memgraph）** | **不推荐**：破坏零依赖原则。除非社区有强烈诉求 | — |

## 决策建议

### 决策 1: 阶段 1 三项立即推进

**理由**：
- MCP server 是**最高 ROI**（一个文件 + 一个依赖，让 Claude Code 用户可用）
- 死代码图遍历是**最低代码量**（~120 行 + 测试，算法清晰）
- AST fingerprint 是**最易扩展**（每种 analyzer 加一个字段）

**约束**：
- 不引入图数据库、不引入 Python、不引入 tree-sitter 全 grammars
- 保持 nice-aos 零外部运行时依赖（仅加 `@modelcontextprotocol/sdk` 一个 prod 依赖）
- 测试覆盖：多根 monorepo、动态 import、entry 边界

### 决策 2: 阶段 2 列入 v0.34.0 候选

**理由**：
- 数据流追踪是 nice-aos 与 code-graph-rag 最大能力差距
- Cypher-like 查询是 agent 工具的合理演进
- Resource 抽象为后续"跨层审计"铺路

**约束**：
- 数据流追踪仅做**油猴脚本**（GM API + fetch + DOM 注入），不做全语言 taint analysis
- `queryGraph` 走现有 link 索引（不引入图数据库）
- ast-grep 放 `optionalDependencies`，不强制安装

### 决策 3: 阶段 3 暂不实现

**理由**：
- 实时增量现有 `--incremental` 已够用
- Memgraph 化破坏零依赖原则
- 社区无强需求时不应过度设计

**触发条件**（何时重评估）：
- 社区有 5+ 个 issue 强烈要求某项
- 阶段 1-2 落地后实测显示有 ROI 不足项
- 出现新的轻量图数据库（如 Kuzu / Cozo 等嵌入式）可零依赖集成

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `@modelcontextprotocol/sdk` 体积 | 增加 npm 包大小 | 仅作为 dependencies，不强制加载（lazy require） |
| 死代码图遍历在大 monorepo 性能 | 扫描变慢 | 仅在显式 `--detect-dead` 启用，不默认开启 |
| AST fingerprint 哈希碰撞 | 误报 | 用 SHA-256（不用 SHA-1）+ 显示节点数辅助判断 |
| 数据流追踪复杂度 | 实现周期长 | 阶段 2 限定油猴脚本（GM API + fetch + DOM），不覆盖全语言 |
| Resource 抽象破坏向后兼容 | 既有 dataMap 解析失败 | 阶段 2 末做迁移辅助：旧节点自动识别为 Resource(kind=legacy) |

## 验证标准

阶段 1 完成后必须满足：

1. **MCP server**：
   - `npx nice-aos mcp` 启动后，`claude mcp list` 能看到
   - 至少 5 个核心工具可用（`getStats / queryObjects / getNodeDetails / listLinks / getHealth`）
   - README 给出"在 Claude Code 中配置"的完整步骤

2. **死代码图遍历**：
   - 测试覆盖 4 种场景：monorepo 入口、单包入口、动态 import、循环依赖
   - 与现有 `deadCandidate` 字段兼容（旧字段自动转换）
   - 性能：1000 文件项目 < 5 秒

3. **AST fingerprint**：
   - 7 种 analyzer 全部实现 fingerprint 提取
   - 蓝图新增 "Duplicate Code" Tab，列出至少 3 种典型重复模式
   - SHA-256 哈希，无碰撞（用 AVL 树 / 集合去重验证）

## 附录 A: code-graph-rag 主要文档清单

调研涉及的官方文档（已通读或重点阅读）：

- `README.md` —— 总览 + 安装
- `docs/architecture/overview.md` —— 两组件架构
- `docs/architecture/graph-schema.md` —— **核心 schema 定义**（21 节点 / 27 关系）
- `docs/architecture/data-flow-edges.md` —— **FLOWS_TO 三 kind 详细规范**
- `docs/architecture/language-support.md` —— 12+8 语言支持矩阵
- `docs/guide/mcp-server.md` —— MCP 集成 + 19 个工具
- `docs/guide/dead-code.md` —— **死代码图遍历算法**
- `docs/guide/dynamic-tracing.md` —— 9 种 runtime 追踪
- `docs/getting-started/configuration.md` —— 配置 + capture groups

## 附录 B: 借鉴 vs 创新 速查

| 借鉴自 code-graph-rag | nice-aos 独立设计 |
|---|---|
| FLOWS_TO 三 kind（数据流） | Domain 概念（横向功能切片） |
| AST fingerprint（重复代码） | PropEdge（props 传递边） |
| Resource 节点统一抽象 | GmApiUsage（油猴 API 审计） |
| MCP server 暴露 19 工具 | 油猴 AI agent（项目级会话） |
| 死代码图遍历 + --decorator-root | L0-L3 抽象层级 + Category 双维分类 |
| 14 语言 capture groups | 7 自写 analyzer（per-language 深度） |
| Entry-point BFS 死代码 | --incremental + Git diff |

## 附录 C: 关键范式引用

调研过程中提炼的 7 个可跨项目复用的范式（与"AI-Canvas-tauri 范式提炼"互补）：

1. **Schema 形式化** —— 节点 + 边 + kind 字段，让"通用引擎 + 领域 schema"成为可能
2. **Resource 抽象** —— 把外部 IO 收敛为 `resource::<KIND>::<identity>` 节点
3. **FLOWS_TO 三 kind** —— taint analysis 形式化为图边的 `kind + via` 属性
4. **AST fingerprint** —— 规范化去标识符 + 哈希，跨语言统一去重
5. **Entry-point BFS 死代码** —— 从导出 + 装饰器 + 入口出发，遍历可达集
6. **MCP server 暴露** —— 让任何"产快照"工具都能被 Claude Code 直接消费
7. **Capture groups 可选化** —— 高级分析作为可选 capture group，默认仅开基础集

**何时复用**：用户做"插件体系/扩展点/工具注册/权限控制/Provider 抽象"时，主动提"code-graph-rag 也有类似范式（特别是 FLOWS_TO / Resource / MCP server）"，并问是否参考。

---

## 附录 D: 深度调研补充（源码级发现，2026-08-26 二次调研）

二次深挖 4 个核心源码/文档，更新阶段 1-2 实施路径：

### D.1 MCP server 核心实现（`codebase_rag/mcp/server.py` ~250 行）

**关键模式**（直接影响 nice-aos 阶段 1 实施）：

```python
# 1. 单 Server + tools registry 模式
server = Server("code-graph-rag")
tools = create_mcp_tools_registry(project_root, ingestor, cypher_gen)  # 35KB tools.py

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [Tool(name=..., description=..., inputSchema=...) for schema in tools.get_tool_schemas()]

@server.call_tool()
async def call_tool(name, arguments):
    handler_info = tools.get_tool_handler(name)
    if not handler_info: return _create_error_content(...)
    result = await handler(**arguments)
    return [TextContent(type="text", text=json.dumps(result, indent=2))]
```

**对 nice-aos 的具体落地**：
- 现有 `src/cli/commands/serve.js` 7 个 `/api/*` 端点 → 抽 `toolRegistry.js`（每个 tool = `{name, description, inputSchema, handler}`）
- 新增 `src/cli/commands/mcp.js`（~120 行）：从 toolRegistry 渲染 MCP 工具列表，stdio 传输
- 工具定义用 JSON Schema（与现有 blueprint Actions 的 `ParamDef` 形态天然兼容）
- 启动校验：parse `nice-aos.config.json` / 环境变量，fail fast

**HTTP 传输的安全设计**（值得借鉴但 nice-aos 阶段 1 不必做）：
- 默认绑定 loopback（`127.0.0.1` / `::1`）
- 远程绑定强制要求 bearer token（`secrets.compare_digest`）
- 401 响应 + `WWW-Authenticate: Bearer` 头

**nice-aos 阶段 1 MCP 实施清单**（基于源码反推）：
- `src/cli/commands/mcp.js` ~120 行
- `src/ontology/toolRegistry.js` ~50 行（与现有 `blueprintActions.js` 共用 ParamDef）
- 依赖：`@modelcontextprotocol/sdk` v1.x
- 测试：`test/mcp.test.mjs` 验证 5+ 工具可调用

### D.2 重复代码检测算法（`docs/guide/duplicates.md` + `codebase_rag/parser_fingerprint.py`）

**核心机制**（比预想的更精细）：

```
whole-tree fingerprint:   规范化 AST → SHA 哈希
branch fingerprint:       每个子树单独哈希
group-by fingerprint:     O(n) 分组，零 pairwise
prefix filtering:         用稀有分支定位候选对
truncated flag:           超阈值时显式告知
```

**AST 规范化规则**（双 fingerprint 都需要）：
- 标识符（变量名 / 函数名 / 字段名）→ 占位符 `□`
- 字面量（数字 / 字符串）→ 占位符 `NUM` / `STR`
- 注释 → 删除
- 关键字 / 操作符 / AST 节点类型 → 保留

**数据存储**：在每个 Function/Method 节点上挂 3 个字段：
```
ast_fingerprint: string           # 整树 hash
ast_fingerprint_nodes: int        # 节点数（防碰撞辅助）
ast_branch_fingerprints: list     # 各分支 hash 列表
```

**JSON 报告 envelope**（`--format json` 输出）：
```json
{
  "groups": [
    {
      "kind": "exact",          // 或 "similar"
      "similarity": 1.0,        // 仅 similar 时有意义
      "node_count": 24,
      "members": [
        {"label": "Function", "qualified_name": "...", "name": "...",
         "path": "billing/cart.py", "start_line": 5, "end_line": 12}
      ]
    }
  ],
  "skipped_symbols": 0,
  "truncated": false            // 超 cap 时为 true
}
```

**对 nice-aos 的具体落地**：
- 在每个 analyzer（ts/vue/go/rust/python/userscript）的 method 节点上加 `astFingerprint: string`、`astFingerprintNodes: int`、`astBranchFingerprints: string[]`
- 规范化：可考虑用 `@babel/types` 或 `typescript` Compiler API 走 visit + 标识符替换
- 蓝图新增 "Duplicate Code" Tab：按 fingerprint 分组，列 file:line
- nice-aos 不需要 prefix filtering（5000 方法规模以下 group-by 已足够快）
- 用 SHA-256 替代 SHA-1（防碰撞更强，~30% 性能损失可接受）

**已知 nice-aos 的简化点**：
- 不实现 `--fail-on-found`（先报告，CI 集成下个版本）
- 不实现 terminal hyperlink 跳转（油猴 AI agent 的 `getNodeDetails` 工具已能跳转）
- 不实现 cross-language 检测（多语言不互通已是设计选择）

### D.3 IO/数据流注册表（`codebase_rag/parsers/io_access/registry.py` ~600 行）

**这是本次深挖最值钱的发现**。code-graph-rag 用纯数据驱动的注册表实现 14 种语言的 IO/数据流追踪，没有任何"hardcode if 链"。

**核心数据模型**（`IOSink`）：
```python
@dataclass
class IOSink:
    callee: str              # 如 "fs.writeFileSync" / "std::env::var"
    kind: ResourceKind       # FILE / NETWORK / DATABASE / ENV / STDIN / STDOUT / STDERR / SOCKET
    direction: IODirection   # READ / WRITE / READ_WRITE
    target_arg: int | None   # 哪个 arg 是 resource identity
    target_kw: str | None    # 哪个 kwarg 是 resource identity（关键字参数语言）
    mode_arg: int | None     # 哪个 arg 是 mode（如 "r" / "w"）
    mode_kw: str | None
```

**注册表组织**（14 种语言，~500 个 sink）：
```python
IO_SINKS: dict[SupportedLanguage, tuple[IOSink, ...]] = {
    PYTHON: _PYTHON_SINKS,   # ~30 个
    JS: _JS_TS_SINKS,        # ~20 个
    TS: _JS_TS_SINKS,        # 共享
    TSX: _JS_TS_SINKS,       # 共享
    GO: _GO_SINKS,           # ~15 个
    JAVA: _JAVA_SINKS,       # ~30 个
    RUST: _RUST_SINKS,       # ~10 个
    CPP: _CPP_SINKS,         # ~10 个
    CSHARP: _CSHARP_SINKS,   # ~50 个
    C: ...,                  # 借用 libc
    LUA: _LUA_SINKS,
    PHP: _PHP_SINKS,
    DART: _DART_SINKS,
    SCALA: _SCALA_SINKS,     # 借用 Java
}
```

**关键设计模式**（nice-aos 阶段 2 直接复用）：

1. **双 key 注册**（每个 sink 两种写法都注册）：
   ```python
   # Rust 示例
   IOSink("std::fs::write", ...)        # 全限定
   IOSink("fs::write", ...)             # 短名（通过 use std::fs; fs::write）
   ```
   - 用 import map 解析：短名 → 全限定
   - shadow check：local `fs` 不污染全局

2. **Handle 解析**（跨方法可见）：
   ```python
   # Python 示例
   self.conn = sqlite3.connect("db.sqlite")  # 构造点
   self.conn.execute("SELECT ...")           # 后续方法归到 DATABASE
   ```
   - 关键字段：`target_arg`（identity 在哪个 arg）、`mode_arg`（read/write 取决于 mode）

3. **`new` 形状 constructor**（Java/C#）：
   ```java
   PrintWriter out = new PrintWriter("x.txt");  // IO_NEW_HANDLE_CONSTRUCTORS
   ```

4. **Wrapper constructor**（嵌套）：
   ```java
   BufferedReader br = new BufferedReader(new FileReader("x"));
   // 第一步：FileReader 是 IO_NEW_HANDLE_CONSTRUCTORS
   // 第二步：BufferedReader 是 IO_NEW_HANDLE_WRAPPERS，identity 从 arg 0 继承
   ```

5. **Type-declaration constructor**（C++）：
   ```cpp
   std::ofstream out("x");  // IO_TYPE_HANDLE_CONSTRUCTORS
   ```

6. **Macro sink**（Rust）：
   ```rust
   println!("x");  // IO_MACRO_SINKS（特殊 key，因为宏不是 call）
   ```

7. **Stream insertion**（C++）：
   ```cpp
   std::cout << x;  // IO_STREAM_SINKS（按左 spine base 匹配）
   ```

8. **Member read**（JS / PHP / Dart / Python）：
   ```javascript
   process.env.X              // IO_MEMBER_READS，head = "process.env"
   ```
   - 同样要 shadow check

9. **Arg-shaped handle**（C/C++/PHP）：
   ```c
   fprintf(stderr, fmt, x);  // 0 是 handle，1+ 是 payload
   // _LIBC_ARG_HANDLE_METHODS：handle_arg=0, data_args=None（所有非 handle 都是 payload）
   fwrite(buffer, size, count, stream);  // 0 是 payload，3 是 handle
   // data=(0,)：只有 arg 0 是 payload，size/count 是 control metadata
   ```

10. **Identity unwrap**（构造参数路径）：
    ```java
    Path.of("cfg.txt")  // 不是 handle，但用作 target 时 unwrap 出 literal
    ```

**对 nice-aos 阶段 2 数据流追踪的具体实施清单**：

新建 `src/analyzers/ioRegistry.js`：
```javascript
// 与 code-graph-rag 同构，但用 JS 实现
export const IO_SINKS = {
  userscript: [  // 油猴专用
    { callee: 'GM_getValue', kind: 'STORAGE', direction: 'READ', targetArg: 0 },
    { callee: 'GM_setValue', kind: 'STORAGE', direction: 'WRITE', targetArg: 0, valueArg: 1 },
    { callee: 'GM_xmlhttpRequest', kind: 'NETWORK', direction: 'READ_WRITE', methodArg: 0, urlArg: 1 },
    { callee: 'GM_addStyle', kind: 'DOM', direction: 'WRITE', cssArg: 0 },
    // ...
  ],
  ts: [  // 浏览器 fetch / localStorage / document.cookie
    { callee: 'fetch', kind: 'NETWORK', direction: 'READ', targetArg: 0, optionsArg: 1 },
    { callee: 'localStorage.getItem', kind: 'STORAGE', direction: 'READ', targetArg: 0 },
    { callee: 'localStorage.setItem', kind: 'STORAGE', direction: 'WRITE', keyArg: 0, valueArg: 1 },
    { callee: 'document.cookie', kind: 'STORAGE', direction: 'READ_WRITE' },
    // ...
  ],
};
```

**坦率说**：油猴脚本的 GM API 远没有 14 种语言那么多，**30-50 个 sink 足够覆盖**。阶段 2 实际工作量约 200-300 行。

### D.4 配置文件 capture groups（`docs/getting-started/configuration.md`）

**模式**：高级分析作为可选 capture group，默认仅开基础集。

**对 nice-aos 的借鉴**：阶段 3 的"高级分析可选化"。

**具体落地**（远期）：
```json
// nice-aos.config.json（新增）
{
  "captureGroups": {
    "definitions": true,   // 默认：基础节点
    "calls": true,         // 默认：调用图
    "io": false,           // 可选：数据流追踪（阶段 2 落地后开放）
    "duplicates": false,   // 可选：重复代码（阶段 1 落地后开放）
    "deadcode": false      // 可选：死代码（阶段 1 落地后开放）
  }
}
```

**好处**：
- 用户能精细控制扫描成本
- 默认扫描速度不变
- 高级分析作为"按需付费"模式

### D.5 增量更新 cache key（`codebase_rag/parser_fingerprint.py`）

**这个文件名字有歧义** —— 它不是"代码重复检测的 fingerprint"，而是"**解析器指纹**"：hash 解析器源码 + 工具链版本 + 配置，用于决定 graph 是否需要重 build。

**算法**（~150 行）：
```python
def compute_parser_fingerprint(package_root, repo_path) -> str:
    hasher = hashlib.md5()
    for source in _fingerprint_sources(root):         # 解析器源码（parsers/）
        hasher.update(source.relative_to(root).as_posix().encode())
        hasher.update(source.read_bytes())
    for entry in _grammar_versions():                 # Tree-sitter grammar 版本
        hasher.update(entry.encode())
    for entry in _repo_frontend_inputs(repo_path):    # C++ 编译数据库
        hasher.update(entry.encode())
    for entry in _frontend_settings():                # frontend mode (tree-sitter/hybrid/...)
        hasher.update(entry.encode())
    for entry in _tool_versions(repo_path):           # go/javac/dotnet 版本
        hasher.update(entry.encode())
    return hasher.hexdigest()
```

**对 nice-aos 阶段 3 增量更新的具体落地**：

当前 `src/analyzers/incrementalParser.js` 的 cache key 是 `{filePath, code}`。但**解析器代码 / 配置变了**时 cache 应该失效（issue：用户在 IDE 改了 tsAnalyzer.js，但旧 cache 命中导致用了旧逻辑）。

**借鉴点**：
- `computeParserFingerprint()` 函数：hash `src/analyzers/` 下所有 .js + 各 analyzer 的关键配置常量
- `incrementalParser` 的 cache 命中检查要双重：file cache + parser cache
- parser cache 变化 → 全量重 build

**预估代码量**：~50 行（一个 util 函数 + 集成到现有 `cachedAnalyze` 包装器）。

### D.6 修订后实施优先级（基于源码级发现）

| 优先级 | 阶段 1 项目 | 工作量 | 风险 | 修订 |
|---|---|---|---|---|
| 🥇 | **MCP server** | 1 文件 + 1 依赖 | 低 | `toolRegistry` 与 `blueprintActions` 共享 ParamDef 形态，代码量可压缩到 100-150 行 |
| 🥈 | **死代码图遍历** | ~100 行 | 低 | 算法清晰（`cgr dead-code` 文档已写明 BFS 策略），可直接 port 思路 |
| 🥉 | **AST fingerprint 重复代码** | ~150 行 | 中 | 需要在 7 种 analyzer 各加 fingerprint 计算；可先做 TS + Vue 验证，渐进式推广 |
| 阶段 2.1 | **数据流追踪（FLOWS_TO）** | 200-300 行 | 中 | **重点借鉴 IO registry 模式**：纯数据驱动注册表 + 影子检查 + handle 解析 |
| 阶段 2.2 | **Cypher-like `queryGraph` 工具** | ~80 行 | 低 | 在 MCP server 阶段 1 落地后增量加，作为新 tool |
| 阶段 2.3 | **ast-grep 集成** | ~100 行 | 中 | 放 `optionalDependencies`；蓝图新 "Pattern" Tab |
| 阶段 2.4 | **Resource 节点统一抽象** | 200 行 + 迁移 | 高 | 大改动，建议放最后做 |
| 阶段 3.1 | **解析器指纹 cache key** | ~50 行 | 低 | **小幅借鉴**：增强现有 `incrementalParser` |
| 阶段 3.2 | **Capture groups 可选化** | ~50 行 | 低 | 配置文件驱动；远期实现 |
| 阶段 3.3 | **Memgraph 化** | — | — | **不推荐**（破坏零依赖原则） |

### D.7 与 AI-Canvas-tauri 范式提炼的对照

调研过程中发现 code-graph-rag 与之前提炼的"AI-Canvas-tauri 10 条范式"有交叉与互补：

| AI-Canvas-tauri 范式 | code-graph-rag 对应 | 互补性 |
|---|---|---|
| 1. Service 边界 = 唯一入口 | IO_SINKS 数据驱动注册表 | 后者是前者的"数据版"（无 service 边界，全数据声明） |
| 2. Tool Registry + Schema + Effect | MCP server tool registry + inputSchema | 完全同构 |
| 3. 固定 Policy Engine | capture groups（可选） | 不完全对应（code-graph-rag 没有 policy） |
| 4. 本地优先 + Provider 适配 | 单一 provider，但 LLM provider 多适配 | 部分对应 |
| 5. 按需加载 + SHA-256 锁定 | parser_fingerprint.py 解析器指纹 | 同构（cache key） |
| 6. 历史快照 | ingest 幂等性（re-ingest 不重复） | 部分对应 |
| 7. Provider 能力声明 | — | code-graph-rag 缺此 |
| 8. 同步取消 + 轻量控制层 | — | code-graph-rag 缺此 |
| 9. 独立窗口 + 受限事件协议 | MCP stdio 协议 | 部分对应（stdio 是一种"受限事件"） |
| 10. 文档即架构 | docs/architecture/*.md 13 篇 | 同构 |

**整合建议**：下次更新记忆时，可把"code-graph-rag 10 条范式"作为第 2 个跨项目复用模式库，与"AI-Canvas-tauri 10 条范式"并列。

