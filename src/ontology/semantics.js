// 语义本体引擎：架构分层推断 / 功能域聚合 / 总结生成
// 设计原则：分类以内容信号为准（单元构成、路由归属、引用结构），目录名仅作弱信号回退；
// 聚合节点（Module / Domain / Project）自动生成职责画像与自然语言总结，避免"只罗列事实、没有抽象"。

// ---- 语义架构层（跨框架通用，取代"目录名即层级"的朴素划分）----
export const ARCH_LAYERS = {
  entry: { label: '入口层', role: '应用引导', description: '应用入口与启动装配（main / App 等）' },
  presentation: { label: '表现层', role: 'UI 呈现', description: '页面、组件与路由等用户界面' },
  state: { label: '状态层', role: '共享状态', description: '跨组件共享状态（Zustand / Pinia / Riverpod Provider）' },
  service: { label: '业务层', role: '业务逻辑', description: '领域服务、引擎与业务编排' },
  tauri: { label: 'Tauri 原生层', role: '桌面原生', description: 'Rust 桌面原生组件（src-tauri：数据模型 / 命令 / 系统集成）' },
  electron: { label: 'Electron 主进程', role: '桌面主进程', description: 'Electron 主进程组件（窗口 / 系统 API / 本地服务）' },
  integration: { label: '集成层', role: '外部集成', description: 'API 客户端与外部系统访问' },
  shared: { label: '共享层', role: '通用复用', description: '通用 Hook、工具函数与复用逻辑' },
  types: { label: '类型层', role: '类型定义', description: '类型、模型与接口定义' },
  config: { label: '配置层', role: '配置常量', description: '常量、环境与配置' },
  script: { label: '脚本层', role: '油猴脚本', description: 'Tampermonkey 油猴脚本（独立运行体系）' },
  test: { label: '测试层', role: '测试', description: '单元测试、E2E 与测试辅助' },
  mixed: { label: '混合层', role: '多层混合', description: '多种架构层混合的聚合模块' },
};

const SERVICE_NAME_RE = /(Service|Engine|Manager|Repository|Factory)$/;

// 目录名 → 语义层弱信号（内容信号优先，此处仅兜底）
const DIR_SIGNALS = [
  [/^(routes?|pages?|views|screens|layouts?|components|ui|widgets|overlays?|templates|presentation)$/, 'presentation'],
  [/^(stores?|state|redux|zustand|pinia|globals?|providers?)$/, 'state'],
  [/^(services?|domains?|business|usecases?|use-?cases?|engines?)$/, 'service'],
  [/^(api|apis|clients?|http|network|gateways?|adapters?|repositories)$/, 'integration'],
  [/^(hooks|composables|utils|lib|libs|helpers|shared|common|tools|kit|core)$/, 'shared'],
  [/^(types?|models|interfaces|schemas?|typings|dts)$/, 'types'],
  [/^(config|configs|constants|envs?|settings|options)$/, 'config'],
  [/^(tests?|__tests__|e2e|spec|specs|mocks?|fixtures?|testing)$/, 'test'],
  [/^(scripts?|userscripts?|monkey|tampermonkey)$/, 'script'],
  [/^(entry|entries|bootstrap|startup|app|main)$/, 'entry'],
];

// 技术目录名：不构成功能域（功能域只从业务命名目录/路由段产生）
const TECH_DIR_NAMES = new Set([
  'src', 'srcs', 'app', 'apps', 'packages', 'package', 'lib', 'libs', 'node_modules',
  'routes', 'route', 'pages', 'page', 'views', 'screens', 'layouts', 'layout',
  'components', 'component', 'ui', 'widgets', 'overlays', 'templates',
  'features', 'feature', 'entities', 'processes', 'containers', 'modules', 'module',
  'stores', 'store', 'state', 'redux', 'zustand', 'pinia', 'globals', 'providers', 'presentation',
  'services', 'service', 'domain', 'domains', 'business', 'usecases', 'engines',
  'api', 'apis', 'clients', 'client', 'http', 'network', 'gateways', 'adapters', 'repositories',
  'hooks', 'composables', 'utils', 'helpers', 'shared', 'common', 'tools', 'kit', 'core',
  'types', 'type', 'models', 'interfaces', 'schemas', 'typings',
  'config', 'configs', 'constants', 'env', 'settings', 'options',
  'tests', 'test', '__tests__', 'e2e', 'spec', 'specs', 'mocks', 'fixtures', 'testing',
  'scripts', 'userscripts', 'assets', 'styles', 'style', 'scss', 'css', 'static', 'public',
  'entry', 'bootstrap', 'startup', 'main', 'dist', 'build', 'coverage', 'docs', 'examples', 'demo', 'demos',
  'src-tauri', 'electron', 'extensions', 'dao',
]);

