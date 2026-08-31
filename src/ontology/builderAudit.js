// 相位 6（buildOntologyData 拆分）：语义富化（架构层/功能域/模块画像）+ 死代码候选与循环依赖
// 原为 builder.js 内联代码段（"7d. 语义富化" 至 "8. 死代码候选与循环依赖"），逻辑不变。
import path from 'node:path';
import { ARCH_LAYERS, inferFileArchLayer, inferModuleArchLayer, buildDomains, summarizeModule } from './semantics.js';
import { findCycles } from './builderUtils.js';

export function builderAuditPhase(ctx) {
  const {
    scan, factsMap, fileObjects, routes, modules, components, stores, hooks, services,
    userScripts, scriptFunctions, interfaces, classes, methods,
    lazyReferencedFiles, testImportedFiles, testNamedRefs,
    indirectlyReferencedFiles, importedTypeRefs, rustUsedNames,
  } = ctx;

  // 后端项目的 routes/ controllers/ endpoints/ 文件应归 service 层而不是 presentation
  const projectFramework = scan?.framework ?? null;

  // 7d. 语义富化：文件级架构分层 → 功能域聚合 → 模块职责画像 → 单元归属回填
  //     分类以内容信号为准（单元构成/路由归属/引用结构），目录名仅作弱信号兜底
  const importersOf = new Map(); // fileId -> Set(importerFileIds)
  for (const f of fileObjects) {
    for (const id of f.importIds) {
      if (!id.startsWith('file:')) continue;
      if (!importersOf.has(id)) importersOf.set(id, new Set());
      importersOf.get(id).add(f.id);
    }
  }
  const fileArchLayer = new Map(); // relPath -> archLayer
  for (const f of fileObjects) {
    const facts = factsMap.get(f.path);
    const archLayer = inferFileArchLayer({
      relPath: f.path,
      isUserScript: !!facts?.isUserScript,
      isTest: f.isTest,
      isEntry: f.isEntry,
      componentCount: facts?.components?.length ?? 0,
      storeCount: facts?.stores?.length ?? 0,
      hookCount: facts?.hooks?.length ?? 0,
      framework: projectFramework,
    });
    f.archLayer = archLayer;
    fileArchLayer.set(f.path, archLayer);
  }

  // 功能域：路由域段 + 业务命名目录 → Domain（与纵向架构层正交的横向功能切片）
  const { domains, fileDomainIds, moduleDomainIds } = buildDomains({
    routes, modules, fileObjects, components, stores, hooks, services, userScripts,
  });

  // 模块子树（文件集合 + 层构成 + 单元构成 + 外部引用）
  const moduleSubtreeFiles = new Map(); // moduleId -> Set<relPath>
  for (const m of modules) {
    const set = new Set();
    for (const f of fileObjects) {
      if (f.path === m.path || f.path.startsWith(`${m.path}/`)) set.add(f.path);
    }
    moduleSubtreeFiles.set(m.id, set);
  }
  const moduleChainOf = (relPath) => {
    const chain = [];
    let dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    while (dir && dir !== '.') {
      chain.push(`mod:${dir}`);
      const parent = path.posix.dirname(dir);
      if (parent === '.') break;
      dir = parent;
    }
    return chain;
  };
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const bumpUnits = (relPath, key, extra = 0) => {
    for (const modId of moduleChainOf(relPath)) {
      const mod = moduleById.get(modId);
      if (!mod) continue;
      mod.unitCounts[key] = (mod.unitCounts[key] ?? 0) + 1;
      if (extra) mod.unitCounts[extra] = (mod.unitCounts[extra] ?? 0) + 1;
    }
  };
  for (const m of modules) {
    m.layerComposition = {};
    m.unitCounts = {};
  }
  for (const f of fileObjects) {
    for (const modId of moduleChainOf(f.path)) {
      const mod = moduleById.get(modId);
      if (mod) mod.layerComposition[f.archLayer] = (mod.layerComposition[f.archLayer] ?? 0) + 1;
    }
  }
  for (const c of components) bumpUnits(c.filePath, 'component', c.kind === 'page' ? 'page' : null);
  for (const h of hooks) bumpUnits(h.filePath, 'hook');
  for (const s of stores) bumpUnits(s.filePath, 'store');
  for (const s of services) bumpUnits(s.filePath, 'service');
  for (const fn of scriptFunctions) bumpUnits(fn.filePath, 'scriptFunction');
  for (const us of userScripts) bumpUnits(us.filePath, 'userScript');

  for (const m of modules) {
    const subtree = moduleSubtreeFiles.get(m.id);
    const { archLayer, dominantShare } = inferModuleArchLayer(m.layerComposition);
    m.archLayer = archLayer;
    m.archLayerLabel = ARCH_LAYERS[archLayer]?.label ?? null;
    m.dominantShare = Math.round(dominantShare * 100);
    m.subtreeFileCount = subtree.size;
    m.unitCount = Object.values(m.unitCounts).reduce((a, b) => a + b, 0);
    m.domainIds = moduleDomainIds.get(m.path) ?? [];
    m.routeCount = 0;
    for (const r of routes) {
      const fp = r.componentFileId?.slice(5);
      if (fp && subtree.has(fp)) m.routeCount += 1;
    }
    m.externalImportedByCount = 0;
    for (const fp of subtree) {
      for (const importerId of importersOf.get(`file:${fp}`) ?? []) {
        if (!subtree.has(importerId.slice(5))) m.externalImportedByCount += 1;
      }
    }
    m.summary = summarizeModule(m);
  }

  // 单元级归属回填：架构层（继承所在文件）+ 功能域
  for (const c of components) {
    c.archLayer = fileArchLayer.get(c.filePath) ?? null;
    c.domainIds = fileDomainIds.get(c.filePath) ?? [];
  }
  for (const h of hooks) {
    h.archLayer = fileArchLayer.get(h.filePath) ?? null;
    h.domainIds = fileDomainIds.get(h.filePath) ?? [];
  }
  for (const s of stores) {
    s.archLayer = fileArchLayer.get(s.filePath) ?? null;
    s.domainIds = fileDomainIds.get(s.filePath) ?? [];
  }
  for (const s of services) {
    s.archLayer = fileArchLayer.get(s.filePath) ?? null;
    s.domainIds = fileDomainIds.get(s.filePath) ?? [];
  }
  for (const us of userScripts) {
    us.archLayer = 'script';
    us.domainIds = fileDomainIds.get(us.filePath) ?? [];
  }
  for (const fn of scriptFunctions) fn.archLayer = 'script';
  for (const i of interfaces) i.archLayer = fileArchLayer.get(i.filePath) ?? null;
  for (const c of classes) c.archLayer = fileArchLayer.get(c.filePath) ?? null;
  for (const m of methods) m.archLayer = fileArchLayer.get(m.filePath) ?? null;

  // 8. 死代码候选与循环依赖
  const importedByCount = new Map();
  for (const f of fileObjects) {
    for (const id of f.importIds) {
      if (id.startsWith('file:')) importedByCount.set(id, (importedByCount.get(id) ?? 0) + 1);
    }
  }
  // import.meta.glob([...]) 动态批量导入的文件（如 snowy 的 views 菜单路由 / icon 选择器）豁免孤儿候选
  const globReferencedFiles = new Set();
  {
    const globToRegExp = (pattern) => {
      let re = '';
      let i = 0;
      while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
          if (pattern[i + 1] === '*') {
            if (pattern[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; continue; }
            re += '[\\s\\S]*'; i += 2; continue;
          }
          re += '[^/]*'; i += 1; continue;
        }
        re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i += 1;
      }
      return new RegExp(`^${re}$`);
    };
    // glob 模式归一为项目相对路径模式（/x → x；../y 相对声明文件目录解析）
    const normalizePattern = (pattern, fromFile) => {
      let p = pattern;
      if (p.startsWith('/')) return p.slice(1);
      if (!p.startsWith('.')) return p; // 相对同目录简写（assets/...）
      const parts = path.posix.dirname(fromFile).split('/');
      for (const seg of p.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
      }
      return parts.join('/');
    };
    for (const [relPath, facts] of factsMap) {
      for (const g of facts.globPatterns ?? []) {
        const includes = g.patterns.filter((p) => !p.startsWith('!'))
          .map((p) => globToRegExp(normalizePattern(p.replace(/^!/, ''), g.fromFile)));
        const excludes = g.patterns.filter((p) => p.startsWith('!'))
          .map((p) => globToRegExp(normalizePattern(p.slice(1), g.fromFile)));
        if (!includes.length) continue;
        for (const f of fileObjects) {
          if (!includes.some((re) => re.test(f.path))) continue;
          if (excludes.some((re) => re.test(f.path))) continue;
          globReferencedFiles.add(f.path);
        }
      }
    }
  }
  const routeComponentFiles = new Set(routes.map((r) => r.componentFileId).filter(Boolean));
  // unplugin-vue-components（组件自动注册目录）/ unplugin-auto-import（导出自动导入目录）：
  // 编译期自动注入 import，源码零 import 记录属常态，豁免孤儿候选
  const autoComponentDirs = scan.autoComponentDirs ?? [];
  const autoImportDirs = scan.autoImportDirs ?? [];
  const isAutoRegistered = (p) => (p.endsWith('.vue') && autoComponentDirs.some((d) => p.startsWith(`${d}/`)))
    || autoImportDirs.some((d) => p.startsWith(`${d}/`));
  const orphanCandidates = fileObjects
    .filter((f) => (f.path.startsWith('src/') || f.path.startsWith('lib/'))
      && !f.isTest && !f.isEntry
      && !routeComponentFiles.has(f.id)
      && !lazyReferencedFiles.has(f.path)
      && !globReferencedFiles.has(f.path)
      && !isAutoRegistered(f.path)
      && !testImportedFiles.has(f.path)
      && (importedByCount.get(f.id) ?? 0) === 0)
    .map((f) => f.path);
  // 导出级死代码：导出符号全仓库零导入且本文件零使用（仅 export 冗余，代码可安全去导出/删除）
  // 保守豁免：入口/测试文件、被 export */命名空间/无子句动态 import 整体引用的文件、
  // 零导入文件（文件级 orphan 已覆盖）、default 导出、外部测试目录的具名引用（relPath#name）
  const deadExportCandidates = [];
  for (const f of fileObjects) {
    f.unusedExports = [];
    if (f.isEntry || f.isTest) continue;
    if (f.path.endsWith('.go')) continue; // Go 导出符号的包级判定已在 5b-0d 完成
    if (indirectlyReferencedFiles.has(f.path)) continue;
    if (((importedByCount.get(f.id) ?? 0) === 0) && !testImportedFiles.has(f.path)) continue;
    const facts = factsMap.get(f.path);
    for (const sym of facts?.exportSymbols ?? []) {
      if (!sym.isExported || sym.isDefault) continue;
      if (importedTypeRefs.has(`${f.path}#${sym.name}`)) continue;
      if (testNamedRefs.has(`${f.path}#${sym.name}`)) continue;
      if (f.path.endsWith('.rs') && rustUsedNames.has(sym.name)) continue; // Rust use 名字级兜底豁免
      const positions = facts.nameReferences?.get(sym.name) ?? [];
      if (positions.length > 1) continue; // 本文件内仍有使用，仅 export 语句冗余，不判死
      f.unusedExports.push(sym.name);
    }
    if (f.unusedExports.length > 0) {
      deadExportCandidates.push({ file: f.path, names: f.unusedExports });
    }
  }
  const cycles = findCycles(fileObjects);

  Object.assign(ctx, { domains, orphanCandidates, deadExportCandidates, cycles });
}
