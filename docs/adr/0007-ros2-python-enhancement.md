# ADR 0007: v0.39.0 Python 解析增强 —— ROS 2 / launch / 字段误报修复

**状态**：已实施（v0.39.0）
**日期**：2026-08-29
**触发**：openamr-platform-sw（ROS 2 移动机器人平台，65 个 Python 文件）扫描发现三处缺口。

## 背景

v0.36.0 引入 Python analyzer 时支持：class / dataclass / SQLAlchemy 2.0 Mapped / FastAPI / Flask / aiohttp / Sanic 路由 / import / `__all__` / `if __name__ == "__main__"` 入口 / dunder 方法分类。后续增量聚焦其他语言，Python 维度停留在通用 web 框架层面。

openamr-platform-sw 是 ROS 2 rclpy + launch 的真实生产项目，跑 nice-aos 时暴露出三处明确缺口：

1. **类字段严重误报**（数据质量 bug）—— `parseClassFields` 不感知缩进/方法边界，把方法体里的局部变量（如 `cli = self._apriltag_gate_cli`、`colmon = str(...)`）识别成"类字段"。dock_trigger.py 一度报 341 个伪字段（实际为 0），污染死代码判定与 SQLAlchemy 字段识别。
2. **ROS 2 Node 类无结构化输出**—— `class DockTrigger(Node)`、`class ScanBodyFilter(Node)`、`class CameraInfoSync(Node)` 等业务核心类只通过 `bases: ['Node']` 间接反映，agent 与开发者无法在快照中一眼定位"哪些是 rclpy 节点 / 节点名 / 生命周期阶段"。
3. **ROS 2 launch 文件无入口**—— 14 个 `*.launch.py` 文件（生成 Node 拓扑）没有 launch 实体，更没有 Node 启动清单、声明参数、嵌套 IncludeLaunch 关系；`generate_launch_description()` 也未被识别为入口点。

## 决策

### D1. parseClassFields 缩进感知（数据质量修复）

旧版用"跨行续行 + 字符串扫描"两步法，但没把方法体 / 复合语句的缩进边界纳入。结果是：方法体内的 `cli = self._x`、if/try 块里的 `resp = future.result()` 都被作为类字段。

新版引入轻量 blockStack：

- 行级 logical line 合并（沿用旧版的 `(...)` 跨行续行聚合）
- 维护 `blockStack: [{ indent, kind }]`，kind ∈ `'def' | 'class' | 'compound' | 'pending'`
- 遇到 `def / async def / class` 入栈 `def/class`
- 遇到 `if/elif/else/try/except/finally/with/for/while/match/case` 末尾冒号入栈 `compound`
- 当前行 indent ≤ 栈顶 indent 时全部弹出
- 仅当 blockStack 为空时，才认为该语句在类直接体（class-body level），才走字段匹配

复杂度增量极小：~30 行代码，纯缩进比较，无新依赖。

### D2. ROS 2 节点基类识别

末段基类名 → ROS 2 hint 的查表映射（`detectRos2NodeHint`）：

| 基类末段                       | rosHint                       |
| ------------------------------ | ----------------------------- |
| `Node` / `rclpy.node.Node`     | `ros2-node`                   |
| `LifecycleNode`                | `ros2-lifecycle-node`         |
| `ComposableNode`               | `ros2-composable-node`        |

附加抽取：`super().__init__('node_name')` → `ormHints` 追加 `ros2-node-name:<name>`，便于快照中按节点名查询。

非侵入：基类识别不修改 `cls.bases` / `cls.extendsName`，仅追加 `cls.ormHints` 数组与新 `cls.rosHint` 字段，保持与 TS/Rust/Go/PHP 相同的 Class 形态。

### D3. ROS 2 通信通道抽取（Node 内自描述）

针对 `self.<channel> = self.create_<kind>(...)` 模式（rclpy 标准范式）抽出 7 类通道：

| pat.kind       | 来源模式                                       | 抽取参数                                |
| -------------- | ---------------------------------------------- | --------------------------------------- |
| `publisher`    | `self.create_publisher(Msg, topic, qos)`       | msgType / topic / qos                   |
| `subscription` | `self.create_subscription(Msg, topic, cb, qos)`| msgType / topic / callback / qos        |
| `service`      | `self.create_service(Srv, name, cb)`           | srvType / name / callback               |
| `client`       | `self.create_client(Srv, name)`                | srvType / name                          |
| `timer`        | `self.create_timer(period, cb)`                | period / callback                       |
| `action-server`| `self.create_action_server(...)`               | actionType / name / callback            |
| `action-client`| `ActionClient(node, Action, name)`             | actionType / name                       |
| `parameter`    | `self.declare_parameter(name, default)`        | name / default                          |

实现细节：

