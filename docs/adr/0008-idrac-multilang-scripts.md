# ADR 0008: v0.40.0 多语言脚本架构 —— argparse / HTTP 客户端 / UTF-16 PS / 跨语言同步

**状态**：已实施（v0.40.0）
**日期**：2026-08-29
**触发**：iDRAC-Redfish-Scripting（[github.com/dell/iDRAC-Redfish-Scripting](https://github.com/dell/iDRAC-Redfish-Scripting)，Dell Redfish API 双实现脚本仓库，146 .py + 79 .ps + 1 .psm1 共 200k+ 行）扫描发现 5 处缺口。

## 背景

v0.39.0 之前，Python analyzer 已支持：class / dataclass / SQLAlchemy 2.0 Mapped / FastAPI / Flask / aiohttp / Sanic / dunder / CLI 装饰器 / ROS 2 Node / launch 文件。PowerShell analyzer 已支持：UTF-8、函数定义、CLI 参数（param() 块）、cmdlet 调用、URL 抽取、注册表、checksum。两者各自独立，但**没有跨语言协同能力**，且对真实仓库的边界情况（UTF-16 BOM、argparse、HTTP 客户端）覆盖不全。

iDRAC-Redfish-Scripting 是 Dell 服务器 Redfish API 的官方双实现脚本仓库（Python + PowerShell 同语义同工作流），是混合脚本架构的典型代表。跑 nice-aos 时暴露出 5 处明确缺口：

1. **PowerShell 文件读为乱码**（数据质量 bug）—— 79 个 .ps/.psm1 全部 UTF-16 LE + BOM + CRLF，原 `fs.readFileSync(..., 'utf-8')` 直接读后所有 token 都是单字节错位，无法被 `findPowerShellFunctions` 等 regex 匹配
2. **argparse CLI 表面丢失**（数据质量 bug）—— iDRAC 每个 Python 脚本 5-20 个 `parser.add_argument(...)` 调用定义完整 CLI 表面，但 pythonAnalyzer 只在 Click 装饰器路径下抽取，argparse 路径完全空白
3. **HTTP 客户端调用零抽取** —— `requests.get/post/patch/put/delete('https://...')` 是 Redfish API 的全部通信方式，145 个 Python 文件中累计 6000+ 次 HTTP 调用，但 nice-aos 既不知道这些 URL 也不知道方法
4. **跨语言同名工作流不关联** —— Python `CreateVirtualDiskREDFISH.py` 和 PowerShell `Invoke-CreateVirtualDiskREDFISH.psm1` 是同一工作流的双实现，但本体图谱上彼此孤立；agent 无法回答"Python 版与 PS 版是否同步 / 谁实现了什么 / 哪个更新"
5. **混合脚本架构层缺失** —— iDRAC 的 `Redfish Python/` 与 `Redfish PowerShell/` 是同一 API 客户端生态，nice-aos 没有 `integration` 层的强信号，导致 `inferFileArchLayer` 把它们都归到 `shared`

## 决策

### D1. PowerShell UTF-16 BOM 探测（数据质量修复）

PowerShell ISE / Windows PowerShell 默认导出为 UTF-16 LE + BOM（`0xFF 0xFE` 开头）+ CRLF 换行。iDRAC 79 个 .ps 文件全部此格式。Unix / Linux 工具链里 PowerShell Core 7+ 也保留此格式作为默认（跨平台兼容）。

实现 `readTextWithBom(absPath)`：
- 头 2 字节 `0xFF 0xFE` → UTF-16 LE BOM → 切片后 `toString('utf16le')`
- 头 3 字节 `0xEF 0xBB 0xBF` → UTF-8 BOM → 切片后 `toString('utf-8')`
- 其余 → `toString('utf-8')`（含 GBK / Shift-JIS / Latin-1 失败时 fallback）

`analyzeShellScriptFromDisk` 用此函数读盘，幂等不破坏既有 UTF-8 仓库（openamr / nice-aos 本体 / 大量 Unix 系项目）。

修复后 `Invoke-CreateVirtualDiskREDFISH.psm1`（1032 行）正确解析：1 个 PsFunction + 21 个 CLI 参数 + 真实 cmdlet 调用清单。

### D2. argparse CLI 参数抽取（与 Bash/PS 的 cliParams 同构）

Bash（v0.38.0 `cliParamNames`）和 PowerShell（v0.38.0 `cliParamObjects`）已有 CLI 参数抽取通道。Python 的 argparse 路径完全缺失，导致 Python 脚本 CLI 表面在本体里是个黑盒。

实现 `extractCliParams(clean, lineStarts)`：
- 模式：`<var>.add_argument(...)` 在 clean 通道（已剥离字符串）扫描
- 每个参数抽取 11 字段：`flag / short / long / name / positional / type / required / default / action / help / line`
- flag 形式支持：`-ip`（短写）/ `--ip`（长写）/ `-ip, --ip-address`（长写+短写）/ `fqdd`（位置参数）
- name 解析优先级：`dest= kwargs` 优先 → 长写去 `--` → 短写去 `-`；kebab 转 snake（`scan-body-filter` → `scan_body_filter`）

iDRAC `CreateVirtualDiskREDFISH.py` 抽出 22 个参数；全仓库累计约 2000+ CLI 参数。Click 装饰器（`@app.command` / `@click.command` / `@typer.command`）的 CLI 入口已在 v0.35 通过 `pythonRoutes` 处理，不重复抽取。

### D3. Python HTTP 客户端端点抽取（requests / urllib / httpx / aiohttp）

实现 `extractHttpClientCalls(clean, lineStarts)`：
- 4 个 lib 共 11+ 模式：
  - `requests.get/post/put/patch/delete/head/options/request` 7 种
  - `urllib.request.urlopen/Request` 2 种
  - `httpx.*` 7 种
  - `aiohttp.{session,client,Session,ClientSession}.*` 7 种
- 抽取 7 字段：`lib / method / url / urlRaw / hasAuth / hasJson / hasData / line`
- `findMatchingParen` 跨行括号匹配
- 同 (lib, method, url) 去重（`if/else` 双分支模式自动合并）

iDRAC `CreateVirtualDiskREDFISH.py` 调用 51 处 → 18 unique URL（去重后）；全仓库累计约 2000+ unique outbound HTTP endpoint。

未来改进（v0.41+ 候选）：与 `NetworkEndpoint` 实体深度整合 —— 把 Python 客户端调用作为 outbound 边与 TypeScript / Go 服务的 `NetworkEndpoint`（来自 server-side handler）双向建边，构成完整 RPC 链。

### D4. PowerShell Verb-Noun 抽取

v0.38.0 已有 `PS_VERB_TO_ROLE` 映射（Get→read / Set→write / Invoke→exec / ...）。在 `PsFunction` fact 上增加：
- `verbNoun: { verb, noun }` —— 显式分离动词与名词
- `crossLangKey: noun` —— 用于跨语言匹配

iDRAC `Get-IdracLifecycleLogsREDFISH` → `verbNoun: { verb: 'Get', noun: 'IdracLifecycleLogsREDFISH' }`，120/120 函数全部识别。

Verb 集合的覆盖参考 PowerShell 官方 Approved Verbs（Get / Set / New / Remove / Reset / Add / Update / Start / Stop / Restart / Mount / Dismount / Push / Pop / ...），用正则一次性穷举。

### D5. 跨语言脚本匹配（crossLangMatches 边）

iDRAC 命名规律：
- Python：`GetIdracLifecycleLogsREDFISH.py`（文件基名以 PS Verb 开头）
- PowerShell：`Get-IdracLifecycleLogsREDFISH`（函数名用 `Verb-Noun` 形态）
- 共享工作流语义但跨语言

匹配键归一化：
- **Python 端**：取文件基名（去 .py），用 `PS_VERB_PREFIXES` 正则去除前缀动词（与 D4 同源）
- **PowerShell 端**：用 `noun` 部分（即 D4 已抽取的 `crossLangKey`）

匹配结果写入 `_meta.crossLangEdges: [{ from: SourceFile(py).id, to: PsFunction.id, key, py, ps, unresolved? }]`，未匹配的 Python 端记 `unresolved: true` 供 agent 后续补全。

iDRAC 实测 158 候选匹配 → 36 命中 + 122 unresolved。unresolved 来源：
- Python 单方实现（如 `BootToNetworkIsoOsdREDFISH.py` 仅有 Python 版）
- PowerShell 共享模块 `IdracRedfishSupport.psm1` 函数（被多脚本 import，无独立 Python 对应）
- 命名不规则（如 `Get-ImportServerConfigurationProfilePreviewREDFISH` 中 `Get-Import` 双动词误判）

### D6. 混合脚本架构层

`inferFileArchLayer` 新增 2 条规则：
- `*.py` 下 `/redfish|sdk|api|client/...` 目录 → `integration`
- `*.ps1 / *.psm1` 同理 → `integration`
- PS Verb 前缀粗判（file 基名）：`Set-* / New-* / Add-*` → `write` 层；其余 → `shared`

iDRAC `Redfish Python/` 与 `Redfish PowerShell/` 整目录归为 `integration`（API 客户端 / SDK 工具语义层），与既有 `services/` → `service` / `models/` → `service` / `repositories/` → `integration` 一致。

### D7. 本体类型扩展

仅 `LINK_TYPES` 54 → 55（+ `crossLangMatches`）：
- `crossLangMatches`：SourceFile(py) ↔ PsFunction（也兼容 SourceFile(ps)）的同名工作流多语言实现
- `OBJECT_TYPES` 38 不变（复用 SourceFile / PsFunction）

## 影响

### 数据形态变更

- `facts.pythonCliParams: []`：新增（默认空数组）
- `facts.httpClientCalls: []`：新增（默认空数组）
- `facts.crossLangKey: string | null`：新增
- `facts.functions[].verbNoun / crossLangKey`：PowerShell 函数新增
- `dataMap._meta.crossLangEdges: []`：新增
- `Project.pyFileCount`（v0.36 已存在）/`pyDetected`（v0.39 已存在）：不变

### 性能影响

- `extractCliParams`：O(行数) 单次扫描
- `extractHttpClientCalls`：O(body 长度 × 11) 但每个 regex 命中后只跑一次括号匹配
- `readTextWithBom`：O(文件大小) 单次 IO
- 全量 iDRAC 扫描（225 文件 200k+ 行）：从 ~3.5s → ~4.1s（+17%）

### 向后兼容保证

- 既有 `facts.imports` / `facts.callEdges` / `facts.pythonRoutes` 零变化
- 既有 PowerShell 字段（`function.role` / `function.cmdletCount` / `function.cliParamNames`）零变化
- `dataMap._meta.shellEdges` / `_meta.rosEdges` 零变化
- `Project.pyFileCount` / `pyDetected` 零变化

## 已锁定决策

- D1 PowerShell UTF-16 BOM 探测（必做）
- D2 argparse CLI 参数抽取（必做）
- D3 Python HTTP 客户端抽取（必做）
- D4 PowerShell Verb-Noun 抽取（必做）
- D5 跨语言脚本匹配 + crossLangMatches 边（必做）
- D6 混合脚本架构层（必做）
- D7 本体扩展 +1 边（必做）

## 不做（v0.40.0 范围外）

- HTTP 客户端 ↔ 服务端 NetworkEndpoint 双向 RPC 链 —— 需前后端协同分析，v0.41+ 候选
- HTTP 客户端 URL 的 host 归一化（`%s/redfish/v1/...` 占位符展开为 iDRAC IP）—— 需 resolve `idrac_ip` 变量值（来自 CLI 参数或 input()），v0.41+ 候选
- argparse subparser（`parser.add_subparsers()`）分层抽取 —— 多数 Python CLI 工具用 Click 而非 argparse subparser，价值有限
- PowerShell DSC（Desired State Configuration）资源抽取 —— iDRAC 不使用 DSC
- Python `global` 关键字追踪 —— 状态流分析价值低，v0.42+ 评估
- Python `*` import 解析增强 —— 多数 Python 模块走 `from X import name` 显式导入，`import *` 主要用于兼容老代码

## 后续候选（v0.41+）

1. **HTTP 客户端 ↔ NetworkEndpoint 双向链** —— Python 客户端调用作为 outbound 边 ↔ TS/Go 服务端 handler，构成完整 RPC 拓扑
2. **CLI 参数 yaml 配置文件追踪** —— 多数 iDRAC 类工具支持 `config.yaml` 覆盖 CLI 默认值，扫描 yaml 把默认值与 CLI 显式值合并
3. **跨语言 API 表面 diff** —— 比对 Python / PowerShell / Go 三端同名 endpoint 的 CLI 参数 / return value / error code 差异（CI 用途）
4. **PowerShell DSC 资源抽取** —— 通用需求
5. **Python `asyncio` / `await` 链路补全** —— asyncio.create_task / gather 内的调用追踪
6. **统一 NetworkEndpoint 实体升级** —— 当前 `NetworkEndpoint` 仅从 TS/JS `fetch / axios` 服务端 handler 抽取；扩展 inbound 边使其也包含 outbound 客户端 URL

## 参考

- iDRAC-Redfish-Scripting 仓库（[github.com/dell/iDRAC-Redfish-Scripting](https://github.com/dell/iDRAC-Redfish-Scripting)）：触发本 ADR 的真实测试输入
- 抽样验证：`/tmp/idrac-e2e/.nice-aos/data/snapshot.json` — 225 文件 → 120 PsFunction + 36 crossLangMatches
- blueprint.js v0.40.0 OBJECT_TYPES 38 / LINK_TYPES 55
- PowerShell Approved Verbs 列表（[docs.microsoft.com/en-us/powershell/scripting/developer/cmdlet/approved-verbs-for-windows-powershell-commands](https://docs.microsoft.com/en-us/powershell/scripting/developer/cmdlet/approved-verbs-for-windows-powershell-commands)）
