// 本体蓝图：对象类型 + 链接关系 + 动作的定义与实现
// 与 asdm-aos 的 codeRepoBlueprint 对应，针对 React/Vue 前端重新建模

export const OBJECT_TYPES = [
  { type: 'Project', prefix: 'proj:', description: '代码仓库' },
  { type: 'Module', prefix: 'mod:', description: '目录模块（领域/分层）' },
  { type: 'SourceFile', prefix: 'file:', description: '源文件（ts/tsx/js/jsx/vue）' },
  { type: 'Component', prefix: 'comp:', description: '前端组件（React / Vue SFC）' },
  { type: 'Hook', prefix: 'hook:', description: '自定义 Hook / Composable' },
  { type: 'Store', prefix: 'store:', description: '状态 Store（Zustand / Pinia）' },
  { type: 'Service', prefix: 'svc:', description: '服务/引擎模块' },
  { type: 'Route', prefix: 'route:', description: '路由条目（Overlay / vue-router 页面）' },
  { type: 'Dependency', prefix: 'dep:', description: 'npm 依赖' },
];

export const LINK_TYPES = ['contains', 'imports', 'importedBy', 'renders', 'renderedBy', 'navigatesTo', 'registers', 'usesStore', 'usesHook'];

export const ACTION_NAMES = ['refreshRepo', 'markReviewed', 'addNote'];

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

  const linkImpls = {
    contains(srcId) {
      if (srcId.startsWith('proj:')) {
        return (dataMap.Module ?? []).filter((m) => !m.parentId || m.parentId === srcId);
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
        return out;
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
