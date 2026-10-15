// LinkDef 元数据表（v0.50.0）：
// nice-aos 56 个 linkType 的**元数据单一事实源**（name / reverse / sourcePrefixes / targetPrefixes / description）。
// 借鉴 asdm-aos-server 的 LINK_DEFS 表（src/modules/graph/converter/aos-gitnexus/resolvers.ts）。
//
// 本阶段只抽元数据，**不**改 linkImpls 行为（blueprint.js link() 函数仍 27 个具名实现，其他 29 个
// 走 createBlueprintV2 或 addLink 函数 — 当前是 void / empty 实现）。
// 这样把"声明"与"实现"分离，让 get_schema.vocabulary / linkWithMeta2 / blueprint.link 走同一表。
// 后续 v0.51.0 converter 钩子下放阶段再考虑把 linkImpls 收敛为 lookup 表。
//
// 字段语义：
//   name              — 链接名（与 LINK_TYPES 元素 1:1 对应）
//   reverse           — 反向链接名（**只在 FORWARD def 上声明**，REVERSE def 不带 reverse 字段）
//   sourcePrefixes    — 源对象 id 前缀列表
//   targetPrefixes    — 目标对象 id 前缀列表
//   description       — 1 行语义描述
//   category          — 抽象分类（'hierarchy' | 'reference' | 'derive'）
//   hasImpl           — blueprint.js 是否有具名 linkImpls 实现（false = 当前返回 []）

