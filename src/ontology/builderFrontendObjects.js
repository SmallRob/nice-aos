// 相位 2（buildOntologyData 拆分）：组件/Hook/Store/Service + 类型实体 + 跨文件引用解析
// 原为 builder.js 内联代码段（"5. 组件 / Hook / Store / Service" 至 report('resolve:done')），逻辑不变。
import path from 'node:path';
import fs from 'node:fs';
import { resolveRustUse } from '../analyzers/rustAnalyzer.js';
import { SERVICE_NAME_RE, uniqueId, componentKind, dirOf } from './builderUtils.js';
import { collectTypeEntities, linkMethodOverrides } from './typeEntities.js';
import { computeFingerprint } from './fingerprint.js';

export function builderFrontendPhase(ctx) {
  const {
    projectRoot, scan, factsMap, fileObjectByPath, resolutionStats, resolver,
    rustFiles, report,
  } = ctx;

  // 5. 组件 / Hook / Store / Service
  const components = [];
  const compIdByName = new Map();
  const compUsedIds = new Set();
  const compStoreCallsById = new Map();
  const hooks = [];
  const hookUsedIds = new Set();
  const stores = [];
  const storeUsedIds = new Set();
  const services = [];
  const svcUsedIds = new Set();
  const componentsByFile = new Map();

  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    const fileObj = fileObjectByPath.get(relPath);

    for (const comp of facts.components) {
      const id = uniqueId(`comp:${comp.name}`, compUsedIds);
      const isVuePage = relPath.endsWith('.vue') && /\/(views|pages)\//.test(relPath);
      components.push({
        id, name: comp.name,
        fileId: fileObj.id, filePath: relPath,
        kind: isVuePage && componentKind(comp.name) === 'common' ? 'page' : componentKind(comp.name),
        isDefaultExport: comp.isDefault,
        isPrimary: facts.primaryComponentName === comp.name,
        propsCount: comp.propsCount,
        hooksUsed: comp.hooksUsed,
        stateCount: comp.stateCount,
        lineCount: comp.lineCount,
        description: comp.description,
        rendersIds: [],
        routeIds: [],
        reviewed: false,
        notes: null,
      });
      compIdByName.set(comp.name, id);
      if (comp.storeCalls?.length) compStoreCallsById.set(id, comp.storeCalls);
      if (!componentsByFile.has(relPath)) componentsByFile.set(relPath, []);
      componentsByFile.get(relPath).push({ id, name: comp.name, isPrimary: facts.primaryComponentName === comp.name });
    }

    for (const hook of facts.hooks) {
      const id = uniqueId(`hook:${hook.name}`, hookUsedIds);
      hooks.push({
        id, name: hook.name,
        fileId: fileObj.id, filePath: relPath,
        lineCount: hook.lineCount,
        description: hook.description,
        reviewed: false, notes: null,
      });
    }

    for (const store of facts.stores) {
      const id = uniqueId(`store:${store.name}`, storeUsedIds);
      stores.push({
        id, name: store.name,
        fileId: fileObj.id, filePath: relPath,
        stateKeys: store.stateKeys,
        actionKeys: store.actionKeys,
        stateKeyCount: store.stateKeys.length,
        hasPersist: store.hasPersist,
        storageKey: store.storageKey,
        location: relPath.includes('/store/') ? 'store' : (relPath.includes('/services/') ? 'services' : 'other'),
        lineCount: store.lineCount,
        providerType: store.providerType ?? null,
        notifierClass: store.notifierClass ?? null,
        reviewed: false, notes: null,
      });
    }

    const isStoreFile = facts.stores.length > 0;
    const stem = path.posix.basename(relPath).replace(/\.(tsx?|jsx?)$/, '');
    const serviceish = !isStoreFile && (
      relPath.includes('/services/') || SERVICE_NAME_RE.test(stem)
    ) && !relPath.includes('/routes/');
    if (serviceish) {
      const id = uniqueId(`svc:${stem}`, svcUsedIds);
      services.push({
        id, name: stem,
        fileId: fileObj.id, filePath: relPath,
        pattern: facts.hasSingletonClass ? 'singleton' : (facts.hasClassExport ? 'class' : 'functions'),
        exportsCount: facts.exportNames.length,
        lineCount: facts.lineCount,
        reviewed: false, notes: null,
      });
    }
  }

  // 5a. 隐式 usesStore：unplugin-auto-import 等场景组件直接调用 useXxxStore()/xxxStore() 而无 import 语句，
  // 静态导入图缺失该边；以全局 Store 名单匹配组件体内调用名（useCalls / setup storeVars 均不依赖 import）补齐
  {
    const storeIdByName = new Map();
    for (const s of stores) {
      if (!storeIdByName.has(s.name)) storeIdByName.set(s.name, s.id);
    }
    for (const c of components) {
      const names = new Set([...(c.hooksUsed ?? []), ...(compStoreCallsById.get(c.id) ?? [])]);
      const ids = new Set();
      for (const name of names) {
        const sid = storeIdByName.get(name);
        if (sid) {
          ids.add(sid);
          // 仅当无显式 import 时计 auto-imported（import 过的会重复出现在 storeIds，但来源不同）
          if (!(c.filePath && fileObjectByPath.get(c.filePath)?.importIds?.some((iid) => {
            const f = fileObjectByPath.get(c.filePath);
            const target = stores.find((s) => s.id === sid);
            return f && target && iid === `file:${target.filePath}`;
          }))) {
            resolutionStats.autoImportedUsesStoreCount += 1;
          }
        }
      }
      c.storeIds = [...ids];
    }
  }

  // 5b-0. 类型实体：Interface / Class / Trait / Method（跨文件 implements/extends/overrides + 函数级死代码候选）
  const {
    interfaces, classes, traits, methods, localTypesByFile, typeSpanById, refsOutsideSpan,
  } = collectTypeEntities(scan.files, factsMap, fileObjectByPath);

  // 5b-0a. PHP trait use 链接：class.usesTraits（名字）→ 全仓库 trait 对象（id）回填
  // 双向写入：class.usesTraitIds / trait.usedByIds（供 blueprint link usesTrait/usedByTrait 消费）
  const traitByName = new Map();
  for (const t of traits) traitByName.set(t.name, t);
  for (const cls of classes) {
    if (!cls.usesTraits || cls.usesTraits.length === 0) continue;
    for (const name of cls.usesTraits) {
      const t = traitByName.get(name);
      if (!t) continue;
      cls.usesTraitIds.push(t.id);
      if (!t.usedByIds.includes(cls.id)) t.usedByIds.push(cls.id);
    }
  }

  // 5b-0a'. PHP DAO 链常量解析：sqlQueries 中 TABLE_X（dynamic）→ define 值（config/config.php
  // `define('TABLE_BUG', '`zt_bug`')`），命中则改写为真实表名并清 dynamic（blueprint mapsToTable 通道消费）
  const phpDefines = {};
  for (const [, f] of factsMap) Object.assign(phpDefines, f.defines ?? {});
  if (Object.keys(phpDefines).length > 0) {
    for (const m of methods) {
      if (!m.sqlQueries?.length) continue;
      for (const q of m.sqlQueries) {
        if (!q.dynamic) continue;
        const resolved = phpDefines[q.table];
        if (resolved) { q.table = resolved; q.dynamic = false; }
      }
    }
  }

  // 5b-0b. AST fingerprint 后处理（v0.32.0+）：给每个有 pos/end 的 method 挂整树 hash
  // 借鉴 code-graph-rag 的去标识符/去字面量/去注释 → SHA-256 算法（src/ontology/fingerprint.js）
  // 用于阶段 1.3 重复代码检测（`nice-aos duplicates` 子命令）。
  //
  // v0.33.0+ 性能门：默认开启（保持 v0.32.0 行为，向后兼容 duplicates 输出）；
  // 大仓库可用 `NICE_AOS_FINGERPRINT=0` 显式关闭以节省 ~5% 扫描时间。
  {
    const fpEnabled = process.env.NICE_AOS_FINGERPRINT !== '0' && process.env.NICE_AOS_FINGERPRINT !== 'false';
    if (fpEnabled) {
      const fileContentCache = new Map(); // relPath -> source text（避免重复 IO）
      const getFileContent = (relPath) => {
        if (fileContentCache.has(relPath)) return fileContentCache.get(relPath);
        try {
          const text = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
          fileContentCache.set(relPath, text);
          return text;
        } catch {
          fileContentCache.set(relPath, null);
          return null;
        }
      };
      for (const m of methods) {
        if (m.pos == null || m.end == null || m.end <= m.pos) continue;
        const content = getFileContent(m.filePath);
        if (!content) continue;
        // 只对有 body 的方法计算 fingerprint（class method 有 body,interface signature 无 body 但仍有 pos）
        // 简化：trust pos/end，对 module functions 必有效，对 class methods 99% 有效
        const body = content.slice(m.pos, m.end);
        // 跳过 interface signature 那种没有 body 的（end-pos < 50 表示基本是空）
        if (m.end - m.pos < 30) continue;
        const fp = computeFingerprint(body);
        if (fp.fingerprint) {
          m.astFingerprint = fp.fingerprint;
          m.astFingerprintNodes = fp.nodes;
        }
      }
    }
  }

  // 5b-0a. Go 同包跨文件方法合并：goOrphanMethods（接收者类型声明在同目录其他文件——Go 允许同包跨文件定义方法）
  {
    const goClassByDirName = new Map(); // `${dir}#${className}` → class entity
    for (const c of classes) {
      if (c.language !== 'go') continue;
      goClassByDirName.set(`${dirOf(c.filePath)}#${c.name}`, c);
    }
    const mergedMethodIdUsed = new Set();
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      const fileObj = fileObjectByPath.get(relPath);
      if (!fileObj || !facts?.goOrphanMethods?.length) continue;
      const dir = dirOf(relPath);
      for (const om of facts.goOrphanMethods) {
        const cls = goClassByDirName.get(`${dir}#${om.receiverType}`);
        if (!cls) continue; // 接收者类型来自外部包或未跟踪类型：跳过
        const mid = uniqueId(`method:${relPath}#${om.receiverType}#${om.name}`, mergedMethodIdUsed);
        methods.push({
          id: mid, name: om.name,
          ownerKind: 'class', ownerId: cls.id, ownerName: cls.name,
          fileId: fileObj.id, filePath: relPath,
          line: om.line,
          isStatic: false, isAsync: false, isOverride: false, exported: /^[A-Z]/.test(om.name),
          signature: om.signature,
          overridesId: null, overriddenByIds: [],
          callIds: [], calledByIds: [], compCallIds: [],
          // Go 跨文件方法：health 不可用，placeholder
          health: { available: false, reason: 'go-cross-file', complexity: {}, lambdas: {}, testInfo: { isTest: false }, risk: 'unknown' },
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        });
        cls.methodIds.push(mid);
      }
    }
  }

  // 跨文件类型引用解析：本文件声明优先；其次具名 import（含 type-only，按 local 名匹配、imported 名定位目标文件导出）
  // Rust 文件：use crate::a::b::Name 路径解析为主，全仓库导出名唯一匹配兜底（crate 内 pub 名唯一性强）
  const exportedTypeIndex = new Map(); // `relPath#name` -> id（仅导出实体）
  for (const i of interfaces) if (i.exported) exportedTypeIndex.set(`${i.filePath}#${i.name}`, i.id);
  for (const c of classes) if (c.exported) exportedTypeIndex.set(`${c.filePath}#${c.name}`, c.id);
  const exportedIdsByName = new Map(); // name -> [id]（全仓库重名检测，Rust 唯一名兜底用）
  for (const e of [...interfaces, ...classes]) {
    if (!e.exported) continue;
    const arr = exportedIdsByName.get(e.name);
    if (arr) arr.push(e.id);
    else exportedIdsByName.set(e.name, [e.id]);
  }
  const resolveTypeRef = (relPath, name) => {
    const facts = factsMap.get(relPath);
    if (!facts) return null;
    const local = localTypesByFile.get(relPath)?.get(name);
    if (local) return local;
    if (relPath.endsWith('.rs')) {
      // use 路径解析：crate::a::b::Name → 目标文件 → exportedTypeIndex
      const usePath = facts.importMap.get(name);
      if (usePath) {
        const r = resolveRustUse(relPath, usePath, rustFiles);
        if (r.kind === 'internal') {
          const id = exportedTypeIndex.get(`${r.file}#${r.importedName}`);
          if (id) return id;
        }
      }
      // 全仓库唯一导出名兜底
      const ids = exportedIdsByName.get(name);
      if (ids && ids.length === 1) return ids[0];
      return null;
    }
    for (const imp of facts.imports) {
      const n = (imp.names ?? []).find((x) => x.local === name && x.imported && x.imported !== '*');
      if (!n) continue;
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind !== 'internal') continue;
      const id = exportedTypeIndex.get(`${r.file}#${n.imported}`);
      if (id) return id;
    }
    return null;
  };
  for (const iface of interfaces) {
    iface.extendsIds = (iface.extendsNames ?? []).map((n) => resolveTypeRef(iface.filePath, n)).filter(Boolean);
  }
  for (const cls of classes) {
    cls.implementsIds = (cls.implementsNames ?? []).map((n) => resolveTypeRef(cls.filePath, n)).filter(Boolean);
    if (cls.extendsName) cls.extendsId = resolveTypeRef(cls.filePath, cls.extendsName);
  }

  // 方法级 overrides：实现类方法与其实现接口/父类中的同名方法建立双向链接
  linkMethodOverrides(interfaces, classes, methods);
  report('resolve:done', {
    interfaceCount: interfaces.length,
    classCount: classes.length,
    methodCount: methods.length,
  });

  Object.assign(ctx, {
    components, compIdByName, compStoreCallsById, hooks, stores, services, componentsByFile,
    interfaces, classes, traits, methods, typeSpanById, refsOutsideSpan,
  });
}
