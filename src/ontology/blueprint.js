// 本体蓝图：概念分类体系（taxonomy）+ 对象类型 + 链接关系 + 动作的定义与实现
// 与 asdm-aos 的 codeRepoBlueprint 对应，针对 React/Vue 前端重新建模；
// 油猴脚本（UserScript）体系与 React/Vue 组件体系并存、逻辑独立

// 概念元模型：对象类型按"概念范畴"（is-a 族）与"抽象层级"（L0-L3）双维组织，
// 消除 14+ 种类型平铺罗列、无抽象总结的问题
export const ONTOLOGY_META = {
  version: '2.0',
  abstractionLevels: [
    { level: 'L3', name: '架构层', description: '产品级聚合：整体架构画像与功能域划分', types: ['Project', 'Domain'] },
    { level: 'L2', name: '结构层', description: '代码组织结构：模块、文件、路由、脚本与运行环境', types: ['Module', 'SourceFile', 'Route', 'UserScript', 'ShellScript', 'PsScript', 'CMakeTarget', 'CMakeModule', 'ArchPackage', 'NixFlake', 'Dependency', 'NixInput', 'RosLaunch'] },
    { level: 'L1', name: '单元层', description: '可独立理解的代码单元（CodeUnit 概念族）', types: ['Component', 'Hook', 'Store', 'Service', 'Interface', 'Class', 'Trait', 'Method', 'PropEdge', 'ScriptFunction', 'BashFunction', 'PsFunction', 'CMakeFunction', 'NixPackage', 'ArchPackageFunction', 'BashBuiltin', 'Cmdlet', 'CMakeOption', 'RosNode', 'RosChannel'] },
    { level: 'L0', name: '事实层', description: '审计事实（AuditFact 概念族）：从代码提取的行为证据', types: ['GmApiUsage', 'InjectionPoint', 'NetworkEndpoint'] },
  ],
  categories: [
    { category: 'Container', label: '容器', description: '按结构聚合代码单元的节点', types: ['Project', 'Domain', 'Module', 'SourceFile'] },
    { category: 'CodeUnit', label: '代码单元', description: '可独立理解的逻辑单元', types: ['Component', 'Hook', 'Store', 'Service', 'Interface', 'Class', 'Trait', 'Method', 'PropEdge', 'ScriptFunction', 'BashFunction', 'PsFunction', 'CMakeFunction', 'NixPackage', 'ArchPackageFunction', 'RosNode', 'RosChannel'] },
    { category: 'EntryPoint', label: '行为入口', description: '用户可触达的行为入口', types: ['Route', 'RosLaunch'] },
    { category: 'Script', label: '脚本/包描述符', description: '独立于宿主应用的脚本形态与系统级包描述符（自带子对象体系）', types: ['UserScript', 'ShellScript', 'PsScript', 'CMakeTarget', 'CMakeModule', 'ArchPackage', 'NixFlake'] },
    { category: 'Builtin', label: '内建/扩展点', description: '外部命令/cmdlet/CMake 选项/内置函数一类的小粒度可调用单元', types: ['BashBuiltin', 'Cmdlet', 'CMakeOption'] },
    { category: 'Environment', label: '运行环境', description: '外部环境要素', types: ['Dependency', 'NixInput'] },
    { category: 'AuditFact', label: '审计事实', description: '安全/行为审计的原子事实', types: ['GmApiUsage', 'InjectionPoint', 'NetworkEndpoint'] },
  ],
};

