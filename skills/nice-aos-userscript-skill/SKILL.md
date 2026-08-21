---
name: nice-aos-userscript
description: |
  Nice AOS 油猴脚本审计 Skill（Nice Anterior Ontology Service — UserScript Audit）：
  针对 Tampermonkey / Greasemonkey UserScript 的安全审计与行为理解工作流，
  基于 nice-aos CLI 的油猴独立分析链（userScriptAnalyzer），
  产出 UserScript（元数据+行为画像+riskLevel/risks 风险清单）、GmApiUsage（GM API 调用与 @grant 交叉比对）、
  InjectionPoint（DOM 注入点+归属函数+interpolated 插值标记）、NetworkEndpoint（网络端点与 @connect 白名单比对）、
  ScriptFunction（函数调用图 calls/calledBy + deadCandidate 死函数）五类对象。
  两种工作模式：单文件模式（action analyzeFile，不落盘，独立脚本零快照开销，stdout JSON 可与 jq/findstr 管道组合）
  与仓库模式（refreshRepo 全量快照 + query/link 毫秒级查询）。
  审计五步：脚本清单 → GM API 越权（declared=false）→ @connect 白名单核对（allowedByConnect=false）→
  XSS 面（InjectionPoint.interpolated=true）→ 风险分级定位（riskLevel/risks）→ 函数调用图下钻。
  固化实战修复模板：缺失 @connect 声明补齐（GM_xmlhttpRequest 目标域名必须全部声明）、
  innerHTML 动态插值必须 escHtml 转义（外部数据不可信）。
  触发：用户说"分析这个油猴脚本 / 脚本用了哪些 GM API / 这个 GM 调用有没有 @grant 声明 /
  脚本往页面注入了什么 DOM / 哪里有 XSS 风险 / 脚本请求了哪些域名 / @connect 白名单齐不齐 /
  有没有请求劫持 / eval / unsafeWindow / cookie 读写 / 这个脚本安全吗 / 油猴脚本安全审计 /
  脚本函数调用图 / 谁调用了这个函数 / 单独分析这个 .user.js 文件"，
  或拿到一个独立 UserScript 文件（不属于任何仓库）需要快速体检时。
  英文触发词：userscript audit, GM API usage, @grant check, @connect whitelist,
  DOM injection points, XSS surface, network endpoints, hijack detection, script function call graph,
  analyze single userscript file, tampermonkey script review。
  不做：通用项目结构查询（用 nice-aos skill）、死代码专项清理（用 nice-aos-deadcode skill，
  本 Skill 仅在审计报告附带 deadFunctionCount/deadCandidate 供参考）、
  代码生成 / 运行脚本 / ESLint（用专用工具）。
---

# Nice AOS Userscript Skill — 油猴脚本安全审计

> 基于 nice-aos CLI 的油猴独立分析链（userScriptAnalyzer），
> 把"通读几千行脚本源码"降级为"结构化本体查询 + 五步审计清单"。
> **分工**：本 Skill 承载油猴审计工作流；通用查询/快照/影响分析/蓝图导出见 `nice-aos` skill；
> 死代码专项清理见 `nice-aos-deadcode` skill。三者共享同一份 CLI 与快照。

## 概述

油猴脚本与 React/Vue 组件体系并存、逻辑独立：脚本不产出 Component/Store，而是 UserScript + 4 类子对象（GmApiUsage / InjectionPoint / NetworkEndpoint / ScriptFunction）。本 Skill 编排审计工作流；CLI 只提供原子查询能力。

**两种模式**：

| 模式 | 适用 | 快照 | 入口 |
|------|------|------|------|
| **单文件模式** | 独立脚本文件（不属于仓库 / 无需全量快照），如单个 `.user.js` 或带 `==UserScript==` 头的 `.js` | 不落盘，stdout 直接输出 JSON | `action analyzeFile` |
| **仓库模式** | 脚本仓库（如数百个脚本的纯油猴仓库）或混合项目（React/Vue + 脚本） | `.nice-aos/data/snapshot.json` | `action refreshRepo` + `query/link` |