const LINK_DEFS_RAW = [
  // ============================================================
  // 核心组件关系（27 个，有 blueprint.linkImpls 具名实现）
  // ============================================================

  // ---- 层级链接 ----
  {
    name: 'contains',
    reverse: 'belongsTo',
    sourcePrefixes: ['proj:', 'mod:', 'file:', 'iface:', 'class:', 'us:'],
    targetPrefixes: ['dom:', 'mod:', 'file:', 'comp:', 'hook:', 'store:', 'svc:', 'iface:', 'class:', 'trait:', 'method:', 'us:', 'fn:', 'gm:', 'inject:', 'net:'],
    description: '容器持有子对象（项目→模块→文件→单元）',
    category: 'hierarchy', hasImpl: true,
  },
  {
    name: 'belongsTo',
    sourcePrefixes: ['mod:', 'method:'],
    targetPrefixes: ['proj:', 'mod:'],
    description: '反向：从属关系（模块→项目 / 方法→模块；contains 的反向）',
    category: 'hierarchy', hasImpl: true,
  },
  {
    name: 'imports',
    reverse: 'importedBy',
    sourcePrefixes: ['file:'],
    targetPrefixes: ['file:'],
    description: '源文件通过 import 引用目标文件',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'importedBy',
    sourcePrefixes: ['file:'],
    targetPrefixes: ['file:'],
    description: '反向：哪些文件 import 了此文件（imports 的反向）',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'passesProps',
    sourcePrefixes: ['comp:', 'prop:'],
    targetPrefixes: ['comp:'],
    description: '组件向子组件传递 props（含来源分类）',
    category: 'reference', hasImpl: true,
  },

  // ---- 组件级引用 ----
  {
    name: 'renders',
    reverse: 'renderedBy',
    sourcePrefixes: ['comp:'],
    targetPrefixes: ['comp:'],
    description: '组件渲染其他组件（JSX/模板标签 → 目标组件）',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'renderedBy',
    sourcePrefixes: ['comp:'],
    targetPrefixes: ['comp:'],
    description: '反向：哪些组件渲染了此组件（renders 的反向）',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'usesStore',
    sourcePrefixes: ['store:', 'file:', 'comp:'],
    targetPrefixes: ['store:', 'file:'],
    description: '使用状态 Store（Zustand / Pinia / ChangeNotifier / Riverpod Provider）',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'usesHook',
    sourcePrefixes: ['file:', 'comp:'],
    targetPrefixes: ['hook:'],
    description: '使用自定义 Hook（React Hook / Vue Composable）',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'registers',
    sourcePrefixes: ['route:', 'file:', 'comp:'],
    targetPrefixes: ['route:', 'file:', 'comp:'],
    description: '路由 → 注册它的组件/文件',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'navigatesTo',
    sourcePrefixes: ['route:'],
    targetPrefixes: ['route:'],
    description: '路由跳转：源路由 → 目标路由',
    category: 'reference', hasImpl: true,
  },

  // ---- 类型体系 ----
  {
    name: 'implements',
    reverse: 'implementedBy',
    sourcePrefixes: ['class:'],
    targetPrefixes: ['iface:'],
    description: '类实现接口',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'implementedBy',
    sourcePrefixes: ['iface:'],
    targetPrefixes: ['class:'],
    description: '接口被哪些类实现（implements 的反向）',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'extends',
    reverse: 'extendedBy',
    sourcePrefixes: ['class:', 'iface:'],
    targetPrefixes: ['class:', 'iface:'],
    description: '继承：类→类 / 接口→接口',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'extendedBy',
    sourcePrefixes: ['class:', 'iface:'],
    targetPrefixes: ['class:', 'iface:'],
    description: '被哪些类/接口继承（extends 的反向）',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'overrides',
    reverse: 'overriddenBy',
    sourcePrefixes: ['method:'],
    targetPrefixes: ['method:'],
    description: '方法重写（Method.overridesIds）',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'overriddenBy',
    sourcePrefixes: ['method:'],
    targetPrefixes: ['method:'],
    description: '被哪些方法重写（overrides 的反向）',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'usesTrait',
    reverse: 'usedByTrait',
    sourcePrefixes: ['class:'],
    targetPrefixes: ['trait:'],
    description: '类通过 use Trait 注入 trait 方法（PHP 语法）',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'usedByTrait',
    sourcePrefixes: ['trait:'],
    targetPrefixes: ['class:'],
    description: '反向：哪些类 use 了此 trait（usesTrait 的反向）',
    category: 'derive', hasImpl: true,
  },

  // ---- 油猴审计 ----
  {
    name: 'usesGmApi',
    sourcePrefixes: ['us:', 'fn:'],
    targetPrefixes: ['gm:'],
    description: '油猴脚本使用 GM_* API',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'injectsInto',
    sourcePrefixes: ['inject:'],
    targetPrefixes: ['file:'],
    description: '审计：DOM 注入点（哪些文件由此注入）',
    category: 'reference', hasImpl: true,
  },

  // ---- 方法调用 / RPC 链 ----
  {
    name: 'requestsTo',
    sourcePrefixes: ['net:'],
    targetPrefixes: ['route:'],
    description: '审计：网络出站端点请求服务端 API 路由',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'callsApi',
    sourcePrefixes: ['route:'],
    targetPrefixes: ['net:'],
    description: '审计：服务端路由被哪些客户端端点调用',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'calls',
    reverse: 'calledBy',
    sourcePrefixes: ['method:', 'fn:'],
    targetPrefixes: ['method:', 'fn:'],
    description: '方法/函数调用其他方法或函数',
    category: 'reference', hasImpl: true,
  },
  {
    name: 'calledBy',
    sourcePrefixes: ['method:', 'fn:'],
    targetPrefixes: ['method:', 'fn:'],
    description: '反向：哪些方法/函数调用了此方法（calls 的反向）',
    category: 'reference', hasImpl: true,
  },

  // ---- ORM / 数据映射 ----
  {
    name: 'mapsToTable',
    reverse: 'mappedFromCode',
    sourcePrefixes: ['class:'],
    targetPrefixes: ['class:'],
    description: '业务类与数据库表的命名映射',
    category: 'derive', hasImpl: true,
  },
  {
    name: 'mappedFromCode',
    sourcePrefixes: ['class:'],
    targetPrefixes: ['class:'],
    description: '反向：被哪些业务类的 tableName 映射回此表类（mapsToTable 的反向）',
    category: 'derive', hasImpl: true,
  },

  // ============================================================
  // Shell 脚本边（v0.38.0）：9 个（其中 4 共享 Bash + PowerShell 语义，4 仅 shell/powershell 专属）
  // ============================================================
  {
    name: 'callsFunction',
    sourcePrefixes: ['sh:', 'ps:'],
    targetPrefixes: ['bashfn:', 'psfn:'],
    description: 'Shell/PowerShell 调用同脚本内的函数体',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'usesBuiltin',
    sourcePrefixes: ['bashfn:'],
    targetPrefixes: ['bashb:'],
    description: 'Bash 函数调用已知外部命令（curl/tar/sudo 等）',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'invokesCmdlet',
    sourcePrefixes: ['psfn:', 'ps:'],
    targetPrefixes: ['cmd:'],
    description: 'PowerShell 调用 cmdlet（Verb-Noun）',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'definesParam',
    sourcePrefixes: ['sh:', 'ps:'],
    targetPrefixes: ['sh:', 'ps:'],
    description: '脚本声明的 param/positional 参数',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'readsCliParam',
    sourcePrefixes: ['bashfn:', 'psfn:'],
    targetPrefixes: ['sh:', 'ps:'],
    description: '函数体读 CLI 参数（通过 scriptId 间接到脚本）',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'downloadsFrom',
    sourcePrefixes: ['bashfn:', 'psfn:'],
    targetPrefixes: ['net:'],
    description: 'Shell 函数从 URL 下载（curl/wget/Invoke-WebRequest）',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'verifiesChecksum',
    sourcePrefixes: ['bashfn:', 'psfn:'],
    targetPrefixes: ['bashfn:', 'psfn:'],
    description: '校验下载产物的 sha256/md5 等',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'writesTo',
    sourcePrefixes: ['bashfn:', 'psfn:'],
    targetPrefixes: ['file:'],
    description: 'Shell 函数写入目标文件',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'readsRegistry',
    sourcePrefixes: ['psfn:'],
    targetPrefixes: ['file:'],
    description: 'PowerShell 读取注册表（reg query）',
    category: 'reference', hasImpl: false,
  },

  // ============================================================
  // CMake 边（v0.38.0）：7 个
  // ============================================================
  {
    name: 'subdirIncludes',
    sourcePrefixes: ['cmm:'],
    targetPrefixes: ['cmm:'],
    description: 'CMake 子目录 include（add_subdirectory）',
    category: 'hierarchy', hasImpl: false,
  },
  {
    name: 'includesModule',
    sourcePrefixes: ['cmm:'],
    targetPrefixes: ['cmm:'],
    description: 'CMake include() 模块声明',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'declaresOption',
    sourcePrefixes: ['cmm:'],
    targetPrefixes: ['cmo:'],
    description: 'CMake option() 选项声明',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'addsDependency',
    sourcePrefixes: ['cmt:'],
    targetPrefixes: ['cmt:', 'cmm:'],
    description: 'CMake target 通过 add_dependencies 关联',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'targetsInclude',
    sourcePrefixes: ['cmt:'],
    targetPrefixes: ['cmm:'],
    description: 'CMake target_link_libraries / target_include_directories',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'fetchesDep',
    sourcePrefixes: ['cmf:', 'cmm:'],
    targetPrefixes: ['cmm:'],
    description: 'CMake FetchContent 拉取依赖',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'findsPackage',
    sourcePrefixes: ['cmf:', 'cmm:'],
    targetPrefixes: ['cmm:'],
    description: 'CMake find_package 查找依赖',
    category: 'reference', hasImpl: false,
  },

  // ============================================================
  // PKGBUILD 边（v0.38.0）：2 个
  // ============================================================
  {
    name: 'pkgDependsOn',
    sourcePrefixes: ['arch:'],
    targetPrefixes: ['arch:'],
    description: 'PKGBUILD depends / makedepends 关系',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'pkgBuilds',
    sourcePrefixes: ['arch:', 'archfn:'],
    targetPrefixes: ['archfn:'],
    description: 'PKGBUILD 的 build() / package() / check() / prepare() 函数与脚本条目',
    category: 'hierarchy', hasImpl: false,
  },

  // ============================================================
  // Nix 边（v0.38.0）：5 个
  // ============================================================
  {
    name: 'declaresInput',
    sourcePrefixes: ['nix:'],
    targetPrefixes: ['nixin:'],
    description: 'Nix flake inputs 声明',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'outputsPackage',
    sourcePrefixes: ['nix:'],
    targetPrefixes: ['nixpkg:'],
    description: 'Nix outputs.packages.<system>.<name>',
    category: 'hierarchy', hasImpl: false,
  },
  {
    name: 'callsPackage',
    sourcePrefixes: ['nixpkg:'],
    targetPrefixes: ['nixpkg:'],
    description: 'Nix pkgs.callPackage 函数式调用',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'fetchesFrom',
    sourcePrefixes: ['nixpkg:'],
    targetPrefixes: ['nix:'],
    description: 'Nix fetchurl / fetchFromGitHub',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'buildsWith',
    sourcePrefixes: ['nixpkg:'],
    targetPrefixes: ['nixin:'],
    description: 'Nix buildInputs 关联',
    category: 'reference', hasImpl: false,
  },

  // ============================================================
  // ROS 2 边（v0.39.0）：5 个
  // ============================================================
  {
    name: 'declaresChannel',
    sourcePrefixes: ['rosnode:'],
    targetPrefixes: ['roschan:'],
    description: 'ROS 2 节点声明通信通道',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'launchesNode',
    sourcePrefixes: ['roslaunch:'],
    targetPrefixes: ['rosnode:'],
    description: 'launch 文件启动的节点',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'launchesLaunch',
    sourcePrefixes: ['roslaunch:'],
    targetPrefixes: ['roslaunch:'],
    description: 'launch → IncludeLaunchDescription 嵌套',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'declaresLaunchArg',
    sourcePrefixes: ['roslaunch:'],
    targetPrefixes: ['roslaunch:'],
    description: 'launch 启动参数声明（args 数组承载）',
    category: 'reference', hasImpl: false,
  },
  {
    name: 'executesProcess',
    sourcePrefixes: ['roslaunch:'],
    targetPrefixes: ['roslaunch:'],
    description: 'launch → ExecuteProcess 外部进程',
    category: 'reference', hasImpl: false,
  },

  // ============================================================
  // 跨语言同步（v0.40.0）：1 个
  // ============================================================
  {
    name: 'crossLangMatches',
    sourcePrefixes: ['file:', 'bashfn:'],
    targetPrefixes: ['file:', 'psfn:'],
    description: '跨语言同步：同名工作流的多语言实现（py ↔ ps / bash）',
    category: 'reference', hasImpl: false,
  },
];

