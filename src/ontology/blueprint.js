// 本体蓝图：概念分类体系（taxonomy）+ 对象类型 + 链接关系 + 动作的定义与实现
// 与 asdm-aos 的 codeRepoBlueprint 对应，针对 React/Vue 前端重新建模；
// 油猴脚本（UserScript）体系与 React/Vue 组件体系并存、逻辑独立

// 概念元模型：对象类型按"概念范畴"（is-a 族）与"抽象层级"（L0-L3）双维组织，
// 消除 14+ 种类型平铺罗列、无抽象总结的问题
export const ONTOLOGY_META = {
  version: '2.0',
  abstractionLevels: [
    { level: 'L3', name: '架构层', description: '产品级聚合：整体架构画像与功能域划分', types: ['Project', 'Domain'] },
    { level: 'L2', name: '结构层', description: '代码组织结构：模块、文件、路由、脚本与运行环境', types: ['Module', 'SourceFile', 'Route', 'UserScript', 'Dependency'] },
    { level: 'L1', name: '单元层', description: '可独立理解的代码单元（CodeUnit 概念族）', types: ['Component', 'Hook', 'Store', 'Service', 'Interface', 'Class', 'Method', 'PropEdge', 'ScriptFunction'] },
    { level: 'L0', name: '事实层', description: '审计事实（AuditFact 概念族）：从代码提取的行为证据', types: ['GmApiUsage', 'InjectionPoint', 'NetworkEndpoint'] },
  ],
  categories: [
    { category: 'Container', label: '容器', description: '按结构聚合代码单元的节点', types: ['Project', 'Domain', 'Module', 'SourceFile'] },
    { category: 'CodeUnit', label: '代码单元', description: '可独立理解的逻辑单元', types: ['Component', 'Hook', 'Store', 'Service', 'Interface', 'Class', 'Method', 'PropEdge', 'ScriptFunction'] },
    { category: 'EntryPoint', label: '行为入口', description: '用户可触达的行为入口', types: ['Route'] },
    { category: 'Script', label: '油猴脚本', description: '独立于宿主应用的脚本形态（自带子对象体系）', types: ['UserScript'] },
    { category: 'Environment', label: '运行环境', description: '外部环境要素', types: ['Dependency'] },
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
  { type: 'Method', prefix: 'method:', category: 'CodeUnit', level: 'L1', description: '方法/函数（类方法、接口方法签名、模块函数、Rust impl fn、Dart 方法；含 overrides、callIds/calledByIds 逻辑调用链与 deadCandidate）' },
  { type: 'PropEdge', prefix: 'prop:', category: 'CodeUnit', level: 'L1', description: '组件间 props 传递边（含来源分类 forward/state/store/handler/literal/computed/spread）' },
  { type: 'ScriptFunction', prefix: 'fn:', category: 'CodeUnit', level: 'L1', description: '脚本函数/类/对象（含业务角色 roles：render/data/state/event/ui/logic）' },
  { type: 'Route', prefix: 'route:', category: 'EntryPoint', level: 'L2', description: '路由条目（Overlay / react-router / vue-router / Flutter GoRoute）' },
  { type: 'UserScript', prefix: 'us:', category: 'Script', level: 'L2', description: '油猴脚本（Tampermonkey UserScript）' },
  { type: 'Dependency', prefix: 'dep:', category: 'Environment', level: 'L2', description: '依赖（npm 包 / pub 包）' },
  { type: 'GmApiUsage', prefix: 'gm:', category: 'AuditFact', level: 'L0', description: 'GM API 使用（@grant 声明比对）' },
  { type: 'InjectionPoint', prefix: 'inject:', category: 'AuditFact', level: 'L0', description: 'DOM 注入点（含归属函数 fns/fnIds，构成逻辑注入链）' },
  { type: 'NetworkEndpoint', prefix: 'net:', category: 'AuditFact', level: 'L0', description: '网络端点（含归属函数 fns/fnIds）' },
];

export const LINK_TYPES = [
  'contains', 'imports', 'importedBy', 'renders', 'renderedBy', 'passesProps', 'navigatesTo', 'registers', 'usesStore', 'usesHook',
  'implements', 'implementedBy', 'extends', 'extendedBy', 'overrides', 'overriddenBy',
  'usesGmApi', 'injectsInto', 'requestsTo', 'calls', 'calledBy', 'belongsTo',
];

export const ACTION_NAMES = ['refreshRepo', 'analyzeFile', 'markReviewed', 'addNote'];

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
        return files.filter((f) => (f.importIds ?? []).includes(storeFileId));
      }
      if (srcId.startsWith('file:') || srcId.startsWith('comp:')) {
        const filePath = srcId.startsWith('file:') ? srcId.slice(5) : getObject(index, srcId)?.filePath;
        if (!filePath) return [];
        const fileId = `file:${filePath}`;
        return (dataMap.Store ?? []).filter((s) => {
          const sFileId = `file:${s.filePath}`;
          const importer = files.find((f) => f.id === fileId);
          return importer && (importer.importIds ?? []).includes(sFileId);
        });
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