## 前置条件

- Node.js 18+
- CLI 获取（二选一）：
  - **仓库内源码**：`node <REPO_ROOT>/nice-aos/src/cli/index.js`（`nice-aos/node_modules` 缺失时先 `cd nice-aos && npm install`）；版本跟随 git，无需 npm 版本检测
  - **npm 包**：`nice-aos`（全局安装）或 `npx nice-aos`
- **版本检测（npm 包方式必须）**：agent 首次调用前先执行 `nice-aos update --check` 确认最新版（旧版缺失 GM 审计/风险分级等新能力）：
  ```bash
  nice-aos update --check   # 输出 JSON：current / latest / upToDate / installMode
  nice-aos update           # upToDate=false 且 installMode=global 时一键升级
  ```
  - `installMode=npx/local/repo` 时无法自动升级，按输出中的 `upgradeCommand` 指引处理
  - `update` 命令不存在 → 版本过旧（< 0.10.0），先执行一次 `npm install -g nice-aos@latest`
  - 网络不可达时 `--check` 返回 `ok:false`（带 current 版本号），跳过升级继续用当前版本，不要阻塞主流程

快照目录约定 `<REPO_ROOT>/.nice-aos/data`（CLI 默认回退链第一候选）；仓库根目录执行命令无需 `--snapshot-dir`。**单文件模式无需快照**。

## 单文件模式（独立脚本体检）

```bash
NICE_AOS="node <path>/nice-aos/src/cli/index.js"   # 或 nice-aos / npx nice-aos

# 全量本体 JSON（_meta.mode === 'single-file'）
$NICE_AOS action analyzeFile --params '{"file":"Steam-License-Classifier.js"}'

# 油猴文件输出形状：
# { _meta: {mode:'single-file', file, objectCounts}, SourceFile: [1条],
#   UserScript: [1条 元数据+画像+risks], GmApiUsage: [...], InjectionPoint: [...],
#   NetworkEndpoint: [...], ScriptFunction: [...含 deadCandidate] }
# （非油猴文件走 tsAnalyzer 链，输出 Interface/Class/Method，见 nice-aos-deadcode skill）
```

**jq 管道速查**（stdout JSON 可直接管道）：

```bash
$AOS action analyzeFile --params '{"file":"x.user.js"}' | jq '{name:.UserScript[0].name, riskLevel:.UserScript[0].riskLevel, risks:.UserScript[0].risks}'
# 未 @grant 声明的 GM 调用（越权面）
... | jq '.GmApiUsage[] | select(.declared==false)'
# 未 @connect 声明的请求域名（运行时弹授权确认）
... | jq '.NetworkEndpoint[] | select(.allowedByConnect==false)'
# 含动态插值的 HTML 注入（XSS 面）
... | jq '.InjectionPoint[] | select(.interpolated)'
# 死函数清单（详见 nice-aos-deadcode skill）
... | jq '.ScriptFunction[] | select(.deadCandidate) | {name, line, deadReason}'
```

Windows 无 jq 时可用 `| findstr "deadCandidate"`（整行 JSON 匹配）后人工确认。

## 仓库模式（脚本仓库 / 混合项目）

```bash
# 构建快照（纯油猴仓库无需 package.json；数百个超大脚本可达数十秒，耐心等待）
$NICE_AOS action refreshRepo --params '{"repoPath":"/path/to/steam-tampermonkey-scripts"}'

# 脚本清单（元数据 + 行为画像 + 风险等级）
$NICE_AOS query UserScript --all
$NICE_AOS query UserScript --where "riskLevel=high"          # 高风险脚本
$NICE_AOS query UserScript --where "hostFramework=vue"       # 跑在 Vue 页面上的脚本
```

## 审计五步工作流

对目标脚本（`us:<相对路径>`）依次执行：