/**
 * 检查 LINK_DEFS_RAW 的内部一致性：name 唯一、reverse 互指、sourcePrefixes 非空。
 * 模块加载时执行一次（fail-fast）。
 */
function _validateLinkDefs(defs) {
  const nameSet = new Set();
  for (const def of defs) {
    if (!def.name || typeof def.name !== 'string') {
      throw new Error(`linkDefs: def 无 name: ${JSON.stringify(def)}`);
    }
    if (nameSet.has(def.name)) {
      throw new Error(`linkDefs: name 重复: ${def.name}`);
    }
    nameSet.add(def.name);
    if (!Array.isArray(def.sourcePrefixes) || def.sourcePrefixes.length === 0) {
      throw new Error(`linkDefs: ${def.name} 必须声明 sourcePrefixes[]`);
    }
  }
  for (const def of defs) {
    if (def.reverse) {
      if (def.reverse === def.name) {
        throw new Error(`linkDefs: ${def.name}.reverse 不能等于 name`);
      }
      if (!nameSet.has(def.reverse)) {
        throw new Error(`linkDefs: ${def.name}.reverse=${def.reverse} 不在 LINK_DEFS 中`);
      }
      // 规则：reverse 字段只能出现在 FORWARD def 上，不能两个 def 都声明
      const reverseDef = defs.find((d) => d.name === def.reverse);
      if (reverseDef?.reverse) {
        throw new Error(`linkDefs: ${def.name} 和 ${def.reverse} 都声明了 reverse 字段（双向对只能 forward 端声明）`);
      }
    }
  }
}