export const OBJECT_TYPES = [
  { type: 'Project', prefix: 'proj:', category: 'Container', level: 'L3', description: '代码仓库（含框架识别/架构画像/健康度/总结；扫描子目录时含宿主定位证据）' },
  { type: 'Domain', prefix: 'dom:', category: 'Container', level: 'L3', description: '功能域（横向功能切片：路由+组件+模块聚合）' },
  { type: 'Module', prefix: 'mod:', category: 'Container', level: 'L2', description: '目录模块（含语义架构层 archLayer 与职责画像 summary）' },
  { type: 'SourceFile', prefix: 'file:', category: 'Container', level: 'L2', description: '源文件（ts/tsx/js/jsx/vue/rs/dart，含 archLayer）' },
  { type: 'Component', prefix: 'comp:', category: 'CodeUnit', level: 'L1', description: '前端组件（React / Vue SFC / Flutter Widget）' },
  { type: 'Hook', prefix: 'hook:', category: 'CodeUnit', level: 'L1', description: '自定义 Hook / Composable' },
  { type: 'Store', prefix: 'store:', category: 'CodeUnit', level: 'L1', description: '状态 Store（Zustand / Pinia / ChangeNotifier / Riverpod Provider）' },
  { type: 'Service', prefix: 'svc:', category: 'CodeUnit', level: 'L1', description: '服务/引擎模块' },
  { type: 'Interface', prefix: 'iface:', category: 'CodeUnit', level: 'L1', description: '接口（TS interface / Rust trait / Dart abstract class；含方法签名与 extends 继承）' },
  { type: 'Class', prefix: 'class:', category: 'CodeUnit', level: 'L1', description: '类（TS class / Rust struct/enum / Dart class：kind 区分，含 implements/extends 关系、derives/fields/variants、isWidget/isStore 与单例标记）' },
  { type: 'Trait', prefix: 'trait:', category: 'CodeUnit', level: 'L1', description: '方法复用单元（PHP trait；同一命名空间，可被多个 Class `use` 注入方法；含 usesTraits 反向链接使用方）' },
  { type: 'Method', prefix: 'method:', category: 'CodeUnit', level: 'L1', description: '方法/函数（类方法、接口方法签名、模块函数、Rust impl fn、Dart 方法；含 overrides、callIds/calledByIds 逻辑调用链与 deadCandidate）' },
  { type: 'PropEdge', prefix: 'prop:', category: 'CodeUnit', level: 'L1', description: '组件间 props 传递边（含来源分类 forward/state/store/handler/literal/computed/spread）' },
  { type: 'ScriptFunction', prefix: 'fn:', category: 'CodeUnit', level: 'L1', description: '脚本函数/类/对象（含业务角色 roles：render/data/state/event/ui/logic）' },
  { type: 'Route', prefix: 'route:', category: 'EntryPoint', level: 'L2', description: '路由条目（Overlay / react-router / vue-router / Flutter GoRoute）' },
  { type: 'UserScript', prefix: 'us:', category: 'Script', level: 'L2', description: '油猴脚本（Tampermonkey UserScript）' },
  { type: 'Dependency', prefix: 'dep:', category: 'Environment', level: 'L2', description: '依赖（npm 包 / pub 包）' },
  { type: 'GmApiUsage', prefix: 'gm:', category: 'AuditFact', level: 'L0', description: 'GM API 使用（@grant 声明比对）' },
  { type: 'InjectionPoint', prefix: 'inject:', category: 'AuditFact', level: 'L0', description: 'DOM 注入点（含归属函数 fns/fnIds，构成逻辑注入链）' },
  { type: 'NetworkEndpoint', prefix: 'net:', category: 'AuditFact', level: 'L0', description: '网络端点（v0.41.0 统一：direction=outbound|inbound；覆盖油猴脚本与 Python requests/urllib/httpx/aiohttp 客户端；含归属函数 fns/fnIds）' },
  // ---- v0.38.0: Shell / CMake / PKGBUILD / Nix 维度 ----
  { type: 'ShellScript', prefix: 'sh:', category: 'Script', level: 'L2', description: 'Bash / Zsh 脚本（CLI/安装器/构建/运维；含 fnCount/cliParams/builtinCalls/risks）' },
  { type: 'PsScript', prefix: 'ps:', category: 'Script', level: 'L2', description: 'PowerShell 脚本（CLI/安装器；含 CmdletBinding/Parameters/cmdletCalls/registryOps）' },
  { type: 'BashFunction', prefix: 'bashfn:', category: 'CodeUnit', level: 'L1', description: 'Bash 函数体（startLine/endLine/role：install/check/network/lifecycle/ui/entry/parse/logic）' },
  { type: 'PsFunction', prefix: 'psfn:', category: 'CodeUnit', level: 'L1', description: 'PowerShell function 块（Verb-Noun 形态；role：read/write/check/exec/resolve/transform）' },
  { type: 'BashBuiltin', prefix: 'bashb:', category: 'Builtin', level: 'L1', description: 'Bash 已知外部命令（curl/tar/sudo/jq/sha256sum 等；调用计数）' },
  { type: 'Cmdlet', prefix: 'cmd:', category: 'Builtin', level: 'L1', description: 'PowerShell cmdlet（Verb-Noun 形态；分类 read/write/exec/check/transform）' },
  { type: 'CMakeTarget', prefix: 'cmt:', category: 'Script', level: 'L2', description: 'CMake 目标（add_executable / add_library / add_custom_target）' },
  { type: 'CMakeModule', prefix: 'cmm:', category: 'Script', level: 'L2', description: 'CMake 模块（.cmake 文件或 CMakeLists.txt 本体）' },
  { type: 'CMakeFunction', prefix: 'cmf:', category: 'CodeUnit', level: 'L1', description: 'CMake function / macro 块（含参数列表）' },
  { type: 'CMakeOption', prefix: 'cmo:', category: 'Builtin', level: 'L1', description: 'CMake option(NAME "desc" DEFAULT) 声明' },
  { type: 'ArchPackage', prefix: 'arch:', category: 'Script', level: 'L2', description: 'Arch Linux PKGBUILD（pkgname/depends/build/package 函数）' },
  { type: 'ArchPackageFunction', prefix: 'archfn:', category: 'CodeUnit', level: 'L1', description: 'PKGBUILD 函数体（build/package/check/prepare；含起止行与函数体行数）' },
  { type: 'NixFlake', prefix: 'nix:', category: 'Script', level: 'L2', description: 'Nix flake 或 *.nix 入口（inputs/outputs/packages）' },
  { type: 'NixPackage', prefix: 'nixpkg:', category: 'CodeUnit', level: 'L1', description: 'Nix outputs.packages.<system>.<name> 条目（含 buildInputs）' },
  { type: 'NixInput', prefix: 'nixin:', category: 'Environment', level: 'L2', description: 'Nix flake input（inputs.<name>.url / flake = false 的源依赖声明）' },
  // ---- v0.39.0: ROS 2 维度 ----
  { type: 'RosNode', prefix: 'rosnode:', category: 'CodeUnit', level: 'L1', description: 'ROS 2 rclpy 节点（class X(rclpy.node.Node / LifecycleNode / ComposableNode)）；含 channels 通信通道清单（publisher/subscriber/service/client/timer/action/parameter）' },
  { type: 'RosLaunch', prefix: 'roslaunch:', category: 'EntryPoint', level: 'L2', description: 'ROS 2 launch 文件（*.launch.py 的 generate_launch_description() 入口）；含 nodes 节点清单、args 启动参数、includeLaunch 嵌套启动、executeProcess 外部进程' },
  { type: 'RosChannel', prefix: 'roschan:', category: 'CodeUnit', level: 'L1', description: 'ROS 2 通信通道（publisher/subscriber/service/client/timer/action-server/action-client/parameter）；topic/name、msgType/srvType/actionType 抽象化' },
];