### ① 元数据与画像核对

```bash
$AOS query UserScript --where "name~license"       # 或 filePath 精确匹配
```

看 `matches`（生效页面）、`grants`/`grantNone`（授权面）、`connects`（网络白名单）、`requires`（外部依赖）、`runAt`（注入时机）、`hostFramework`（宿主框架标记）、`isIife`/`usesStrict`（代码隔离形态）。

### ② GM API 越权审计（@grant 比对）

```bash
$AOS query GmApiUsage --where "declared=false"                      # 仓库级：全部越权调用
$AOS link usesGmApi --src "us:scripts/steam-inventory.user.js"      # 单脚本：用了哪些 GM API
$AOS link usesGmApi --src "gm:scripts/x.user.js#GM_xmlhttpRequest"  # 反查该 API 使用所属脚本
```

`declared=false` 表示调用了未在 `@grant` 声明的 API；`@grant none` 下调用 GM API 记为风险 `gm-api-without-grant`。

### ③ @connect 白名单核对

```bash
$AOS query NetworkEndpoint --where "allowedByConnect=false"    # GM 请求域名未在 @connect 声明
$AOS link requestsTo --src "us:scripts/x.user.js"              # 单脚本：请求了哪些域名
```

`allowedByConnect=false`（静态域名且未声明）→ 运行时弹授权确认，属缺陷；`(dynamic)` 域名不参与比对（`allowedByConnect=null`）。

### ④ XSS 面定位（DOM 注入）

```bash
$AOS query InjectionPoint --where "interpolated=true"          # 含动态插值的 HTML 注入
$AOS query InjectionPoint --where "kind=inner-html"
$AOS link injectsInto --src "us:scripts/x.user.js"             # 单脚本：注入了什么
```

`interpolated=true` 表示 innerHTML/insertAdjacentHTML/document.write 的模板串中含 `${...}` 或 `+ 变量` 拼接 → 需逐处确认插值来源是否可信（网络响应 / localStorage / URL 参数等外部数据必须转义）。

### ⑤ 风险清单与函数下钻

```bash
$AOS query UserScript --where "riskLevel=high"    # 逐个看 risks 数组（按 severity 排序）
$AOS link contains --src "us:scripts/x.user.js"   # 全部子对象（函数/GM/注入/端点）
$AOS link calls --src "fn:scripts/x.user.js#renderOverview"      # 函数调用了谁
$AOS link calledBy --src "fn:scripts/x.user.js#fetchPrice"       # 谁调用了它（修改影响面）
```

**风险类型全集**（`risks[]` 数组，severity 排序 high > medium > low）：

| kind | severity | 含义 |
|------|----------|------|
| `hijack-fetch` / `hijack-xhr` / `hijack-eventtarget` / `hijack-websocket` / `hijack-history` | high | 重写宿主页面 fetch/XHR/EventTarget/WebSocket/history |
| `eval-usage` | high | eval / new Function 动态代码执行 |
| `cookie-write` | high | 写入 document.cookie |
| `cookie-read` | medium | 读取 document.cookie |
| `unsafe-window-write` | medium | 向宿主页面写全局变量（unsafeWindow.xxx = …） |
| `unsafe-window-read` | low | 读取宿主页面全局变量 |
| `html-injection` | medium | HTML 注入含动态插值（潜在 XSS 面，需确认已转义） |
| `undeclared-gm-api` | medium | GM API 未在 @grant 声明 |
| `unlisted-connect-domain` | medium | GM 请求域名未在 @connect 声明（运行时弹授权确认） |
| `gm-api-without-grant` | low | @grant none 下调用 GM API |
| `window-define` | low | Object.defineProperty(window, ...) |

## 修复建议模板（实战固化）

**模板 A — 缺失 @connect 声明**（`unlisted-connect-domain` / `allowedByConnect=false`）：