_validateLinkDefs(LINK_DEFS_RAW);

// 派生常量：从 linkDefs 派生各种视角下的数据结构

/** name → def */
export const LINK_DEF_BY_NAME = Object.fromEntries(LINK_DEFS_RAW.map((d) => [d.name, d]));

/** REVERSE_OF[forward] = reverse（如 REVERSE_OF.renders = 'renderedBy'） */
export const REVERSE_OF = Object.fromEntries(
  LINK_DEFS_RAW.filter((d) => d.reverse).map((d) => [d.name, d.reverse]),
);
/** FORWARD_OF[reverse] = forward（如 FORWARD_OF.renderedBy = 'renders'） */
export const FORWARD_OF = Object.fromEntries(
  LINK_DEFS_RAW.filter((d) => d.reverse).map((d) => [d.reverse, d.name]),
);

/** linkTypePairs 形态（与 viewerModel.blueprint.vocabulary.linkTypePairs 对齐） */
export const LINK_TYPE_PAIRS = Object.fromEntries(
  LINK_DEFS_RAW.filter((d) => d.reverse).map((d) => [d.name, d.reverse]),
);

/** 仅反向 linkType 名（即任何 def.reverse 的取值去重） */
export const REVERSE_LINK_TYPES = Object.values(LINK_TYPE_PAIRS);