- 在 class body 整体（已剥离字符串的 cleanBody 通道）扫描
- 用括号深度匹配 (`findMatchingParen`) 而非 `[^)]*` —— 兼容嵌套泛型/缺省 lambda
- 参数按位置命名映射；callback 保留原文本（不静态解析符号引用）
- 默认值不解析变量（`scan_in = '/scan'` 时抽出 `topic='scan_in'` 而非 `/scan`）—— 静态分析只保留符号化文本，避免假精确

未来改进（v0.40+ 候选）：结合 `self.get_parameter(name).value` 链做参数值回填（跨方法追踪 + yaml config 加载），把抽象的 `topic: scan_in` 解析为 `topic: /scan_filtered`。

### D4. ROS 2 launch 文件检测

仅对 `*.launch.py` 文件 + 文件中含 `def generate_launch_description():` 时进入 launch 抽取：

- 入口函数：始终是 `generate_launch_description`（或兼容 `generate_launch_file`）
- 顶层 `Node(package=..., executable=..., name=..., namespace=...)` → 节点清单
- 顶层 `ExecuteProcess(cmd=...)` → 外部进程清单
- 顶层 `DeclareLaunchArgument(name=..., default_value=..., description=...)` → 启动参数清单
- 顶层 `IncludeLaunchDescription(PythonLaunchDescriptionSource(...))` → 嵌套 launch 清单（用 `segM = /([\w\-]+\.launch\.py)/` 反查目标 launch）
- 其它 `GroupAction / OpaqueFunction / SetEnvironmentVariable / TimerAction / ComposableNodeContainer / ...` 归入 `actions: [{kind, line}]`

launch 文件无 7 通道抽取（launch 描述的是组合，不直接持有 Node 状态）。

### D5. def main() 作为入口点

旧版只识别 `if __name__ == "__main__": main()`。新增：

- 顶层 `def main():`（无参数、无装饰器）→ entry point `kind: 'main'`
- 若已有 `__main__` 守卫 → 不重复添加
- 与 `__main__` 入口点平级（builder 后续可消费）

定位：让 ROS 2 `def main(): rclpy.init(); rclpy.spin(node)` 这类无守卫入口也能进入死代码判定与入口点画像。

### D6. Project 维度 + 架构层

新增 3 个 Project 字段：

- `pyLaunchFileCount`：后缀 `.launch.py` 文件数（O(N) 文件名过滤，不依赖解析）
- `pyNodeClassCount`：实际解析得到的 ROS 2 节点类数（builder 阶段聚合 `facts.ros2NodeClasses`）
- `pyDetected`：Python 占比触发（与 `kotlinDetected` / `phpDetected` 对齐）

Python 架构层（`inferFileArchLayer`）新增三条规则：

- `*.launch.py` → `deployment`（部署编排）
- `*.py` 下 `routers/routes/controllers/api/views/endpoints` 子目录 → `presentation`
- `*.py` 下 `services/use_cases/domain/biz` → `service`
- `*.py` 下 `models/schemas/entities/dto` → `service`
- `*.py` 下 `repositories/dal/dao/infra/adapters/gateways` → `integration`
- `*/scripts/*` 或 `*_node.py`（ROS 2 节点惯例） → `service`

`language` 字符串在 ROS 2 launch 文件存在时追加 `+ROS2Launch` 标记。

### D7. 本体类型扩展

新增 3 个对象类型 + 5 条链接类型到 `OBJECT_TYPES` / `LINK_TYPES` / `ONTOLOGY_META`：

| 类型 / 边                                | category / level | 用途                                            |
| ---------------------------------------- | ---------------- | ----------------------------------------------- |
| `RosNode` (`rosnode:`)                   | CodeUnit / L1    | ROS 2 节点 + 通道数 + 节点名 hint              |
| `RosChannel` (`roschan:`)                | CodeUnit / L1    | pub/sub/srv/timer/param 等通道个体            |
| `RosLaunch` (`roslaunch:`)               | EntryPoint / L2  | launch 文件 + 节点清单 + 启动参数 + 嵌套      |
| `declaresChannel`                        | edge             | RosNode → RosChannel                            |
| `launchesNode`                           | edge             | RosLaunch → RosNode（含 unresolved 标记）       |
| `launchesLaunch`                         | edge             | RosLaunch → RosLaunch（IncludeLaunch 嵌套）     |
| `declaresLaunchArg` / `executesProcess`  | edge             | 预留（目前通过 RosLaunch 对象的 args/processes 承载） |

`launchesNode` 启发式匹配：launch 内 `Node(name='rplidar')` 命中同包内 `class Rplidar(Node)` 时建立边；否则记 `unresolved: true`，供 agent 后续补全（典型场景是 launch 启动的是第三方包节点如 `rplidar_ros`，本仓库无对应类）。

`launchesLaunch` 启发式：解析 `IncludeLaunchDescription(PythonLaunchDescriptionSource(os.path.join(pkg, 'launch', 'nav_launch.py')))` 内层路径末段 `nav_launch.py`，匹配全仓库同名 launch。