GM_xmlhttpRequest 实际请求过的**每个**域名（含子域，按需用 `*.example.com`）都必须在元数据块声明，否则运行时逐域弹授权确认：

```js
// ==UserScript==
// ...
// @connect store.steampowered.com
// @connect api.example.com
// ==/UserScript==
```

核对方式：`NetworkEndpoint[].domain` 全集 × 现有 `connects` 白名单 → 差集即需补声明项。

**模板 B — innerHTML 插值 XSS**（`html-injection` / `interpolated=true`）：

外部数据（网络响应 JSON 字段、localStorage、URL 参数、页面 DOM 抓取值）拼进 innerHTML / insertAdjacentHTML 前必须转义：

```js
const escHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 注入处：app.name 等外部字段一律包裹
container.innerHTML = `<div class="name">${escHtml(app.name)}</div>`;
```

**模板 C — GM API 越权**（`undeclared-gm-api`）：在元数据块补对应 `@grant`（如 `// @grant GM_setValue`）；`@grant none` 脚本确需 GM API 时改回显式 grant 列表。

**模板 D — 请求劫持/eval（hijack-* / eval-usage）**：多为功能性设计（如拦截请求重写响应），审计结论按"是否必要 + 是否可最小化"给建议，不直接判错。

## 交付物建议

- **审计报告**：脚本清单表（riskLevel 分级）→ 高危项明细（kind/line/detail）→ 修复建议（引用上述模板）→ 复核结论
- **给人看**：`export --format markdown --output report.md`（自动含安全风险清单、GM API 使用、DOM 注入点、网络请求与请求劫持、脚本函数 Top 30 共 6 节）；`export --format html`（脚本蓝图页：函数调用 SVG 图 + 注入锚点 + 网络端点，一图直读注入链）
- **回写结论**：`action markReviewed --params '{"objectId":"us:<path>"}'`（GmApiUsage/InjectionPoint 等子对象同样支持，跨会话保留）

## Agent 行为规范

| 场景 | 行为 |
|------|------|
| 用户给单个脚本文件（不在仓库内） | 直接 `action analyzeFile`，无需建快照 |
| 用户问脚本安全/风险/越权 | 走审计五步工作流，先看 `risks`/`riskLevel` 再逐项下钻 |
| `declared=false` / `allowedByConnect=false` 命中 | 优先按模板 A/B/C 给修复建议，注明"缺 @connect 运行时会弹授权确认"这类后果 |
| 用户问函数级问题（谁调用了 X / X 调用了谁） | `link calls/calledBy`，不要通读源码 |
| 快照不存在 | 提示后直接 `action refreshRepo`（无需用户确认） |
| 用户要死函数清单 | 本 Skill 可给 `deadFunctionCount`/`deadCandidate` 概览，专项清理流程切换到 `nice-aos-deadcode` skill |
| 审计完成后 | `action markReviewed` 回写审计结论 |

## 技术限制

- 脚本识别为启发式：`.user.js` 扩展名，或 `.js` 文件头部 4KB 内含 `==UserScript==` 元数据块（元数据块须在文件头部 8KB 内）；无元数据块的普通 .js 不会误判
- 动态拼接的 URL/域名记为 `(dynamic)` 且不做 @connect 比对（`allowedByConnect=null`）
- querySelector 变量锚点同名时取全文最后声明；`unsafeWindow.xxx = window.xxx` 全局暴露按赋值左侧文本匹配
- 宿主框架仅按 `__vue__`/`__reactContainer$` 等运行时标记推断（并存时 mixed，无标记 unknown）
- 函数调用图只覆盖静态可解析的名字调用（`obj['method']()` 可记，动态变量调用不记）；对象方法归属到声明它的顶层对象；同文件同名函数 ID 追加 `@2`/`@3` 后缀（如 `fn:path#init@2`）
- 语法级解析（TypeScript Compiler API），不做类型检查与运行时验证；`interpolated=true` 是"潜在 XSS 面"提示，是否成立需人工确认插值来源
