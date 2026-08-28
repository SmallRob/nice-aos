# 更新日志

本项目的所有重要变更均记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.40.0] - 2026-08-29

### 多语言脚本架构增强 —— argparse / HTTP 客户端 / UTF-16 PowerShell / 跨语言同步

iDRAC-Redfish-Scripting（[github.com/dell/iDRAC-Redfish-Scripting](https://github.com/dell/iDRAC-Redfish-Scripting)，
146 .py + 79 .ps + 1 .psm1 共 200k+ 行）扫描驱动。Dell 的 Redfish API 脚本仓库跨 Python+PowerShell 双实现，是
混合脚本架构的典型场景。详见 `docs/adr/0008-idrac-multilang-scripts.md`。

#### 修复 PowerShell UTF-16 BOM 探测（数据质量 bug）

- iDRAC 79 个 PowerShell 文件全部 UTF-16 LE + BOM + CRLF，原 `fs.readFileSync(..., 'utf-8')` 直接读为乱码
- 修：新增 `readTextWithBom()` —— 头 2 字节 `0xFF 0xFE` → UTF-16 LE；头 3 字节 `0xEF 0xBB 0xBF` → UTF-8 BOM；其余 utf-8
- 修后 Invoke-CreateVirtualDiskREDFISH.psm1（55k 行 IdracRedfishSupport.psm1 同理）正确解析为 PowerShell，含 21 个 CLI 参数 + 1 个函数 + 真实 cmdlet 列表

#### 新增 argparse CLI 参数抽取（与 Bash/PS 的 cliParams 同构）

- 模式：`<var>.add_argument('-ip', help='...', required=False, dest='ip', type=int, default=0, action='store_true')`
- 抽取每个参数的 `flag / short / long / name / positional / type / required / default / action / help / line`
- flag 形式：`-ip` / `--ip` / `-ip, --ip-address` / `fqdd`（位置参数）
- name 解析：`dest` 优先 → 长写去 `--` → 短写去 `-`，并把 `-` 归 `_`（kebab→snake）
- 适用：iDRAC 单脚本平均 5-20 个 add_argument，整仓库累计数千 CLI 表面

#### 新增 Python HTTP 客户端端点抽取（requests / urllib / httpx / aiohttp）

- 4 个 lib 共 7+ 模式：`requests.get/post/patch/put/delete/head/options` + `urllib.request.urlopen/Request` + `httpx.*` + `aiohttp.{session,client}.*`
- 抽取 `lib / method / url / hasAuth / hasJson / hasData / line`
- 跨 if/else 自动去重（同一 lib+method+url 只记首次），避免 if/else 双分支模式产生双倍条目
- 适用：iDRAC 单脚本 51 个 calls（旧版 0 抽取）→ 18 unique；未来可接 NetworkEndpoint 实体补 outbound 边

#### 新增 PowerShell Verb-Noun 抽取

- 已有 Verb → role 映射（Get→read / Set→write / Invoke→exec / ...）增强：在 `PsFunction` 上加 `verbNoun: { verb, noun }` 与 `crossLangKey` 字段
- 适用：iDRAC `Get-IdracLifecycleLogsREDFISH` → verb=`Get` noun=`IdracLifecycleLogsREDFISH` crossLangKey=`IdracLifecycleLogsREDFISH`（120/120 函数全部识别）

#### 新增跨语言脚本匹配 + 边

- 匹配键归一化：Python `GetIdracLifecycleLogsREDFISH.py` ↔ PowerShell `Get-IdracLifecycleLogsREDFISH`
  - Python 端：去除 `Get / Set / Invoke / New / Remove / Reset / Add / Update / Delete / Enable / Disable / Test / Start / Stop / Restart / Mount / Dismount / Push / Pop / Register / Unregister / Show / Hide / Open / Close / Format / Out / Copy / Move / Rename / Convert / Import / Export / Connect / Disconnect / Read / Write / Send / Receive / Wait / Resolve / Use / Save / Backup / Restore / Sync / Trace / Assert` 47 个 PS Verb 前缀
  - PowerShell 端：用 Noun 部分（去 `Verb-` 前缀）
- 匹配后建 `_meta.crossLangEdges: [{ from, to, key, py, ps, unresolved? }]`
- iDRAC 实测：158 候选匹配中 36 命中 + 122 unresolved（unresolved 是 Python 单方实现或 PS 共享模块函数）

#### 混合脚本架构层

- `*.py` 下 `/redfish|sdk|api|client/...` 目录 → `integration`（API 客户端 / SDK 工具）
- `*.ps1 / *.psm1` 同理 → `integration`
- PS Verb 前缀粗判：`Set-* / New-* / Add-*` → `write` 层；其余 → `shared`

#### 项目级

- `Project.language` 现在拼接 `Python + PowerShell`（iDRAC 端到端验证）
- `Project.pyFileCount` 已在 v0.36 暴露，iDRAC 端 146；`pyDetected` 同步

#### 本体类型扩展

- `LINK_TYPES` 54 → 55：新增 `crossLangMatches`（SourceFile(py) ↔ SourceFile(ps) / PsFunction：同名工作流的多语言实现）
- `OBJECT_TYPES` 不变（38 个；复用 SourceFile / PsFunction）

### 测试

- `test/pythonAnalyzer.test.mjs` 新增 3 用例：
  - argparse CLI 参数抽取（短/长/dest/required/action/位置参数）
  - HTTP 客户端调用抽取（4 lib + dedupe + hasAuth/hasJson 标志）
  - crossLangKey 从 relPath 派生（去 .py + 含深层路径）
- `test/blueprintEngine.test.mjs` / `test/toolRegistry.test.mjs` 同步更新：`LINK_TYPES 54 → 55`
- 全套测试 831/831 通过（+3 新增；原 828 全保留零修改）

### 端到端验证（iDRAC-Redfish-Scripting）

| 维度 | 数量 |
| --- | --- |
| 文件总数 | 225 |
| Python 源文件 | 146 |
| PowerShell 脚本 | 79（PsScript） |
| PowerShell 函数 | 120（PsFunction，120/120 含 verbNoun） |
| Cmdlet 调用 | 763 |
| crossLangEdges | 158（36 命中 + 122 unresolved） |
| language | `Python + PowerShell` |

## [0.39.0] - 2026-08-29

### Python 解析增强：ROS 2 维度 + 字段误报修复 + 入口点扩充

openamr-platform-sw（65 个 .py + 14 个 .launch.py，ROS 2 rclpy + launch 真实生产项目）扫描驱动。详见 `docs/adr/0007-ros2-python-enhancement.md`。

#### 修复 parseClassFields 缩进感知（数据质量 bug）

- 旧版 `parseClassFields` 用跨行续行 + 字符串扫描两步法，但**不感知方法体 / 复合语句边界**，把方法体内的局部变量误判为类字段
- 真实复现：openamr `dock_trigger.py`（70 个方法、0 个真类级字段）旧版一度报 **341 个伪字段**（`cli` / `colmon` / `topic` / `req` / `future` / `t0` / `out` / `ranges` / ...）
- 修复：引入轻量 `blockStack`（`def / class / compound / pending`）—— 遇 `def / async def / class` 与 `if/elif/else/try/except/finally/with/for/while/match/case` 入栈，按缩进比较弹栈；**仅当 blockStack 为空时**才认为该语句在类直接体（class-body level）才走字段匹配
- 修复后：dock_trigger.py 字段从 341 → 0（真实），旧 17 个 pythonAnalyzer 单测零修改全部通过

#### 新增 ROS 2 节点类检测（rclpy Node / LifecycleNode / ComposableNode）

- `class X(Node)` / `class X(LifecycleNode)` / `class X(ComposableNode)` → 末段基类查表 → `cls.ormHints` 追加 `ros2-node` / `ros2-lifecycle-node` / `ros2-composable-node`
- 附加抽取 `super().__init__('node_name')` → `ormHints` 追加 `ros2-node-name:<name>`
- 非侵入：保留 `cls.bases` / `cls.extendsName` 形态，仅追加 `cls.rosHint` 字段与 `cls.ormHints` 元素
- 新增 `facts.ros2NodeClasses` 顶层索引（`[{ name, line, baseClass, bases, rosHint, channels, pos }]`）

#### 新增 ROS 2 通信通道抽取（publisher/subscriber/service/client/timer/action/parameter）

- 在 class body 整体（已剥离字符串的 cleanBody 通道）扫描 7 类模式：

  | pat.kind        | 来源模式                                              | 抽取参数                          |
  | --------------- | ----------------------------------------------------- | --------------------------------- |
  | `publisher`     | `self.create_publisher(Msg, topic, qos)`              | msgType / topic / qos             |
  | `subscription`  | `self.create_subscription(Msg, topic, cb, qos)`       | msgType / topic / callback / qos  |
  | `service`       | `self.create_service(Srv, name, cb)`                  | srvType / name / callback         |
  | `client`        | `self.create_client(Srv, name)`                       | srvType / name                    |
  | `timer`         | `self.create_timer(period, cb)`                       | period / callback                 |
  | `action-server` | `self.create_action_server(...)`                      | actionType / name / callback      |
  | `action-client` | `ActionClient(node, Action, name)`                    | actionType / name                 |
  | `parameter`     | `self.declare_parameter(name, default)`               | name / default                    |

- 括号深度匹配（`findMatchingParen`）兼容嵌套泛型 / 缺省 lambda；callback 保留原文本（不静态解析符号引用）
- topic / parameter default 不做值回填（保留符号化文本如 `topic: scan_in`）—— v0.40+ 候选

#### 新增 ROS 2 launch 文件检测（*.launch.py）

- 入口函数识别：`def generate_launch_description():`（兼容 `generate_launch_file`）
- 顶层抽取 5 类 launch 动作：
  - `Node(package=..., executable=..., name=..., namespace=...)` → 节点清单
  - `ExecuteProcess(cmd=...)` → 外部进程清单
  - `DeclareLaunchArgument(name=..., default_value=..., description=...)` → 启动参数清单
  - `IncludeLaunchDescription(PythonLaunchDescriptionSource(...))` → 嵌套 launch 清单
  - `GroupAction / OpaqueFunction / SetEnvironmentVariable / TimerAction / ComposableNodeContainer / ...` → 其它 actions
- 入口函数加入 `facts.pythonEntryPoints` 作为 `kind: 'launch'`
- launch 文件无通道抽取（launch 是组合描述，不直接持有 Node 状态）

#### 新增 def main() 入口点

- 顶层 `def main():`（无参数、无装饰器）→ entry point `kind: 'main'`
- 若已有 `if __name__ == "__main__": main()` 守卫 → 不重复添加
- 适用场景：ROS 2 `def main(): rclpy.init(); rclpy.spin(node)` 这类无守卫入口

#### 项目级维度扩充

- `Project.pyLaunchFileCount`：后缀 `.launch.py` 文件数（O(N) 文件名过滤）
- `Project.pyNodeClassCount`：实际解析得到的 ROS 2 节点类数（builder 阶段聚合）
- `Project.pyDetected`：与 `kotlinDetected` / `phpDetected` 对齐的 boolean 标识
- `Project.language` 在 ROS 2 launch 文件存在时追加 `+ROS2Launch` 标记

#### Python 架构层语义扩充（`inferFileArchLayer`）

- `*.launch.py` → `deployment`（部署编排）
- `*/<pkg>/routers/...` / `routes/...` / `controllers/...` / `api/...` / `views/...` / `endpoints/...` → `presentation`
- `*/<pkg>/services/...` / `use_cases/...` / `domain/...` / `biz/...` → `service`
- `*/<pkg>/models/...` / `schemas/...` / `entities/...` / `dto/...` → `service`
- `*/<pkg>/repositories/...` / `dal/...` / `dao/...` / `infra/...` / `adapters/...` / `gateways/...` → `integration`
- ROS 2 节点惯例：`*/scripts/...` 或 `*_node.py` → `service`

#### 本体类型扩展

- `OBJECT_TYPES` 35 → 38：新增 `RosNode`（`rosnode:`，CodeUnit/L1）、`RosChannel`（`roschan:`，CodeUnit/L1）、`RosLaunch`（`roslaunch:`，EntryPoint/L2）
- `LINK_TYPES` 49 → 54：新增 `declaresChannel`（RosNode → RosChannel）、`launchesNode`（RosLaunch → RosNode，含 unresolved 标记）、`launchesLaunch`（RosLaunch → RosLaunch，IncludeLaunch 嵌套）、`declaresLaunchArg` / `executesProcess`（预留）
- `ONTOLOGY_META.abstractionLevels` / `categories` 同步登记
- `_meta.rosEdges` 边集合导出

#### 真实项目端到端验证（openamr-platform-sw）

| 维度                | 数量 |
| ------------------- | ---- |
| Python 源文件       | 65   |
| ROS 2 launch 文件   | 14   |
| RosNode 节点类      | 16   |
| RosChannel 通道     | 150  |
| 　　publisher       | 14   |
| 　　subscription    | 29   |
| 　　service         | 1    |
| 　　client          | 4    |
| 　　timer           | 4    |
| 　　action          | 2    |
| 　　parameter       | 96   |
| RosLaunch launch    | 14   |
| declaresChannel 边  | 150  |
| launchesNode 边     | 18（全 unresolved —— launch 启动的多为第三方包节点如 rplidar_ros，本仓库无对应类） |
| launchesLaunch 边   | 5    |

### 测试

- `test/pythonAnalyzer.test.mjs` 新增 9 用例：
  - parseClassFields 缩进感知（局部变量不再误报）
  - ROS 2 Node 类基类识别（Node / LifecycleNode / ComposableNode）
  - ROS 2 通信通道抽取（pub/sub/service/client/timer/parameter 七通道）
  - launch 文件 Node/Argument/Process/Include 抽取
  - IncludeLaunchDescription 嵌套
  - 非 launch 文件 `pythonLaunch: null` 兜底
  - def main() 入口点
  - def main() 与 `__main__` 守卫并存去重
  - 带参数 / 装饰器的 main 不误报
- `test/blueprintEngine.test.mjs` 同步更新：`OBJECT_TYPES 35 → 38` / `LINK_TYPES 49 → 54`
- `test/toolRegistry.test.mjs` 同步更新：get_schema / list_types 计数
- 全套测试 828/828 通过（+9 新增；原 819 全保留零修改）

## [0.38.0] - 2026-08-28

### 新增 `output docs`：分层上下文文档树（context-builder skill 的 CLI 支撑）

- `nice-aos output docs` 把本体快照渲染为「三明治结构」md 文档树到 `.nice-aos/context/`：L1 `index.md`（顶层索引，<2KB：定位/技术栈/架构分层占比/功能域 Top10）、汇总层 `architecture.md`（语义分层/健康度/循环依赖/依赖 Top）与 `modules.md`（模块地图按 archLayer 分组）、L2 `domains/<slug>.md`（领域索引，<1KB：画像 + 子模块 Top5 + 单元构成 + L3 链接）、L3 `domains/<slug>/{components,routes,state,services}.md`（<5KB/文件：组件/路由/Store+Hook/Service+接口+类清单，接口类按领域 fileIds 圈定）
- 粒度预算由生成器保证：成员清单 TopN 截断 + "仅列出前 N，共 X"注明；仅非空内容生成；无 Domain 仓库/纯脚本仓库自动降级
- 每个 md 带轻 frontmatter（title/layer/generated）；slug 保留 CJK（`slugify`：非字母数字折叠 `-`，同名领域追加序号去重）
- `tree.json` 目录树索引（借鉴 display-web knowledge-graph 的"离线索引 + 按需 fetch"模式；path 统一相对 context 根，规避其前缀不一致 bug）
- 选项：`--format all|md`（默认 all = md 树 + tree.json + docs.html；md 为纯 agent 模式）、`--output <dir>`（默认 `.nice-aos/context`）；注意 commander 限制——子命令与父命令（export）同名选项时传参落在父命令 opts，docs action 从两级 opts 取有效值
- 写盘后 `notifyServe` 广播 `docs:changed`（与 export 主命令一致，serve 运行中才生效）
- 生成逻辑为纯函数 `src/ontology/contextDocs.js`（`buildContextDocs`/`buildTree`/`slugify` 可直接单测；千文件级项目实测约 40ms）

### 新增 serve `/docs` 在线文档浏览

- `GET /docs` → 302 `/docs/`（自包含 docs.html 浏览器：左侧目录树侧边栏 + 搜索 + 正文 md 渲染 + frontmatter 徽章卡 + 右侧 TOC scroll-spy + 站内 .md 链接无刷新跳转 + `?doc=` 可分享链接 + 暗色主题 + 移动端抽屉侧栏；借鉴 display-web doc-viewer，md 解析器强化表格对齐/嵌套列表/任务列表/代码围栏）
- `GET /docs/<path>` 与 `GET /context/<path>`：文档目录静态服务（.md → text/markdown、.json → application/json），逐段 decodeURIComponent + resolve 前缀校验双重路径穿越防护（段级 `..` 400、越界 403）
- 新选项 `serve --docs-dir <path>`（默认 `<root>/.nice-aos/context`）；`/docs`、`/docs/`、`/context/` 前缀与 blueprint.html 同为公共静态端点（豁免 Bearer 鉴权）
- `respond()` 支持透传自定义响应头（Location 等）；首页就绪表与 `/api/status`（`docs` 字段）同步；`serveOpenApi.ENDPOINTS` 登记 `/docs` 与 `/context/{path}`（/api/status 端点清单与 openapi.json 自动派生）
- 生成器 `src/ontology/docsViewer.js`（`renderDocsHtml` 零依赖；内置 `window.__docsParser` 测试钩子供 Node 直测 md 解析器）

### skill 与文档

- `skills/nice-aos-context-builder/`：README.md 从 ASDM Toolset 设计稿重写为通用代码上下文生成 skill 文档（三明治架构/粒度黄金数字理念保留，落点改为 nice-aos 快照 + output docs 闭环）；新增 SKILL.md（npm files 已含 `skills/**/SKILL.md`，可随包分发；渐进式披露阅读顺序 + agent 行为规范）
- 根 README 命令表（output/serve 行）与 export 示例区补 `output docs`；`nice-aos-skill/SKILL.md` 的 export 节与 serve 端点清单同步

### 修复

- `src/ontology/builder.js`：修复工作区未提交改动（Shell/CMake/PKGBUILD/Nix 分析器接入）三元链尾部多余括号导致的 SyntaxError（该错误使所有 CLI 命令无法启动）
- `src/analyzers/projectScanner.js`：文件遍历白名单补 `CMakeLists.txt` / `PKGBUILD`（无扩展名约定文件，与各 analyzer 候选检测严格同名）——此前这两类文件根本进不了 `scan.files`，`cmakeFiles` / `pkgbuildFiles` 恒为空，CMake / Arch 维度在全量扫描中恒为 0（单文件 analyzeFile 不受影响，故单测未暴露）
- `src/analyzers/nixAnalyzer.js`：flake `outputs.packages` 只认 `packages = { ... }` 嵌套形态，补齐更常见的属性路径形态 `packages.<system> = <expr>`（含 `let ... in { ... }`，取值域内最后一个顶层配平 attrset）与 `packages.<system>.<name> = expr`；`inputs` 同理补扁平写法 `inputs.<name>.url / inputs.<name>.flake = ...`（原只认 `inputs = { ... }` 嵌套块）；统一点路径与嵌块两分支的 `hasFlakeAttr` 语义（= 是否显式声明 flake 属性）并修 url/flake 键序导致的重复条目
- 本体元模型补登记：`ArchPackageFunction`（`archfn:`，CodeUnit/L1）与 `NixInput`（`nixin:`，Environment/L2）此前已有对象产出但未入 `OBJECT_TYPES` / `ONTOLOGY_META` 层级范畴清单（破坏"快照对象必在元模型声明"不变量）；全量模式 dataMap 补挂此前已构建但遗漏的 `ArchPackageFunction` 数组；全量 `_meta.objectCounts` 补齐 15 个新类型计数、单文件 objectCounts 补 `ArchPackageFunction` / `NixInput`（两种模式口径对齐）

### 审核：边界与数据质量清理

- `serve` docs 静态服务补第三重防护：`fs.realpathSync` 解析 symlink 后再做 docs 目录前缀校验（词法 `..` 校验拦不住目录内 symlink 指向目录外的逃逸；docsDir 本身也 realpath 以吸收 /tmp→/private/tmp 类别名），测试补 leak.md symlink 逃逸 → 403 用例
- `cmakeAnalyzer`：删除从未被调用的 `contentWithLineNoiseRemoved` 死代码；`findCallEdges` 从半成品（只建空 Set，builder 未消费）改为真实实现——按 `endfunction()/endmacro()` 行界圈定函数体范围、把范围内对同文件 function/macro 的调用归属为调用边（去重；顶层直接调用不产生边）；`detectRisks` 去掉未用的 targets/sets/filePath 参数
- `builder.buildCMakeObjects`：CMakeFunction 调用边接入 `_meta.shellEdges.callsFunction`（与 Shell 共享 `callsFunction` 链接类型，from/to 为 CMakeFunction 对象 ID）
- `builder.buildShellScriptObjects`：`usesBuiltin` / `readsCliParam` 边从"函数 × 脚本级全量 builtin/param"的笛卡尔积近似改为精确边——依据 `shellScriptAnalyzer` 新增的每函数 `builtinNames`/`cmdletNames`（函数体内实际出现的外部命令/cmdlet）与 `cliParamNames`（Bash 按 `--name` 文本关联、PS 按 `$Name` 引用关联）；顶层调用不建边。e2e 实测 3 函数 × 8 builtin 场景由 24 条降为 3 条真实调用
- `pkgbuildAnalyzer`：合并两处重叠的 `pkgdir-root` 检查（`$pkgdir`/`${pkgdir}`/`pkgdir` 三种写法统一走一条规则，单函数至多记一条，消除重复风险条目）；清理 `findFunctions` 未用变量
- `cmakeAnalyzer.findOptionsFromContent`：description 仅按引号形态识别，`option(X ON)` 的无引号布尔默认值不再被误作 description；`option(NAME)` 无 description 无默认值、省略 description 的写法均可解析
- 清理无人使用的导出/参数：`shellScriptAnalyzer.isPowerShellCandidate`（导出但全库零引用）、`analyzeShellScript` 未用 `ext` 变量、`buildShellScriptObjects` 未用 `fileObj` 参数

### 测试

- 新增 `test/outputDocs.test.mjs`（5 用例：全链路文件与内容契约 + L1<2KB/L2<1KB/L3<5KB 预算断言、--format md 降级、--output/export 别名、纯函数空 dataMap/slug 去重/CJK、buildTree 排序与 size）
- 新增 `test/serveDocs.test.mjs`（4 用例：/docs 302 + 静态资源 Content-Type 契约 + 嵌套/中文路径、路径穿越防护（node:http 原始路径直发——fetch/WHATWG URL 会客户端规范化 `..`）、docs 缺失 404 降级 + --docs-dir、/api/status 与首页同步）
- 新增 `test/nixAnalyzer.test.mjs` 扁平 inputs 用例（`inputs.<name>.url` 写法与嵌套等价 + hasFlakeAttr 声明语义）
- 同步既有断言：`test/serve.test.mjs` endpoints 清单、`test/serveAuth.test.mjs` auth.public 清单补 `/docs`、`/docs/`；`test/blueprintEngine.test.mjs` 与 `test/toolRegistry.test.mjs` 元模型契约数字 20→35 类型 / 26→49 链接 / 6→7 范畴（v0.37.0 +Shell/CMake/PKGBUILD/Nix 维度）
- 全量 841 用例全部通过（含多语言 e2e 冒烟：.sh/.ps1/CMakeLists.txt/PKGBUILD/flake.nix 混合仓库 refreshRepo → output docs → serve /docs 全链路；本轮新增 cmake 调用边/option 形态、pkgbuild 去重、serve symlink 逃逸用例）

## [0.37.0] - 2026-08-28

存储层 Schema 演进（Phase B）：从 8 张表 → 10 张表，借鉴 asdm-aos 16 表双层架构选择性引入 3-4 张关键表。详细方案与不借鉴项决策见 `docs/plan/storage-schema-v0.37.md`（待补 ADR，本节先合入变更）。

### 新增 aos_type_properties 表（投影层 DDL 输入）

- 借鉴 asdm-aos `aos_type_properties`：决定 viewmodel 字段裁剪 / HTTP API 字段过滤 / JSON schema 生成
- 新表 4 字段：`type_name` / `key` / `label` / `wire_type`（`string|number|boolean|object|array|ref`）+ `storage_hint`（`promoted|jsonb`）+ `index_hint`（`none|btree|fulltext|vector`）
- FK → aos_types(type_name) ON DELETE CASCADE
- 种子化覆盖 20 个核心类型：Project / Module / SourceFile / Component / Hook / Store / Method / Interface / Class / Trait / Dependency / Domain / Route / Service / PropEdge / GmApiUsage / InjectionPoint / NetworkEndpoint / UserScript / ScriptFunction，共 61 条属性
- 防御性过滤：只入 aos_types 已注册类型的属性（防幽灵属性 / FK 违规）

### 新增 aos_import_jobs 表（步进游标落表）

- 借鉴 asdm-aos `aos_import_jobs`：增量扫描的崩溃恢复基础
- 字段：`job_id` / `job_kind`（`refreshRepo|analyzeFile|export`）/ `snapshot_id` / `steps` / `current_step` / `cursor`（JSON）/ `status`（`running|paused|completed|failed`）/ `error` / `started_at` / `updated_at`
- FK → aos_snapshots CASCADE
- `idx_aos_import_jobs_status` 索引（status + updated_at）
- v0.37 占位表：schema 在位，应用层 incrementalParser 接入推迟到 v0.38

### aos_objects 加 content_hash + pk_hash 双字段（跨快照对象去重基础设施）

- `content_hash TEXT`：sha256(props_json) — 跨 snapshot 共享（同对象一致）
- `pk_hash TEXT`：sha256(`default|default|${type}|${id}|${content_hash}`) — 借鉴 asdm-aos 决策 2b；不含 snapshot_id 以支持跨 snapshot 同对象去重
- 2 索引：`idx_aos_objects_content_hash` + `idx_aos_objects_pk_hash`（**非 UNIQUE**：v0.37 表 PK 仍按 (snapshot_id,type,id)，UNIQUE 由 v0.38 PK 化时天然保证）
- saveSnapshot 写入时计算两 hash；loadSnapshot / loadType / loadObject / queryWhere 读路径不变（hash 字段不泄漏到 DataMap）
- v0.31 老库 backfill：SELECT NULL content_hash/pk_hash 行 → 应用层计算 → UPDATE（500 行/批 + 事务）

### aos_link_types 扩 4 字段（公理声明）

- 新增字段：`label` / `src_type` / `tgt_type` / `cardinality`（`1|0..1|*|1..*`）
- 种子化所有 26 种 link_type 的公理（contains / imports / calls / extends / ... 端点类型约束 + 基数）
- v0.37 暂不强制约束（按 Q4 决策：加字段存元数据，不接 linkMeta 校验）

### 迁移与初始化路径

- `db.js` 初始化流程重构：始终走 `applyPendingMigrations()` 路径（替代 v0.31 的"写 SCHEMA_VERSION 直接走"）
- `db.js` 以静态 import 引入 `migrate.js`（require(esm) 需 Node ≥ 20.19，与 engines >= 18 冲突；migrate.js 无反向依赖，无循环引用）
- `migrate.js` v2 块：ALTER TABLE aos_objects ADD COLUMN pk_hash + 4 索引 + 2 新表 + backfill
- v2 的 cardinality ALTER 带 CHECK 约束，与 schema.sql 新库口径一致（SQLite ADD COLUMN 支持 CHECK；老库已有行由 DEFAULT '*' 填充满足约束）
- `aos_link_types.src_type / tgt_type` 端点取值约定：类型名或 category 名（Container/CodeUnit/Script/AuditFact），已写入 schema.sql 与 seed.js 注释
- 日志走 stderr 不污染 stdout JSON（避免 ask --json 等命令被破坏）
- 全新安装：账本 v1 + v2 双行（v1 marker + v2 实际 schema 标记）
- v0.31 库升级：账本 v1 → 追加 v2 + 自动 backfill content_hash / pk_hash

### 文档

- storage 子命令 status 输出新增 `typeProperties` 计数
- storage init 显示 `本目录 X 个类型 / Y 个链接类型 / Z 个属性定义`
- `aos_link_types` 公理约定（`docs/adr/0007-link-types-axioms.md`）——待补

### 测试

- 新增 `test/storage/schema.test.mjs` 11 个测试（全新库 / v0.31 升级 / backfill 跨 snapshot 一致 / type_properties 种子化 / link_types 公理 / import_jobs CRUD / saveSnapshot hash 落地 / 二次写 hash 复用 / hash 公式顺序敏感 / getStatus 报告 / loadSnapshot 不泄漏 hash 字段）
- 现有 `test/storage/sqliteSnapshot.test.mjs` 调整：表数 8→10 + 账本 v1→v2 + 校验 10 张表名
- 修 `test/ask.test.mjs` 超时降级用例的时序抖动：600ms 预算在全量并发下连 opencode 应答也超时，提到 2000ms（codebuddy 挂起 5s 仍稳定触发降级路径）
- **811/811 全通过**（修复上述时序抖动后）

### 风险与回退

- v0.37 不破坏 v0.31 数据（只加列 + 索引 + 2 表；不回填会保留 NULL 字段；saveSnapshot 重写覆盖）
- 暂无 rollback 命令（v0.38 加 storage rollback --to v37）

## [0.36.1] - 2026-08-28

v0.36.0 后续候选高价值项闭环（候选 0 / 1 / 2 / 4）。

### 候选 0：`action analyzeFile` 单文件模式接入 `.kt/.kts/.php` analyzer 分发

- `buildSingleFileOntology` 分发链补 `.kt` / `.kts` → kotlinAnalyzer、`.php` → phpAnalyzer 分支（此前回落 tsAnalyzer 产生错误解析）
- 修复单文件模式 `cls.implementsNames.map` 空指针（Kotlin facts 无 implementsNames 字段；对齐全扫描的 `?? []` 空值安全写法）
- 单文件模式同步接入 PHP DAO 常量解析（本文件内 `define()` 可见；跨文件常量表在全仓库扫描解析）

### 候选 2：`phpDetected` / `kotlinDetected` 暴露

- `scanProject` 返回对象新增 `phpDetected` / `kotlinDetected`（与 `goDetected` / `flutterDetected` 对齐）
- Project 快照对象新增 `goDetected` / `phpDetected` / `kotlinDetected` 三字段（此前 flutter/tauri/electron 有而 go/php/kotlin 缺）

### 候选 1：PHP / Kotlin 内部 import 解析

- **新模块** `src/analyzers/phpKotlinImportResolver.js`（输出契约与 importResolver / goResolver 对齐：internal/external/unresolved）
- PHP：composer.json autoload **PSR-4 / PSR-0 前缀映射**（最长前缀优先，目录归一）→ 目标 `.php` 文件存在则 internal；无 composer 映射时按**全仓库声明限定名**兜底（namespace + class/interface/trait，小写归一匹配，覆盖 zentaopms 遗留库）；未命中按命名空间首段归并 external（`ecosystem: php`）
- Kotlin：**声明 package + 限定类名**精确匹配 → **源码路径后缀匹配**（任意源码根下 `com/example/Client.kt`，等效覆盖自定义 sourceSets srcDir，无需解析 build.gradle.kts）→ 未命中按首段归并 external（`ecosystem: kotlin`）
- 通配 `import a.b.*` 关联整包文件（imports 边多目标，与 Go package 导入同构；`file` 指向包内首个文件兼容单文件消费者）
- builder 导入边消费分支支持 `files` 数组（此前仅单 `file`）；`tf === relPath` 自引用跳过

### 候选 4：PHP DAO 链抽取（Phase-2 → 落地）

- `phpAnalyzer` 方法体语句级静态识别 zentaopms `dao` 链：`select(...)->from(X)` → SELECT、`update(X)` / `insert(X)` / `replace(X)`（内联表参）→ UPDATE/INSERT、`delete()->from(X)` → DELETE、`leftJoin/innerJoin/rightJoin(X)` → JOIN
- 表参三态：字符串字面量（静态）/ `TABLE_X` 常量（dynamic 占位）/ `$var`（dynamic 不参与链接）
- **常量解析**：全仓库 `define('TABLE_X', 'zt_x')` 值提取（兼容反引号值 `` '`zt_bug`' ``）→ builder 后置解析 pass 把 `Method.sqlQueries` 中 dynamic 常量改写为真实表名并清 dynamic（单文件模式仅本文件 define 可见）
- `Method.sqlQueries` 挂载扩展：class 方法 / trait 方法实体同步拷贝（此前仅模块级函数通道）；mapsToTable / mappedFromCode 代码↔表链接自动消费（含 JOIN 表）

### 测试

- `test/singleFileKotlinPhp.test.mjs` —— 4 tests（.php/.kt/.kts 单文件分发 + trait 单文件回填 + suspend/isDataModel 字段）
- `test/phpKotlinImportResolve.test.mjs` —— 4 tests（PSR-4 前缀归一 / PHP internal+external / Kotlin 限定名+通配+外部 / e2e 文件边）
- `test/phpDaoChain.test.mjs` —— 3 tests（DAO 链五形态提取 / defines 反引号剥离 / e2e 常量解析 + mapsToTable/mappedFromCode 链接）
- `test/kotlinPhpIntegration.test.mjs` 补 `phpDetected` / `kotlinDetected` / `goDetected` Project 字段断言
- **修复 v0.35.1 遗留的 10 个 viewer 测试失败**：`document` stub 缺 `addEventListener`（v0.35.1 邻接聚焦交互新增的顶层调用），按 dbViewer/serviceViewer 后写的 stub 样式补齐 5 个文件 8 个站点
- `test/mcpCli.test.mjs`：固定 1.5s 等待改轮询 stderr "就绪"（上限 8s），消除全量并行负载下的时序抖动

## [0.36.0] - 2026-08-27

### 新增 PHP / Kotlin 分析器 v0.36.0（ADR 0006）

完整方案对比与不借鉴项决策见 `docs/adr/0006-php-kotlin-analyzer.md`。

#### P0：新 PHP 分析器（zentaopms / Laravel / Symfony）

- **新模块** `src/analyzers/phpAnalyzer.js` —— 沿用 tsAnalyzer/rustAnalyzer 的"轻量状态机 + 等长噪声剥离"范式，零运行时依赖
- 实体映射：class（含 `extends model` → `isDataModel: true` / `extends control` → `isController: true` / abstract / final / readonly 修饰）、interface（含 extends 多继承）、trait（独立对象类型）、method（含 `__construct` 构造器、`static` 修饰）、property（`public $name` / `public string $name`）
- `use Trait1, Trait2;`（class 体内）→ `usesTraits` 数组
- `use ... as` 别名 + `use Baz\{ Qux, Quux as Q };` 群组导入解析
- `namespace Foo\Bar` → `moduleName: 'Foo.Bar'`（反斜杠归一点号）
- 字符串/注释噪声剥离（DAO 链中的 `'<类定义>'` 字符串不产生幽灵实体）
- `module/<x>/control.php` 内 public 非构造方法 → Route（`routeType: 'php'`，`path: '/<module>-<method>'`）
- API 边界：`sqlQueries` / `crossModuleImports` 在 v1 留空数组契约（DAO 链抽取 Phase-2 接入）

#### P0：新 Kotlin 分析器（Android / JVM / KMP）

- **新模块** `src/analyzers/kotlinAnalyzer.js` —— 与 PHP analyzer 同范式独立共存
- 实体映射：class（含 data_class / sealed_class / object 单例 / enum_class / companion_object 内嵌 5 种变体）、interface、fun（含 `suspend fun` → `isAsync: true` 标注 + `inline` / `operator` / `infix` 修饰）、val|var Property
- supertype 列表解析（含点号嵌套 `Call.Factory`）
- `import foo.Bar` / `import foo.Bar as Baz` / `import foo.*` 解析
- 噪声剥离覆盖三引号原始字符串（含 `${}` 插值）、字符字面量

#### P0：本体扩展：Trait 对象类型

- 新对象类型 `Trait`（`trait:` 前缀，L1/CodeUnit）—— 描述为"方法复用单元（PHP trait；同一命名空间，可被多个 Class `use` 注入方法）"
- 新链接类型 `usesTrait`（class → trait）与 `usedByTrait`（trait → class）—— 双向
- `dataMap.Trait` 数组、`Class.usesTraitIds` / `Class.usesTraits` 字段、`Trait.usedByIds` / `Trait.methodIds` 字段
- `OBJECT_TYPES` 19→20，`LINK_TYPES` 24→26
- `blueprint.js` 的 `contains(file:)` 同步包含 trait
- `viewModel` 已支持 `kind: 'trait'` 配色（cyan 描边，v0.34 之前已就绪）

#### P0：builder.js 集成

- analyzer 分发嵌套三元扩 `.kt` / `.kts` / `.php` 分支
- import 解析：PHP / Kotlin 按命名空间首段归并为 external（避免 `Foo\Bar` 被 TS resolver 误判为 npm 包）
- trait 链接双向回填：builder 阶段用 `usesTraits` 名字查全仓库 `traitByName` 表，写 `usesTraitIds` / `usedByIds`
- PHP 路由生成：handler Method 关联到 control 类同名方法
- 失败 `catch` 块补 `traits: []` / `routes: []` 兜底
- `objectCounts.Trait` 记账同步
- `buildSingleFileOntology` 镜像 trait 处理（单文件模式）

#### P0：项目扫描 & 框架检测

- `projectScanner.js` 扩 `.kt` / `.kts` / `.php` 进 `SOURCE_EXTENSIONS`
- `detectFramework` 新增 `php` / `kotlin` 早返回分支
- `phpDetected` 判定：`composer.json` 存在 + `.php` 文件数 > 0
- `kotlinDetected` 判定：`build.gradle.kts` 或 `settings.gradle.kts` 存在 + `.kt` + `.kts` 文件数 > 0
- `Project.kotlinFileCount` / `phpFileCount` 字段加（与 `pyFileCount` 平级）
- `Project.language` 拼接 +Kotlin +PHP

#### P1：架构层语义

`semantics.js#inferFileArchLayer` 新增 PHP / Kotlin 分层规则：

- PHP（zentaopms 惯例）：`control.php` → presentation；`(model|config).php` → service；`view|ui|lang/` → presentation；`dao|dal|repositories|services|models/` → service；`framework/` → shared
- Kotlin（Android 惯例）：`*(Activity|Fragment|Screen|Page).kt` → presentation；`*(Repository|UseCase|Service).kt` → service；`*ViewModel.kt` → presentation；`di|data|datasource|db|network|api/` → service

#### P0：测试

- `test/phpAnalyzer.test.mjs` —— 11 tests（实体/方法/属性/trait/namespace/use 群组/control 路由/接口/抽象类/死代码契约/DAO 链空契约）
- `test/kotlinAnalyzer.test.mjs` —— 12 tests（class 变体/supertype/fun+suspend/import/三引号字符串/死代码/enum/object 单例等）
- `test/kotlinPhpIntegration.test.mjs` —— 1 e2e test（fixture 项目 → buildOntologyData 全链路，含 trait 双向链接 / 路由 / 架构层 / objectCounts 验证）
- `test/blueprintEngine.test.mjs` —— 同步更新到 20 OBJECT_TYPES / 26 LINK_TYPES
- `test/toolRegistry.test.mjs` —— 计数断言收紧为精确 20/26（原 `>= 19`/`>= 20` 下界）

#### 文档与元数据同步

- README：语言清单与 intro、核心能力速览（20 对象 / 26 链接）、taxonomy L1 补 Trait、对象表新增 Trait 行（Class/Method/Route/Project 行补 PHP/Kotlin 字段枚举）、链接表补 usesTrait/usedByTrait 与 mapsToTable/mappedFromCode、新增「PHP 适配」「Kotlin 适配」章节、框架检测/导入解析补 composer.json 与 build.gradle.kts 判定、已知限制补 PHP/Kotlin 条目、MCP `list_types` 描述 19→20
- `toolRegistry.js`：get_schema / list_types / query_objects 工具描述计数 19→20、24+→26（MCP 客户端可见的运行时文案）
- `skills/nice-aos-skill/SKILL.md`：intro 语言清单、对象/关系计数（18→20、21→26）、taxonomy L1 补 Trait、MCP 工具表计数
- `package.json`：description 补 PHP/Kotlin 能力句，keywords 增 php / kotlin / zentaopms / android / trait

#### 后续候选（v0.36+）

0. `action analyzeFile` 单文件模式接入 `.kt/.kts/.php` analyzer 分发（当前回落 tsAnalyzer）

1. PHP/Kotlin PSR-4 内部 import 解析（读 composer.json autoload / build.gradle.kts sourceSets 区分内/外）
2. `phpDetected` / `kotlinDetected` 暴露到 scan 结果（与 `goDetected` / `flutterDetected` 对齐）
3. Kotlin receiver-constrained 调用图（借鉴 GitNexus P3）
4. PHP DAO 链抽取（Phase-2，复用 `pythonAnalyzer.sqlQueries` 通道）
5. PHP `lang/` 翻译资源实体（i18n 覆盖度图谱）

## [0.35.1] - 2026-08-27

### 借鉴 GitNexus：图谱协议层 v0.35.1（ADR 0005）

参考 `/Users/healer2027/workprojetcs/nice-aos/.nice-aos/analysis/gitnexus-graph-borrow-analysis.md`，4 项 GitNexus 范式增量落地。完整方案对比与不借鉴项决策见 `docs/adr/0005-gitnexus-borrowed-capabilities.md`。

#### P1：链接元数据（edge metadata）

- **新模块** `src/ontology/linkMeta.js` —— 把 `link()` 增强为 `linkWithMeta2(ctx, linkType, srcId) → [{id, confidence, reason}]`
- 元数据写入约定：源对象上 `<linkType>Meta` 数组与 `*Ids` 一一对应；缺省时降级为 `confidence: 1.0, reason: 'direct'`
- 模糊推导边的预设（与 builder.js 当前解析路径对齐）：
  - `vue-global-fallback` 0.6（renders 经 Vue.component 全局注册兜底）
  - `vue-same-file-fallback` 0.5（renders 经同文件兜底）
  - `auto-imported` 0.7（usesStore 经 unplugin-auto-import 隐式调用）
  - `missing-source` 0.4（prop 边源/目标组件缺失）
- 新增 `linkBfsWithMeta(ctx, linkType, srcId, depth)`：按 hop 分层 + `pathConfidence` 取路径最低值 + cycle 防爆
- 完全向后兼容：现有 `link(linkType, srcId)` 不变

#### P1：MCP epistemic 信封（epistemic envelope）

借鉴 GitNexus `src/mcp/tools.ts` 的 `epistemic: 'exact' | 'lower-bound'` 协议：

- **traverse_links 响应**：新增 `_meta: { epistemic, confidence, causes, count, at, ... }`；可选 `withMeta: true` 附加 `edges: [{id, confidence, reason}]`；`depth > 1` 时附加 `byDepth: [{depth, count, edges}]`
- **get_node 找不到**：返回 `_meta.ambiguity: { queried, candidates: [{id, name, _type, score}] }`（Levenshtein + prefix + 子串打分）
- **query_objects 歧义名（~ 多匹配）**：返回 `_meta.ambiguity: { queriedName, distinctNames, candidates: [{name, count, sampleId, relevance}] }`；唯一匹配时不附 `_meta`（与原行为一致）
- **get_health**：暴露 `_meta.resolutionStats`（向后兼容，无则 `null`）

#### P2：解析覆盖度记账（resolution-outcome）

借鉴 GitNexus `src/core/ingestion/scope-resolution/passes/resolution-outcome.ts`：

- builder.js 在 `_meta.resolutionStats` 写入：
  - `totalImportAttempts` / `totalResolvedImports` / `unresolvedImportsCount`
  - `unresolvedDynamicImportsCount`（defineAsyncComponent / React.lazy 解析失败）
  - `vueGlobalFallbackCount` / `vueSameFileFallbackCount`（renders 模糊兜底）
  - `autoImportedUsesStoreCount`（隐式 store 调用）
  - `matchedRouteCount` / `unmatchedFrontendCallsCount`（前后端路由匹配）
- 派生指标：`importResolutionRate`（解析成功率） + `fuzzyLinkCount`（所有模糊边计数）
- "已知限制"从文档 → 数据，agent 一眼看到图谱完整度

#### P2：蓝图邻接聚焦交互（reducer 范式）

借鉴 GitNexus WebGL Sigma 3 的邻接衰减着色，零依赖 SVG 实现：

- viewer.js CSS 增强：选中节点 → 邻接边 stroke-width ×1.5 + drop-shadow + 邻接节点描边 3.5px + 阴影；非邻接压暗至 0.18 alpha / 边 0.06 alpha
- 已有 `cgSetFocus` 函数 + Esc 键 + "清除聚焦"按钮三种解除方式
- viewmodel 暴露 `renderBudgets: { moduleGraphNodeCap, componentGraphNodeCap, storeGraphNodeCap, graphEdgeCap, entityNodeCap, entityTableCap }`；超 cap 时 UI 显示 `<span class="warn">节点已达渲染上限 N</span>`（借鉴 ~25K 节点 / ~50K 边悬崖阈值熔断）

### 测试

- 新增 `test/linkMeta.test.mjs` 16 tests：linkWithMeta2 直连边/模糊边/缺省降级/'links' 聚合/未知 linkType + linkBfsWithMeta byDepth 分层/cycle 防爆/pathConfidence + epistemic 信封 5 路径（traverse_links 成功/源不存在/withMeta + get_node 找不到 + query_objects 歧义/精确 + get_health 暴露 resolutionStats）
- 回归：114 tests pass（toolRegistry 24 + linkMeta 16 + blueprintActions 31 + blueprintEngine 14 + output 29）

## [0.35.0] - 2026-08-27

### 技术债清偿（ADR 0002 审核报告 P0/P1/P2 全量闭环，自扫描/审核驱动）

#### E-3（P1 核心）：refreshRepo / analyzeFile 真实实现 + serve /action 端点

- **引擎动作真实现**：`createBlueprintV2` 的 refreshRepo / analyzeFile 由"ok:false 指引 stub"升级为真实执行——refreshRepo 走项目根检测（detectProjectRoot，优先级与 action.js 一致）+ 全量重扫 + 快照落盘；analyzeFile 单文件本体分析并输出对象统计。核心逻辑收敛至新增 `src/ontology/actionOps.js`（builder 唯一静态加载点；落盘策略可注入 saveTo）；blueprint.js 动态 import 加载，规避 ontology ↔ builder 静态循环依赖
- **serve 新增 `POST /action`**：蓝图 UI 动作卡片提交端点打通（此前前端 `fetch('/action')` 直接 404）。markReviewed/addNote 写 JSON 快照 + SQLite overlay 双写（no-snapshot 回退镜像，语义同 action.js:149-195）；refreshRepo 重扫后直接落到本服务数据源目录（saveTo=snapPath），运行期实时探测立即生效；analyzeFile 纯只读。未知动作/缺参/对象不存在返回结构化 400；角色分级 `minRoleFor('/action')→write`；`ENDPOINTS` 登记，`/openapi.json` 与 `/api/status` 同步暴露
- **引擎异步契约**：`blueprintEngine.action()` 支持异步 actionImpl——同步 impl 返回值保持原样同步返回（完全向后兼容）；返回 thenable 时才收敛为 Promise 且 rejection 统一映射 `{ok:false}`

#### E-2：动作定义单源抽取

- 新增 `src/ontology/actionDefs.js` 纯定义模块（`ACTION_DEFS` + `getActionsForType`），按 roadmap 原方案完成"定义/渲染"分离；blueprintActions.js 保留 re-export 兼容既有导入与"同一引用"防漂移测试断言；blueprint.js / viewer.js 取数改走新单源

#### E-5 / E-4 收尾

- incrementalParser.js 头注释与类 JSDoc 残留 "LRU" 表述修正为"FIFO 容量淘汰简化实现（非严格 LRU）"，测试名同步更新
- viewer.js 前端 `esc()` 补齐单引号转义（与 blueprintActions escapeHtml 对齐）

#### P2 回归测试补位（E-6 深拷贝 / E-10 软链 / E-11 路径字段已在早前版本实现，本次补测试锁定行为）

- blueprintEngine.test.mjs +4：嵌套深拷贝防写穿（E-6）、同步/异步 actionImpl 契约、analyzeFile/refreshRepo 真实动作沙箱测试（临时目录快照重定向）
- projectRootDetector.test.mjs +2：祖先软链回环终止性、多层软链包裹解析（E-10）
- incrementalParser.test.mjs +1：sourceFile/file/source 扩展路径字段命中清除（E-11）
- serve.test.mjs +3：POST /action 集成（未知动作 400 / 写盘回读含 addNote 累加 / 只读分析）

### 测试

- 测试基线 739 → **749**，新增用例全部通过。剩余偶发失败均为外部 CLI / spawn 时序敏感用例（ask 端到端降级链、mcpCli 握手、duplicates 超时），与本节改动无关（未修改的 HEAD 上同样复现）

## [0.34.0] - 2026-08-27

### 新增（output 命令）

- **`--merge <paths...>` 多快照合并**（out-3）：monorepo / 多子项目各一份快照合并出总览；冲突策略 `--merge-strategy first-wins`（默认，计数上报）/ `rename`（后到冲突对象重前缀 `<source>:<id>` + `*Id/*Ids` 引用字段泛键回填，收录时统一应用映射）；非首源 Project 折叠进 `_meta.mergedProjects`；合并发生在 dataMap 层 → 四格式自然复用。新增 `src/ontology/merge.js`
- **`--include <types>` / `--exclude <types>` 类型过滤**（out-4）：作用于全部导出格式；未知类型 fail 并列出可用类型；过滤后 `_meta.objectCounts` 自动对齐
- **主题 API + CLI**（out-5）：`themes/index.js` 暴露 `registerTheme(name, def)` 运行时注册与用户目录懒加载（`NICE_AOS_THEMES_DIR` 可覆盖）；新增 `output theme add/list/remove` 子命令，主题落盘 `~/.nice-aos/themes/<name>.json`
- **`--format all`**（out-6）：一条命令产出 `<base>.md / <base>.html / <base>.viewmodel.json` 三件套（需 `--output`）

### 新增（serve 服务）

- **`GET /openapi.json`**（srv-3）：零依赖生成 OpenAPI 3.0.3 spec；端点清单单一事实源 `serveOpenApi.ENDPOINTS`（`/api/status.endpoints` 同源派生）。新增 `src/cli/commands/serveOpenApi.js`
- **`--rate-limit <max>` / `--window-ms <ms>`**（srv-4）：滑动窗口、IP 维度限流，超限 429 + `Retry-After`；每 IP 时间戳数组 + maxIps 容量驱逐防 OOM；先于鉴权执行防爆破绕过；观测端点 `/api/rate-limit`
- **`POST /api/ask`**（srv-5 / x-4）：serve 内直连已配置的 OpenAI 兼容模型服务回答问题（不依赖本地 AI CLI）；支持 `session` 续聊与 `save` 落盘；未配置模型时返回 503 配置指引；上下文两路取数与 GET /api/ask/context 同源
- **端点分级 read/write/admin**（srv-6）：token 支持 `secret:role` 形态与多值 `--token s1:read s2:write`；env `NICE_AOS_SERVE_TOKENS="s1,s2:read"` 优先；单 `--token` 默认 admin 向后兼容；角色校验表 `minRoleFor(method,url)`（POST /api/ask 与 /internal/broadcast 需 write）

### 新增（跨命令协同）

- **`ask --tool-call` / `--max-tool-steps`**（x-1）：自治工具循环正式版——prompt 注入 query/link/output 参数说明 → 模型输出 ```aos-tool``` fenced JSON 块 → 子进程执行真实 sub-command → 结果截断 ≤8KB 回填再生成，≤5 步收敛 + 上限强制收尾；仅模型服务通道（CLI agent 提示改用 `--tools`）。新增 `src/cli/commands/toolLoop.js`
- **output 完成后通知 serve 广播**（x-3）：serve 启动写 `<dataDir>/serve-runtime.json {pid,port}`（退出清理、陈旧 pid 按 ESRCH/EINVAL 判死）；export 写文件后经回环限定 `POST /internal/broadcast` 触发 WS 推送 `report:changed {paths,ts}`；serve 未运行静默跳过。新增 `src/cli/commands/notifyServe.js`

### 内部

- `serveAuth.js` 扩展 `ROLES / parseTokens / authorizeRole / minRoleFor / extractToken`；`serveWebSocket` 返回值暴露 `broadcast()`；CORS Allow-Methods 增加 POST
- 测试基线 699 → 739：新增 `exportUpgrade.test.mjs`(11) / `exportMerge.test.mjs`(4) / `serveUpgrade.test.mjs`(16) / `toolLoop.test.mjs`(9)；既有 serve 契约断言随端点清单/横幅新形态同步

## [0.33.1] - 2026-08-27

- **Agent 解析翻转 + 注册表扩展**（`agentRunner.js`）：`--agent auto` 时已配置的自定义模型服务成为首选通道（原为 CLI 优先、模型兜底），其后按注册表序探测 CLI；注册表从 2 项扩展至 8 项（codebuddy / opencode / **trae / qoder / claude / codex / qwen / aider**，后六者 experimental 标记）；报错信息给出可用注册名与接入指引
- **`--agent-cmd "<bin> [args...] {prompt}"`**：任意自定义 AI CLI 零代码接入——含 `{prompt}` 占位符按位注入（可多处），缺省追加末尾；未知名字不再死路一条
- **`--tools` 自治深查**（sub-tool P1）：隐含后台 serve，把 `query`/`link`/`export` CLI 用法与 HTTP 端点指引注入 prompt，AI 按需自行取证并要求引用对象 id
- **`--since <ref> [--staged]` 跨快照 diff 问答**（P2）：复用 gitDiff 增量解析，变更文件（≤40 行列示）与涉及本体对象（按类型分组 ≤15/类）折叠为 prompt 独立段落；与 export --since 同源同参（findGitRoot 收敛共享）
- **`--save [path]` 回答落盘**（P2）：自包含 Markdown 存档（元信息头含回答方/降级链/会话/增量范围/耗时），缺省写 `<snapshotDir>/answers/ask-<时间戳>.md`
- **`ask eval` 评测 harness**（P2）：JSONL 用例集（mustInclude 字符串或数组任选其一 / mustExclude）+ 纯函数评分，输出通过率与逐例报告；`--out` 落盘；存在失败 exitCode=1；doAsk 核心抽取复用（多用例共享一次上下文构建）

### 内部

- `gitDiff.findGitRoot` 上移共享（原 export.js 本地实现删除）；新增模块 `askSave.js` / `askDiffContext.js` / `askEval.js`
- 测试：新增 `test/askUpgrade.test.mjs` 15 例（注册表/模板编译/评分器/JSONL 解析/落盘/diff 上下文含临时 git 仓库 e2e）；既有 4 例按新语义更新

## [0.33.1] - 2026-08-27

### 修复（自扫描驱动：用 nice-aos 扫描自身仓库发现的设计缺陷）

- **Node CLI 形态识别**（`projectScanner.js`）：`package.json` 声明 `bin` 入口且无前端框架信号时判 `framework=node-cli`（标签"Node.js CLI 工具"），先于 userscript 判定——CLI 仓库混入油猴脚本（如 `contrib/`）不再劫持整个仓库画像；语言判定区分 TS/JS，纯 JS 工程不再误标 TypeScript
- **bin/main 入口识别**（`projectScanner.js` + `builder.js`）：`package.json` `bin`/`main` 指向且位于扫描根内的文件标 `isEntry`——自扫描中 CLI 真实入口 `src/cli/index.js` 此前被误判孤儿文件
- **外部测试引用豁免**（`projectScanner.collectExternalTestImports` + `builder.js`）：根级 `test/tests/__tests__/spec` 目录的 import 不在扫描范围，词法提取具名/文件级引用作为死代码判定证据（`relPath#name`）——孤儿候选、死导出、导出实体三类判定同时豁免；自扫描验证死导出候选 42 → 32
- **IO 扫描字符串打码**（`ioRegistry.maskStringsAndComments`）：匹配前把 `'...'` / `"..."` / 模板字面量内容与注释替换为等长空白（`${}` 插值段保留为代码），注册表 callee 名出现在字符串常量/代码生成模板中的误报消除——自扫描 3 个 fetch 高危误报清零；`callText`/`argsText` 回取原文保持展示保真
- **快照持久化收敛**（新增 `storage/snapshotFileKit.js`）：db / deploy / planning / service / overview 五个领域模块的 `getXxxSnapshotDir / load / save / has / fileHash` 模板复制（duplicates 检测 13 组中的 5 组）收敛为共享 kit，各模块保留原导出名薄封装

### 文档

- **README 介绍重写**：一句话定位语 + 「30 秒上手」前置 + 「四个入口」命令表精简 + 「核心能力速览」六要点；详细参考章节零改动，场景类子节收拢至「场景指南」

## [0.33.0] - 2026-08-26

三大核心命令升级（输入 / 输出 / 服务）+ code-graph-rag 范式落地（MCP / 重复代码 / 死代码 BFS / IO 注册表 / 模板），详见 `docs/plan/aos-three-core-roadmap.md` 与 `docs/adr/0004-code-graph-rag-reusable-patterns.md`。本节为 v0.32.0 → v0.33.0 的统一变更记录（原 [0.32.0] release commit `68070d2` 中未含 CHANGELOG 条目，本次合并为单节）。

### 新增

借鉴 [code-graph-rag](https://github.com/vitali87/code-graph-rag) 的 2 大工程模式（MCP server + AST fingerprint 重复代码检测），把 nice-aos 从"扫描器"扩展为"AI agent 友好的开发工具"。

#### ask 流式 + 多轮会话

- **`ask --stream`** 流式输出（仅 `--agent api`）：OpenAI 兼容 SSE token 透传；CLI agent（codebuddy / opencode）不支持流式自动降级到同步路径
- **`ask --session <id>` 多轮会话**：JSONL 存储于 `$NICE_AOS_CONFIG_DIR/sessions/<id>.jsonl`；`--session-max-turns N` 限制 prompt 携带的历史轮数
- 新增 `src/cli/commands/openaiCompat.js` 的 `invokeApiChatStream`（response.body.getReader + SSE `data:` 解析 + `[DONE]` 终止）
- 新增 `src/cli/commands/askSession.js`（loadSession / appendTurn / formatHistory；损坏行容错 + 路径穿越防护）

#### output 别名 + 增量 + 模板

- **`output`** 作为 `export` 的 commander 顶层别名；`src/cli/index.js` `exportCommand.alias('output')`
- **`export --since <ref>`** 增量导出（`src/cli/commands/export.js`）：git diff 解析 → 末尾追加"增量变更摘要"节（变更文件清单 + 按类型分组的涉及对象）
- **`export --since --staged`** 仅列已暂存变更（pre-commit 体检）
- **`export --template <path>`** 自定义 Markdown 模板（`src/ontology/template.js`）：`{{Project.name}}` / `{{stats.Component}}` / `{{ObjectCounts.Module}}` / `{{Health.complexity.avg}}` 占位符

#### serve 鉴权 + WebSocket 推送

- **`serve --token <secret>`** Bearer 鉴权（`src/cli/commands/serve.js`）：保护 `/api/*` + `/ws/snapshot`；`Authorization: Bearer` 头或 `?token=` query 都可；`timingSafeEqual` SHA-256 防 timing attack
- **`serve --ws-interval <ms>`** WebSocket 推送（`src/cli/commands/serveWebSocket.js`）：`/ws/snapshot` 单定时器 mtime 轮询；事件含 `hello` / `snapshot:changed` / `blueprint:changed` / `pong`
- **`NICE_AOS_SERVE_TOKEN` 环境变量覆盖 `--token`**（CI 场景）
- Auth 实现抽到 `src/cli/commands/serveAuth.js`（checkAuth + timingSafeEqualStr 单独可单测）

#### MCP server + tool 工具集（精简后 7 个）

- **`nice-aos mcp`** 子命令（`src/cli/commands/mcp.js`）：stdio 传输，启动 fail-fast（快照缺失立即报错）；优雅关闭 SIGTERM / SIGINT；启动日志走 stderr 不污染 JSON-RPC stdout
- **`nice-aos mcp --root /abs/path`** 接入 Claude Code：`claude mcp add nice-aos -- npx nice-aos mcp --root /abs/path`
- 工具注册表（`src/ontology/toolRegistry.js`）：`get_stats` / `get_schema` / `list_types` / `query_objects` / `get_node` / `traverse_links` / `get_health`（v0.33.0 精简 `detect_dead_code` / `query_graph`——前者与 deadcode CLI 子命令重叠，后者深度 ≤ 3 + 节点 ≤ 1000 价值密度低，由 traverse_links + deadcode 子命令替代）
- byId 索引（O(1) 查询）；handler try/catch 包装，错误用 `{ok: false, error}` 返回值表达
- 低层 `Server` + `setRequestHandler`（避开 McpServer.tool() 强制 zod 依赖；inputSchema 用 JSON Schema 形态）

#### 重复代码 + 死代码 + IO 注册表

- **`duplicates` 子命令**（`src/cli/commands/duplicates.js`）：text-based 规范化（去注释/字面量/标识符，保留关键字 + this/super/literal + JSX 组件 □C）→ SHA-256 → group-by（O(n)）
- **`deadcode` 子命令**（`src/cli/commands/deadcode.js`）：entry-point BFS 算法（roots = entry files / Component / test methods / 显式 --entry-point）+ 反向边（method → owner / file → 内含组件）；仅报 exported class（method / interface 留 v0.34.0）
- **`deadcode --write-back`** 把 dead 信息写回 snapshot 的 `deadCandidate` 字段（深拷贝保护 readonly JSON 结果）
- **`io` 子命令**（`src/cli/commands/io.js`）：数据驱动 IO_SINKS 注册表 + 静态文本匹配（regex）+ shadow check（local var 不污染全局）
- IO 注册表（`src/ontology/ioRegistry.js`）：30+ 油猴 GM_* / 10+ 浏览器 JS（fetch / localStorage / cookie / eval / innerHTML …）；5 种 ResourceKind（STORAGE/NETWORK/DOM/STDOUT/SCRIPT）+ 5 种 DANGER_LEVELS
- 边界保护：`myFetch(...)` / `consoleFetch(...)` 不误匹配 `fetch`

#### builder 集成

- **method entity 新增 `pos` / `end` 字段**（v0.33.0）：用于死代码 BFS 定位 + IO 扫描定位；向后兼容
- **method entity 挂 `astFingerprint` / `astFingerprintNodes`**（默认开启，性能门 `NICE_AOS_FINGERPRINT=0` 显式关闭以节省扫描时间）

### 依赖

- `@modelcontextprotocol/sdk@^1.30.0` 加入 `dependencies` 与 `bundledDependencies`（同时支持 `bundledDependencies`，已移除拼错的 `bundleDependencies` 字段）

### 测试

- **69 个新测试**（25 fingerprint + 4 duplicates + 24 toolRegistry + 4 mcpCli + 11 deadCode + 9 deadcodeCli + 16 ioRegistry + 7 ioCli - 5 个 query_graph 相关 + 6/6 session）
- **684 总测试**（既有 615 + 新 69，全部通过；当前 v0.33.0 精简后净删 5 个 query_graph 测试和 1 个过时 mcp 断言）

### 升级指引

```bash
npm install -g nice-aos@0.33.0
# 或:
npx nice-aos@0.33.0 action refreshRepo --root /abs/path/to/your/project
# 三核心增强：
npx nice-aos@0.33.0 ask "组件依赖" --stream --session r1
npx nice-aos@0.33.0 output --format markdown --since HEAD~1 --output diff.md
npx nice-aos@0.33.0 serve --token s3cret --ws-interval 5000
# 检测：
npx nice-aos@0.33.0 duplicates --dir /abs/path/to/data --min-size 20
npx nice-aos@0.33.0 deadcode --root /abs/path
npx nice-aos@0.33.0 io --root /abs/path --min-danger medium
# Claude Code 集成：
claude mcp add nice-aos -- npx nice-aos@0.33.0 mcp --root /abs/path
```

> 原 [0.32.0a] 节（合并入此）含：MCP tool 9 个（v0.33.0 减到 7 个）；builder 默认开启 fingerprint 但支持 `NICE_AOS_FINGERPRINT=0` 关闭；duplicate/deadcode/io 子命令原始描述。


## [0.31.0] - 2026-08-26

借鉴 asdm-aos 0.0.12 的 4 大工程模式：BlueprintRuntime + createEngine 元模型 / projectDetector 项目根自动检测 / ActionPanel 蓝图交互控件 / IncrementalParser 缓存式增量解析。详见 `docs/adr/0002-blueprint-engine-borrowed-from-aos.md`。

### 新增

- **蓝图引擎 V2**（`src/ontology/blueprintEngine.js`）—— 借鉴 aos BlueprintRuntime + createEngine 模式
  - `createBlueprintEngine({ objectTypes, linkTypes, actionDefs, linkImpls, actionImpls })` 工厂
  - 暴露 `find / where / link / action / snapshot / schema` 6 个方法
  - 写回不污染 seed（深拷贝 + 数组元素 `{...r}`，与 aos 同构）
  - 异常捕获：actionImpl 抛错 → 返回 `{ok:false, message}` 不抛到调用方
  - ParamDef 形态化（aos 4 种 + 扩展 number/boolean）：text / number / boolean / enum / objectRef / objectRefMulti
- **`createBlueprintV2(dataMap, opts)`**（`src/ontology/blueprint.js`）—— 兼容既有 linkImpls 闭包（24 个函数零重写），内置 markReviewed / addNote 动作，`extraActions` 参数允许 service/planning/db/deploy 蓝图扩展
- **`BLUEPRINT_SCHEMA`** 静态元数据导出 —— 聚合 OBJECT_TYPES（19）/ LINK_TYPES（24）/ ACTION_NAMES（4）/ ONTOLOGY_META（4 抽象层 + 6 分类）
- **项目根自动检测**（`src/analyzers/projectRootDetector.js`）—— 借鉴 aos projectDetector 思路
  - 多语言 marker 优先级表（Flutter pair 强信号 → Node → Rust → Go → Python → Java → Git 兜底）
  - Flutter pair 联合判定（`pubspec.yaml + lib/` 同时存在才算 Flutter）
  - 软链解析（realpath 防死循环）+ maxDepth=10 上限
  - monorepo 子包发现（命中 `package.json` 时自动探查 `apps/* / packages/*`）
  - `detectProjectRoot(inputPath, opts)` → `{ root, marker, description, fromPath, isFile, monorepoRoots }`
- **`action refreshRepo` 自动项目根检测**（`src/cli/commands/action.js`）—— 接受 `repoPath` 可选
  - 显式 `repoPath` 文件路径 → 向上找根；目录路径 → 用 detectProjectRoot
  - 不传 `repoPath` → 从 `process.cwd()` 向上找根
  - 输出 JSON 新增 `projectRoot: { path, source, marker, description }` 字段
- **蓝图交互操作**（`src/ontology/blueprintActions.js` + `src/ontology/viewer.js`）—— 借鉴 aos ActionPanel.tsx 设计
  - `buildActionCards({ selectedObjId, selectedObjType })` 结构化输出 4 张动作卡片
  - `renderActionCardHtml / renderActionCardsHtml` 按 ParamDef 自动渲染表单
  - 蓝图报告新增"交互操作"Tab：对象选择器（按 id/name/path 搜索 + 类型筛选）+ 动作卡片
  - 提交走 `fetch('/action', ...)` 调 `nice-aos serve` 端点（v0.32.0 集成）
- **增量解析器**（`src/analyzers/incrementalParser.js`）—— 借鉴 aos IncrementalParser 思路（无 tree-sitter）
  - `IncrementalParser` 类：LRU 缓存 `Map<filePath, {code, result}>`，默认容量 1000
  - `parse(filePath, code, analyzer)` 三态：缓存未命中 → 全量；命中且 code 未变 → 复用；code 变更 → 重算
  - 单例缓存（按 analyzer 类型隔离）：`getParser('ts') / 'vue' / ...`
  - `cachedAnalyze(analyzerName, analyzer)` 包装函数：零侵入集成
  - Git 集成：`listChangedFiles(repoRoot, since)` / `listStagedFiles` / `listUntrackedFiles`
  - 合并策略：`mergeSnapshotByFiles(oldSnapshot, changedFiles, newFileAnalyses)` by-id 替换

### 变更

- **`createBlueprint()` 兼容层保留** —— 既有 CLI（query / link / action）继续走 V1 路径，零迁移
- **`objectTypes` 增加 `kind: "object"|"interface"` 字段** —— 与 aos 对齐（nice-aos 现有 19 种类型均为 object）
- **现有 `/api/schema` 端点兼容新 schema** —— V2 engine 暴露 `engine.schema()` 形态一致

### 验证

- 全部 429 个测试通过（既有 322 + P0 30 + P1 26 + P2 23 + P3 28）
- 性能基准：1000 文件项目，10 个文件变更场景下，增量 < 全量 30%
- 既有 32 个测试文件（blueprintEngine / projectScanner / configAnalyzer / vueAnalyzer / tsAnalyzer / dartAnalyzer / goAnalyzer / rustAnalyzer / pythonAnalyzer / userScriptAnalyzer / sqlAnalyzer / propsChain / serviceBuilder / serviceAuditor / serviceViewer / dbBuilder / dbAuditor / dbViewer / deployBuilder / deployAuditor / deployViewer / planning / themes / serve / update / external-calls / routeMapView / data-model / nextRoutes / jsxRoutes / method-health / method-health）全通过

### 升级指引

```bash
npm install -g nice-aos@0.31.0
# 或:
npx nice-aos@0.31.0 action refreshRepo --params '{}'  # 自动从 cwd 找项目根
# 新增:蓝图报告交互操作 Tab（markReviewed / addNote / refreshRepo / analyzeFile）
nice-aos export --format html --output blueprint.html
```

## [0.30.0] - 2026-08-25

借鉴 asdm-aos 0.0.12 的 4 大能力：方法健康度 / 外部调用 / API 端点 / 数据模型 → 表链接 + 步骤化进度 + 元模型端点。详见 `docs/adr/0001-asdm-aos-borrowed-capabilities.md`。

### 新增

- **Method.health 子对象**：方法级代码健康度画像（圈复杂度 / 最大嵌套 / 分支数 / throw 数 / await 数 / 早期 return 数 / lambda 计数与 JSX 内联回调 / 测试方法识别 / `vi.mock` vs `jest.mock` 框架来源 / 派生 risk 评级 low/medium/high/critical）。统一承载 aos 的 complexity / isTest / lambdaCount / endpointInfo 4 个零散字段，单一 query 取全。接口方法无 body / Go 跨文件方法 / 非 ts 来源均使用 `placeholderHealth()` 兜底（向后兼容旧快照）
- **Method.externalCalls**：识别函数体里的 React Hooks（19 种）/ DOM API（14 种）/ 状态管理 API（11 种），输出 `[{ name, kind, framework, line }]`。不进入 `calls` 链接（旧 viewer 渲染契约不变），仅作 `query Method --where "externalCalls~useState"` 字段过滤
- **Method.endpointInfo**：API 端点装饰器级识别，覆盖 Next.js App Router（`app/api/.../route.ts` + `export async function GET/POST`）/ Next.js Pages Router（`pages/api/*.ts` + `handler(req,res)`）/ Nuxt 3（`server/api/*.get.ts` + `export default function`）
- **Method.sqlQueries**：从函数体字符串提取 SQL 表名（SELECT/INSERT/UPDATE/DELETE + 动态模板 `${name}`），4 个独立简单正则避免大字符串回溯爆炸；用作 mapsToTable 第二通道
- **Interface/Class.isDataModel + dataModelType**：类/接口名后缀启发式（DTO/Model/Entity/Schema/Request/Response/Params/Input/Output/Form/Payload → 对应类型）+ 装饰器识别（`@Entity/@ObjectType/@InputType/@Model/@ArgsType` → `orm-decorated`）
- **Interface/Class 链入 mapsToTable**：Class/Interface/Store/Service 作为 src 也能映射到 Table（之前仅 mappedTableIds 显式映射）
- **Dependency.isTypeDefinition**：标记 `@types/*` / `typescript` 类型定义包（仅 devDependency 时）。标记而非隐藏 —— 不破坏旧 query/link 行为
- **action 步骤化进度**：`refreshRepo --params '{"silent":false}'` 输出 5 步耗时（scan:start/done / parse:done / resolve:done / build:done）+ 人类可读汇总。默认 `silent=true` 保持 JSON 单一输出（向后兼容）
- **`/api/schema` 端点**：`nice-aos serve` 新增本体元模型端点，暴露 `OBJECT_TYPES`（19 个）/ `LINK_TYPES`（24 个）/ `ACTION_NAMES`（4 个）+ 概念元模型（abstractionLevels / categories）。借鉴 asdm-aos `ObjectTypeDef / LinkTypeDef / ActionDef` 设计，让外部 agent 自动发现能力

### 变更

- **mapsToTable 三通道匹配**（`src/ontology/blueprint.js`）：
  1. `mappedTableIds` 显式映射（dbModel.matchTablesToCodeEntities 设置）—— 兼容旧快照
  2. 自身 sqlQueries + 子方法聚合（Method/Class/Interface/Store/Service 都能映射）
  3. 命名约定：`UserEntity → users` / `Product → products` / `Class → classes`
- **mapsToTable ↔ mappedFromCode 共享** `collectTableIdsForEntity()` 私有函数，消除内联重复
- **asdm-aos 借鉴注释收敛**：24 处「借鉴 asdm-aos」注释统一指向 `docs/adr/0001-` ADR 文档（避免分散）

### 验证

- 全部 321 个测试通过（0.29.1 时 318 + methodHealth P1 修复回归 3 个）
- 端到端：`/api/schema` 返回 19/24/4 元模型；`silent:false` 输出 5 步耗时；`Method.health` 真实反映复杂度（renderPlanningMarkdown 17 圈复杂 → high）

### 升级指引

```bash
npm install -g nice-aos@0.30.0
# 或:
npx nice-aos@0.30.0 action refreshRepo --params '{"repoPath":"你的项目"}'
# 查看方法健康度:
nice-aos query Method --where "health.risk=critical"
# 查看本体元模型:
nice-aos serve  # 打开 http://127.0.0.1:8420/api/schema
```

## [0.29.1] - 2026-08-25

补 0.29.0 离线安装可用性：tgz 自带 `commander` / `typescript` / `yaml` 三个运行时依赖。

### 变更

- **`bundledDependencies` 加入 `commander` / `typescript` / `yaml`**：tgz 从 507 KB 增长到 4.8 MB，但安装时无需访问 npm registry
- **严格离线测试通过**：清空 npm cache + 阻断 registry 后 `npm install nice-aos-0.29.1.tgz` 880ms 完成，跑 `asdm-portal` 烟囱扫描正常

### 验证

- `npm install --offline` + `nice-aos --version` → 0.29.1
- asdm-portal 烟囱扫描：65 源文件 / 498ms / 0 错误

### 升级指引

```bash
# 已用 0.29.0 的用户：升级到 0.29.1 获得离线安装能力
npm install -g nice-aos@0.29.1
# 或用 tgz 离线装（无需网络）
scp nice-aos-0.29.1.tgz remote-host:~
ssh remote-host "npm install -g ./nice-aos-0.29.1.tgz"
```

## [0.29.0] - 2026-08-25

把"代码本体扫描"从 9 种主语言扩展为 **9 主语言 + 9 种配置/视图/SQL/部署文件**，并新增 `nice-aos-fullscan-skill` 一站式调度（代码 + 数据库 + 部署三套蓝图）。

### 新增

- **9 种配置/视图/SQL/部署文件纳入主本体扫描**（`src/analyzers/configAnalyzer.js`，200+ 行；与 `tsAnalyzer` / `vueAnalyzer` / `dartAnalyzer` / `goAnalyzer` / `rustAnalyzer` / `pythonAnalyzer` 平级）
  - **`.css`**：提取 `@import` URL / `@keyframes` 名 / CSS 自定义变量（`--xxx`）/ 顶层选择器（`.class` / `#id` / `tag`）
  - **`.html`**：提取 `<title>` / `<script src>` / `<link href>` / `<meta name|property>` / `id` 锚点
  - **`.sql`**：提取 `CREATE TABLE/VIEW/INDEX/FUNCTION/PROCEDURE/TRIGGER/SEQUENCE` 与 `DROP` 对象名（含 schema 限定名）；字符串字面量内的伪关键字不被误识别
  - **`.yml` / `.yaml`**：提取顶层 key + 二级 key + 强信号字段（`version` / `services` / `apiVersion` / `kind` / `image` / `metadata`）
  - **`.conf`**：支持 `[section]` + nginx 风格 `section { ... }` + nginx 指令（`key value;`）
  - **`.toml`**：`[section]` + `key = value`
  - **`.ini`**：`[section]` + `key = value`
  - **`.env` / `.env.development` / `.env.production` / `.env.local`**：仅提取 KEY 名（不取 value，敏感信息保护）；路径后追加 `#env` 标记供 builder 还原真实文件名
- **`projectScanner.SOURCE_EXTENSIONS` 扩展**：在原 9 种主语言上增加 `.css .html .sql .yml .yaml .conf .toml .ini .env`
- **`.env.*` 文件规范化**：`path.extname('.env.development')` 返回 `.development` 不在白名单 — 在 `walk` 阶段按文件名匹配并把扩展名规范化为 `env`，避免漏扫
- **`resolveRoots` 自动双根**：项目有 `src/` 时返回 `['src', '.']`（之前只有 `['src']`），让顶层 `.env*` / `index.html` / `*.conf` / `nginx.conf` 不被遗漏；`walk` 阶段按 relPath 去重（`seen` Set）避免重复
- **SourceFile 新增 3 字段**（蓝图展示用）：
  - `configKind`：css / html / sql / yaml / config
  - `configItems`：顶层 key / 标签 / 对象名 / 嵌套结构数组（最大 100 项 / 文件）
  - `configTruncated`：文件 > 2MB 时跳过详细解析仍算行数
- **`nice-aos-fullscan-skill`**（`skills/nice-aos-fullscan-skill/SKILL.md`）：一站式全栈扫描调度，标准工作流含 `_scan.sh` 批量模板

### 安全

- `.env` 文件分析**仅提取 KEY 名**（`parseEnv` 函数不取 value），避免把数据库密码 / API Key 写入 snapshot / 蓝图

### 验证

- 新增 `test/configAnalyzer.test.mjs`（11 个测试：CSS / HTML / SQL / YAML / INI / CONF / TOML / .env / 行数 / 大文件 / 磁盘 / 未识别 ext）
- 全套测试 266/266 通过（`node --test test/*.test.mjs`）

## [0.28.1] - 2026-08-25

补 0.28.0 周期内已存在但未发布的本地特性，并清理 release 副作用。

### 新增

- **Python 后端脚本分析子系统**（`src/analyzers/pythonAnalyzer.js`，1000+ 行，参照 `tsAnalyzer` / `vueAnalyzer` / `dartAnalyzer` / `goAnalyzer` / `rustAnalyzer` 平级设计、逻辑完全独立）
  - **实体映射**（对齐 TS/Rust/Dart 语义）：
    - `class X(Base, Mixin, metaclass=Meta): ...` → `Class`（kind: class；bases 抽末段类型名；`metaclass=` 抽到 `metaclassName`）
    - 含 `@abstractmethod` 或继承 `ABC` 且只有抽象方法的 class → `Interface`
    - `def f(...)` / `async def f(...)` → `Method`（`ownerKind=class`）；模块级 `def` → `moduleFunctions`
    - `@property` / `@staticmethod` / `@classmethod` / `@abstractmethod` / 自定义装饰器 → `methods[].decorators[]`（含 `kind` 标签）
    - `import X` / `from X import Y` / `from X import Y as Z` / `from X import *` → `imports`（`importMap` 含 local→specifier 与 from 子名映射）
    - `__init__` / `__str__` / `__repr__` / `__enter__`/`__exit__` 等 dunder → `methods[].isDunder=true + dunderCategory` 语义标签
    - `__all__ = [...]` → `pythonExports`（模块公开符号清单）
    - `if __name__ == "__main__":` → `pythonEntryPoints`（脚本入口）
    - `@app.command` / `@click.command` / `@typer.command` 装饰器 → `pythonEntryPoints`（CLI 入口）
    - 方法/函数体内调用 → `callEdges`（`self.method()` / `cls.method()` / `Class.method()` / `pkg.func()` / `new Class()`）
    - `@app.get/post/put/delete/patch` + `@app.route` / `@router.get` 系列 → `pythonRoutes`（method/path/handler/target）
  - **双通道噪声剥离**：`stripPythonNoise`（全剥离：f-string 插值 + 三引号/单引号/字节串 + 注释）供块状态机与调用提取；`stripCommentsOnly`（仅剥注释）供 import / 装饰器字符串 / 路由 path / `__all__` 列表 / docstring 提取
- **批量 Python AST 语法校验**（`checkPythonSyntaxBulk`）
  - 一次性 spawn `python3` 调 `ast.parse`，把失败文件登记到模块级 `pythonSyntaxErrors` Map
  - `analyzePythonFileFromDisk` 检测到当前文件失败时主动 throw（`code='PYTHON_SYNTAX_ERROR'`），由 `builder.js` 的 try/catch 写入 `Project.analysisErrors`
  - **关键价值**：`pythonAnalyzer` 是基于缩进的轻量级块结构匹配，原先对 `SyntaxError` 文件会"静默成功"。批量 AST 校验把这类问题暴露在 `analysisErrors`，不污染下游本体
  - 性能：TheAlgorithms/Python 1382 个 .py 文件批量校验 0.3 秒
- **`projectScanner` 识别 `.py` 文件**（`SOURCE_EXTENSIONS` 加入 `.py`，`scanProject` 输出 `pyFileCount`，`buildProject` 汇总 `pyFileCount`）
- **`action analyzeFile` 支持 `.py` 文件**（之前提示只支持 `.ts/.tsx/.js/.jsx/.mjs/.vue/.rs/.dart`）
- **`pythonAnalyzer.test.mjs` 测试套件**（`test/pythonAnalyzer.test.mjs`）—— 覆盖 class / 装饰器 / dunder / import / 路由 / 入口点 / 自定义 Analyzer 调用链聚合
- `package.json` `description` 与 `keywords` 同步纳入 Python（description 加入 "Python 后端脚本分析 CLI"，keywords 追加 `python`）
- `scanProject` 沿用 `pub` / `npm` 同级设计：识别 `.py` 后自动进入 `Project.pyFileCount` / `Project.language`（追加 "Python"）

### 修复

- **`package.json` self-dependency 残留**：dependencies 列表曾含 `"nice-aos": "^0.23.0"`（自我引用），会导致 `npm install nice-aos` 拉一个旧版副本。清理后 tarball 不再带 self-dep（`npm pack --dry-run` 验证 `total files` 由 68 → 67）

### 验证

- `npm test`：255/255 通过（含新增 `pythonAnalyzer.test.mjs`）
- `npm pack --dry-run`：67 files、494.9 kB、sha512 已记录
- TheAlgorithms/Python 端到端：1382 个 .py、308 Class、3844 Method、12 个 `analysisErrors`（全部为 Python 2 风格 `except X, Y:` 未加括号）
- nice-aos 自家项目（无 .py）：0 errors，行为不变

## [0.28.0] - 2026-08-24

### 新增

- **产品规划 / PRD 文档蓝图子系统**：扫描产品规划管理库（特性 PRD Markdown + Modules/ 目录 + 进展报告 + Roadmap 文档），产出**规划模型 `planning-snapshot.json`** 与自包含 **产品规划蓝图 HTML（7 Tab：总览 / 特性 / 模块 / 图谱 / 迭代与发布 / Roadmap 与战略 / 审计）**
  - 数据流：planning-snapshot.json（PlanningModel）→ `buildPlanningViewerModel()`（视图模型）→ `renderPlanningBlueprintHtml()`（HTML）
  - 实体类型（query 命令空间）：features / modules / releases / milestones / themes / dependencies
  - 状态归一化：emoji → key（🟢→done / 🟡→implementing / 🟠→designing / 🟣→clarifying / 🔴→blocked）+ 关键词 fallback（"阻塞/风险/有问题"→blocked，"实现中/开发中/进行中"→implementing，"澄清中/待确认/评审中"→clarifying …）；未命中归 `unknown`
  - 优先级归一化：P0/P1/P2/P3 + 高/中/低
  - 模块解析：合并特性表「分类」+ Modules/ 目录文档，模块标签去数字前缀（`01-` `02-`）
  - 迭代里程碑：扫描所有表，取首列形如 `v1.x` 的版本规划行
  - 四维健康审计：`coverage` 覆盖完整性 / `statusHealth` 状态健康 / `dependencyRisk` 依赖风险 / `releasePlanning` 版本规划
  - **CLI 命令组 `planning`**：`planning scan / snapshot / view / query / audit`
- **`skills/nice-aos-planning-skill/`** 产品规划 Skill：编排产品规划文档扫描 + 规划蓝图生成 + 四维审计 + 蓝图 AI 助手适配 `planning-viewer-data`
- **`contrib/blueprint-ai-agent` 适配产品规划蓝图**：页面类型检测新增 `planning-viewer-data` → 切换为"产品规划蓝图"智能体（10 个专属工具：概览/特性/模块/图谱/迭代与发布/Roadmap/审计/维度/状态分布/优先级分布），系统提示词、建议问题、FAB 与启动日志同步适配
- **图谱 2.0**（参考 `src/deployment/deployViewer.js` 的依赖图实现）。`src/planning/docsViewer.js` 重写图谱渲染块，提供：
  - **统一交互基础设施**：`graph-container` 包住 SVG 容器 + 右上 `graph-toolbar`（缩放 −/+/重置）+ 左下 `graph-legend`（状态色 dot + 边类型）+ 操作提示（"滚轮缩放 · 拖拽平移 · 点击节点高亮"）。所有交互通过修改 SVG `viewBox` 实现（缩放、平移、重置），无需第三方库
  - **节点结构升级**：从 `<circle>` 升级为 `<g class="g-node" data-id="...">` 包裹，绑定 `mousedown`/`click`/`wheel` 事件——点击节点高亮关联边（其它边 + 节点 `.dim` 透明度 0.08/0.18），再点空白或节点本身取消高亮
  - **`forceLayout` 改为确定性**：初始位置用 id FNV-1a 哈希替代 `Math.random()`——同输入恒出同位置，杜绝切 tab/重渲染时的"图谱抖动"
  - **`特性 × 模块` 改用分层分列布局**（借鉴 deployViewer 的 `LAYER_ORDER` 思路）：左列每个模块一格 + 右列特性汇总 + 列背景框 + 列标签，连接线带箭头 `marker-end`；不再抖动，节点密度可读
  - **图例 + 空状态**：`drawGraph` 支持 `legend: [{label,color,kind:'node'|'edge'}]` 与 `emptyMsg`，分情况渲染状态色 + 边类型图例
- `src/themes/index.js` 注册 `planning` 主题（沿用 `deep-blue` 配色）

### 修复

- 模块卡片 `X 特性` 标签：`docsScanner.buildModules` 产出对象无 `featureCount` 字段导致前端显示 "undefined 特性"。改为从 `m.featureIds` 兜底计算，**未识别到特性时整段标签隐藏**（不显示 `0 特性` 冗余、不显示 `undefined` 字面值）
- 发布卡片 `X 迭代 · Y 特性` 标签同步隐藏逻辑：迭代数与特性数都为 0 时整段 meta 标签隐藏

### 新增测试

- `图谱 HTML 模板含 toolbar / legend / viewBox 占位 + 脚本挂载交互`
- `特性依赖图节点为 g.g-node + 边为 path.g-edge，数据属性可定位高亮`
- `特性 × 模块图为分层分列布局：列背景 + 模块节点 + 特性节点`
- `图例渲染：状态色节点 + 边类型`
- `forceLayout 确定性：相同输入两次结果完全一致（同 id → 同坐标）`
- `test/planning.test.mjs` 新增 12 项产品规划子系统测试：`statusKey 状态归一化 / parseMarkdownTables 解析表格 / extractOverview 提取功能概述 / scanPlanningModel 解析特性/模块/依赖/里程碑/发布/主题 / snapshot 往返 / buildPlanningViewerModel 视图模型字段齐全 / renderPlanningBlueprintHtml 含 planning-viewer-data 且可解析 / auditHealth 输出四维审计 / 蓝图浏览器脚本运行时冒烟 / 图谱无内容时隐藏图谱 Tab 与子视图 / 仅特性依赖无模块归属时隐藏「特性 × 模块」子视图并切换默认激活 / 仅模块归属无依赖时隐藏「特性依赖」子视图并默认激活「特性 × 模块」`

## [0.27.0] - 2026-08-24

### 新增

- **nice-aos-code-review-skill**：综合代码评审 Skill（严格超集 `nice-aos-deadcode-skill`）。在四级死代码（文件/导出/类型/函数）清理工作流之上，整合 nice-aos 本体快照 + asdm-aos 服务模型（含五维健康审计 complexity/dataHealth/testCoverage/analysisQuality/dependencyHealth）+ 代码/服务蓝图（`export --format html|viewmodel`）+ 外部扫描 JSON（ESLint/Sonar/Checkstyle/Semgrep/Trivy/npm audit），编排七步流水线：**装配 → 通用维度 → 领域维度 → 死代码 → 后端服务 → 外部扫描融合 → 报告输出与 markReviewed 闭环**。规则按 ASDM code-review v2.0 的领域驱动模型扩展为 4 组共 **11 维度 + 50+ 规则 ID**（ARCH/TYPE/PERF/UX/SEC/STYLE 通用 + DOMAIN/REUSE/COUPLE/COHESION 领域 + DEAD-FILE/EXPORT/TYPE/FN 死代码 + BACK-CX/DATA/TEST/QA/DEP 后端）。报告模板 `spec/review-template.md` 含五维评分 + 死代码清单 + 外部扫描融合 + markReviewed 跨会话闭环；评级 P0~P3（CRITICAL/MAJOR/MINOR/INFO）。继承 nice-aos-deadcode-skill 全部规则矩阵（含判定豁免：命名空间导入 / `export *` / 动态 import / 接口方法永不判死 / 油猴 ScriptFunction 额外豁免），并明确边界——死代码**清理动作**（删除实体）仍由 deadcode skill 承载，本 Skill 仅输出评审报告
- `spec/review-rules.md` 通用+领域+死代码完整规则矩阵（含 PROJ-01~05 项目特定规则）
- `spec/backend-review-rules.md` 后端服务五维规则 + 蓝图评审 4 条
- `spec/review-template.md` 综合评审 Markdown 报告模板（11 维度小计表 + 死代码清单 + 外部扫描融合表 + markReviewed 闭环表）
- `reports/` 评审报告输出目录（gitkeep 占位）

### 变更

- `.gitignore` 新增 `.workbuddy/`（本地 memory 文件）与 `*-service-blueprint.html`（本地生成的服务蓝图）—— 避免误提交
- SKILL.md 系列继续保持 **`nice-aos-skill`（核心查询） / `nice-aos-deadcode-skill`（死代码清理） / `nice-aos-userscript-skill`（油猴审计） / `nice-aos-database-skill`（数据库） / `nice-aos-deployment-skill`（部署） / `nice-aos-service-skill`（后端服务查询） / `asdm-aos-skill`（Java 本体）** 七系生态 + **新增 `nice-aos-code-review-skill`（综合评审）**，职责边界明确

### 不变更

- nice-aos-deadcode-skill 的全部清理动作（删除 / `markReviewed` / `addNote`）保持不变——本 Skill 仅消费其四级候选清单，不接管清理

## [0.26.0] - 2026-08-24

### 新增

- **Java 后端服务蓝图**（基于 asdm-aos 本体快照）：新增 `service` 命令组，消费 asdm-aos 工具产出的 Java 后端本体快照（`snapshot.json`，含包/类/接口/方法/调用关系/DDL 表/依赖）构建后端服务模型，产出分析 JSON 与自包含服务蓝图 HTML（`service-blueprint.html`，9 Tab：总览/模块/分层/**图谱**/API 面/数据层/依赖与集成/代码质量/健康审计）
- **图谱 Tab**（力导向图，内联力模拟零依赖）：三种视图——**模块图谱**（节点=服务模块，大小 ∝ 类数；边=包依赖 `Package.dependsOnPackageIds`（蓝）+ 跨模块方法调用（绿），排除 other 噪声模块）、**分层调用流**（节点=架构分层，边=跨层方法调用，宽度 ∝ 调用次数，如 Controller→Service→Repository→Entity，实测 service→entity ×5310）、**模块×技术栈**（二分图：模块 + 技术分类（紫），边=模块使用该技术 `Package.dependencyIds`）；交互：拖拽节点/滚轮缩放/拖空白平移/点击聚焦高亮邻接
- **蓝图 AI 助手适配服务蓝图**（`contrib/blueprint-ai-agent`）：页面类型检测新增 `service-viewer-data` → 「服务蓝图」智能体（10 个专属工具：概览/模块/分层/端点/表/依赖技术栈/代码质量/健康审计/审计明细/图谱查询），系统提示词、建议问题、设置面板快照地址、FAB 与启动日志同步适配
- **模块动态推导**（`serviceModel.js` `deriveModuleRules`）：模块规则**不硬编码**——首次构建从快照包结构动态推导（基础包多数前缀 + 分层关键词守门员 + 单模块仓库坍缩），写入模块配置文件 `service-modules.json`（默认 `serviceSnapshotDir` 下），后续构建自动加载；`--module-prefix` 临时覆盖 / `--module-config` 指定配置文件，切换后端项目无需改代码
- **分层判定**（`serviceModel.js` `detectLayer`）：注解（`@RestController`/`@Service`/`@Repository`/`@Entity`/`@Configuration`/`@Mapper`）→ 类名后缀 → 包名关键词，覆盖 Controller/Service/Repository/Mapper/Entity/DTO/Config/Adapter/任务/工具 11 层
- **技术栈判定**（`serviceModel.js` `TECH_STACK_RULES`）：33 条依赖名正则，具体 starter（data-jpa/data-redis/security/webflux…）优先于泛型 spring-boot，识别 JPA/MyBatis/Spring Security/JJWT/ShedLock/SpringDoc/Redis/ES/S3/OBS/MinIO/OkHttp/MySQL 等
- **五维健康审计**（`serviceAuditor.js`）：代码复杂度 / 数据层健康 / 测试覆盖率 / 分析质量 / 依赖健康加权评分（含评分环 SVG）
- **CLI 命令**：`service build --snapshot <path>`（构建+保存模型）、`service export [--format json|html|viewmodel] [--snapshot <path>]`（支持直接指定快照 json 路径一步生成蓝图）、`service query <type>`（14 种对象）、`service audit health|all`
- 全局选项 `--service-snapshot-dir`；默认主题映射 `DEFAULT_THEMES.service = 'elegant-purple'`

### 变更

- `src/themes/index.js`：`DEFAULT_THEMES` 新增 `service` 条目
- 服务快照文件：`service-snapshot.json` / `service-modules.json`（与代码/数据库/部署快照分离，均在服务快照目录）
- **分层判定修复**：`domain` 包关键词从 `util` 改为 `entity`（DDD/MyBatis 项目的 POJO 位于 domain 包，leaniss-system-core 实测实体层 4→100 类）；接口补充 `layerKey` 判定（Mapper/Repository 接口归入对应分层，Mapper 接口 65 个、Repository 接口 3 个）
- **审计修正（代码审核发现）**：复杂度热点占比改为从全量方法重算（`complexityHotspots` 是 TOP50 展示截断列表，此前以截断列表计算占比，asdm-admin 实测热点数 50→159）；依赖多版本检测只比较具体版本号，忽略 Maven 属性占位符（`${xxx.version}`）与空版本（消除 asdm-admin 4 条误报 error，依赖健康 60→90，综合 77/C→82/B）
- **模块配置跨仓库防串用**：加载 `service-modules.json` 时校验 `repositoryName`，与快照仓库不符（切项目残留）则忽略并重新推导，CLI 输出警告并记入 `_meta.moduleConfigWarning`
- **口径统一与瘦身**：仓库级 `classCount` 与 `stats.classCount` 一致（不含枚举，asdm-admin 1878→1801）；服务蓝图 HTML 审计数据去重（`health.audits` 不再重复内嵌），热点标题显示实际条数（cc≥15，TOP n）

### 验证

- 221 个单元测试全过，零回归（新增 `serviceBuilder` / `serviceViewer` / `serviceAuditor` 25 个）
- 端到端实测：asdm-admin 本体快照（3583 文件/335 包/1878 类/189 接口/20408 方法/799 端点/107 表/55 依赖），模块动态推导与报告手写模块完全一致（core 960 类/adapter 282/integration 124/agentorbit 99/orgmapping 98/telemetry 81/file 49/sso 41/mcp 26/portal 118），热点 TOP3（圈复杂度 74/69/59）与测试统计（1154 单元/47 集成）均与报告一致；五维健康评分 82/B（复杂度 97：全量 159 个 cc≥15 热点；依赖 90：占位符误报清零）
- **leaniss-system-core 实测（引入 asdm-aos-skill 后）**：asdm-aos 扫描（577 Java 文件/464 类/157 接口/5581 方法/86 依赖/3316 DDL 表/63 Mapper）→ 后端服务蓝图（7 模块 common 126 类/system 120/manager 149/job 38/file 9/gateway 14/auth 8；技术栈 jjwt/quartz/springdoc/redis/minio/feign/mysql；448 端点；模块图谱 22 边）；另建前端（Vue2，163 组件/132 路由/67 领域）、数据库（Sprint 布局，80 迁移/106 表/6 库/11 领域）、部署（19 服务/15 路由/5 中间件）三类蓝图，四蓝图 HTML 内嵌数据与脚本均验证通过

## [0.25.0] - 2026-08-24

### 新增

- **代码↔数据库跨层审计**（借鉴 Java AOS 实体-表融合思路）：第 9 个审计场景 `db audit crosslayer`——孤儿表检测（无代码实体映射的表）、隐式外键识别（`*_id` 列无显式 FK 约束）、代码实体覆盖率、幽灵类型检测（代码有 Interface 但无对应数据库表）
- **跨层命名约定匹配**（`dbModel.js`）：`matchTablesToCodeEntities()` 三级匹配策略（精确→命名约定→子串），snake_case 表名 ↔ PascalCase 接口名自动关联（`user_roles` → `UserRole`）
- **前端数据模型类型识别**（`dbModel.js`）：`FRONTEND_DATA_MODEL_RULES` 5 种类型——API Response Type / API Request Type / Store Model / Entity Interface / Table Mirror
- **跨层链接类型**（`blueprint.js`）：新增 `mapsToTable`（Interface/Class/Store → Table）和 `mappedFromCode`（Table → Interface/Class/Store）两种链接，支持代码↔数据库双向遍历
- **CLI 命令**：`db audit crosslayer [--code-snapshot <path>]`；`db audit all` 新增 `--code-snapshot` 选项自动启用跨层审计

### 变更

- `dbModel.js` 导出新增：`tableNameToCandidateNames`、`codeNameToCandidateNames`、`matchTablesToCodeEntities`、`FRONTEND_DATA_MODEL_RULES`、`detectDataModelType`
- `LINK_TYPES` 从 22 种扩展为 24 种（+`mapsToTable` / `mappedFromCode`）
- 数据库 Skill SKILL.md 同步更新：9 大审计场景、跨层审计章节、触发场景、Agent 行为规则

### 验证

- 195 个单元测试全过，零回归
- 端到端实测：asdm-admin deploy 目录（141 文件/53 服务/35 路由/6 中间件），5 维审计评分（健康度 76/C、安全性 60/D、高可用 76/C、一致性 96/A、依赖 82/B）

## [0.24.0] - 2026-08-24

### 新增

- **数据统计 Tab**（数据库蓝图 dataoverview）：参考代码蓝图「代码统计」（9bbd034）为数据库脚本分析补齐规模画像——KPI 卡片（数据表 / 列总数 / 外键 / 索引 / 迁移版本 / 平均每表列数，视图/触发器/存储过程徽章）、领域数据量分布条形图（按列数排序，附表数/外键数/占比）、领域列数占比环形图（纯 SVG `stroke-dasharray`，r=15.9155 周长=100 直用百分比，领域沿用自身配色）、DDL/DML 操作分布（全部迁移 `operationSummary` 累计：CREATE TABLE/ALTER/INDEX/DROP/VIEW/TRIGGER/PROC/FUNC/INSERT/UPDATE）、列类型分布（归一化基础类型：`VARCHAR(255)`→VARCHAR、`INT UNSIGNED`→INT）、Top 20 宽表（按列数 + 领域/FK/索引/注释）、迁移版本操作量 Top 10 表格
- **数据图谱 Tab**（数据库蓝图 dataoverview）：表 / 领域两级关系网络的**力导向图**（内联力模拟零依赖：库仑斥力 + 弹簧引力 + 向心重力 + 速度阻尼，320 步冷却布局，与代码蓝图代码图谱同一套参数）——表图谱节点 = 表（大小 ∝ 列数，颜色 = 领域，节点携带服务端配色免客户端映射）、边 = 外键引用（同向 FK 聚合权重，粗细 ∝ FK 数）；领域图谱节点 = 领域（大小 ∝ 表数）、边 = 跨领域外键耦合；交互：拖拽节点实时重算、滚轮缩放、空白平移、点击聚焦邻接高亮（显示列/外键/索引/领域/首建版本/注释与邻接边数）、表/领域视图切换、重新布局、重置视图

### 变更

- `buildDbViewerModel` 视图模型新增 `stats` 与 `dataGraph` 两个聚合（纯函数，可供 AI agent 直接消费 `db export --format viewmodel`）；无表数据时置空并隐藏对应 Tab
- 数据图谱保护上限：表视图节点 ≤ 150（按 FK 度数 + 列数排序截断，`hiddenTableCount` 提示未展示小表）、领域节点 ≤ 24、边 ≤ 600；悬挂外键（指向不存在表）不建边；领域视图排除域内 FK 与自环
- 多数据库场景领域键对齐：统计与图谱统一使用 `db:domain` 复合键（与 `buildDomainsArray` 一致）

### 修复

- **演进分析图表空白**（数据库蓝图）：`auditEvolution` 读取 `m.operations` 数组 / `m.tableCount` 字段，而 `dbBuilder` 产出的迁移只携带 `operationSummary` 对象——导致真实扫描下表数增长曲线恒为 0、操作类型分布无柱条、演进趋势占比恒 0%；现兼容两种形态（`operationSummary` 主路径 + `operations` 旧形态），操作大类按 operationSummary 键映射（CREATE/ALTER/INDEX/DROP/DML/其他），增长曲线优先按当前表 `createdAt` 精确累计（终点 = 当前表数，重建表不重复计数），无 createdAt 时退回 CREATE-DROP 净增近似
- **顶部统计卡片窄屏错乱**（数据库蓝图）：flex 布局（`flex: 1 1 90px`）在约 780-800px 宽度下出现"第一行挤压 7 张窄卡 + 第二行 1 张孤卡被 grow 拉伸占满整行"；改为固定 8 项网格 `repeat(8, 1fr)`，≤1080px 切 4 列、≤560px 切 2 列，任意宽度下卡片等宽铺满
- **演进分析图表宽屏横向拉伸变形**（数据库蓝图）：图表渲染 IIFE 在页面加载时执行，而该 Tab 默认 `display:none`，`getBoundingClientRect()` 量宽为 0 后回退 480 假宽度，叠加 `preserveAspectRatio="none"` + `width:100%` 在 1500px 视口下被横向拉伸 3.1 倍——曲线压扁、X 轴版本号文字剪切变形、数据点变椭圆、堆叠柱挤成一片；重构为惰性渲染 `renderEvolution()`（与 ER 图同一模式）：隐藏时跳过图表绘制、Tab 激活时按实测宽度 1:1 绘制（viewBox 严格等于容器像素宽、显式 width/height、移除 preserveAspectRatio=none）、窗口 resize 防抖重绘、静态部分（图例/领域首版/趋势/里程碑）只渲染一次

### 验证

- 195 个单元测试全过（`test/dbViewer.test.mjs` 新增 6 个：stats/dataGraph 模型聚合（领域分布/操作累计/列类型归一化/FK 聚合权重/悬挂外键排除/跨域边）+ DOM stub 执行内嵌脚本渲染产物（KPI/环形图/力导向 SVG 无 NaN 且坐标在画布内 + 演进图表有曲线与柱条 + 卡片网格 CSS）+ 演进分析 operationSummary 聚合 + 演进图表惰性渲染（隐藏时不绘制 / Tab 激活按实测宽度绘制 / resize 重绘 / 无 preserveAspectRatio）+ 空数据容错）
- 端到端实测：sprint 布局 SQL 目录 `db scan` → `db export --format html`，5 表/19 列/5 领域全链路正确；真实浏览器验证两个新 Tab 渲染、表/领域视图切换、节点点击聚焦（user_info → 3 邻接高亮 + 元信息）
- 修复项实测（asdm-admin 真实库）：migrations（140 迁移/95 表）与 mysql-telemetry（8 迁移/6 表）演进分析均出数——telemetry 早期 CREATE 63% / 后期 ALTER 95%、11 根操作柱条、里程碑出现；顶部卡片 780px 下 4+4 两行等宽铺满（修复前 7 张 94px + 1 张 732px 孤卡）
- 图表变形修复几何级验证：1500px 视口下 Tab 激活前 viewBox 为空（隐藏不绘制），激活后 viewBox=1403=容器实测像素宽、preserveAspectRatio 已移除（修复前 viewBox=480 被拉伸 3.1 倍）；视觉复检 X 轴版本号字形端正无剪切、数据点为正圆、柱条宽度正常；窗口 resize 防抖重绘跟随新宽度

## [0.23.0] - 2026-08-23

### 新增

- **代码统计 Tab**（蓝图查看器）：行数 / 文件 / 单元规模画像——KPI 卡片（代码总行数 / 源文件总数 / 一级模块 / 代码单元 / 平均单文件行数 / 测试文件）、模块代码量分布条形图、代码分布占比环形图（纯 SVG `stroke-dasharray`，r=15.9155 周长=100 直用百分比）、语言分布（按行数）、架构层分布、Top 20 代码单元（组件/Hook/Store/服务混合按行数）、最大文件 Top 15 表格
- **代码图谱 Tab**（蓝图查看器）：模块 / 组件两级依赖网络的**力导向图**（内联力模拟零依赖：库仑斥力 + 弹簧引力 + 向心重力 + 速度阻尼，320 步冷却布局）；模块视图节点 = 二级以内模块（边 = 文件导入聚合权重）、组件视图节点 = 组件/Store（props 传递 / 文件导入 / useStore 三种边）；节点大小 ∝ 代码行数，Top 节点带标签；交互：拖拽节点实时重算、滚轮缩放、空白平移、点击聚焦邻接高亮、模块/组件视图切换、重新布局、重置视图
- **隐式 usesStore 边**：unplugin-auto-import 场景组件直接调用 `useXxxStore()` 而无 import 语句，静态导入图缺失该边——`vueAnalyzer` 组件 facts 新增 `storeCalls`（`useXxxStore` 经 useCalls + `globalStore` 等非 use 前缀形态经 setup storeVars）；builder post-pass 以**全局 Store 名单**匹配调用名解析为 `Component.storeIds`（零误报：不在名单内的 useXxx 不会误判）；blueprint `usesStore` 链接双向合并 import 与隐式使用；组件图谱 usesStore 边同步补齐

### 变更

- 模块统计粒度自动下钻：顶层分区过少（单 `src/` 根或融合仓库）时下钻一层，让粒度对齐真实代码分区（components/services 等）
- 代码图谱排除"全部代码聚合"的单一根模块巨型节点（与模块统计下钻逻辑对齐）；`hiddenModuleCount` 不再计入被排除的根
- 扩展名归一化：各分析器格式不一（ts: `tsx`；dart/rs: `.dart`），统一去点后再聚合语言分布

### 验证

- 189 个单元测试全过（viewer 新增 3 个：stats/codeGraph 模型聚合 + DOM stub 执行内嵌脚本渲染产物 + 隐式 usesStore 全链路；vueAnalyzer 新增 1 个：storeCalls 双命名形态）
- 四技术栈实测：nice-today-2.0（React+TS，1591 文件/55 万行）、nice-today-web-2.0（React+Tauri）、gameStore_flutter（Flutter+Riverpod，usesStore 11 条）、steam-stat（Vue3+Electron+Pinia，隐式边 0→43 条，31/207 组件解析出 storeIds 与源码 rg 结果一致）；力模拟坐标零越界零 NaN，产物自包含（无外部 CDN）

## [0.22.0] - 2026-08-23

### 新增

- **蓝图 CSS 主题化（`--theme`）**：三个蓝图查看器（部署 / 数据库 / 代码）的内嵌 CSS 拆分为「主题 token + 共享骨架 + 查看器专属布局」三段——布局骨架固定在 HTML 蓝图中，视觉风格按主题切换（参考 sglv-shared-css 的 CSS 变量 token 模式）
- **主题注册表**（`src/themes/index.js`）：`deep-blue`（深蓝暗色，GitHub dark 配色）、`fresh-green`（淡绿清新浅色主题：白卡片 + 深绿主色 `#1e7f5c`，语义色调深保证浅背景可读）与 `elegant-purple`（典雅紫暗色：深紫夜幕底 `#12101f` + 紫主色 `#a78bfa` + 粉紫点缀，玻璃质感）三个主题，`THEMES` 对象可无限扩展；`resolveTheme()` / `buildThemeCss()` / `listThemeNames()`
- **炫彩评分圆环**（`src/themes/ring.js`）：健康审计评分由普通 border 圆圈升级为 SVG 能量环（参考 steam-family-analysis 家庭健康分设计）——渐变弧（from → 分数插值色 → to）+ feGaussianBlur 辉光滤镜 + 圆头端点 + 顶部起始 + 1.1s 加载动画 + aria-label；客户端读取 `<html data-theme>` 按主题取环配色：deep-blue 紫→绿（分数越高越绿）、fresh-green 淡绿→深绿、elegant-purple 紫→粉
- **维度得分条渐变辉光**：健康审计维度进度条升级为渐变填充（`--bar-c` CSS 变量驱动 `color-mix` 渐变 + 辉光阴影）
- **共享骨架样式**（`src/themes/sharedCss.js`）：三个查看器完全一致的基础规则（body/header/统计卡片/标签页/面板/卡片网格/表格/搜索栏/健康仪表盘/响应式断点），透明色一律用 `color-mix()` 从主题变量派生，无硬编码 rgba
- **CLI `--theme` 选项**：`deploy export`（默认 deep-blue）、`db export`（默认 fresh-green）、`export`（默认 deep-blue）均支持主题切换，未知主题名报错并列出可选项
- **HTML 主题标记**：`<html data-theme="...">` + `:root[data-theme="..."]` 变量块，便于调试与未来 CSS 钩子
- **无障碍与原生控件适配**：主题块输出 `color-scheme: dark/light`（暗色主题下滚动条/输入框跟随）；圆环动画与卡片过渡在 `prefers-reduced-motion: reduce` 下自动禁用

### 变更

- **CSS 内硬编码透明色全部变量化**：`rgba(88,166,255,.4)` 之类改为 `color-mix(in srgb, var(--blue) 40%, transparent)`，主题切换时边框/悬停/热度色等透明变体自动跟随
- **代码蓝图（blueprint）语义色统一**：`--green` `#3fb950`→`#4ade80`、`--purple` `#bc8cff`→`#a78bfa`，与部署/数据库蓝图在 deep-blue 主题下完全一致（消除三个查看器间的历史色值漂移）；`--teal`/`--go` 作为代码蓝图私有变量经 `buildThemeCss` 追加
- **数据库蓝图（dataoverview）默认主题改为 fresh-green**：外观由深色变为淡绿浅色（用户场景示例"数据分析是淡绿色风格"），可通过 `--theme deep-blue` 切回深色
- 查看器专属布局样式（部署拓扑层 / ER 图 / UML 类图 / 路由树等）原样保留在各 viewer 中，DOM 结构与 class 名零改动——油猴脚本页面检测（`#deploy-viewer-data` / `#db-viewer-data` / `#viewer-data`）与 JS 渲染逻辑不受影响

### 验证

- 185 个单元测试全过（`test/themes.test.mjs` 13 个：注册表解析 / 变量块生成 / 私有变量追加 / 共享骨架完整性 / 三查看器默认主题与切换 / 圆环三主题配置 / 圆环客户端函数模拟 DOM 执行 / 产物注入）
- 产物逐份验证：deploy×deep-blue、db×fresh-green、db×elegant-purple、deploy×elegant-purple——每份含 `data-theme` 标记、圆环客户端代码、专属样式齐全
- 圆环端到端模拟：用产物内嵌真实健康数据（分数 90 / 等级 A）执行渲染，渐变端点、插值色、辉光滤镜、aria-label 全部正确
- CLI 错误路径：未知主题名 → 报错并列出 `deep-blue / fresh-green / elegant-purple`

## [0.21.0] - 2026-08-23

### 新增

- **部署配置目录分析（`nice-aos deploy`）**：扫描项目部署目录（如 `./deploy`），解析五类配置文件——docker-compose（`.yml`/`.yaml`）、K8s manifest（Deployment/Service/Ingress/ConfigMap/Secret/Job/CronJob）、Dockerfile（`Dockerfile*`）、nginx 配置（`nginx.conf`/`*.conf`）、环境文件（`.env`/`*.env`）与部署 shell 脚本，产出独立部署架构模型快照（`deploy-snapshot.json`，SHA-256 manifest 支持增量扫描）
- **服务归一化与跨文件合并**：compose 多文件（override/分环境）与 K8s manifest 定义的同名服务自动合并（名称归一化：小写 + 下划线转连字符；优先取首个非空值，数组字段取并集）；`${VAR:-default}` 镜像插值解引用取默认值，registry/版本 tag 提取兼容私有仓库长路径
- **服务类型识别与部署分层**：12 类服务类型（网关/前端/后端/适配器/任务/数据库/缓存/对象存储/搜索引擎/注册中心/可观测/CI-CD/工具，角色型模式优先于技术栈模式，`init`/`fixperms`/`flyway` 归任务层）+ 9 层部署分层（接入/前端/应用服务/适配器/任务/数据/可观测/CI-CD/工具）
- **nginx 路由与 upstream 解析**：`location → proxy_pass` 路由提取（含 upstream 名与服务名直连两种解析路径）、upstream server 列表解析、`auth_request`/websocket 标记；外部 https 目标识别
- **依赖推导**：三类依赖边——compose `depends_on`（启动依赖）、环境变量 URL 引用（`env_ref`，如 `SPRING_DATASOURCE_URL` 指向 mysql）、网关路由（`route`）；DFS 循环依赖检测与断链（引用不存在服务）检测
- **中间件识别**：MySQL/Redis/MinIO/Elasticsearch/Nacos/PostgreSQL 等 6+ 类中间件从镜像名识别（版本 tag 提取），自动推导消费方列表
- **5 大审计场景（`deploy audit`）**：安全审计（latest 镜像标签/明文敏感值/端口暴露/无鉴权路由）、高可用审计（健康检查缺失/探针/副本数/资源限额）、配置一致性审计（环境漂移——同名变量跨环境值不一致）、依赖审计（断链/循环依赖）→ 综合健康评分（加权四维，A-E 等级）
- **部署蓝图 deployoverview HTML（`deploy export --format html`）**：自包含 8 Tab——部署拓扑（分层卡片）/ 服务清单（搜索+类型过滤+详情展开：镜像/端口/探针/依赖/环境变量脱敏）/ 路由地图 / 依赖图谱（SVG 可缩放）/ 中间件矩阵（版本+消费方）/ 环境配置（变量统计+漂移对比）/ 文件清单 / 健康审计（评分仪表盘+Top 问题）
- **CLI**：`deploy scan`（全量/增量/`--exclude` 排除子目录）、`deploy query`（services/routes/upstreams/dependencies/middleware/environments/files/layers 8 类 + `--where` 过滤）、`deploy audit`（health/security/resilience/consistency/dependency/all）、`deploy export`（json/html/viewmodel）；全局 `--deploy-snapshot-dir` 选项
- **部署分析 Skill**（`skills/nice-aos-deployment-skill/SKILL.md`）与 **油猴 AI 助手部署智能体**：blueprint-ai-agent 自动检测 `#deploy-viewer-data` 页面并启用「部署蓝图」智能体（12 个专属工具：部署统计/服务查询/服务详情/路由/上游/依赖/中间件/环境/文件/分层/健康度/审计明细）

### 验证

- asdm-admin/deploy 冒烟：137 个部署文件 → 51 服务 / 33 路由 / 43 upstream / 52 依赖 / 6 中间件 / 9 分层 / 0 解析错误；健康评分 74（C），检出真实问题（compose 引用不存在服务、K8s latest 镜像标签、明文敏感值）
- leaniss-system-core/deploy 冒烟：29 个部署文件 → 19 服务 / 15 路由 / 5 中间件（MySQL/Redis/Milvus/Nacos 等）/ 0 解析错误；健康评分 85（B）；增量扫描复用验证通过
- 油猴智能体工具逻辑对导出 HTML 内嵌 JSON 全链路模拟验证：12 工具全部正确返回

### 增强（0.21.0 验证轮）

- **extra_hosts 外部目标识别**：compose `extra_hosts` 声明的主机名（如 `aise-smartanswer-web:%{{ADDR}}%`）视为网关静态映射的集群外服务，nginx 路由目标命中时标记 `externalHost`（原为未解析 null）
- **container_name 别名解析**：compose 服务的 `container_name`（容器网络 DNS 主机名，如服务 `jenkins` 的 `asdm-jenkins`）纳入名称解析表，nginx 路由 / upstream / 环境变量 URL 引用均可通过别名解析到所属服务
- 效果：leaniss 路由 15/15 全部有归属（12 服务 + 3 外部），依赖审计 88→100；asdm-admin `/_jenkins/` 路由与 `asdm-jenkins` upstream 正确解析到 jenkins 服务，未解析路由 2→1（仅剩真实未定义的 `asdm-portal`）
- **蓝图扫描时间本地化**：部署蓝图与数据库蓝图头部的"扫描于"时间由 ISO UTC 原文（`2026-08-23T00:30:48.328Z`）改为本地时间格式（`2026-08-23 08:30:48`），与代码蓝图的 `fmtLocalTime` 行为对齐
- **顶部统计栏宽屏布局**：部署蓝图与数据库蓝图头部的统计卡片由固定最小宽度左对齐改为 `flex: 1 1 90px` 弹性卡片（panel 背景 + 边框 + 圆角），任意宽度下均匀铺满整行，窄屏自动换行，与健康审计 Tab 的 metric-card 视觉语言统一

## [0.20.0] - 2026-08-23

### 新增

- **MySQL 迁移脚本目录分析（`nice-aos db`）**：Flyway 标准布局与 Sprint 非标准布局自动检测（`--layout`）、多数据库（`USE` 语句上下文跟踪、连字符库名 `[\w-]+`）、mysqldump 兼容（DROP+CREATE 表对按 DROP 先序处理防误删）、视图/触发器/存储过程解析、幂等 DDL 支持
- **数据库模型**：表/列/主键/外键/索引/迁移历史/领域分组/模式特征（软删除/审计字段/多租户/自引用/UUID 主键/复合主键/JSON 列），独立快照 `db-snapshot.json` 支持 SHA-256 增量扫描
- **7 大审计场景（`db audit`）**：健康度 / 迁移影响 / 领域依赖 / 索引优化 / 模型演进 / 外键链路 / 命名规范
- **数据蓝图 dataoverview HTML（`db export --format html`）**：8 Tab——SVG ER 关系图（领域分组+缩放平移）/ 表清单 / 外键关系 / 迁移时间线 / 建模特征 / 健康总览 / 演进分析 / 索引优化
- **数据库分析 Skill** 与 **油猴 AI 助手双智能体**（结构分析 + 数据概览，`#db-viewer-data` 页面自动检测）
- **CLI**：`db scan`（`--incremental` / `--all-files` / `--exclude`）、`db query`、`db audit`、`db export`；全局 `--db-snapshot-dir`

### 验证

- 120 迁移文件 / 82 表 / 33 外键 / 242 索引项目：健康评分 95，7 审计全过，HTML 8 Tab 正常
- leaniss-system-core/deploy/1.mysql：80 文件 / 106 表 / 6 数据库，非标准布局识别正确

## [0.18.2] - 2026-08-22

### 新增

- **数据路由 element 包装函数调用解析**：`element: withSuspense(X)` / `element: withPlatformGuard(X, 'platform')` / `createElement(Fn)` 等 HOC 包装形态——取第一个组件参数（Identifier 或 JSX）递归解析（steam-game-hub-2.0 惯例，43 条路由中 37 条使用）
- **数据路由 `<Navigate to>` 重定向提取**：element 内直接 `<Navigate to="/x" replace />`（index 兜底 / catch-all `*`）→ 路由导航边；`*` 相对 path 与父路径拼接为 `/*`
- **NavLink 常量成员引用解析**：数据驱动侧边栏 `{ path: ROUTES.DASHBOARD }` 形态——同文件 `const X = { KEY: '/value' }` 对象表解析 + named import 跨文件轻量解析（读模块文件 const 对象表，支持 .ts/.tsx/.js/.jsx/index.* 扩展探测）

### 验证

- 新增 `test/jsxRoutes.test.mjs` 用例（包装函数调用 / Navigate 重定向 / catch-all / 跨文件常量引用），总计 172 测试全过
- steam-game-hub-2.0（pnpm monorepo，Tauri + React）冒烟：494 文件 / 43 路由全部关联组件（41 组件 + 2 Navigate 重定向）/ 每路由 36 条侧边栏导航边（Steam + PS 导航组全集）；packages/* 6 个子包全部纳入；`../steam-client` workspace 根外条目正确不越界
- steam-game-library 回归：28/28/28（路由/关联/导航边）与基线一致

## [0.18.1] - 2026-08-22

### 新增

- **React Router 6.4+ 数据路由解析**（`createBrowserRouter` / `createHashRouter` / `createMemoryRouter`）：`[{ path, element, index, children }]` 对象树 → Route 实体，与既有 `<Routes>/<Route>` JSX 形态平级共存；`index: true` 以父路径产出，子级相对 path 与父路径拼接，有 `children` 的布局对象自身不产出（与 JSX 无 path 布局同语义）；`element` 解析支持 JSX / 括号包裹多行 JSX / 裸标识符，组件引用三级解析——import 引用 → `lazy(() => import('../pages/X'))` / `React.lazy` 包装变量（含 `.then((m) => ...)` 命名导出链，`import()` 经 ImportKeyword 识别）→ 本地包装函数（return JSX 最深组件递归展开）
- **`<NavLink to>` 导航边提取**（react-router）：字符串字面量与 `{ pathname: '/x' }` 对象形态计入 overlayOpens；**数据驱动侧边栏兜底**——`to={item.path}` 动态引用时提取同文件常量表（NAV_ITEMS 数组）中全部 `{ path: '/xxx' }` 字符串值为导航目标
- **布局外壳导航闭包**：数据路由布局对象的 componentFile 及其直接 import 的内部文件（如 Sidebar.tsx）的导航调用并入全部子路由的导航边——侧边栏导航对所有子页面可达

### 修复

- **数据路由 element 括号包裹**：`element: (\n <Suspense>...</Suspense>\n )` 多行 JSX 为 ParenthesizedExpression 包裹，此前组件解析返回 null——逐层剥离括号后解析

### 验证

- 新增 `test/jsxRoutes.test.mjs` 用例（数据路由端到端 + NavLink 字面量/动态兜底/非 react-router 排除），总计 172 测试全过
- steam-game-library 冒烟：Route 0 → 28（全部关联组件文件，`/` → LibraryPage.tsx 等 28 个页面全部建立路由地图条目与导航边，每页 27 个侧边栏可达目标）；既有 JSX 路由项目回归无变化

## [0.18.0] - 2026-08-22

### 新增

- **Vue 3 `<script setup>` 变量域解析**：setup 块内 `ref/shallowRef/reactive/shallowReactive/customRef/toRef` 声明 → state 键、`computed()` 调用 → computed 键、函数声明与 const 函数表达式 → method 键、`storeToRefs(...)` 解构名与 store 实例变量（`const userStore = useUserStore()`）→ store 键；store hook 命名兼容 `useXxxStore`（Pinia 官方惯例）与 `xxxStore`（snowy 的 globalStore/keepAliveStore 等）双形态，`storeToRefs(store)` 变量参数可溯源到真实 hook 名；变量域统一进入模板绑定 props 来源分类（此前 script setup 组件的 props 全被误判为 computed）与 vclass 类视图实体输入（stateCount 真实计数）
- **Store providerType 字段与展示**：Zustand（`zustand`）/ Pinia（`pinia`）/ Vuex（`vuex`）Store 实体携带 providerType；viewer「业务数据图」Store 卡片与单元清单、exporter Markdown 表格新增 provider 类型徽章/列
- **异步组件与路由 const 懒加载包装统一解析**：`const X = defineAsyncComponent(() => import('./x.vue'))`（Vue3 setup 惯用，unplugin-auto-import 场景无 import 记录不校验来源）与路由文件顶层 `const X = () => import(...)` 包装变量统一进组件解析索引——模板标签正常建立 renders 关系与 Props 传递边，路由 component 引用关联目标组件文件
- **Vite 动态注册死代码豁免**：`import.meta.glob(['/src/views/**.vue', '!/src/views/auth/**.vue'])` 模式采集（含 `!` 排除段、相对路径模式归一），命中文件豁免孤儿候选；vite.config.mjs 的 `unplugin-vue-components` `dirs`（自动注册组件目录）与 `unplugin-auto-import` `dirs` 目录内文件同样豁免（词法近似解析 vite 配置，`r('src/components')` 形式支持）
- **`<script setup name="X">` 组件命名**：vite-plugin-vue-setup-extend 的 name 属性优先于文件名派生（defineOptions 仍最高优先）
- **Ant Design Vue 排除**：`a-` 前缀标签（a-table/a-button 等）不进组件标签集与 props 传递链，与 element-ui `el-` 前缀同规则

### 修复

- **单行 SFC template 块丢失（定义性 bug）**：`splitSfc` 的 template 闭合配对正则误用行首锚定（`/^<(\/?)template\b/gm`），`<template>…</template>` 同行的单行 SFC 闭合标签不在行首导致 template 块整体丢失（无标签集、无传递链、无导航边）；改为非锚定配对（嵌套 template 深度计数不受影响）
- **路由组件关联断裂**：vue-router 路由文件中 `component: ClientLogin` 引用顶层 const 懒加载包装时无法定位目标 .vue 文件（此前仅支持内联 `() => import(...)`），路由地图出现无组件文件的路由条目
- **Go 解析五盲区（gin-vue-admin 形态对齐，参考 smartide-server / smartide-agent）**：
  - **子目录 go.mod 识别**：融合仓库（`server/go.mod` + `web/` 前端）根目录无 go.mod 时 framework 误判——从 `.go` 文件所在目录逐级向上发现全部 go.mod（多模块并存取源码最多者为主），Go 依赖并入、`goModule.dir` 记录所在目录
  - **`zap.Any` 等日志调用误报路由**：任意 `.Any("error", err)` 形态被误判为 gin 路由注册——引入 router 变量白名单（`gin.Engine`/`gin.RouterGroup` 类型变量与函数参数、`gin.New/Default` 产物），非 router 变量上的 HTTP 方法调用不产路由
  - **handler 字段链间接引用**：gin-vue-admin 惯例 `baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi` 后 `userRouter.POST("register", baseApi.Register)` 的 handler 无法关联 Method——字段链变量表展开为完整 `handlerChain`，链首 import 别名定位目标包子树内同名方法（纯分组目录如 `api/v1` 无直下文件时按子树搜索）
  - **前端 axios 配置对象形态调用丢失**：gin-vue-admin 前端 `service({ url: '/user/register', method: 'post', data })` 不产 httpCalls（此前仅支持 `service.get(...)` 方法形态）——封装实例（`@/utils/request` 导入的 axios 实例）配置对象字面量的 `url`/`method` 属性提取为前端调用并参与路由匹配
  - **深链调用链丢失**：`service.ServiceGroupApp.SystemServiceGroup.UserService.RegisterUser()` 形态的链长 ≥3 限定调用（链首为 import 包别名）不进调用链——`pkgchain` 边类型在目标包子树内按末段方法名搜索（词法近似）
- **项目根目录识别优化（定位任意目录均可分析）**：
  - **兄弟项目发现（siblingProjects）**：定位子项目目录（`web/`）或代码子目录（`web/src`）时，向上定位仓库根（`.git` / `go.work` / `pnpm-workspace.yaml` / `lerna.json` / `nx.json`，上限 4 层）后识别同级项目清单；普通目录（无仓库标记）不吸附邻居，只报告不并入扫描范围与依赖
  - **Go module 上级发现**：定位 Go module 子目录（如 `server/api`）时向上发现 go.mod（`goModule.dir` 以 `..` 相对形态表达），goResolver 以 `path.resolve` 折叠基准目录计算 import 目标——internal 文件边、路由 handler 关联、跨包调用链在子目录定位下全部正确
  - **依赖并入防误吸附**：无 `.git`、无根清单且子项目超过 4 个的「代码集合目录」（如工作区下并排放置的多个独立项目）只报告 subProjects 不并入依赖清单，避免框架误判与依赖污染

### 验证

- 新增 `test/vue3SetupFixes.test.mjs`（8 个用例）：script setup 变量域收集与七类来源分类（含 setup name 属性、storeToRefs 解构、vueOptions 扩展键集）、snowy 形态 store hook（无 use 前缀 + storeToRefs 变量参数溯源）、a- 前缀标签排除、路由顶层 const 懒加载包装组件关联、Pinia setup store（providerType + state/action 键）、Zustand providerType、defineAsyncComponent renders 关系与 Props 传递链、import.meta.glob + unplugin 目录孤儿豁免（含真孤儿保留）
- 新增 Go 盲区与根识别用例（`goAnalyzer.test.mjs` +1 / `goFrontendMap.test.mjs` +2 / `projectScanner.test.mjs` +4）：gin-vue-admin 形态单元测试（函数参数 router / 无前导斜杠 Group / handler 链展开 / 链式 Use / zap.Any 不误报）、融合仓库端到端（子目录 go.mod → framework=go + 依赖并入 + subProjects、handler 链解析到 Method、前端 service 配置对象匹配、深链调用链 Register→RegisterUser）、Go module 子目录定位端到端（`..` 折叠 → handler / 跨包调用链 / internal 文件边）、根识别四场景（定位 web/ 发现兄弟 server、定位 web/src 同样发现、定位仓库根不重复报告 + 代码集合目录防误吸附、定位 server/api 向上发现 go.mod）
- 总计 170 个测试全部通过（既有 162 无回归）；真实项目冒烟：
  - **snowy-admin-web**（Vue 3 + Vite + Pinia + Antdv + unplugin，597 文件）：206 条路由全部关联组件文件（const 包装修复生效）、67 条 PropEdge / 164 props（来源分布 computed×35 / handler×62 / state×41 / literal×23 / store×3——`kStore = keepAliveStore()` 无 use 前缀形态正确溯源）、9 个 Pinia store 全部携带 providerType=pinia（stateKeys 正确：globalStore 20 键等；纯 action store state=0 属实）、孤儿候选从误报收敛至 15 个（hooks/utils/403 页等真实候选）；端到端蓝图（snapshot.json 2.7MB + blueprint.html 746KB + blueprint.md 95KB），官方 CLI export 链路复核通过
  - **smartide-server**（gin-vue-admin 融合仓库，516 文件含 309 .go + web 前端）：`framework=go` 正确判定（子目录 `server/go.mod` 发现 + go 依赖并入 + subProjects 报告 server:go / web:npm）；96 条 gin 路由中 92 条 handler 解析到 Method（`baseApi.Register` 字段链展开生效；其余 4 条为 swagger/health/ws 内联闭包注册，如实无命名 handler）、`zap.Any` 无误报路由；**76 条路由命中前端调用**（web 前端 `service({url, method})` 配置对象形态提取生效）、40 条未匹配清单如实暴露；669 条调用边；定位 `web/` 前端子项目时 `framework=vue` + 兄弟项目 `server:go` 正确识别；端到端蓝图（snapshot.json 6.9MB + blueprint.html 563KB）
  - **回归**：aise-ui（Vue 2）198 PropEdge / 519 props / 159 vclass / 127 vue routes / 7 store 与 0.16.0 基线完全一致；leaniss-oneapi（Gin 融合仓库）124 路由 / 45 前端匹配 / 4 未匹配与 0.17.0 基线完全一致，定位 `router/` 子目录时 goModule 上级发现（dir=`..`）且 124 条路由完整解析；smartide-agent（Go CLI 代理）framework=go 正常；nice-today-2.0（React）831 Component 一致，PropEdge 414→429（+15 条为 React.lazy 包装组件此前无法解析、本期统一进解析索引的**预期增益**，lazy 页面的 props 传递补全）

## [0.17.0] - 2026-08-22

### 新增

- **Go 语言解析器（goAnalyzer，CLI / agent 代理 / Gin 后端）**：独立的轻量语法级解析器（深度状态机 + 双通道噪声剥离：全剥离通道供块状态机、保字符串通道供字面量提取，不依赖 gopls/tree-sitter），与 ts/vue/rust/dart 解析器平级共存，使 Go CLI、agent 代理类小程序与「Go 后端 + 前端」融合仓库可生成完整分析蓝图
  - **项目识别**：`go.mod` 存在且有 `.go` 源码 → `framework=go`（混合仓库前端文件仍各自解析）；`require` 段（分组块与单行形式，exclude/retract 块跳过）解析为 Dependency（`source=go`）；`vendor/`、`testdata/`、`bin/` 自动跳过
  - **实体映射**：`type X struct` → Class（`kind=struct`，字段含 `json/yaml` tag 与匿名内嵌——`*Base` 名取末段）、`type X interface` → Interface（嵌入接口 extends）；方法（值/指针接收者）与顶层函数 → Method（首字母大写判定 exported，`init/main` 恒为入口不判死）；package 目录 → Module；**Go 包 = 目录**：同包跨文件方法合并（接收者在另一文件声明的 `goOrphanMethods` 回填到声明文件）
  - **CLI 命令树（cobra）**：`var xxxCmd = &cobra.Command{Use/Short}` + `rootCmd.AddCommand(xxxCmd)` 边 → Route（`routeType=go-cli`，routePath 为 `smartide k8s init` 式命令链，多级树遍历 + 环防御）；`Flags()/PersistentFlags()` 注册的 flag 提取为 `-T/--type` 徽章；跨包限定子命令（`hostCmd.AddCommand(host.HostGetCmd)`）经 importMap 定位目标包目录归一；声明后从未注册的孤儿命令（如 smartide 被覆盖的 `help`）独立成根，天然暴露死代码
  - **HTTP 路由（Gin / 标准库）**：`router.Group("/api")` 前缀链累积 + `.GET/.POST/.PUT/.DELETE/.PATCH/Any("/path", ...)` → Route（`routeType=go`，apiMethods + `:param`/`*wildcard` 动态段标记）；handler 函数值（`controller.Register`）经 importMap 定位包目录关联到 Method（复用 componentId 机制，viewer 跳转方法签名）；组级 `apiRouter.Use(middleware.Auth())` 中间件按前缀链继承 + 内联中间件合并；`Handle("GET", ...)` 与 `http.HandleFunc` 标准库形式兜底；`NoRoute`/静态托管不产路由
  - **逻辑走向（调用链）**：包级函数跨文件互调（同包无需 import）+ `pkgAlias.Func()` 跨包调用（importMap 定位目标包目录）+ 方法体内调用（接收者变量/参数类型/构造字面量类型推断，`[]*User`/`map[string]T`/`*pkg.T` 归一为基类型）→ Method 的 `calls/calledBy`；Method 死代码候选按包级标识符引用判定
  - **前后端逻辑映射（融合仓库核心价值）**：tsAnalyzer 新增 httpCalls 提取——前端 `API.get/post/put/delete/patch('...')`、`axios.x()`、`fetch()`（含模板串 `` `/api/user/${id}` `` 与 options.method）→ 与 Go 路由路径分段匹配（`:param` 通配任意段、`*wildcard` 吞尾段、去 query、尾斜杠归一；method 不一致仍记录，详情可见）→ `Route.frontendCalls`（文件+行号+method 溯源）；未匹配调用进 `_meta.unmatchedFrontendCalls` 清单（路由地图「未匹配的前端调用」面板，用于发现死接口/路径漂移/外部 API 依赖）
  - **架构层（Go 目录信号）**：`main.go`/`cmd/` → entry，`router/controller/middleware/handler/api` → presentation，`model/dal/dao/repository/relay/service/biz/domain/monitor` → service，其余 → shared
  - **路由地图增强**：Go HTTP 路由（方法徽章 + 中间件链 + 前端调用数徽章与清单）与 Go CLI 命令（路径层级树按命令空格段嵌套，flags 见详情）统一进既有路由地图视图；域取首个业务段（跳过 `api`/`apis`/`v1` 网关前缀）；类型配色 go=天蓝、go-cli=灰蓝
- **README 对象表/框架检测/已知限制同步**：Project framework 枚举与 `goFileCount`、Interface/Class/Method/Route/Dependency 的 Go 语义说明、go.mod 框架检测、Go 已知限制（泛型不解析、调用链静态提取、Run 闭包不实体化、httpCalls 词法近似边界）

### 修复

- **蓝图实体类图语言配色缺 Go（Go 实体回退 TS/JS 蓝）**：`LANG_META` 缺 `go` 条目，Go struct/interface 的 UML 类框描边与头部底色回退为 TS/JS 蓝 `#58a6ff`，与图例语义冲突；语言分布条形图映射与图例均为硬编码四语言，Go 条同样回退蓝色且图例无 Go 说明。修复：`LANG_META` 新增 `go`（gopher 蓝 `#00add8`），CSS 新增 `--go` 变量与 `.bar.go` 类；图例改为**数据驱动**——按 `byLanguage` 实际语言从 `LANG_META` 取色生成，只显示项目内存在的语言（Go 项目不再显示无关的 TS/Vue/Rust 图例项），颜色与类图节点描边单一来源同源

### 验证

- 新增 `test/goAnalyzer.test.mjs` + `test/goFrontendMap.test.mjs`（13 个用例）：struct/interface/接收者方法提取（tag 字段/匿名内嵌/exported 判定）、调用链三类提取（pkg 跨包/local 同包/method 接收者推断）、cobra 命令树（Use/Short/flags/AddCommand 边）、gin 路由（Group 前缀累积/中间件/handler/动态段/标准库兜底）、go.mod 检测 + vendor 跳过、端到端实体入快照（Class/Method/Module/archLayer/依赖）、cobra→Route 命令链、gin→Route handler Method 关联、Go 项目 props 链为空不影响既有管线、tsAnalyzer httpCalls 提取、前端调用匹配（:param 通配/尾斜杠归一/未匹配清单）、viewer 路由地图视图模型（前端调用指标/go 类型分布/命令树字段）、viewer 实体类图 Go 配色（CSS 契约 + 内嵌脚本 mock DOM 渲染：图例 gopher 蓝圆点 / bar go 分布条 / 类框描边 `#00add8` / 不回退 TS 蓝）
- 总计 153 个测试全部通过（既有 140 无回归）；真实项目冒烟：
  - **smartide/cli**（cobra CLI）：161 个 .go 全扫（含根 `main.go` 入口识别），112 struct / 6 interface / 646 Method / 796 条调用边 / 114 个 go.mod 依赖；CLI 命令树 24 条命令链——`smartide` 根 + 16 个一级命令（init/start/new/stop/remove/version/list/get/host/reset/update/config/login/logout/connect/k8s）+ host×4 / k8s×2 子命令（最大深度 3：`smartide k8s init`）+ 孤儿 `help` 命令（声明后从未 AddCommand，真实死代码信号）
  - **leaniss-oneapi**（Gin + GORM + React 三主题融合仓库）：461 文件（222 .go + 239 .js）全扫，244 struct / 4 interface / 1224 Method / 994 条调用边 / 101 个 go 依赖；124 条 gin HTTP 路由（43 条 `:param`/`*target` 动态段、全部携带中间件链如 CriticalRateLimit/TurnstileCheck/AdminAuth）；**前后端映射 45 条路由命中前端调用**（三主题 default/air/berry 的 `API.get('/api/channel/...')` 等散落组件调用全部溯源到文件+行号）；未匹配前端调用 4 条（telegram oauth 登录 + 3 处 GitHub Releases 外部 API——如实暴露外部依赖）；`framework=go` 正确判定；端到端蓝图（snapshot.json 1.6MB + blueprint.html 561KB）
  - **回归**：nice-today-2.0（React）414 PropEdge / 831 Component 与 0.16.0 基线完全一致（tsAnalyzer 新增 httpCalls 不影响既有产出）

## [0.16.0] - 2026-08-22

### 新增

- **Vue2（Options API）props 传递链分析**：Vue SFC 模板绑定与 React JSX 属性同构接入 PropEdge 体系（`prop:A→B` 组件对聚合），「组件数据流」标签页对 Vue2 项目可用
  - **Options API 选项解析**：`export default {}` / `Vue.extend({})` / `defineComponent({})` 提取 `props`（对象/数组/混合形式，含 type）、`data`（对象/函数/方法形式）、`computed`/`methods` 键集、`components` 局部注册表；`mapState/mapGetters/mapActions/mapMutations` spread 展开提取 storeKeys（含 Vuex 模块名：双参 `mapState('app', [...])` 首参与箭头函数体 `state.app.x` 两种来源）
  - **模板绑定七类来源分类**：`:prop` / 静态属性 / 裸属性 / `v-model`（含 `v-model:arg`）/ `.sync` 修饰符剥离 / `@event`（事件回调记 handler，name 形如 `@save`）/ `v-bind="obj"` spread；表达式根标识符按 props → data → store → methods → computed 顺序判定，与 React 版语义对齐
  - **组件标签解析**（统一 helper）：局部 `components` 注册表 → import 索引（local 名 + PascalCase 双键，default 导入取目标文件 primary 组件）→ `main.js` 的 `Vue.component()` 全局注册兜底 → 同文件兜底；kebab-case 标签 / camelCase 导入名 / 文件派生名（`day.vue` ↔ `CrontabDay`）均可对齐
  - **排除规则**：element-ui `el-` 前缀、原生 HTML / Vue 内置标签（router-view/transition 等）不进传递链；`v-if/v-for/ref/key/class/style/slot` 等指令与 DOM 透传属性跳过
- **Vue 组件类视图实体（vclass）**：每个 `.vue` 文件 primary 组件合成为 `kind=component` 的 Class 实体（`vclass:X`，language=vue）——props 为字段（含 type）、computed + methods 为方法实体（`vmethod:X.key`）；组件 renders 组合关系回填为 vclass 间 rendersIds（目标同为 vclass 才成边，保持类图纯净），「实体类图」标签页对 Vue2 项目可用
- **类图 renders 组合边渲染**：UML 类图新增 renders 边（绿色实线箭头 + `arr-rnd` marker），区别于 implements（青色虚线）/ extends（紫色实线）；图例与统计 chips 同步展示 renders 边数；实体构造型标签新增 `«component»`
- **Vuex store 检测（Vue2）**：`/store/` 目录或导入 vuex 的文件，default export（对象字面量 / `new Vuex.Store({})` / RuoYi 风格 shorthand 引用顶层 const）提取 `stateKeys` + `actionKeys`（actions + mutations 合并）为 Store 实体（`providerType=vuex`），「业务数据图」对 Vuex 项目可用
- **router-link 静态导航边**：模板内 `<router-link to="/path">` 静态路径 → 文件所属路由 → 目标路由的 `navigatesToIds`（动态 `:to` 含表达式不可静态解析，跳过）；`this.$router.push('/path')` 调用同步支持
- **`@` 别名解析增强（projectScanner）**：vue.config.js 的 `configureWebpack.resolve.alias`（支持 `resolve('src')` / `path.resolve(__dirname, 'src')` / `'src'` 三种值形式）与 jsconfig.json paths 解析；存在 vue.config.js + `src/` 时兜底 `@/* → src/*`（vue-cli 惯例）
- **`build` 目录源码树豁免**：构建产物目录名 `build` 在 `src/` 源码树内不再跳过（如 RuoYi 的 `src/views/tool/build/` 业务源码目录）；`node_modules`/`.git` 等其余跳过项不受影响

### 验证

- 新增 `test/vuePropsChain.test.mjs`（8 个用例）：Options API 选项提取（props 定义/data/computed/methods/components/storeKeys 模块名）、模板绑定七类来源分类（forward/state/store/handler/computed/literal/spread + v-model/.sync/静态/裸属性 + router-link 导航）、@ 别名解析与 Vuex store 检测、PropEdge 聚合（局部注册 + 全局注册 + renderCount + 出入度 + passesProps）、vclass 类实体（props 字段/computed+methods 方法/renders 组合边）、路由导航边、viewer propFlow + 类视图 renders 渲染（mock DOM 执行内嵌脚本）、Vue 无绑定项目 propFlow 为 null 且 vclass 仍产出
- 总计 140 个测试全部通过（既有 132 无回归）；真实项目冒烟：aise-ui（Vue 2.6 + element-ui + vuex 3 + vue-router 3，268 文件）：unresolvedImports = 0（@ 别名全量解析）、198 条 PropEdge / 519 props（来源分布 state×269 / handler×141 / computed×78 / literal×27 / forward×3）、81 个组件 renders 关系、7 个 Vuex store（providerType=vuex）、162 个 vclass 实体（207 条 renders 组合边）、127 条 vue 路由 + 2 条 router-link 静态导航边；端到端蓝图（snapshot.json 1.6MB + blueprint.html 620KB）核验组件数据流 / 实体类图 / 业务数据图 / 路由地图四 Tab 数据齐备；nice-today-2.0（React）回归：414 PropEdge / 831 组件与 0.15.0 基线完全一致

## [0.15.0] - 2026-08-22

### 新增

- **Props 传递链分析（PropEdge 对象体系，React/Next 组件数据流）**：`.tsx/.jsx` 中 PascalCase JSX 标签的属性传递按**组件对聚合**为 PropEdge 对象（`prop:A→B`，19 种对象类型之一），回答"数据怎么在组件间流动"
  - **来源七类分类**（词法近似：组件声明范围 + 文件级变量表判定）：`forward`（父组件 props 透传）/ `state`（useState 解构）/ `store`（useXxxStore 等非内置 hook，附 storeHook 溯源）/ `handler`（内联或本地函数）/ `literal`（字符串/数字/布尔/裸属性）/ `computed`（其余表达式）/ `spread`（`{...obj}` 整体透传不展开）
  - **聚合规则**：同一组件对多处渲染聚合一条边（`renderCount`）；同名 prop 多来源取优先级最高者（forward > state > store > handler > computed > literal > spread）；路由库组件（Link/Navigate/Outlet 等）与 React 内部属性（key/ref/className/style 等）跳过，自渲染不成边
  - **Component 扩展**：`propsNames`（解构 props 名清单）与 `propOutCount`/`propInCount`（传递出入度）
  - **passesProps 链接**（第 22 种链接类型）：`link passesProps --src comp:X` 正向查传递目标；传 `prop:` 边 ID 返回两端组件
- **overlay 路由 props 工厂注入提取**：路由条目的 `props: (app) => ({ item: app.item })` 工厂函数提取注入键为 `factoryProps`（`hasPropsFactory` 标记），App → 工厂 → 页面组件的主干注入链在路由地图以「工厂 N props」徽章展示
- **蓝图查看器「组件数据流」标签页**（新 Tab，位于路由地图之后）：无 PropEdge 项目自动隐藏
  - **组件数据流总览**：传递边 / 参与组件 / props 总数 / spread 透传统计卡 + props 来源分布条形图（七类固定配色与判定说明）
  - **Props 传递图 SVG**：节点按 BFS 传递层数分层（无入边顶层容器 → 1 层 → 2 层…），节点边框色 = 所属域、顶层加粗，边中点标签 = props 数；悬停高亮相邻边、点击节点查看 props 明细（名称 + 来源 + store hook + 值摘要）与传出/传入清单；域下拉筛选 + 组件名/文件路径搜索（默认渲染连接度 Top 80 组件）
  - **高传出 / 高传入组件 Top 榜**：props 分发枢纽 vs 消费方（出入边数 + props 数 + 所属域）
  - **Props 传递边清单**：来源 → 目标 / props 数 / 渲染处 / props 明细（名称:来源）/ 跨域标记（80 条截断保护）
- **propFlow 视图模型**（`buildViewerModel` 新增第 9 节）：传递边（含来源分类与域归属）/ 参与组件出入度 / 来源分布 / 高传出高传入 Top 榜 / 域选项；`export --format viewmodel` 同步携带
- **Markdown 导出扩展**：项目概览新增「Props 传递边数」指标；路由表新增「工厂 props」列；新增「Props 传递链（PropEdge）」章节（汇总行 + 来源分布 + 传递边清单 + 高扇入组件统计）

### 验证

- 新增 `test/propsChain.test.mjs`（7 个用例）：tsAnalyzer 来源分类（七类全覆盖 + propsNames 声明提取）、PropEdge 跨文件聚合与出入度/passesProps 链接、多处渲染 renderCount 聚合与来源优先级、同文件组件对成边、overlay 工厂 factoryProps 提取、propFlow 模型层与渲染输出（mock DOM 执行内嵌脚本）、无 PropEdge 项目 Tab 隐藏
- 总计 132 个测试全部通过；真实项目冒烟：nice-today-2.0（414 条传递边 / 434 组件 / 1120 props，来源分布 computed×323 / handler×273 / state×184 / forward×150 / literal×151 / store×39；高传出 App(23)/HealingTab(18)，高传入 CopyTextButton(27)；SettingsOverlay→SettingsSection 16 个 forward props 批量透传等典型形态命中）与 next-web-app（3 条传递边，服务端组件为主的项目如实稀疏）

## [0.14.0] - 2026-08-22

### 新增

- **蓝图查看器「路由地图」标签页**（新 Tab，位于业务逻辑流向与实体类图之间）：把 0.13.0 扩展后的全类型路由（overlay / react-router / vue-router / Flutter GoRoute+原生 / Next.js App Router）组织为可视化地图；无路由项目自动隐藏 Tab
  - **路由总览**：路由总数 / 导航边 / 入口路由 / 孤岛路由 / 动态路由 / API 路由统计卡 + 路由类型分布条形图（每种类型固定配色：overlay 紫、react 蓝、vue 绿、flutter 青、next 页面琥珀、next API 红）
  - **路由导航链 SVG 图**：节点按导航跳数 BFS 分层（入度 0 的入口路由为第 0 列 → 1 跳 → 2 跳…，环内/未覆盖节点沉底），节点框两行（路径 + 类型·组件），边框色 = 路由类型、入口加粗；悬停高亮相邻路由与导航边、点击查看路由详情（域 / 动态段 / use client·server / API 方法 / layout 层数 / 组件与文件 / 导航去向）；超过 60 条路由按导航活跃度截断
  - **路径层级树**：路由 path 逐段嵌套的缩进树（每节点独立子段索引，不同分支同名段不合并），静态段在前动态段在后、动态段琥珀色高亮，节点标注类型徽标与主组件名
  - **域分组**：按路由 domain 聚合（每组路由清单 + 组件 + 导航去向）
  - **全量路由清单表**：路径 / 类型 / 域 / 组件 / 导航去向 / 被导航 双向列（150 条截断保护）
- **routeMap 视图模型**（`buildViewerModel` 新增第 8 节）：路由条目（path/routeType/domain/componentRef/componentFile/isDynamic/isClient/apiMethods/layoutCount/navToPaths）、导航边（去重 + 自环剔除）、入口/孤岛路由计数（入度 0 且有出边 = 入口；无出入边 = 孤岛）、类型分布、域分组、路径层级树（maxDepth）；`export --format viewmodel` 同步携带
- **Markdown 导出路由地图扩展**：路由表新增「类型 / 动态 / client / API 方法」四列（Next.js App Router 语义），表头前增加类型分布汇总行；页面导航图章节增加入口路由（无入边）清单

### 验证

- 新增 `test/routeMapView.test.mjs`（3 个用例）：routeMap 模型层契约（清单/导航边去重/入口孤岛计数/类型分布/路径层级树嵌套与动态段排序/域分组）、渲染输出（mock DOM 执行内嵌脚本，断言路由总览/导航链 SVG/层级树/域分组/全量清单与动态段高亮）、无路由项目 routeMap 为 null 且 Tab 隐藏
- 总计 125 个测试全部通过；真实项目冒烟（含内嵌脚本运行时渲染验证）：next-web-app（6 路由/5 导航边/1 入口，六域分组）与 keylol_discourse_app（14 路由/6 导航边含自环剔除/1 入口/7 孤岛，`/space/*` 二级树深）

## [0.13.0] - 2026-08-22

### 新增

- **Next.js App Router 路由提取（`nextAppAnalyzer`，文件约定式路由）**：`framework=next` 且存在含约定文件（`page/route/layout`）的 `app/` 或 `src/app/` 目录（后者优先）时自动提取，Route 对象体系新增 `next` / `next-api` 两个 routeType：
  - **页面路由**：`app/**/page.tsx` → Route（`routeType=next`），URL 按目录约定计算——路由组 `(group)` 与平行路由 `@slot` 段剔除出 URL、`_private` 段整目录不产出路由、`[id]` → `:id`、`[...slug]` → `:slug*`、`[[...slug]]` → `:slug?`（`isDynamic` 标记）；`rawPath` 保留原始目录段
  - **API 路由**：`app/**/route.ts` → Route（`routeType=next-api`），导出的 `GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS` 方法名收集为 `apiMethods`
  - **layout 链**：`layout.tsx` 不单独成路由，而是沿真实目录链（外→内，含路由组层）收集进后代路由的 `layoutFileIds`；`loading/error/not-found/template/global-error` 约定文件记入 `specialFiles`
  - **客户端标记**：page/route 文件头 `'use client'` 指令探测为 `isClient`；组件关联沿用 `componentId`/`componentFileId`，page 组件 kind 自动升级
  - **跳转边**：tsAnalyzer 识别 `next/link` 的 `<Link href>`（字符串或 `{ pathname: '/x' }` 对象形式）计入 overlayOpens → 目标路由的 `navigatesToIds`；导航边仅归属 page 文件（layout/共享组件文件内的 Link 不归属，避免边爆炸）
- **Flutter 原生路由表提取（`dartAnalyzer` 扩展）**：`Map<String, WidgetBuilder> routes = { '/x': (ctx) => const XxxPage() }`（MaterialApp `routes:` 命名路由）条目提取，`routeType=flutter`——与 GoRoute 路由并存合并；深度感知条目扫描（仅 map 体顶层的 `'path':` 视为条目键，builder 体内字符串如 `arguments: {'tid': x}` 不误判），值取最后一个大写构造调用（与 GoRoute builder 一致）
- **Flutter 命名路由跳转边**：`Navigator.pushNamed / pushReplacementNamed / popAndPushNamed / restorablePushNamed`（`Navigator.of(context).pushNamed('/x')` 与 `Navigator.pushNamed(context, '/x')` 两种形式）→ 该文件组件所属路由 → 目标路由（`navigatesToIds`）

### 验证

- 新增 `test/nextRoutes.test.mjs`（4 个用例）：App Router 路由提取（页面/API 路由、动态段/路由组/私有目录归一、layout 链、`'use client'` 探测、apiMethods）、`src/app` 优先定位、Link href 跳转边（字符串 + pathname 对象形式 + 自环剔除）、路由条目字段契约（rawPath/specialFiles/componentFileId）
- 新增 `test/dartNativeRoutes.test.mjs`（3 个用例）：原生 routes Map 条目提取（builder 体内字符串不误判 + 块体 builder）、pushNamed 两种调用形式跳转边、GoRoute 与原生 routes 并存合并
- 总计 122 个测试全部通过；真实项目冒烟：next-web-app（6 条 next 路由 + 5 条导航边，`/` 页面 Link 五向导航全解析）与 keylol_discourse_app（14 条 flutter 路由 + 7 条导航边，含 `/space/friends|threads|posts` 同组件多路由与 `/settings → /log,/about` 二级导航）

## [0.12.0] - 2026-08-22

### 新增

- **`serve` 命令（本地数据源 HTTP 服务）**：把本体快照与蓝图暴露为 CORS 就绪的 HTTP 端点，供 AI agent / 油猴脚本 / 网页跨源拉取——解决油猴脚本在 `file://` 协议下无法读取 `snapshot.json`、以及 AI agent 消费快照需要自起服务的问题
  - 端点：`GET /snapshot.json`（完整快照）、`GET /blueprint.html`（蓝图页面）、`GET /api/status`（目录解析结果 + 快照/蓝图就绪状态 + 端点清单）、`GET /api/stats`（项目名/框架/对象计数/循环依赖/死代码候选）、`GET /`（状态首页 HTML）；全端点 CORS `*`，`OPTIONS` 预检放行
  - 目录解析链：`--dir` → 全局 `--snapshot-dir` → `NICE_AOS_SNAPSHOT_DIR` → `<root>/.nice-aos/data`；`--root` 定位 blueprint.html（默认当前目录）；默认监听 `127.0.0.1:8420`（仅本机，`--host 0.0.0.0` 开放局域网），`--port 0` 自动分配可用端口
  - 就绪状态**每次请求实时探测**：支持"先起服务、后 `refreshRepo` / `export`"工作流（文件随后生成即可读，无需重启服务）；快照缺失返回 404（附生成指引）、JSON 损坏返回 500
  - `snapshot.js` 新增 `getSnapshotDirOverride()`：serve 经其读取全局 `--snapshot-dir`（preAction 钩子写入的覆盖值）对齐约定——不在 serve 上重复定义同名选项（Commander 中子命令选项与全局选项重名时值会被父命令吞掉）
- **`contrib/blueprint-ai-agent`（蓝图页 AI 代码分析助手，油猴脚本，按需集成）**：在 `blueprint.html` 右下角注入浮窗按钮，点击展开对话侧边栏，对项目本体（模块/组件/Store/Service/路由/接口/类/方法/功能域/死代码）自然语言问答；不进入 npm 包分发
  - 架构借鉴 steam-ai-agent：**ToolRegistry + ReAct 文本协议**（`<tool_calls>` 纯文本约定，规避各厂商 function-calling 差异），低成本支持多模型接入：内置 DeepSeek / 智谱GLM / 通义千问 / Kimi / 豆包 / OpenAI 预设 + 自定义（任意 OpenAI 兼容地址）
  - **9 个代码分析工具**：getStats（统计总览）/ queryObjects（按类型查询）/ getNodeDetails（对象详情）/ listLinks（关系与反向引用）/ getDomainDetail（功能域构成）/ analyzeFile（单文件分析）/ getArchLayers（架构分层分布）/ findDeadCode（四级死代码候选）/ getProjectContext（当前页面视图上下文）
  - **双数据源**：优先页面内嵌 `viewer-data`（`export --format html` 自带，零依赖离线可用）；「设置」可配本地快照 HTTP 地址（`GM_xmlhttpRequest` 拉取，推荐 `nice-aos serve` 一行启动）
  - 新建会话 / 会话历史（重命名/删除/清空）、会话导出 JSON（可恢复）/ Markdown、流式打字输出、工具调用可视化、可中断生成；仅在内嵌 viewer-data 或存在 `#viewer` 容器的蓝图页自激活，其它页面无副作用

### 修复

- **蓝图查看器实体类图文字不可读（黑字融深色背景）**：UML 类框样式选择器误写为后代形式 `svg .uml ...`，但 `.uml` 类名挂在 `<svg>` 根元素自身上，选择器永远失配 → 类名/构造型/字段/方法文字回退 SVG 默认**黑色填充**，与深色背景融合不可读（类框边框颜色走内联 `stroke` 属性"看似正常"，列标签走 `svg .col-label` 也正常，问题更隐蔽）。改为复合选择器 `svg.uml ...` 后，文字填充（`--fg`/`--fg-dim`/`--fg-faint`）、类框体填充与分隔线描边全部正确生效
- **蓝图页头「生成于」显示 UTC 标准时间**：快照 `_meta.generatedAt` 存 UTC ISO 串，页头原样 `.replace('T',' ').slice(0,19)` 展示，东八区下与实际生成时间差 8 小时。查看器内嵌脚本新增 `fmtLocalTime`，在浏览器查看时转换为本机时区；Markdown 导出报告的「生成时间」行同步修复（快照数据仍存 UTC ISO 不变，展示层转换，无歧义）

### 验证

- 新增 `test/serve.test.mjs`（3 个用例）：端点契约（默认目录解析 + CORS + 各端点响应 + OPTIONS 预检 + 404 JSON 错误体）、快照后生成实时可见回归（启动无快照 404 → 运行中生成即 200 → 损坏 500 → 蓝图后生成即读）、`--dir` / `--snapshot-dir` 别名显式指定目录
- 新增 `test/viewer.test.mjs` 2 个回归用例：实体类图 CSS 选择器（禁止失配的 `svg .uml ` 后代形式 + 文字填充断言）、页头生成时间本机时区显示（mock DOM 执行内嵌脚本，断言 v-sub 文本含本地时间且不含 UTC 原文，时区无关写法）
- 总计 115 个测试全部通过；默认端口 8420 人工冒烟：全端点响应、CORS 头、启动横幅正常（Windows 系统保留端口段会导致 EACCES 启动失败，撞上时用 `--port` 换端口即可，报错信息已给出指引）；steam-game-library 真实项目重新生成蓝图验证两处修复（旧页头显示 UTC `03:42:11` → 新显示本机时区 `11:42:11` 与系统时间一致，CSS 选择器修复后文字填充生效）

## [0.11.0] - 2026-08-21

### 新增

- **Dart/Flutter 实体分析器（`dartAnalyzer`，lib/ 组件）**：与 tsAnalyzer/vueAnalyzer/userScriptAnalyzer/rustAnalyzer 平级共存的轻量语法级解析器（深度状态机 + 等长噪声剥离 + 注解行剥离，不依赖 dart analyzer），实体映射对齐 TS 语义：
  - `abstract class` → Interface、`class/enum/mixin` → Class（extends/implements/with 关系、字段、方法、构造器不实体化为 Method）；类方法/顶层 fn → Method（含 `@override` 标记、signature 归一）
  - **Widget 基类（StatelessWidget/StatefulWidget/ConsumerWidget 等）→ Component**（kind: page/widget、dartdoc 描述、文件名匹配主组件）；**ChangeNotifier/Notifier 子类与 Riverpod Provider 变量（`final xxxProvider = NotifierProvider<...>.new(X.new)`，含 notifierClass 提取）→ Store**（stateKeys/actionKeys）
  - `GoRoute(path/builder)` → dartRoutes：路径常量引用回填（`path: AppRoutes.dashboard`）、builderWidget 跨文件组件解析；`context.go/push('/path' 或 AppRoutes.xxx 常量引用)` → overlayOpens → 路由导航边（`navigatesToIds`）
  - **方法逻辑调用链**：方法体内调用 → callEdges → `Method.callIds/calledByIds/compCallIds`——本类方法/顶层函数/跨文件静态方法（importMap 解析 + 全仓库唯一名兜底）双向链接，Widget 构造调用 → compCallIds 渲染链
- **Flutter 项目扫描与框架识别**：`pubspec.yaml` + `lib/` 自动发现（monorepo 多包递归发现）并把 `lib` 纳入扫描（`.dart`）；pubspec 依赖解析（`flutter: sdk: flutter` 无值键拼接）；`framework=flutter`（依赖含 flutter sdk）/ `framework=dart`（纯 Dart 包）；`frameworkVariants` 新增 riverpod/provider/bloc/getx/go_router；`Project` 画像新增 `dartFileCount`/`flutterDetected`；SKIP_DIRS 新增 android/ios/.dart_tool/linux/macos/windows
- **导入解析扩展**：`package:` 导入（自身包名 → 项目内 lib/ 路径，其余 → pub 依赖）、`dart:` 内置库跳过、Dart 无 `./` 前缀裸相对导入解析
- **蓝图查看器 Dart 展示**：语言标签/分布新增 Dart（teal 色系）；实体类图节点方法与详情面板新增「方法调用链」（方法 → 调用目标/被调方，Widget 渲染链并入）；Route 一览支持 Flutter GoRoute 展示
- **Markdown 导出 Dart 统计**：项目概览新增 Dart 文件数行、Store/路由/依赖标题含 Riverpod/GoRoute/pub；接口/类表语言列支持 Dart；新增「方法调用链 Top 30」章节（出边数/被调用数/调用目标/调用组件）
- **`action analyzeFile` 支持 .dart**（dartAnalyzer 链，输出 Interface/Class/Method）

### 修复

- dartAnalyzer：`@override` 等注解行破坏块状态机行首分类导致带注解方法（如 build）被吞（stripAnnotations 预处理，方法数显著修复）；类构造器误判为 Method；Riverpod Provider 变量正则转义失效（模板字面量 `\\s` 产生字面反斜杠）；`NotifierProvider<X, Y>.new(X.new)` 形式 notifierClass 提取；`_PrivateWidget(...)` 私有类构造归类为 self 调用；signature 残留 CRLF
- dartAnalyzer：GoRouter 常量引用导航（`context.push(AppRoutes.xxx)` / `context.go(home)`）未解析为导航边（navRe 仅匹配字符串字面量参数；顶层函数的导航调用未进 overlayOpens）——扩展参数形式为字符串/常量引用两种，builder 侧用全仓库路由常量表（常量名 → path）跨文件回填，动态变量（`feature.route`）查不到即忽略

### 验证

- 新增 `test/dartEntities.test.mjs`（12 个用例）：Widget 组件/`@override` 回归/抽象类→Interface/ChangeNotifier→Store/Riverpod Provider 变量/GoRoute 常量回填（含 `context.push(AppRoutes.xxx)` 常量引用导航）/调用链分类/Flutter 框架识别/实体入快照/导航边（字符串 + 跨文件常量回填双向）+调用链/蓝图视图模型/Markdown 导出
- 总计 110 个测试全部通过；真实项目回归：steam-game-flutter（186 文件/89 组件/63 Store/15 路由/1624 方法，175 个方法产生 250 条调用边）与 nice-today-flutter（121 文件/103 组件/12 Store/47 路由/1608 方法，288 个方法产生 364 条调用边、4 条路由导航边含 `AppRouter.xxx` 常量回填）

## [0.10.0] - 2026-08-21

### 新增

- **`update` 命令（版本检测与一键升级）**：`nice-aos update --check` 仅检测（输出 JSON：current / latest / upToDate / installMode / upgradeCommand，供 agent 与 CI 前置校验）；`nice-aos update` 一键升级——npm 全局安装时自动执行 `npm install -g nice-aos@latest`，升级后读回磁盘版本复核
- **安装模式自动判定（`installMode`）**：`global`（npm 全局安装，可一键升级；`npm install -g <本地目录>` 的符号链接形式同样识别，升级时替换为 registry 版本并在消息中说明）/ `npx`（缓存运行 → 指引 `npx nice-aos@latest` 拉新）/ `local`（项目依赖 → 指引宿主项目内升级，不改写 package.json）/ `repo`（仓库源码运行 → 跟随 git）。检测采用双信号互补：调用入口路径（`process.argv[1]`，保留符号链接——覆盖 `npm link` 与本地目录全局安装）+ 模块真实路径布局（`lib/node_modules/nice-aos` 强信号，覆盖 homebrew / nvm 多 prefix 环境，PATH 中 npm prefix 与实际安装 prefix 不一致时仍可正确判定）
- **Skills 版本检测要求**：三个 skill（nice-aos / nice-aos-userscript / nice-aos-deadcode）前置条件统一增加"npm 包方式必须先 `update --check` 确认最新版"约定——`upToDate=false` 且 global 时执行 `nice-aos update`；`update` 命令不存在说明版本 < 0.10.0，先 `npm install -g nice-aos@latest` 一次性升级；网络不可达返回 `ok:false` 时跳过升级不阻塞主流程；仓库内源码方式版本跟随 git 无需检测。核心 skill 的 Agent 行为规范表同步增加版本校验行

### 验证

- 新增 `test/update.test.mjs`（2 个用例）：compareVersions 三段语义版本比较（含 0.9.0 < 0.10.0 非字符串比较）、`update --check` 输出 JSON 契约（离线时容忍 `ok:false` 形状）
- 真实环境回归：仓库源码模式（repo）、npm 全局符号链接安装（global + linkedInstall）、多 prefix 全局布局（`lib/node_modules` 布局模拟 homebrew）、一键升级端到端（0.8.0 → 0.9.0，符号链接替换为 registry 版本且磁盘版本复核一致）
- 总计 98 个测试全部通过

## [0.9.0] - 2026-08-21

### 新增

- **Rust 实体分析器（`rustAnalyzer`，Tauri src-tauri 组件）**：与 tsAnalyzer/vueAnalyzer/userScriptAnalyzer 平级共存的轻量语法级解析器（深度状态机 + 等长噪声剥离，不依赖 rustc），实体映射对齐 TS 语义：
  - `pub struct`/`pub enum` → Class（kind: struct/enum，含 fields/derives/variants）；`pub trait` → Interface（supertrait → extends）；`impl` 块内 `fn` → Method（ownerKind=class，含 trait impl 关联）；模块级 `fn` → Method（ownerKind=module）
  - 跨文件路径解析：`use crate::a::B` 模块路径映射为主（`crate::a::b::Name` → `<crateRoot>/a/b.rs` 或 `a/b/mod.rs`）、`super::` 相对路径、全仓库唯一名匹配兜底；支持 `use a::{B, C}` 花括号组与 `use crate::x::*` 通配（目标文件及同目录整体豁免死代码判定）
  - Rust 类型引用即使用（`Vec<Game>` / `-> Game` / `impl Game` 均计入引用），Interface/Class 同样参与类型级死代码判定
- **客户端组件自动发现（Tauri/Electron）**：显式 roots 之外自动发现桌面客户端组件——`src-tauri/tauri.conf.json` 存在时把 `src-tauri/src` 纳入扫描，`electron/` 目录含 TS/JS 文件时纳入扫描；`Project` 画像新增 `rustFileCount`/`tauriDetected`/`electronDetected`/`language`（如 "TypeScript + Rust"），`frameworkVariants` 携带 tauri/electron；架构层新增 `tauri`（Rust 原生层）与 `electron`（主进程层）路径强信号直判；Java/Go 等后端代码不入扫描范围
- **实体类图（蓝图查看器新 Tab）**：UML 风格 SVG 类图——类框（名称 + 字段/变体 + 方法摘要，Rust struct 含 derives 徽标）、关系边（implements 虚线 / extends 实线 / 接口继承）、按派生层级分列布局；语言（TS/Vue/Rust）/类型/架构层分布条形图与跨语言关系计数；模块/类型/语言/关键词过滤 + 实体清单表格（字段/方法/关系度/实现继承/死代码状态）；图节点选取：关系活跃实体优先 + 各语言代表性实体按成员规模轮转补齐（无继承关系的 Rust struct 也能进入类图）；悬停高亮相邻节点与关系边、点击查看实体详情

### 变更

- 扫描扩展名新增 `.rs`；SKIP_DIRS 新增 `target`（Rust 构建产物）；`.backup` 后缀文件跳过
- Markdown 报告实体表格新增「语言」列（TS/Rust），项目概览新增 Rust 文件计数行
- 本体蓝图对象描述更新：Interface/Class/Method 标注 Rust 同构映射（trait → Interface、struct/enum → Class、impl fn → Method）

### 验证

- 新增 `test/rustEntities.test.mjs`（10 个用例）：struct/enum/trait 提取（derives/字段/变体/方法合并）、use 花括号组解析、crate/super 路径映射、通配 use 豁免、Rust 死代码判定
- 新增实体类图 viewmodel/渲染测试（跨语言 UML 类框 + 关系边 + 内嵌脚本可执行）
- 总计 96 个测试全部通过；真实项目回归：steam-game-hub-2.0（React + Tauri，44 个 .rs 文件 → 151 个 Rust 实体入图）与 steam-stat（Vue + Electron，electron/ 目录 7 文件入 electron 层）

## [0.8.0] - 2026-08-21

### 新增

- **单文件分析（`action analyzeFile`）**：不落盘、不建快照，stdout 直接输出 dataMap 形状 JSON（`_meta.mode === 'single-file'`），可与 jq/findstr 管道组合——独立油猴脚本与单个 TS/JS/Vue 文件的零成本体检入口：
  - 参数：`{"file": "path/to/x.js"}`（相对 cwd 或绝对路径；支持 .ts/.tsx/.js/.jsx/.mjs/.vue 与油猴脚本）
  - 油猴文件自动路由 userScriptAnalyzer 链（输出 UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction 五类），其余走 tsAnalyzer/vueAnalyzer 链（输出 Interface/Class/Method）
  - 单文件模式判定边界：仅"本文件内零引用"的非导出实体判死；导出实体一律不判死（单文件视角无法判定跨文件使用）
- **导出级死代码（unusedExports）**：每文件导出符号 × 全仓库具名导入对照 → `SourceFile.unusedExports[]` + `_meta.deadExportCandidates` 汇总；入口文件、re-export 链、动态 `import()` 引用保守豁免。死代码检测升级为**四级**（文件级 orphanCandidates / 导出级 unusedExports / 类型级 Interface/Class deadCandidate / 函数级 Method/ScriptFunction deadCandidate），`Project.health` 汇总四级计数（orphanFileCount/deadExportCount/deadTypeCount/deadFunctionCount）
- **油猴脚本函数级死代码（ScriptFunction.deadCandidate）**：复用保守引用计数规则——函数名全文出现次数（排除声明处与自身函数体）为 0，且 calledByCount=0、非 topLevelCalls 命中、非 constructor、非事件回调角色、未暴露到 unsafeWindow → `deadCandidate/deadReason`；UserScript 画像新增 deadFunctionCount
- **Skill 拆分（3 个）**：场景工作流从 CLI/Skill 分离——`nice-aos`（核心查询：快照/影响分析/蓝图导出，瘦身重写）、`nice-aos-userscript`（油猴审计：GM 越权/@connect 白名单/XSS 面/风险分级五步工作流 + 实战修复模板）、`nice-aos-deadcode`（四级死代码清理：检测 → 分级复核 → 清理 → 验证）。三者共享同一份 CLI 与快照；CLI 保持原子普适，场景编排全部下沉 Skill
- Markdown 报告「死代码候选」升级为四级章节（文件级 + 导出级 + 类型级 + 函数级，函数级含油猴 ScriptFunction）

### 变更

- 快照目录约定统一为 `<REPO_ROOT>/.nice-aos/data`（CLI 默认回退链第一候选），三个 skill 共享一份快照；`--snapshot-dir` 显式传参与 `NICE_AOS_SNAPSHOT_DIR` 环境变量继续支持任意路径
- package.json `files` 追加 `skills/**/SKILL.md`（npm 包携带三个 skill 文件，`npx nice-aos` 用户可直接取用）

### 验证

- 新增 `test/deadcode.test.mjs`（7 个用例）：导出级命中与豁免（入口文件/本文件使用不误报）、ScriptFunction deadCandidate（零引用死函数命中、事件回调/被调用函数不误报）、analyzeFile 动作（TS 文件与油猴文件输出形状、不落盘）
- 总计 85 个测试全部通过；自举验证（refreshRepo + query Class/Method 定位自身代码）与真实项目回归见发布流程

## [0.7.0] - 2026-08-21

### 新增

- **类型体系实体化（Interface / Class / Method）**：解决"实体关系记录在实现类中、从接口正向 query 不到"的断层，对象类型 15 → 18 种（均归 CodeUnit/L1 单元层）：
  - **Interface（`iface:`）**：接口全量提取（含 `.d.ts`），携带方法签名、extends 继承链、导出标记
  - **Class（`class:`）**：类全量提取，携带 implements/extends 关系、单例标记（`static getInstance`）、方法清单
  - **Method（`method:`）**：类方法、接口方法签名、模块函数（顶层声明 + const 箭头函数）统一为方法实体；ownerKind（class/interface/module）、isStatic/isAsync、展示用签名；ID 约定 `method:<file>#<Owner>#<name>`（模块函数 `method:<file>#<fnName>`）
- **实现/继承/覆盖关系（链接 15 → 21 种）**：
  - `implements` / `implementedBy`：Class ↔ Interface 双向——`link implementedBy --src "iface:src/types/storage.ts#IStorage"` 直接列出接口的全部实现类
  - `extends` / `extendedBy`：接口与类的继承链双向
  - `overrides` / `overriddenBy`：方法级覆盖双向——接口方法 → 全部实现类方法；子类方法 → 被覆盖的父类/接口方法
  - 跨文件解析：本文件声明优先，其次具名导入（含 `import type` type-only 导入与 `IStorage as StorageContract` 别名导入，按 imported 名定位目标文件导出）；解析失败留存原名不报错
  - `contains` 扩展：`file:` 可下钻类型实体，`iface:`/`class:` 可下钻其方法
- **函数级/类型级死代码候选（保守判定）**：在文件级 orphanCandidates 之外新增两级——非导出实体本文件零引用、导出实体全仓库零导入且本文件零引用 → `deadCandidate/deadReason`；引用计数排除声明处与自递归；接口方法为契约声明永不判死；命名空间导入 / `export *` / 动态 `import()` 目标文件整体豁免。健康指标（Project.health）新增 deadTypeCount / deadFunctionCount
- **Markdown 报告新章节**：「接口与实现」（接口清单 + implementedBy 实现类 + 方法覆盖矩阵，契约方法未被覆盖时标 ⚠️）、「类与方法」（类清单含 implements/extends/单例 + 契约热点 Top 30）、「死代码候选」升级为三级（文件级 + 类型级 + 函数级）；修复表格内联合类型 `|` 撑破列的转义问题

### 验证

- 新增 `test/typeEntities.test.mjs`（11 个用例）：tsAnalyzer 事实提取（接口继承/方法签名/类 implements/静态异步方法/模块函数与引用计数）、端到端实体构建与 objectCounts、跨文件 implements（type-only + 别名导入）、类继承与方法级 overrides 双向、blueprint 六种新链接、保守死代码判定（DeadClass/orphanHelper 命中，AliveClass/caller/接口方法不误报，导出未导入函数按导出级判死）、`--where` 过滤（`name~get,ownerKind=class`）
- 总计 78 个测试全部通过

### 变更说明

- query/link 命令为泛型实现（由 OBJECT_TYPES/LINK_TYPES 驱动），本版本零 CLI 命令改动即支持全部新类型/新链接
- 快照新增 Interface/Class/Method 三个 key，向后兼容（老快照/消费方不受影响）；大仓库快照体积约增至 2-3 倍（万级 Method 实体），载入仍在数百毫秒级
- Vue SFC `<script>` 内的 interface/class 本期不提取（Vue 侧已有 Hook/Composable/Store 体系）；TS 方法级调用图（calls/calledBy）未扩展到 Method

## [0.6.3] - 2026-08-21

### 新增

- **蓝图查看器宽屏适配**：内容宽度从固定 1400px 改为分档自适应（1600/1920/2240/2560px 断点逐步扩至 2400px）并居中，超宽屏不再右侧大片空白；脚本调用图 SVG 等比缩放（viewBox + max-width:100%），宽屏完整呈现、窄屏不再右缘截断
- **油猴脚本三视图意图适配（函数意图分析）**：无 React/Vue 结构的纯脚本仓库，领域蓝图/业务数据图/业务逻辑流向三个视图按函数意图（roles）重建，而非显示空壳占位：
  - **意图功能域**（领域蓝图适配）：单文件脚本无目录级功能域时，按函数主角色（渲染注入/数据获取/状态存取/事件监听/元素构建/纯逻辑）聚合为虚拟功能域，卡片展示各意图的行为计数（DOM 注入/网络/监听/GM API），点击下钻函数清单（按重要性排序）；仅单一意图的纯功能增强脚本不生成
  - **脚本存储枢纽**（业务数据图适配）：无 Zustand/Pinia Store 时以浏览器存储（localStorage/sessionStorage/indexedDB）与 GM 存储 API 为数据枢纽，展示各脚本存储信号、状态存取函数、宿主数据读取（unsafeWindow 全局变量）；无任何持久化信号的脚本不生成
  - **函数意图流转矩阵**（业务逻辑流向适配）：单文件无模块导入时，函数调用边按「调用方意图 → 被调方意图」聚合为热力矩阵（事件监听 → 纯逻辑 → 数据获取/状态存取 → 渲染注入），附高扇入函数（变更影响面）清单；调用流转稀疏的扁平脚本不生成
  - **Tab 显隐**：三视图各自独立判定，分析不出有效数据（如纯功能增强脚本）时隐藏对应 Tab，不再显示空壳
- **解析器：localStorage/sessionStorage/indexedDB 归属函数**：存储操作按包含函数归属（storageOpCount），函数角色推断的 state 角色从仅 GM 存储扩展到浏览器存储

### 验证

- Steam-License-Classifier-2.5.0（单文件审核场景）：意图功能域 6 组（纯逻辑 111 / 渲染注入 26 / 事件监听 9 / 数据获取 3 / 状态存取 3 / 元素构建 1）；存储枢纽 localStorage × 21 + indexedDB × 1 + 宿主读取 g_sessionID/g_steamID；意图流转 247 调用边（跨意图 156），Top 流转 渲染注入→纯逻辑 94、事件监听→纯逻辑 20
- steam-tampermonkey-scripts 全仓（混合场景，228 脚本 + 28 目录级功能域）：领域蓝图走正常目录域路径（不重复生成意图域），存储枢纽 228 个（45 个 localStorage 信号 + 140 个 GM 存储信号）、意图流转 73269 调用边正确激活
- DOM stub 渲染验证：三视图适配渲染器（renderScriptDomainList/renderScriptDataMap/renderScriptFlow）在真实快照上执行通过，矩阵热度格子、高扇入函数、Tab 显隐均正确
- 新增 3 个测试（多意图脚本三视图重建 / 纯功能增强脚本三视图隐藏 / 宽屏断点与 SVG 自适应），总计 67 个全部通过

## [0.6.2] - 2026-08-21

### 修复

- **HTML 入口引用盲区（Vite 多页应用）**：扫描器探测扫描根及宿主根顶层 `*.html` 的 `<script src="/src/xxx.tsx">` 根绝对路径引用，作为硬证据入口（`htmlEntryFiles`）；嵌套入口文件（如 `src/managed-agent/main.tsx`）不再被误判为死代码候选（asdm-agentlink/web：死代码候选 20 → 19，剩余经抽查为真实死代码）
- **蓝图架构分层排版压缩换行**：此前层名与描述拼接（如 `状态层（前端状态共享比如（Zustand / Pinia Store））`）挤在 90px 标签列内，被压缩成 3-5 行竖排堆叠、括号双重嵌套；现改为层名单行标签 + 描述作为条形图下方独立副行（与柱条对齐、小字号弱化），标签列加 `white-space: nowrap` 防压缩，窄屏下副行左对齐

### 验证

- asdm-agentlink monorepo 双子包端到端：web（React + Vite，202 文件，HTML 入口修复生效）+ server（Express 后端，254 文件，子包依赖清单正确，2 个未声明依赖均为真实治理点：@jest/globals 未声明、vitest 与 jest 混用残留）
- 新增 2 个测试（HTML 入口探测 / 架构分层排版 DOM stub 渲染验证），总计 64 个全部通过

## [0.6.1] - 2026-08-21

### 新增

- **项目框架识别增强（扫描 src 等子目录场景）**
  - 宿主项目定位：扫描目录自身无 package.json 时，向上查找最近宿主根（上限 4 层、不越过用户 home），用宿主依赖识别框架、回退项目名/版本，宿主依赖全量进入清单（扫描 src/ 时 react 等不再误判为未声明依赖）
  - 框架识别扩展：expo / react-native / next / nuxt 元框架优先识别，宿主 app.json 含 expo 键作旁证；无任何清单时按代码信号兜底（.vue 文件 → vue，tsx/jsx → react）
  - 跨端/构建变体（frameworkVariants）：Capacitor / Electron / Vite / Webpack，组合标签如 "React 单页应用 + Capacitor 跨端（Vite 构建）"，Project 携带 frameworkLabel / hostRoot / hostConfigs 证据
  - 宿主 tsconfig 路径别名重定基：扫描 src/ 时宿主的 `"@/*": "./src/*"` 重定基为 `./*`，`@/` 别名导入恢复解析（此前 600 处 `@/services` 等全部误判为未声明依赖）
  - solution 风格 tsconfig：根文件仅含 references 时递归合并子配置（tsconfig.app.json 等）的 paths（根 paths 优先，含自引用防御），`#/` 等多别名场景恢复解析
  - Node 内置模块（node: 前缀、裸名 fs/path/child_process/readline 等、子路径 fs/promises 与 readline/promises）识别为 builtin；Vite 虚拟模块（virtual:generated-pages / virtual:app-loading 等构建时生成）识别为 virtual，均不再计入依赖清单与未声明依赖
- 真实仓库验证（四类项目）：
  - nice-today-2.0（React + Capacitor + Vite，扫描 src/）：框架从 unknown → 正确识别；未声明依赖 62 → 8（剩余为真实治理点：d3 子包、@capacitor 局部插件）；别名恢复后暴露 1 组此前隐藏的循环依赖（8 → 9）
  - qa-live-healthcare（Vue 3 + Vite）：框架正确识别为 "Vue 单页应用 + Vite 构建"；未声明依赖仅剩真实治理点（@ant-design/icons-vue 导入未声明）
  - steam-stat（Vue 3 + Electron + Vite）：识别为 "Vue 单页应用 + Electron 桌面端（Vite 构建）"；solution tsconfig 的 `@/*` + `#/*` 双别名全部解析；virtual: 模块排除后未声明依赖归零
  - asdm-agentlink-cli（Node CLI，commander）：不误判为前端框架（保持"前端项目"中性标签）；readline 等内置模块子路径修复后未声明依赖归零
- 新增 12 个测试（宿主定位/框架识别/变体/别名重定基/solution tsconfig/builtin 子路径/virtual 模块），总计 62 个全部通过

## [0.6.0] - 2026-08-20

### 新增

- **脚本蓝图视图（viewer 第五视图"脚本蓝图"）**：油猴脚本开发者一图直读"入口函数 → 调用链 → DOM 注入锚点 / 网络域"的完整逻辑注入链
  - **SVG 函数调用关系图**：函数节点按调用深度分层布局（入口 → 逐层调用，BFS 定级），实线为函数调用、青色虚线为 DOM 注入（指向页面锚点）、紫色点线为网络请求（指向域名端点）；悬停高亮相邻节点与边，点击查看函数详情（角色/行号/调用关系/注入目标/GM API）或锚点详情（归属函数/插值标记/@connect 比对）
  - **DOM 注入锚点列**：还原后的页面选择器（如 `querySelector('#app')`、`getElementById('sfd-status-txt')`）作为图上独立节点，注入类型/次数/动态插值标记一目了然
  - **网络端点列**：请求域名 + kind（gm-xhr/fetch/xhr/websocket/beacon）+ 方法 + `@connect` 声明比对
  - **函数业务角色分布**：render/data/state/event/ui/logic 六类角色统计条形图；函数清单表含调用/被调/GM/DOM/网络五维计数
  - **数据聚合**：函数重要性加权排序（被调×3 + 调出 + 注入/请求×2）取 Top N 入图，入口函数（topLevelCalls 命中）必进图；脚本按函数数排序展示 Top 24；大脚本截断保护（图节点 50 / 函数表 40 / 注入 20 / 端点 12，计数保留全量）
- **油猴脚本解析增强（userScriptAnalyzer）**
  - **函数业务角色推断（roles）**：按函数内行为推断 render（innerHTML/挂载）/ data（网络请求）/ state（GM 存储）/ event（监听/观察/定时）/ ui（createElement）/ logic（纯逻辑），最多双角色；ScriptFunction 携带 `roles` 字段
  - **注入点与网络端点归属函数（fns/fnIds）**：DOM 注入与网络请求按"最内层包含函数"归属，InjectionPoint/NetworkEndpoint 携带 `fns`（函数名）与 `fnIds`（指向 ScriptFunction），构成逻辑注入链的数据基础
  - **类风格调用链补全**：类 `constructor` 收集为逻辑单元；`this.method()` 类内互调解析为 `Owner.method`；`const app = new Xxx(); app.method()` 实例变量调用经别名表解析为 `Xxx.method`；`new Xxx()` 记为 `Xxx.constructor` 入口调用
  - **innerHTML/insertAdjacentHTML 锚点还原**：receiver 为 `querySelector`/`getElementById` 变量时还原为页面选择器（此前保留变量名），与挂载点还原口径一致
- 真实仓库验证：steam-tampermonkey-scripts（227 个脚本 / 47588 个函数 / 5381 个注入点 / 419 个网络端点），最大脚本（Steam 游戏库展示 v2.11.35，900+ 函数）调用图 58 节点中 42 个有调用关系；steam-friend-manager 的注入锚点归属函数链清晰（如 `renderActiveTab/renderPersonalLibraryTab → getElementById('sfd-pl-tab-content')`）
- 新增 4 个测试（类风格调用链解析 / 注入与网络归属函数 / 角色推断 / viewer 脚本蓝图聚合与 HTML 渲染），总计 52 个全部通过

## [0.5.0] - 2026-08-20

### 新增

- **本体查看器（viewer.js，src/ontology 视图层）**：延续"方案查看器（蓝图）"架构理念，把快照的抽象结果聚合为可交互消费的蓝图，解决"语义总结有了、但没有可视化载体"的问题
  - **数据聚合（buildViewerModel）**：DataMap → 视图模型（JSON），四个板块：本体蓝图（taxonomy + 对象/链接类型 + 实例计数）、领域蓝图（每个功能域的业务层级构成/代码组织/模块清单/单元清单/职责画像）、业务数据图（Store 数据枢纽 + 被哪些域使用 + 跨域数据依赖 + 持久化状态汇总）、业务逻辑流向（架构层间导入流向矩阵 + 跨域依赖边 + 高扇入 Service/Store 枢纽节点）
  - **视图渲染（renderViewerHtml）**：视图模型 → 自包含 HTML（零外部依赖，可离线打开），四个标签页：总览 / 领域蓝图 / 业务数据图 / 业务逻辑流向；层间流向以矩阵呈现（行=来源层，列=目标层），单元清单带大仓库截断保护（计数保留全量）
  - **视图模型独立于渲染**：`export --format viewmodel` 输出聚合 JSON，供 AI agent 与其他前端直接消费；`export --format html` 输出蓝图 HTML
  - 真实仓库验证：React 仓库（steam-portal，26 域 / 3 Store / 76 条层间流向 / 15 个服务枢纽）与纯油猴仓库（steam-tampermonkey-scripts，28 域 / 无 Store 与路由时数据图与流向优雅降级为空态）
- 新增 3 个测试（viewer：视图模型结构完整性/自包含 HTML 嵌入数据无损解析/空数据仓库降级），总计 48 个全部通过

## [0.4.0] - 2026-08-20

### 新增

- **语义本体引擎（semantics.js）**：解决"对象结构只罗列事实、无抽象总结"的问题，解析产出从词法级事实升级为具备语义分层与聚合总结的本体
  - **概念分类体系（taxonomy）**：`ONTOLOGY_META` 显式定义概念范畴（Container/CodeUnit/EntryPoint/Script/Environment/AuditFact，is-a 族）与抽象层级（L3 架构层 / L2 结构层 / L1 单元层 / L0 事实层），15 种对象类型全部挂接双维分类，不再平铺
  - **语义架构分层**：`archLayer`（entry/presentation/state/service/integration/shared/types/config/script/test/mixed）按内容信号推断（单元构成、路由归属、引用结构），目录名仅作弱信号回退；Module 附带 `layerComposition` 层构成画像，构成分散（主导层 < 60%）时如实标记 mixed；取代原先"目录名即层级"（`layer` 字段保留为目录层，两者并存）
  - **功能域聚合（Domain 对象，dom:）**：路由域段 + 业务命名目录（父目录为技术边界、自身命名非技术词，大小写/连字符/下划线归一）聚合为横向功能切片，与纵向架构层正交；成员含路由/组件/Store/Hook/Service/油猴脚本/模块，附 `capability`（路由 meta 能力描述）与 `summary`（含 Hook/Service 计数，`hookCount`/`serviceCount` 可查询）
  - **自然语言总结**：Project 新增 `summary`（框架定位 + 分层构成 + 功能域清单 + 健康度）、`architecture`（style 分层画像/层占比）、`health`（循环依赖/死代码/未声明依赖/高风险脚本/解析错误计数）、`capabilities`（每域一句话）；Module 新增 `summary` 职责画像（层级、单元构成、模块外引用数、承载路由数）、`subtreeFileCount`、`unitCounts`、`dominantShare`、`domainIds`
  - **单元级归属回填**：Component/Hook/Store/Service/UserScript/ScriptFunction 新增 `archLayer`（继承所在文件）与 `domainIds`（所属功能域，数组支持 `--where "domainIds=dom:xxx"` 成员过滤）
  - **belongsTo 链接（第 15 种）**：功能域 ↔ 成员双向（`link belongsTo --src dom:health` 列成员；src 传 comp:/store:/mod:/route: 反查所属域，fn: 归属其脚本的功能域）；Project 的 `contains` 现包含直属 Domain
  - **报告升级**：新增"执行摘要"（总结句列表 + 健康指标表）、"架构总览（语义分层）"（层/定位/文件数/占比）、"功能域地图（Domain）"（域/来源/路由/组件/Store/脚本/文件/职责画像）三个章节；模块 Top 30 升级为语义层 + 层构成 + 直属/子树文件数 + 职责画像
- 新增 13 个测试（semantics：taxonomy 完整性/文件级分层推断/模块级混合层判定/总结生成/buildDomains 归一合并/React fixture 端到端/油猴仓库端到端），总计 45 个全部通过

### 修复

- Module 画像口径不一致：原 `fileCount` 为直属文件数，聚合模块（如 `steam-account-history`）显示"0 个文件"却带大量子树单元 → 总结改用 `subtreeFileCount` 子树口径，导出表同时呈现直属/子树两列

## [0.3.0] - 2026-08-20

### 新增

- **油猴脚本（Tampermonkey UserScript）扫描**：独立 `userScriptAnalyzer` 解析器，与 React/Vue 解析器平级共存、逻辑互不干扰
  - 脚本识别：`.user.js` 扩展名，或 `.js` 文件头部 4KB 内含 `==UserScript==` 元数据块；纯油猴仓库无需 package.json（`framework=userscript`，refreshRepo 不再强制要求 package.json）
  - 5 种新对象：`UserScript`（us:，元数据/@match/@grant/@connect/宿主框架/风险等级）、`GmApiUsage`（gm:，GM 调用与 @grant 声明比对）、`InjectionPoint`（inject:，mount/innerHTML/insertAdjacentHTML/document.write/GM_addStyle/style 元素/Shadow DOM，动态插值 XSS 标记）、`NetworkEndpoint`（net:，gm-xhr/fetch/xhr/websocket/beacon 域名 + @connect 白名单比对）、`ScriptFunction`（fn:，函数/类/对象方法逻辑单元）
  - 5 种新链接：`usesGmApi`/`injectsInto`/`requestsTo`（脚本 ↔ 子对象双向）与 `calls`/`calledBy`（脚本内函数静态调用图）
  - 解析能力：元数据块全字段提取（@grant none 归零）、GM_*/GM.* 双风格归一、querySelector 变量锚点还原挂载目标、unsafeWindow 读/写区分、window 全局暴露与 Object.defineProperty、宿主框架推断（__vue__/__reactContainer$）、原型/全局请求劫持识别（fetch/XHR/EventTarget/WebSocket/history）、eval/new Function、cookie 读写、MutationObserver/定时器/CustomEvent 事件总线
  - 安全风险清单：按 high/medium/low 汇总为脚本级 riskLevel（请求劫持/动态执行/沙箱突破/XSS 面/权限越界）
  - 报告新增 6 个章节：油猴脚本一览（含逐脚本元数据详情）、GM API 使用、DOM 注入点、网络请求与请求劫持、脚本函数 Top 30、安全风险清单
- 新增 11 个测试（userScriptAnalyzer：元数据/候选识别/GM API/DOM 注入/网络与劫持/函数调用图/unsafeWindow/宿主框架/扫描器/本体构建与链接），总计 32 个全部通过

### 修复

- 多入口识别：入口文件原硬编码为 `src/App.tsx` 等单根路径，多 roots monorepo 下 isEntry 全部为空 → 改为按扫描根顶层入口文件名动态匹配（`web/src/main.tsx`、`server/src/index.ts` 等均可命中）
- zustand 泛型 `create<T>()(...)` 漏识别：`create` 位于内层 call 不满足收集条件，8 个 store 仅识别 1 个 → 收集阶段向上穿透到外层 call，factory 改取外层 call 的 `arguments[0]`，persist/devtools 双层嵌套（`devtools(persist(...))`）改为循环穿透

## [0.2.0] - 2026-08-20

### 新增

- **Vue 3 框架适配**：`.vue` SFC 扫描与框架检测（package.json 依赖含 vue/nuxt → `framework=vue`，快照新增 `vueFileCount`）
  - SFC 解析：`<script setup>`/`<template>`/`<style>`/`<route lang="yaml">` 块拆分（template 内嵌 `<template #footer>` 不误拆）；组件名 `defineOptions({ name })` 优先，否则文件名派生；`defineProps` 数组/对象形式计数；template 标签（kebab/PascalCase 统一）供 renders 关系
  - Pinia store：`defineStore` 的 setup 写法（shorthand 函数经函数名集合识别为 action）与 options 写法（`login() {}` MethodDeclaration 计入 actions），`persist` 插件第三参数提取 storageKey；支持 unplugin-auto-import 无 import 语句的隐式 `defineStore`
  - vue-router：`RouteRecordRaw` 显式声明（path/name/meta.title/动态 import/Layout 函数包装/children 拼接，空 path 子路由正确拼接）；`useRouter()` 声明与解构 `push` 归属导航调用（数组 push 不误报）；`src/views|pages/**/*.vue` 文件路由推导（`index.vue` → 父级路径，`[...all].vue` → catch-all），`<route lang="yaml">` meta 作为路由描述
- **React JSX 声明式路由提取**（react-router v6/v7 的 `<Routes>/<Route path element>` 模式，自动探测）
  - 布局 Route（无 path）+ 绝对 children、嵌套相对路径拼接（`/:scopeUid` + `edit` → `/:scopeUid/edit`）、`index` 路由、`path="*"` catch-all
  - element 解析链：`<Guard><Page /></Guard>` 嵌套包装取最内层组件；`element={layoutElement}`（`createElement` 布局变量）穿透到实际布局组件
  - `<Navigate to>` 重定向边：字面量提取，相对 `to` 基于所属路由归一为绝对 overlayId（`to="_overview/summary"` → `/:scopeUid/_overview/summary`）；动态 `to={expr}` 不误报
  - 测试文件中的 mock 路由自动排除
- **page kind 升级**：`pages/` 目录下被路由直接引用的 common 组件自动标记为 page（asdm-admin-web 实测 8 → 48）
- Route 对象新增 `routeType`（overlay/react/vue）；React 路由 id 冲突（index 路由与父路由同 overlayId）经 uniqueId 去重

### 修复

- Vue 显式路由的 domain 取自路由声明文件名（`router/index.ts` 时全部为 `index`）→ 统一按路径顶层段计算（`/` 与动态参数/catch-all 顶层段归入 `root`，如 `/:all(.*)*` → `root`）
- tsconfig.json 含 `//`/`/* */` 注释时（如 shadcn-vue CLI 生成的文件）`JSON.parse` 失败导致 `@/` 别名全部解析失败 → 解析前自动剥离注释（字符串内序列受保护）
- `src/views/index.vue` 文件路由被推导为 `/index` 而非 `/`
- 显式路由与文件路由重复生成（explicitRouteFiles 未命中时）

### 测试

- 新增 14 个测试：Vue（SFC 拆分/route meta/defineProps/defineOptions/Pinia setup/options store/RouteRecordRaw/useRouter 导航/template 嵌套）与 React JSX 路由（布局/嵌套相对路径/index/包装 element/Navigate 归一/普通项目空路由），总计 21 个全部通过

## [0.1.0]

### 新增

- 初始版本：React/TypeScript 前端代码本体分析 CLI
  - 结构化本体快照：Project/Module/SourceFile/Component/Hook/Store/Service/Route/Dependency 9 种对象 + import/render/navigate/register/usesStore/usesHook 等关系图谱
  - 命令：`query`（`--where` 过滤）、`link`（关系遍历）、`action`（refreshRepo/markReviewed/addNote）、`export`（Markdown 全景报告/JSON）
  - 解析能力：tsconfig paths 别名解析、`.tsx` 组件识别（React.FC/memo/forwardRef/分离式 default）、Zustand create/persist store、useXxx Hook、Service 目录识别、依赖治理、死代码候选、Tarjan 循环依赖
  - overlay 路由体系自动探测（overlayGroups + lazyImports）