export const LINK_TYPES = [
  'contains', 'imports', 'importedBy', 'renders', 'renderedBy', 'passesProps', 'navigatesTo', 'registers', 'usesStore', 'usesHook',
  'implements', 'implementedBy', 'extends', 'extendedBy', 'overrides', 'overriddenBy',
  'usesGmApi', 'injectsInto', 'requestsTo', 'calls', 'calledBy', 'belongsTo',
  'usesTrait', 'usedByTrait',
  'mapsToTable', 'mappedFromCode',
  // ---- v0.38.0: Shell / CMake / PKGBUILD / Nix 边 ----
  // Shell 脚本边(Bash + PowerShell 共享语义)
  'callsFunction', 'usesBuiltin', 'invokesCmdlet', 'definesParam', 'readsCliParam',
  'downloadsFrom', 'verifiesChecksum', 'writesTo', 'readsRegistry',
  // CMake 边
  'subdirIncludes', 'includesModule', 'declaresOption',
  'addsDependency', 'targetsInclude', 'fetchesDep', 'findsPackage',
  // PKGBUILD 边
  'pkgDependsOn', 'pkgBuilds',
  // Nix 边
  'declaresInput', 'outputsPackage', 'callsPackage', 'fetchesFrom', 'buildsWith',
  // ---- v0.39.0: ROS 2 边 ----
  'declaresChannel',    // RosNode → RosChannel（节点声明的通信通道）
  'launchesNode',       // RosLaunch → RosNode（launch 文件启动的节点）
  'launchesLaunch',     // RosLaunch → RosLaunch（IncludeLaunchDescription 嵌套）
  'declaresLaunchArg',  // RosLaunch → 共享参数声明（目前通过 args 数组承载）
  'executesProcess',    // RosLaunch → ExecuteProcess（外部进程）
  // ---- v0.40.0: 跨语言脚本同步 ----
  'crossLangMatches',   // SourceFile(py) ↔ SourceFile(ps) / BashFunction：同名工作流的多语言实现（iDRAC CreateVirtualDiskREDFISH.py ↔ Invoke-CreateVirtualDiskREDFISH.psm1）
  // ---- v0.42.0: 前后端 RPC 链 ----
  'callsApi',           // NetworkEndpoint(outbound) ↔ Route(go/python)：客户端端点请求到服务端 API 路由；双向（net: 查命中的路由，route: 查调用方端点）
];

export const ACTION_NAMES = ['refreshRepo', 'analyzeFile', 'markReviewed', 'addNote'];

// 蓝图 schema 静态元数据（供 /api/schema 端点、HTML 蓝图 UI、createBlueprintV2 共用）
// 借鉴 asdm-aos 的 BlueprintRuntime 模式：把 schema 与 data 分离
// 既有 createBlueprint() 不感知此常量（保持向后兼容）
export const BLUEPRINT_SCHEMA = {
  id: 'nice-aos-ontology',
  name: '代码本体蓝图',
  description: 'React/Vue/Flutter/Go/Rust/Python/Kotlin/PHP/油猴脚本/Bash+PowerShell/CMake/PKGBUILD/Nix 的多语言代码本体',
  version: '2.0', // 与 ONTOLOGY_META.version 对齐
  objectTypes: OBJECT_TYPES,
  linkTypes: LINK_TYPES,
  actionNames: ACTION_NAMES,
  // 抽象层级与分类（与 ONTOLOGY_META 共用，避免双源）
  meta: ONTOLOGY_META,
};

export function createIndex(dataMap) {
  const byId = new Map();
  const byType = new Map();
  for (const [type, objects] of Object.entries(dataMap)) {
    if (type.startsWith('_')) continue;
    byType.set(type, objects);
    for (const obj of objects) byId.set(obj.id, obj);
  }
  return { byId, byType };
}

function getObject(index, id) {
  return index.byId.get(id) ?? null;
}

function objectsForIds(index, ids) {
  return ids.map((id) => index.byId.get(id)).filter(Boolean);
}