function stemOf(relPath) {
  return relPath.split('/').pop().replace(/\.(user\.js|mjs|cjs|tsx?|jsx?)$/, '');
}

// 目录信号：先看文件所在目录段（basename 优先），再看更浅层的技术目录段
function matchDirSignal(relPath) {
  const segs = relPath.split('/').filter(Boolean);
  const dirSegs = segs.slice(0, -1);
  for (let i = dirSegs.length - 1; i >= 0; i--) {
    for (const [re, layer] of DIR_SIGNALS) {
      if (re.test(dirSegs[i])) return layer;
    }
  }
  return null;
}

// 文件级语义层推断：内容信号（单元构成）优先，目录信号兜底
export function inferFileArchLayer(input) {
  const { relPath, isUserScript, isTest, isEntry, componentCount = 0, storeCount = 0, hookCount = 0, framework = null } = input;
  if (isUserScript) return 'script';
  if (isTest) return 'test';
  // 后端项目：routes / controllers / endpoints 目录文件 → service（不是前端 SPA 的 "presentation"）
  // 必须先于通用 DIR_SIGNALS，否则会被 'routes' → 'presentation' 抢判
  if (BACKEND_FRAMEWORKS.has(framework)
    && /(^|\/)(routes?|controllers?|endpoints?|handlers?)(\/|$)/.test(relPath)) {
    return 'service';
  }
  // 桌面客户端组件路径强信号（构建工具约定目录，直判）
  if (relPath.endsWith('.rs') || /\/src-tauri\//.test(relPath)) return 'tauri';
  if (/^electron\/|\/electron\//.test(relPath)) return 'electron';
  // Go 项目分层：main.go / cmd 为入口；router/controller/middleware/handler 为表现层；
  // model/dal/dao/relay/service 为业务层；pkg/common/internal 等其余目录归共享层
  if (relPath.endsWith('.go')) {
    if (isEntry || /(^|\/)cmd\//.test(relPath)) return 'entry';
    if (/(^|\/)(routers?|controllers?|middlewares?|handlers?|apis?)\//.test(relPath)) return 'presentation';
    if (/(^|\/)(models?|dal|dao|repositories?|relay|services?|monitor|biz|domain)\//.test(relPath)) return 'service';
    return 'shared';
  }
  if (relPath.endsWith('.d.ts')) return 'types';
  // PHP 项目分层（zentaopms 惯例）：module/<x>/control.php 为表现层（方法即路由）；
  // model.php / config.php 为业务层；view/lang 为展示资产；framework/ 为共享层
  if (relPath.endsWith('.php')) {
    if (/\/control\.php$/.test(relPath)) return 'presentation';
    if (/\/(model|config)\.php$/.test(relPath)) return 'service';
    if (/\/(view|ui|lang)(\/|$)/.test(relPath)) return 'presentation';
    if (/(^|\/)(dao|dal|repositories?|services?|models?)(\/|$)/.test(relPath)) return 'service';
    if (/(^|\/)(controllers?|routes?|api)(\/|$)/.test(relPath)) return 'presentation';
    if (/(^|\/)framework(\/|$)/.test(relPath)) return 'shared';
    return 'shared';
  }
  // Kotlin 项目分层（Android/JVM 惯例）：Activity/Fragment/Compose 文件为表现层；
  // Repository/UseCase/Service/ViewModel 归业务层；di/ 数据层归共享
  if (relPath.endsWith('.kt') || relPath.endsWith('.kts')) {
    if (/(Activity|Fragment|Screen|Page)\.kt$/.test(relPath)) return 'presentation';
    if (/\/(ui|compose|views?|screens?|pages?)(\/|$)/.test(relPath)) return 'presentation';
    if (/(Repository|UseCase|Interactor|Service|RepositoryImpl)\.kt$/.test(relPath)) return 'service';
    if (/(ViewModel)\.kt$/.test(relPath)) return 'presentation';
    if (/\/(di|data|datasource|db|network|api|remote|local)(\/|$)/.test(relPath)) return 'service';
    return 'shared';
  }
  // v0.39.0 ROS 2 / Python 项目分层：
  //   *.launch.py（launch 描述）→ deployment（部署/编排）
  //   rclpy Node 业务实现（*/scripts/, */<pkg>/<module>.py 包内）→ service
  //   test/、tests/ 目录下的 Python → test
  if (relPath.endsWith('.launch.py')) return 'deployment';
  if (relPath.endsWith('.py')) {
    if (isTest) return 'test';
    // FastAPI / Flask / aiohttp 路由（与 TS FastAPI 同语义）
    if (/\/(routers?|routes?|controllers?|api|views?|endpoints?)(\/|\.py)/.test(relPath)) return 'presentation';
    if (/\/(services?|use_cases?|domain|biz)(\/|\.py)/.test(relPath)) return 'service';
    if (/\/(models?|schemas?|entities|dto)(\/|\.py)/.test(relPath)) return 'service';
    if (/\/(repositories?|dal|dao|infra|adapters?|gateways?)(\/|\.py)/.test(relPath)) return 'integration';
    // ROS 2 节点（scripts/ 或同包内 *_node.py）→ service
    if (/\/scripts\//.test(relPath) || /_node\.py$/.test(relPath)) return 'service';
    // v0.40.0 Python 客户端 / SDK 工具脚本（与 PS/Bash 同目录的 API wrapper）→ integration
    if (/\/(redfish|sdk|api|client)s?(\/|$)/i.test(relPath)) return 'integration';
    return 'shared';
  }
  // v0.40.0 PowerShell 项目分层：
  //   PS 客户端 / SDK 工具脚本（与 Python 同目录的同名 API wrapper）→ integration
  //   PS 测试 → test（isTest 已优先命中，此处兜底）
  if (relPath.endsWith('.ps1') || relPath.endsWith('.psm1')) {
    if (isTest) return 'test';
    if (/\/(redfish|sdk|api|client)s?(\/|$)/i.test(relPath)) return 'integration';
    // PS Verb-Noun 前缀粗判
    if (/^\s*Set-|^\s*New-|^\s*Add-/.test(relPath.replace(/.*\//, ''))) return 'write';
    return 'shared';
  }
  if (isEntry) return 'entry';
  const serviceish = SERVICE_NAME_RE.test(stemOf(relPath)) || /\/services\//.test(relPath);
  const integrationish = /\/(api|apis|clients?|http|network|gateways?|adapters?|repositories)\//.test(relPath);
  if (storeCount > 0 && componentCount === 0) return 'state';
  if (integrationish && componentCount === 0 && storeCount === 0) return 'integration';
  if (serviceish && componentCount === 0 && storeCount === 0) return 'service';
  if (componentCount > 0) return 'presentation';
  if (hookCount > 0) return 'shared';
  const dirSignal = matchDirSignal(relPath);
  if (dirSignal) return dirSignal;
  return 'shared';
}

// 后端框架集合：这些 framework 走 backend-service 架构风格（区别于前端的 layered-spa / component-app）
// 与 projectScanner.FRAMEWORK_LABELS_FULL 配合；flutter/dart 是客户端不在此列
const BACKEND_FRAMEWORKS = new Set(['node-server', 'go', 'php', 'kotlin', 'python']);

// 模块级语义层：按子树文件的层构成取主导层；构成分散（主导 < 60%）时如实标记 mixed
export function inferModuleArchLayer(layerComposition) {
  const total = Object.values(layerComposition).reduce((a, b) => a + b, 0);
  if (total === 0) return { archLayer: null, dominantShare: 0 };
  const sorted = Object.entries(layerComposition).sort((a, b) => b[1] - a[1]);
  const [topLayer, topCount] = sorted[0];
  const dominantShare = topCount / total;
  if (sorted.length === 1 || dominantShare >= 0.6) return { archLayer: topLayer, dominantShare };
  return { archLayer: 'mixed', dominantShare };
}

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]/g, '');
}

// 功能域聚合：路由域段 + 业务命名目录 → Domain 对象（横向功能切片，与纵向架构层正交）
// 返回 { domains, fileDomainIds, moduleDomainIds }，供 builder 回填 domainIds
export function buildDomains({ routes, modules, fileObjects, components, stores, hooks, services, userScripts }) {
  // 1. 域名候选：路由 domain 段
  const routeDomainIds = new Map(); // rawName -> routeIds
  for (const r of routes) {
    const d = r.domain;
    if (!d || d === 'root' || d.startsWith(':')) continue;
    if (!routeDomainIds.has(d)) routeDomainIds.set(d, []);
    routeDomainIds.get(d).push(r.id);
  }
  // 2. 域名候选：业务命名目录模块（父目录为技术目录或根的技术边界，自身命名非技术词）
  const moduleDomainNames = new Set();
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  for (const m of modules) {
    if (TECH_DIR_NAMES.has(m.name.toLowerCase())) continue;
    const parent = m.parentId ? moduleById.get(m.parentId) : null;
    const parentIsTechBoundary = !parent
      || TECH_DIR_NAMES.has(parent.name.toLowerCase())
      || parent.depth === 1;
    if (parentIsTechBoundary) moduleDomainNames.add(m.name);
  }
  // 3. 归一合并（health / Health / diet-health 视为同域，展示名取首个原始名）
  const domainKeys = new Map(); // normalized -> raw display name
  for (const raw of [...routeDomainIds.keys(), ...moduleDomainNames]) {
    const key = normalizeName(raw);
    if (!domainKeys.has(key)) domainKeys.set(key, raw);
  }

  const domains = [];
  const fileDomainIds = new Map();
  const moduleDomainIds = new Map();

  for (const [key, rawName] of domainKeys) {
    const matchedModules = modules.filter((m) =>
      m.path.split('/').some((seg) => normalizeName(seg) === key));
    const domainId = `dom:${rawName}`;
    const fileIds = [];
    const fileSet = new Set();
    for (const f of fileObjects) {
      if (matchedModules.some((m) => f.path === m.path || f.path.startsWith(`${m.path}/`))) {
        fileSet.add(f.path);
        fileIds.push(f.id);
      }
    }
    const routeIds = routeDomainIds.get(rawName) ?? [];
    // 路由组件文件也归入域
    for (const r of routes) {
      if (!routeIds.includes(r.id)) continue;
      const fp = r.componentFileId?.slice(5);
      if (fp && !fileSet.has(fp)) { fileSet.add(fp); fileIds.push(r.componentFileId); }
    }
    const domainComponents = components.filter((c) => fileSet.has(c.filePath));
    const domainStores = stores.filter((s) => fileSet.has(s.filePath));
    const domainHooks = hooks.filter((h) => fileSet.has(h.filePath));
    const domainServices = services.filter((s) => fileSet.has(s.filePath));
    const domainScripts = userScripts.filter((u) => fileSet.has(u.filePath));
    const capability = [...new Set(
      routes.filter((r) => routeIds.includes(r.id)).map((r) => r.description).filter(Boolean),
    )].slice(0, 3).join('、') || null;
    const lineCount = fileObjects.filter((f) => fileSet.has(f.path)).reduce((a, f) => a + (f.lineCount ?? 0), 0);

    domains.push({
      id: domainId,
      name: rawName,
      sources: [
        ...(routeDomainIds.has(rawName) ? ['route'] : []),
        ...(matchedModules.length > 0 ? ['module'] : []),
      ],
      routeIds,
      moduleIds: matchedModules.map((m) => m.id),
      fileIds,
      componentIds: domainComponents.map((c) => c.id),
      storeIds: domainStores.map((s) => s.id),
      hookIds: domainHooks.map((h) => h.id),
      serviceIds: domainServices.map((s) => s.id),
      userScriptIds: domainScripts.map((u) => u.id),
      routeCount: routeIds.length,
      moduleCount: matchedModules.length,
      fileCount: fileIds.length,
      componentCount: domainComponents.length,
      storeCount: domainStores.length,
      hookCount: domainHooks.length,
      serviceCount: domainServices.length,
      scriptCount: domainScripts.length,
      lineCount,
      capability,
      summary: null, // 由 summarizeDomain 填充
      reviewed: false,
      notes: null,
    });

    // 回填索引
    for (const f of fileObjects) {
      if (!fileSet.has(f.path)) continue;
      if (!fileDomainIds.has(f.path)) fileDomainIds.set(f.path, []);
      if (!fileDomainIds.get(f.path).includes(domainId)) fileDomainIds.get(f.path).push(domainId);
    }
    for (const m of matchedModules) {
      if (!moduleDomainIds.has(m.path)) moduleDomainIds.set(m.path, []);
      if (!moduleDomainIds.get(m.path).includes(domainId)) moduleDomainIds.get(m.path).push(domainId);
    }
    for (const r of routes) {
      if (routeIds.includes(r.id)) {
        if (!r.domainIds) r.domainIds = [];
        if (!r.domainIds.includes(domainId)) r.domainIds.push(domainId);
      }
    }
  }

  domains.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
  for (const d of domains) d.summary = summarizeDomain(d);
  return { domains, fileDomainIds, moduleDomainIds };
}

function describeUnitCounts(unitCounts = {}) {
  const parts = [];
  if (unitCounts.component > 0) {
    parts.push(unitCounts.page > 0
      ? `组件 ${unitCounts.component}（页面 ${unitCounts.page}）`
      : `组件 ${unitCounts.component}`);
  }
  if (unitCounts.hook > 0) parts.push(`Hook ${unitCounts.hook}`);
  if (unitCounts.store > 0) parts.push(`Store ${unitCounts.store}`);
  if (unitCounts.service > 0) parts.push(`Service ${unitCounts.service}`);
  if (unitCounts.scriptFunction > 0) parts.push(`脚本函数 ${unitCounts.scriptFunction}`);
  if (unitCounts.userScript > 0) parts.push(`油猴脚本 ${unitCounts.userScript}`);
  return parts.join('、');
}

// 模块职责画像：一句话说清"这个目录是什么层、装了什么、被谁依赖"
export function summarizeModule(m) {
  const label = ARCH_LAYERS[m.archLayer]?.label ?? m.archLayer ?? '';
  const fileCount = m.subtreeFileCount ?? m.fileCount ?? 0;
  let head = `${label}：`;
  if (m.archLayer === 'mixed' && m.layerComposition) {
    const comp = Object.entries(m.layerComposition)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${ARCH_LAYERS[k]?.label ?? k} ${v}`).join(' · ');
    if (comp) head = `${label}（${comp}）：`;
  }
  const parts = [`${fileCount} 个文件`];
  const units = describeUnitCounts(m.unitCounts);
  if (units) parts.push(units);
  if (m.externalImportedByCount > 0) parts.push(`被模块外 ${m.externalImportedByCount} 处引用`);
  if (m.routeCount > 0) parts.push(`承载 ${m.routeCount} 条路由`);
  return `${head}${parts.join('，')}。`;
}

export function summarizeDomain(d) {
  const parts = [];
  if (d.routeCount > 0) parts.push(`${d.routeCount} 条路由`);
  if (d.componentCount > 0) parts.push(`${d.componentCount} 个组件`);
  if (d.storeCount > 0) parts.push(`${d.storeCount} 个 Store`);
  if (d.hookCount > 0) parts.push(`${d.hookCount} 个 Hook`);
  if (d.serviceCount > 0) parts.push(`${d.serviceCount} 个 Service`);
  if (d.scriptCount > 0) parts.push(`${d.scriptCount} 个油猴脚本`);
  parts.push(`${d.fileCount} 个文件`);
  const head = d.capability ? `${d.capability}：` : '';
  return `${head}${parts.join('、')}。`;
}

const FRAMEWORK_LABELS = {
  flutter: 'Flutter 应用',
  dart: 'Dart 应用',
  react: 'React 单页应用',
  vue: 'Vue 单页应用',
  next: 'Next.js 应用',
  nuxt: 'Nuxt 应用',
  'react-native': 'React Native 应用',
  expo: 'React Native（Expo）应用',
  userscript: '油猴脚本集合',
  unknown: '前端项目',
};

// 项目级架构画像：分层结构 / 架构风格 / 健康度 / 自然语言总结
export function buildProjectProfile(ctx) {
  const {
    framework, frameworkLabel, fileObjects, modules, domains, routes, components, stores, hooks, services,
    userScripts, dependencies, cycles, orphanCandidates, analysisErrors,
    deadFunctionCount = 0, deadTypeCount = 0, deadExportCount = 0,
  } = ctx;

  const layerDist = new Map();
  for (const f of fileObjects) layerDist.set(f.archLayer, (layerDist.get(f.archLayer) ?? 0) + 1);
  const totalFiles = fileObjects.length || 1;
  const layers = [...layerDist.entries()]
    .map(([key, fileCount]) => ({
      key,
      label: ARCH_LAYERS[key]?.label ?? key,
      description: ARCH_LAYERS[key]?.description ?? '',
      fileCount,
      share: Math.round((fileCount / totalFiles) * 1000) / 10,
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  const style = framework === 'userscript' ? 'script-collection'
    : BACKEND_FRAMEWORKS.has(framework) ? 'backend-service'
    : (routes.length > 0 ? 'layered-spa' : 'component-app');

  const undeclaredDependencyCount = dependencies.filter((d) => d.source === 'undeclared').length;
  const highRiskScriptCount = userScripts.filter((s) => s.riskLevel === 'high').length;
  const health = {
    cycleCount: cycles.length,
    orphanFileCount: orphanCandidates.length,
    deadTypeCount,
    deadFunctionCount,
    deadExportCount,
    undeclaredDependencyCount,
    analysisErrorCount: analysisErrors.length,
    highRiskScriptCount,
  };

  const sentences = [];
  sentences.push(`${frameworkLabel ?? FRAMEWORK_LABELS[framework] ?? framework}（${fileObjects.length} 个源文件，${modules.length} 个模块）。`);
  if (layers.length > 0) {
    const top = layers.slice(0, 3)
      .map((l) => `${l.label} ${l.share}%（${l.fileCount} 文件）`).join('、');
    sentences.push(`架构分为 ${layers.length} 个语义层，主体为 ${top}。`);
  }
  if (domains.length > 0) {
    const top = domains.slice(0, 5).map((d) => `${d.name}（${d.fileCount} 文件）`).join('、');
    sentences.push(`功能域 ${domains.length} 个：${top}${domains.length > 5 ? ' 等' : ''}。`);
  }
  sentences.push(summarizeHealth(health));

  return {
    architecture: {
      style,
      styleLabel: { 'layered-spa': '分层单页应用', 'component-app': '组件应用', 'script-collection': '脚本集合', 'backend-service': '后端服务' }[style],
      layers,
      layerCount: layers.length,
      domainCount: domains.length,
      unitCounts: {
        component: components.length, hook: hooks.length, store: stores.length,
        service: services.length, userScript: userScripts.length,
      },
    },
    health,
    capabilities: domains.slice(0, 10).map((d) => ({ domain: d.name, summary: d.summary })),
    summary: sentences.join(''),
  };
}

function summarizeHealth(health) {
  const items = [];
  if (health.cycleCount > 0) items.push(`循环依赖 ${health.cycleCount} 组`);
  if (health.orphanFileCount > 0) items.push(`死代码候选文件 ${health.orphanFileCount} 个`);
  if (health.deadTypeCount > 0) items.push(`死代码候选类型 ${health.deadTypeCount} 个`);
  if (health.deadExportCount > 0) items.push(`死代码候选导出 ${health.deadExportCount} 个`);
  if (health.deadFunctionCount > 0) items.push(`死代码候选函数 ${health.deadFunctionCount} 个`);
  if (health.undeclaredDependencyCount > 0) items.push(`未声明依赖 ${health.undeclaredDependencyCount} 个`);
  if (health.highRiskScriptCount > 0) items.push(`高风险油猴脚本 ${health.highRiskScriptCount} 个`);
  if (health.analysisErrorCount > 0) items.push(`解析错误 ${health.analysisErrorCount} 个`);
  if (items.length === 0) return '健康度良好：未发现循环依赖、死代码候选与未声明依赖。';
  return `健康度：存在 ${items.join('、')}（治理点）。`;
}

export { SERVICE_NAME_RE };