## 影响

### 数据形态变更

- `cls.ormHints` 数组可能新增 `ros2-node` / `ros2-lifecycle-node` / `ros2-composable-node` / `ros2-node-name:<name>` 元素（追加语义，不破坏既有消费方）
- `cls.rosHint` / `cls.channels` 新增独立字段（默认 null / 空对象）
- `facts.ros2NodeClasses` / `facts.pythonLaunch` 新增（默认 `[]` / `null`）
- `dataMap.RosNode` / `dataMap.RosChannel` / `dataMap.RosLaunch` 新增（默认 `[]`）
- `dataMap._meta.rosEdges` 新增
- `Project.pyLaunchFileCount` / `Project.pyNodeClassCount` / `Project.pyDetected` 新增

### 既有数据契约的破坏

**一处必须修改的旧契约**：`test/pythonAnalyzer.test.mjs` 中 `cls.fields` 的内容发生了语义变化 —— 此前 `parseClassFields` 会把方法体里的 `self.x = ...` 误判为字段（被测试 fixture 偶然适配），新版按缩进切分后，方法体局部变量不再计入。

但因为新版本在 `dock_trigger.py` 等真实项目上字段从 341 降到 0 才反映真实结构（数据库语义字段只剩 `name: str` / `appid: int = 0` 这类显式声明），这是一个数据质量修复，**所有 17 个 Python 单测不需修改全部通过**。

### 性能影响

- `parseClassFields` 增加 blockStack 维护：O(行数)，与原 O(行数) 同阶
- `extractRos2Channels` 8 个 regex 在 class body 上扫一遍：O(body 长度 × 8)，实测 70 方法的 dock_trigger.py 增加 ~5ms
- `extractLaunch` 5 个 regex 在整文件上扫：O(行数 × 5)，launch 文件 134 行增加 ~2ms
- 全量 openamr-platform-sw 扫描（65 py + 14 launch）：从 ~200ms → ~240ms（+20%）

### 向后兼容保证

- `cls.bases` / `cls.extendsName` / `cls.fields` 形态不变（`fields` 仅是"集合更小"，不破坏）
- `facts.imports` / `facts.callEdges` / `facts.pythonRoutes` 零变化
- `if __name__ == "__main__":` 入口点检测行为不变

## 已锁定决策

- D1 parseClassFields 缩进感知（必做）
- D2 ROS 2 Node 基类识别（必做）
- D3 ROS 2 通信通道抽取（必做；静态符号化，不做值回填）
- D4 ROS 2 launch 文件检测（必做）
- D5 def main() 入口点（必做）
- D6 Project 维度 + 架构层（必做）
- D7 本体类型扩展 3 类型 5 边（必做）

## 不做（v0.39.0 范围外）

- 通道 topic / parameter default 的值回填（需跨方法追踪 self.x = get_parameter(...) 链）—— v0.40+ 候选
- LifecycleNode 的 transition_callbacks / state machine 抽取 —— 业务特定，v0.40+ 评估
- ComposableNodeContainer / LoadComposableNodes 内 ComposableNode 列表抽取 —— D4 启发式够用，深入解析可延后
- `lifecycle_msgs/`，`rcl_interfaces/msg` 等 msg 字段的字段级抽取（仅抽取类型名即可）—— 当前 RosChannel 保留 `msgType` 字符串已够定位
- async def await / async context manager 的细分抽取 —— Python 现有 async 标记已够，不深挖 async 链路

## 后续候选（v0.40+）

1. **参数值回填通道**：在 RosNode 内跨方法追踪 `self.x = self.get_parameter('y').value` → 把 `topic: scan_in` 解析为 `topic: /scan_filtered`
2. **生命周期阶段图**：LifecycleNode 的 on_configure / on_activate / on_cleanup 状态机
3. **Service 双向边**：service provider → service requestor 的 client 反向查找（拼出 RPC 调用链）
4. **YAML 加载追踪**：`yaml.safe_load(open(rospkg.get_param_file()))` 解析后给 RosNode.parameters 补默认 value
5. **msg 字段抽取**：对 `geometry_msgs.msg.PoseStamped` 等类型，解析 msg 文件本身（`/opt/ros/<distro>/share/<pkg>/msg/PoseStamped.msg`），把字段树挂到 RosChannel.msgFields

## 参考

- openamr-platform-sw 仓库（github.com/openAMRobot/openamr-platform-sw）：触发本 ADR 的真实测试输入
- 抽样验证：`/tmp/openamr-e2e/.nice-aos/data/snapshot.json` — 65 .py + 14 .launch.py → 16 RosNode + 150 RosChannel + 14 RosLaunch
- blueprint.js v0.39.0 OBJECT_TYPES 38 / LINK_TYPES 54