/**
 * 跨层链接：代码实体(Interface/Class/Store/Service/Method) → Table ID 集合
 * 三通道匹配抽取(mapsToTable 与 mappedFromCode 共享):
 *   1) obj.mappedTableIds 显式映射
 *   2) sqlQueries:Method 直接读自己的;Class/Interface/Store/Service 聚合子方法 methodIds
 *   3) 命名约定:entity.name 去后缀(Entity/Dto/Model/Schema/Table/Request/Response/Params/Input/Output/Form/Payload)→ table.name
 * @param {Object} obj - 代码实体
 * @param {Object} dataMap - 完整数据图谱
 * @param {Object} index - createIndex() 产出
 * @returns {Set<string>} 匹配的 table id 集合(如 'table:users')
 */
function collectTableIdsForEntity(obj, dataMap, index) {
  const allTables = dataMap.Table ?? [];
  const out = new Set();

  // 通道 1:mappedTableIds 显式
  for (const id of (obj.mappedTableIds ?? [])) out.add(id);

  // 通道 2a:实体自身有 sqlQueries 字段(Method 形态)
  if (obj.sqlQueries?.length) {
    for (const q of obj.sqlQueries) {
      if (q.dynamic) continue;
      const hit = allTables.find((t) => t.id === `table:${q.table}` || t.name === q.table);
      if (hit) out.add(hit.id);
    }
  }

  // 通道 2b:Class/Interface/Store/Service → 聚合子方法 methodIds 的 sqlQueries
  if (obj.methodIds) {
    for (const mid of obj.methodIds) {
      const m = getObject(index, mid);
      if (!m?.sqlQueries) continue;
      for (const q of m.sqlQueries) {
        if (q.dynamic) continue;
        const hit = allTables.find((t) => t.id === `table:${q.table}` || t.name === q.table);
        if (hit) out.add(hit.id);
      }
    }
  }

  // 通道 3:命名约定(UserEntity → users / User → users)
  const nameBase = (obj.name ?? '').replace(/(?:Entity|Dto|Model|Schema|Table|Request|Response|Params|Input|Output|Form|Payload)$/i, '');
  if (nameBase) {
    const candidates = [
      nameBase.toLowerCase(),         // User → user
      nameBase.toLowerCase() + 's',   // User → users
      nameBase.toLowerCase() + 'es',  // Class → classes
    ];
    for (const c of candidates) {
      const hit = allTables.find((t) => t.name === c);
      if (hit) out.add(hit.id);
    }
  }

  return out;
}