/** 全部 LinkDef 数组 */
export const LINK_DEFS = LINK_DEFS_RAW;

/** 全部 linkType name 数组（与 blueprint.js LINK_TYPES 镜像；测试时一致性校验） */
export const LINK_TYPE_NAMES = LINK_DEFS_RAW.map((d) => d.name);

/** 仅 hasImpl=true 的 linkType name 数组（blueprint.link() 调用方白名单） */
export const IMPLEMENTED_LINK_TYPES = LINK_DEFS_RAW.filter((d) => d.hasImpl).map((d) => d.name);

/** 按 category 分组的 linkType name */
export const LINK_DEFS_BY_CATEGORY = LINK_DEFS_RAW.reduce((acc, def) => {
  const k = def.category ?? 'reference';
  if (!acc[k]) acc[k] = [];
  acc[k].push(def.name);
  return acc;
}, /** @type {Record<string, string[]>} */ ({}));

/**
 * 查 def：给定 linkType 返回 def 或 null（未知 linkType 不抛错）。
 * @param {string} linkType
 * @returns {object | null}
 */
export function getLinkDef(linkType) {
  return LINK_DEF_BY_NAME[linkType] ?? null;
}

/**
 * 判断给定的 source id 前缀是否被 linkType 支持。
 * 用于 traverse_links 早返校验（与 v0.48.0 unknown linkType 错误信配套）。
 * @param {string} linkType
 * @param {string} srcId
 * @returns {boolean}
 */
export function acceptsSource(linkType, srcId) {
  const def = getLinkDef(linkType);
  if (!def) return false;
  return def.sourcePrefixes.some((p) => srcId.startsWith(p));
}

/**
 * 判断 linkType 当前是否有具名实现（blueprint.js linkImpls 是否能处理）。
 * @param {string} linkType
 * @returns {boolean}
 */
export function hasLinkImpl(linkType) {
  const def = getLinkDef(linkType);
  return def?.hasImpl === true;
}