export function createBlueprint(dataMap) {
  const index = createIndex(dataMap);
  const files = dataMap.SourceFile ?? [];
  const components = dataMap.Component ?? [];
  const routes = dataMap.Route ?? [];
  const userScripts = dataMap.UserScript ?? [];
  const gmApiUsages = dataMap.GmApiUsage ?? [];
  const injectionPoints = dataMap.InjectionPoint ?? [];
  const networkEndpoints = dataMap.NetworkEndpoint ?? [];
  const scriptFunctions = dataMap.ScriptFunction ?? [];
  const interfaces = dataMap.Interface ?? [];
  const classes = dataMap.Class ?? [];
  const traits = dataMap.Trait ?? [];
  const methods = dataMap.Method ?? [];

  const linkImpls = {
    contains(srcId) {
      if (srcId.startsWith('proj:')) {
        return [
          ...(dataMap.Domain ?? []),
          ...(dataMap.Module ?? []).filter((m) => !m.parentId || m.parentId === srcId),
        ];
      }
      if (srcId.startsWith('mod:')) {
        return [
          ...(dataMap.Module ?? []).filter((m) => m.parentId === srcId),
          ...files.filter((f) => f.module === srcId.slice(4)),
        ];
      }
      if (srcId.startsWith('file:')) {
        const filePath = srcId.slice(5);
        const out = [];
        out.push(...components.filter((c) => c.filePath === filePath));
        out.push(...(dataMap.Hook ?? []).filter((h) => h.filePath === filePath));
        out.push(...(dataMap.Store ?? []).filter((s) => s.filePath === filePath));
        out.push(...(dataMap.Service ?? []).filter((s) => s.filePath === filePath));
        out.push(...interfaces.filter((i) => i.filePath === filePath));
        out.push(...classes.filter((c) => c.filePath === filePath));
        out.push(...traits.filter((t) => t.filePath === filePath));
        out.push(...methods.filter((m) => m.filePath === filePath));
        out.push(...userScripts.filter((u) => u.filePath === filePath));
        return out;
      }
      if (srcId.startsWith('iface:') || srcId.startsWith('class:')) {
        return objectsForIds(index, getObject(index, srcId)?.methodIds ?? []);
      }
      if (srcId.startsWith('us:')) {
        // 油猴脚本的子对象：函数 / GM API 使用 / 注入点 / 网络端点
        return [
          ...scriptFunctions.filter((f) => f.scriptId === srcId),
          ...gmApiUsages.filter((g) => g.scriptId === srcId),
          ...injectionPoints.filter((i) => i.scriptId === srcId),
          ...networkEndpoints.filter((n) => n.scriptId === srcId),
        ];
      }
      return [];
    },

    imports(srcId) {
      const obj = getObject(index, srcId);
      if (!obj || !srcId.startsWith('file:')) return [];
      return objectsForIds(index, obj.importIds ?? []);
    },

    importedBy(srcId) {
      return files.filter((f) => (f.importIds ?? []).includes(srcId));
    },

    renders(srcId) {
      const obj = getObject(index, srcId);
      if (!obj || !srcId.startsWith('comp:')) return [];
      return objectsForIds(index, obj.rendersIds ?? []);
    },

    renderedBy(srcId) {
      return components.filter((c) => (c.rendersIds ?? []).includes(srcId));
    },

    // props 传递链：comp: → 其传 props 的目标组件；prop: → 边的两端组件
    passesProps(srcId) {
      const propEdges = dataMap.PropEdge ?? [];
      if (srcId.startsWith('comp:')) {
        const out = new Map();
        for (const e of propEdges) {
          if (e.fromComponentId === srcId && e.toComponentId) out.set(e.toComponentId, true);
        }
        return objectsForIds(index, [...out.keys()]);
      }
      if (srcId.startsWith('prop:')) {
        const edge = getObject(index, srcId);
        if (!edge) return [];
        return objectsForIds(index, [edge.fromComponentId, edge.toComponentId].filter(Boolean));
      }
      return [];
    },

    navigatesTo(srcId) {
      const obj = getObject(index, srcId);
      if (!obj || !srcId.startsWith('route:')) return [];
      return objectsForIds(index, obj.navigatesToIds ?? []);
    },

    registers(srcId) {
      if (srcId.startsWith('route:')) {
        const route = getObject(index, srcId);
        if (!route) return [];
        return objectsForIds(index, [route.componentId, route.componentFileId].filter(Boolean));
      }
      // 反向：组件/文件 → 注册它的路由
      const filePath = srcId.startsWith('file:') ? srcId.slice(5) : getObject(index, srcId)?.filePath;
      if (!filePath) return [];
      return routes.filter((r) => r.componentFileId === `file:${filePath}` || r.componentId === srcId);
    },

    usesStore(srcId) {
      if (srcId.startsWith('store:')) {
        const store = getObject(index, srcId);
        if (!store) return [];
        const storeFileId = `file:${store.filePath}`;
        const out = new Map();
        for (const f of files) {
          if ((f.importIds ?? []).includes(storeFileId)) out.set(f.id, f);
        }
        // 隐式使用：组件体内调用（auto-import 场景无 import 语句）
        for (const c of components) {
          if ((c.storeIds ?? []).includes(srcId)) {
            const f = files.find((x) => x.id === c.fileId);
            if (f) out.set(f.id, f);
          }
        }
        return [...out.values()];
      }
      if (srcId.startsWith('file:') || srcId.startsWith('comp:')) {
        const comp = srcId.startsWith('comp:') ? getObject(index, srcId) : null;
        const filePath = comp ? comp.filePath : srcId.slice(5);
        if (!filePath) return [];
        const fileId = `file:${filePath}`;
        const importer = files.find((f) => f.id === fileId);
        const out = new Map();
        for (const s of (dataMap.Store ?? [])) {
          if (importer && (importer.importIds ?? []).includes(`file:${s.filePath}`)) out.set(s.id, s);
        }
        // 隐式使用：本文件组件（或该组件自身）体内的 store 调用
        for (const c of components) {
          if (c.filePath !== filePath) continue;
          if (srcId.startsWith('comp:') && c.id !== srcId) continue;
          for (const sid of c.storeIds ?? []) {
            const s = getObject(index, sid);
            if (s) out.set(s.id, s);
          }
        }
        return [...out.values()];
      }
      return [];
    },

    usesHook(srcId) {
      if (srcId.startsWith('hook:')) {
        const hook = getObject(index, srcId);
        if (!hook) return [];
        const hookFileId = `file:${hook.filePath}`;
        return files.filter((f) => (f.importIds ?? []).includes(hookFileId));
      }
      if (srcId.startsWith('file:') || srcId.startsWith('comp:')) {
        const filePath = srcId.startsWith('file:') ? srcId.slice(5) : getObject(index, srcId)?.filePath;
        if (!filePath) return [];
        return (dataMap.Hook ?? []).filter((h) => {
          const hFileId = `file:${h.filePath}`;
          const importer = files.find((f) => f.id === `file:${filePath}`);
          return importer && (importer.importIds ?? []).includes(hFileId);
        });
      }
      return [];
    },

    // ---- 类型体系链接：实现 / 继承 / 方法覆盖（双向）----
    implements(srcId) {
      if (!srcId.startsWith('class:')) return [];
      const obj = getObject(index, srcId);
      if (!obj) return [];
      return objectsForIds(index, obj.implementsIds ?? []);
    },

    implementedBy(srcId) {
      if (!srcId.startsWith('iface:')) return [];
      return classes.filter((c) => (c.implementsIds ?? []).includes(srcId));
    },

    extends(srcId) {
      const obj = getObject(index, srcId);
      if (!obj) return [];
      if (srcId.startsWith('class:')) {
        return obj.extendsId ? objectsForIds(index, [obj.extendsId]) : [];
      }
      if (srcId.startsWith('iface:')) {
        return objectsForIds(index, obj.extendsIds ?? []);
      }
      return [];
    },

    extendedBy(srcId) {
      const out = [];
      for (const c of classes) if (c.extendsId === srcId) out.push(c);
      for (const i of interfaces) if ((i.extendsIds ?? []).includes(srcId)) out.push(i);
      return out;
    },

    // 方法覆盖：method:(类方法) → 它实现/覆盖的接口方法或父类方法
    overrides(srcId) {
      if (!srcId.startsWith('method:')) return [];
      const obj = getObject(index, srcId);
      return obj?.overridesId ? objectsForIds(index, [obj.overridesId]) : [];
    },

    // 被实现/被覆盖（反向）：method:(接口方法/父类方法) → 全部实现方法
    overriddenBy(srcId) {
      if (!srcId.startsWith('method:')) return [];
      const obj = getObject(index, srcId);
      return objectsForIds(index, obj?.overriddenByIds ?? []);
    },

    // ---- 油猴脚本链接（双向：us: 正向；gm:/inject:/net:/fn: 反查所属脚本）----
    usesGmApi(srcId) {
      if (srcId.startsWith('us:')) {
        const script = getObject(index, srcId);
        if (!script) return [];
        return objectsForIds(index, script.gmApiIds ?? []);
      }
      if (srcId.startsWith('gm:')) {
        const usage = getObject(index, srcId);
        return usage ? [getObject(index, usage.scriptId)].filter(Boolean) : [];
      }
      return [];
    },

    injectsInto(srcId) {
      if (srcId.startsWith('us:')) {
        const script = getObject(index, srcId);
        if (!script) return [];
        return objectsForIds(index, script.injectionIds ?? []);
      }
      if (srcId.startsWith('inject:')) {
        const point = getObject(index, srcId);
        return point ? [getObject(index, point.scriptId)].filter(Boolean) : [];
      }
      return [];
    },

    requestsTo(srcId) {
      if (srcId.startsWith('us:')) {
        const script = getObject(index, srcId);
        if (!script) return [];
        return objectsForIds(index, script.networkIds ?? []);
      }
      if (srcId.startsWith('net:')) {
        const endpoint = getObject(index, srcId);
        return endpoint ? [getObject(index, endpoint.scriptId)].filter(Boolean) : [];
      }
      return [];
    },

    // ---- v0.42.0: 前后端 RPC 链 ----
    // NetworkEndpoint(outbound) ↔ Route(go/python)：客户端端点请求到服务端 API 路由
    // 双向：net: → 命中的服务端路由；route: → 调用该路由的全部客户端端点
    callsApi(srcId) {
      if (srcId.startsWith('net:')) {
        const endpoint = getObject(index, srcId);
        return endpoint?.serverRouteId ? [getObject(index, endpoint.serverRouteId)].filter(Boolean) : [];
      }
      if (srcId.startsWith('route:')) {
        const route = getObject(index, srcId);
        return objectsForIds(index, route?.clientEndpointIds ?? []);
      }
      return [];
    },

    // 脚本函数/方法调用图：fn:/method: → 目标（正向被调用 callees；反向 calledBy）
    calls(srcId) {
      if (srcId.startsWith('fn:') || srcId.startsWith('method:')) {
        const obj = getObject(index, srcId);
        if (!obj) return [];
        return objectsForIds(index, [...(obj.callIds ?? []), ...(obj.compCallIds ?? [])]);
      }
      return [];
    },

    calledBy(srcId) {
      if (srcId.startsWith('fn:') || srcId.startsWith('method:')) {
        const obj = getObject(index, srcId);
        if (!obj) return [];
        return objectsForIds(index, obj.calledByIds ?? []);
      }
      return [];
    },

    // ---- 跨层链接：代码实体 ↔ 数据库表（借鉴 asdm-aos 的 mapperMapsTable/mapperMapsEntity）----
    // 三通道匹配（向前兼容 + 向后兼容）：
    //   1) mappedTableIds 显式映射（dbModel.matchTablesToCodeEntities 设置）
    //   2) sqlQueries：Method 直接读自己的;Class/Interface/Store/Service 聚合子方法
    //   3) 命名约定：entity.name（去 s 后缀）== table.name（如 UserEntity → users）
    // 共享匹配逻辑抽取为 collectTableIdsForEntity()，mapsToTable 与 mappedFromCode 复用
    mapsToTable(srcId) {
      const obj = getObject(index, srcId);
      if (!obj) return [];
      return objectsForIds(index, [...collectTableIdsForEntity(obj, dataMap, index)]);
    },

    // mappedFromCode: Table → Interface/Class/Store/Service/Method（数据库表被哪些代码实体映射）
    // 对称实现：扫描所有 codeEntity(含 Method,因 Method 也有 sqlQueries)找包含 srcId 的
    // 注意:不递归调 mapsToTable(避免死循环),复用 collectTableIdsForEntity 内联同样的三通道
    mappedFromCode(srcId) {
      if (!srcId.startsWith('table:')) return [];
      const allTables = dataMap.Table ?? [];
      const table = allTables.find((t) => t.id === srcId);
      if (!table) return [];
      const tableName = table.name;
      const codeEntities = [
        ...(dataMap.Interface ?? []),
        ...(dataMap.Class ?? []),
        ...(dataMap.Store ?? []),
        ...(dataMap.Service ?? []),
        ...(dataMap.Method ?? []),
      ];
      const out = [];
      for (const e of codeEntities) {
        const matchedIds = collectTableIdsForEntity(e, dataMap, index);
        // mappedFromCode 是反向查询:该实体只要映射到 srcId 即可
        if (matchedIds.has(srcId)) out.push(e);
      }
      return out;
    },

    // ---- Trait 复用链（双向：class: → use 的 trait:；trait: → 使用它的 class:）----
    // PHP trait 专属：class 体内 `use Trait1, Trait2;` 由 phpAnalyzer 抽到 usesTraits →
    // builder 写入 usesTraitIds；trait 对象反向聚合 usedByIds
    usesTrait(srcId) {
      if (!srcId.startsWith('class:')) return [];
      const obj = getObject(index, srcId);
      if (!obj) return [];
      return objectsForIds(index, obj.usesTraitIds ?? []);
    },

    usedByTrait(srcId) {
      if (!srcId.startsWith('trait:')) return [];
      const traitObj = getObject(index, srcId);
      if (!traitObj) return [];
      return objectsForIds(index, traitObj.usedByIds ?? []);
    },

    // ---- 功能域归属（双向：dom: 列成员；mod:/comp:/store:/hook:/route: 反查所属域）----
    belongsTo(srcId) {
      if (srcId.startsWith('dom:')) {
        const domain = getObject(index, srcId);
        if (!domain) return [];
        return objectsForIds(index, [
          ...(domain.moduleIds ?? []),
          ...(domain.routeIds ?? []),
          ...(domain.componentIds ?? []),
          ...(domain.storeIds ?? []),
          ...(domain.hookIds ?? []),
          ...(domain.serviceIds ?? []),
          ...(domain.userScriptIds ?? []),
        ]);
      }
      const obj = getObject(index, srcId);
      if (obj?.domainIds?.length) return objectsForIds(index, obj.domainIds);
      // 脚本函数归属其所在脚本的功能域
      if (srcId.startsWith('fn:')) {
        const script = obj?.scriptId ? getObject(index, obj.scriptId) : null;
        return script?.domainIds?.length ? objectsForIds(index, script.domainIds) : [];
      }
      return [];
    },
  };

  return {
    index,
    link(linkType, srcId) {
      const impl = linkImpls[linkType];
      if (!impl) throw new Error(`未知链接类型: ${linkType}（可用: ${LINK_TYPES.join(', ')}）`);
      return impl(srcId);
    },
    find(id) {
      return getObject(index, id);
    },
  };
}

// =============================================================================
// 蓝图引擎 V2：借鉴 asdm-aos v0.0.12 BlueprintRuntime 模式（src/server/ontology/engine.ts:39-93）
// -----------------------------------------------------------------------------
// createBlueprint() 走"数据驱动单蓝图"路线（既有 CLI 走这里，零迁移）；
// createBlueprintV2() 走"schema+impls"配置路线，把 linkImpls/actionImpls 显式解耦。
//
// V2 的核心价值：
//   1. 引擎对外暴露统一的 find / where / link / action / snapshot / schema API
//   2. 数据写回不污染 seed（深拷贝，与 aos 的 createEngine 行为一致）
//   3. schema 自描述：/api/schema 端点可直接走 engine.schema()（更通用）
//   4. 动作实现统一接收 (ctx, input) => {ok, message}，便于蓝图 UI 统一渲染
//
// 约束：
//   - V2 复用 V1 的 linkImpls 闭包（仅做适配），不重写 24+ 个 link 解析函数
//   - 既有 createBlueprint() 行为零变化
// =============================================================================

import { createBlueprintEngine } from './blueprintEngine.js';
import { ACTION_DEFS } from './actionDefs.js'; // E-2：纯定义单源（blueprintActions.js 仍 re-export 兼容）

/**
 * 蓝图 V2 工厂：把既有 dataMap 包装为 BlueprintEngine 实例。
 *
 * 关键设计：
 *   - linkImpls 委托给 createBlueprint() 的 linkImpls 闭包（24 个函数零重写）
 *   - actionImpls 内置 markReviewed / addNote 两个写回动作（与 src/cli/commands/action.js 同语义）
 *   - 引擎 link() 内部自动按 id 找源对象并传入 linkImpl
 *   - data 通过 createData() 提供；engine.data 是深拷贝副本，写回不污染 seed
 *
 * @param {DataMap} dataMap
 * @param {{ extraActions?: Object, snapshotSave?: (dataMap) => string }} [opts]
 *   extraActions: 额外注册的动作实现（key 为动作名），用于跨蓝图复用
 *   snapshotSave: 动作写回时调用的保存函数（默认不保存，调用方负责持久化）
 * @returns {Engine}
 */
export function createBlueprintV2(dataMap, opts = {}) {
  const { extraActions = {}, snapshotSave = null } = opts;

  // 构造 linkImpls：委托给既有 createBlueprint 的 linkImpls 闭包
  // 注意：createBlueprint() 内部要重新构造一次（其 linkImpls 是闭包绑定 dataMap）
  // 为避免重复构造（开销大），我们直接重用一个轻量包装：调 createBlueprint().index
  // 但要拿到 linkImpls 闭包本身，得改既有代码——这里走"二次调用 createBlueprint"
  // 拿到 link 方法后用 Proxy 拦截转给 engine
  const legacy = createBlueprint(dataMap);
  const legacyLink = (linkType, srcId) => {
    // 既有 createBlueprint().link() 内部对未注册类型抛错；V2 引擎需要"未知 link 返回 []"
    try {
      return legacy.link(linkType, srcId);
    } catch (err) {
      if (err.message?.startsWith('未知链接类型')) return [];
      throw err;
    }
  };

  // 链接实现：调既有 link 闭包；ctx 参数透传（legacy 不用，但未来 linkImpl 可用）
  const linkImpls = {};
  for (const lt of LINK_TYPES) {
    linkImpls[lt] = (src, ctx) => {
      if (!src || !src.id) return [];
      return legacyLink(lt, src.id);
    };
  }

  // 动作实现：markReviewed / addNote 与 src/cli/commands/action.js 同语义
  // 写回时通过 snapshotSave 回调持久化（默认不存，调用方负责）
  const actionImpls = {
    markReviewed: (ctx, input) => {
      const objectId = input?.objectId;
      if (!objectId) return { ok: false, message: '缺少参数 objectId' };
      const obj = ctx.byId.get(objectId);
      if (!obj) return { ok: false, message: `对象不存在: ${objectId}` };
      obj.reviewed = true;
      obj.reviewedAt = new Date().toISOString();
      if (snapshotSave) snapshotSave(toLegacyDataMap(ctx.data));
      return { ok: true, message: `已标记 ${objectId} 为已审查` };
    },
    addNote: (ctx, input) => {
      const objectId = input?.objectId;
      const note = input?.note;
      if (!objectId) return { ok: false, message: '缺少参数 objectId' };
      if (!note || !String(note).trim()) return { ok: false, message: 'note 不可为空' };
      const obj = ctx.byId.get(objectId);
      if (!obj) return { ok: false, message: `对象不存在: ${objectId}` };
      obj.notes = obj.notes ? `${obj.notes}\n${note}` : note;
      if (snapshotSave) snapshotSave(toLegacyDataMap(ctx.data));
      return { ok: true, message: `已为 ${objectId} 添加注释` };
    },
    // v0.35.0（E-3）：refreshRepo / analyzeFile 真实实现收敛到 ./actionOps.js；
    // 此处动态 import 保持蓝图模块轻量并规避静态循环依赖。
    // actionImpl 为异步 → 引擎 action() 对 thenable 返回 Promise，见 blueprintEngine.js。
    refreshRepo: async (_ctx, input) => {
      const ops = await import('./actionOps.js');
      return ops.runRefreshRepo(input ?? {});
    },
    analyzeFile: async (_ctx, input) => {
      const ops = await import('./actionOps.js');
      return ops.runAnalyzeFile(input ?? {});
    },
    ...extraActions,
  };

  // 把既有 OBJECT_TYPES 转为 ObjectTypeDef 形态（保留 prefix 用于 findObjectByPrefix）
  const objectTypes = OBJECT_TYPES.map((t) => ({
    name: t.type,
    label: t.type,
    kind: 'object',
    prefix: t.prefix,
    description: t.description,
  }));

  // linkTypes：保留既有字符串数组形态 + 加 description 占位
  const linkTypes = LINK_TYPES.map((name) => ({ name, description: name }));

  // actionDefs：从 blueprintActions.js 的 ACTION_DEFS 获取（单一数据源）
  const actionDefs = ACTION_DEFS.map(({ name, label, params, description }) => ({
    name, label, params, description,
  }));

  return createBlueprintEngine({
    id: 'nice-aos-ontology',
    name: '代码本体蓝图',
    description: 'React/Vue/Flutter/Go/Rust/Python/Kotlin/PHP/油猴脚本/Bash+PowerShell/CMake/PKGBUILD/Nix 的多语言代码本体',
    objectTypes,
    linkTypes,
    actionDefs,
    linkImpls,
    actionImpls,
    createData: () => toLegacyDataMap(dataMap),
  });
}

/**
 * 把 engine.data 转回 nice-aos 标准的 DataMap 形态（保留 _meta 顶层键）。
 * 引擎 ctx.data 已经是 { Type1: [], Type2: [] } 形态，但默认不包含 _meta。
 * 这里确保 _meta 也被保留（调用方提供）。
 */
function toLegacyDataMap(dataMap) {
  const out = {};
  for (const [k, v] of Object.entries(dataMap)) {
    out[k] = v;
  }
  return out;
}
