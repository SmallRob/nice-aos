// 后端服务模型构建器：asdm-aos 本体快照（snapshot.json）→ ServiceModel
// 单遍聚合：以 Map 按 id 索引包/类，避免 O(n²) 查找；产出模块/分层/API/数据层/依赖/质量/统计
// 模块规则解析：--module-prefix（CLI）> 模块配置文件（service-modules.json）> 从快照包结构动态推导

import fs from 'node:fs';
import path from 'node:path';
import {
  SERVICE_MODEL_META, deriveModuleRules, compileModuleRules, detectModule, detectLayer,
  detectTechCategory, extractDomainPrefix, COMPLEXITY_HOTSPOT_CC, TECH_STACK_RULES,
} from './serviceModel.js';
import { getServiceModuleConfigPath } from './serviceSnapshot.js';

const ENDPOINT_CAP = 2000;
const FK_CHAIN_CAP = 50;
const HOTSPOT_CAP = 50;
const TEST_CLASS_CAP = 20;
const LAYER_CLASS_ID_CAP = 200;

// 读取 asdm-aos 本体快照 JSON（带友好错误提示）
export function loadAosSnapshot(snapshotPath) {
  if (!snapshotPath) {
    const err = new Error('未指定 asdm-aos 快照路径');
    err.code = 'NO_SNAPSHOT_PATH';
    throw err;
  }
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`asdm-aos 快照不存在: ${snapshotPath}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf-8');
  } catch (err) {
    throw new Error(`无法读取 asdm-aos 快照: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`asdm-aos 快照不是合法 JSON（${snapshotPath}）: ${err.message}`);
  }
}

// 从 asdm-aos 本体快照构建后端服务模型
export function buildServiceModel(snapshotObj, opts = {}) {
  const startedAt = Date.now();
  const repos = snapshotObj.Repository || [];
  const packages = snapshotObj.Package || [];
  const classes = snapshotObj.Class || [];
  const interfaces = snapshotObj.Interface || [];
  const methods = snapshotObj.Method || [];
  const dependencies = snapshotObj.Dependency || [];
  const tablesRaw = snapshotObj.Table || [];
  const mappersRaw = snapshotObj.Mapper || [];

  // ---- 模块规则解析：显式编译规则 > --module-prefix > 动态推导 ----
  let compiledRules;
  let modulePrefixSource;
  if (opts.moduleRules && opts.moduleRules.length) {
    compiledRules = opts.moduleRules;
    modulePrefixSource = opts.modulePrefixSource || 'custom';
  } else if (opts.modulePrefixes && opts.modulePrefixes.length) {
    compiledRules = compileModuleRules(opts.modulePrefixes);
    modulePrefixSource = 'cli';
  } else {
    const pkgNames = packages.map((p) => p.name || p.fullPath || '').filter(Boolean);
    compiledRules = compileModuleRules(deriveModuleRules(pkgNames, opts.deriveOptions));
    modulePrefixSource = 'derived';
  }

  // ---- 索引：包 / 类 ----
  const packageById = new Map();
  const moduleInfoByKey = new Map(); // key -> { key, label, prefix, packageCount }
  for (const pkg of packages) {
    const pkgPath = pkg.name || pkg.fullPath || '';
    const mod = detectModule(pkgPath, compiledRules);
    pkg._module = mod;
    packageById.set(pkg.id, pkg);
    if (!moduleInfoByKey.has(mod.key)) {
      moduleInfoByKey.set(mod.key, { key: mod.key, label: mod.label, prefix: mod.prefix, packageCount: 0 });
    }
    moduleInfoByKey.get(mod.key).packageCount += 1;
  }
  // 保序：模块按包数降序，other 恒置尾
  const moduleOrder = [...moduleInfoByKey.entries()]
    .sort((a, b) => (a[0] === 'other' ? 1 : b[0] === 'other' ? -1 : b[1].packageCount - a[1].packageCount))
    .map(([key]) => key);

  const classById = new Map();
  const classSummaries = [];
  for (const cls of classes) {
    const pkg = packageById.get(cls.packageId) || {};
    const mod = pkg._module || { key: 'other', label: '其他', prefix: '' };
    const layerKey = detectLayer(cls, pkg.name || pkg.fullPath || '');
    const summary = {
      id: cls.id,
      name: cls.name,
      type: cls.type === 'enum' ? 'enum' : 'class',
      visibility: cls.visibility,
      modifiers: cls.modifiers || [],
      lineCount: cls.lineCount || 0,
      packageId: cls.packageId,
      moduleKey: mod.key,
      layerKey,
      isDataModel: Boolean(cls.isDataModel),
      dataModelType: cls.dataModelType || null,
      tableName: cls.tableName || '',
      entityName: cls.entityName || '',
      methodCount: 0,
      complexity: { maxCyclomatic: 0, totalCyclomatic: 0, avgCyclomatic: 0 },
      isController: false,
      isService: false,
      isRepository: false,
      isEntity: false,
      isConfig: false,
      isMapper: false,
    };
    for (const m of summary.modifiers) {
      if (m.startsWith('@RestController') || m.startsWith('@Controller')) summary.isController = true;
      else if (m.startsWith('@Service')) summary.isService = true;
      else if (m.startsWith('@Repository')) summary.isRepository = true;
      else if (m.startsWith('@Entity')) summary.isEntity = true;
      else if (m.startsWith('@Configuration')) summary.isConfig = true;
      else if (m.startsWith('@Mapper')) summary.isMapper = true;
    }
    classById.set(cls.id, { ...cls, _module: mod, _layerKey: layerKey });
    classSummaries.push(summary);
  }
  const classBySummaryId = new Map(classSummaries.map((c) => [c.id, c]));

  // ---- 接口 ----
  const interfaceSummaries = interfaces.map((intf) => {
    const pkg = packageById.get(intf.packageId) || {};
    const mod = pkg._module || { key: 'other', label: '其他' };
    return {
      id: intf.id,
      name: intf.name,
      visibility: intf.visibility,
      lineCount: intf.lineCount || 0,
      packageId: intf.packageId,
      moduleKey: mod.key,
      layerKey: detectLayer(intf, pkg.name || pkg.fullPath || ''),
      methodCount: (intf.methodSignatures || []).length,
      description: intf.description || '',
    };
  });

  // ---- 方法 / 端点 / 复杂度 / 测试 ----
  const methodSummaries = [];
  const endpoints = [];
  let skippedEndpointCount = 0;
  const hotspotCandidates = [];
  let totalLineCount = 0;
  let totalCyclomatic = 0;
  let methodsWithComplexity = 0;
  let testMethodCount = 0;
  let unitTestCount = 0;
  let integrationTestCount = 0;
  let testSetupCount = 0;

  for (const m of methods) {
    const cls = classById.get(m.classId) || {};
    const summary = classBySummaryId.get(m.classId);
    const cplx = m.complexity || {};
    const cc = Number(cplx.cyclomaticComplexity) || 1;
    const method = {
      id: m.id,
      name: m.name,
      returnType: m.returnType,
      visibility: m.visibility,
      lineCount: m.lineCount || 0,
      classId: m.classId,
      moduleKey: cls._module?.key || 'other',
      layerKey: cls._layerKey || 'other',
      complexity: {
        cyclomaticComplexity: cc,
        maxNestingDepth: Number(cplx.maxNestingDepth) || 0,
        branchCount: Number(cplx.branchCount) || 0,
        loopCount: Number(cplx.loopCount) || 0,
        exceptionHandlerCount: Number(cplx.exceptionHandlerCount) || 0,
        earlyReturnCount: Number(cplx.earlyReturnCount) || 0,
      },
      isTest: Boolean(m.isTest),
      testType: m.testType || null,
      isTestSetup: Boolean(m.isTestSetup),
      endpointInfo: m.endpointInfo || null,
    };
    methodSummaries.push(method);

    if (summary) {
      summary.methodCount += 1;
      summary.complexity.totalCyclomatic += cc;
      summary.complexity.maxCyclomatic = Math.max(summary.complexity.maxCyclomatic, cc);
    }

    totalLineCount += method.lineCount;
    if (cplx.cyclomaticComplexity != null) {
      totalCyclomatic += cc;
      methodsWithComplexity += 1;
    }
    if (cc >= COMPLEXITY_HOTSPOT_CC) {
      hotspotCandidates.push({
        id: m.id,
        className: cls.name || '',
        methodName: m.name,
        methodId: m.id,
        cyclomaticComplexity: cc,
        maxNestingDepth: method.complexity.maxNestingDepth,
        branchCount: method.complexity.branchCount,
        loopCount: method.complexity.loopCount,
        location: `${cls.name || ''}#${m.name}`,
        moduleKey: method.moduleKey,
      });
    }
    if (method.isTest) {
      testMethodCount += 1;
      if (method.testType === 'IntegrationTest') integrationTestCount += 1;
      else if (method.testType === 'UnitTest') unitTestCount += 1;
    }
    if (method.isTestSetup) testSetupCount += 1;

    // API 端点（含空 path：类级 @RequestMapping 的基路径映射，path 为空串）
    if (m.endpointInfo) {
      const httpMethod = String(m.endpointInfo.httpMethod || '').toUpperCase();
      const pathValue = m.endpointInfo.path || '';
      if (endpoints.length < ENDPOINT_CAP) {
        endpoints.push({
          id: `ep:${httpMethod}:${pathValue}:${m.id}`,
          httpMethod,
          path: pathValue,
          framework: m.endpointInfo.framework || '',
          methodId: m.id,
          classId: m.classId,
          className: cls.name || '',
          moduleKey: method.moduleKey,
          layerKey: method.layerKey,
          domainPrefix: extractDomainPrefix(pathValue),
          hasPathVariables: pathValue.includes('{'),
        });
      } else {
        skippedEndpointCount += 1;
      }
    }
  }

  // 类级复杂度归一
  for (const s of classSummaries) {
    if (s.methodCount > 0) s.complexity.avgCyclomatic = Math.round((s.complexity.totalCyclomatic / s.methodCount) * 10) / 10;
  }

  // ---- 模块聚合 ----
  const moduleCounts = new Map(moduleOrder.map((key) => [key, {
    key, label: moduleInfoByKey.get(key).label, prefix: moduleInfoByKey.get(key).prefix,
    packageCount: moduleInfoByKey.get(key).packageCount,
    classCount: 0, interfaceCount: 0, methodCount: 0, endpointCount: 0,
    layerCounts: {},
  }]));
  for (const s of classSummaries) {
    const m = moduleCounts.get(s.moduleKey);
    if (m) {
      m.classCount += 1;
      m.layerCounts[s.layerKey] = (m.layerCounts[s.layerKey] || 0) + 1;
    }
  }
  for (const i of interfaceSummaries) {
    const m = moduleCounts.get(i.moduleKey);
    if (m) m.interfaceCount += 1;
  }
  for (const mth of methodSummaries) {
    const m = moduleCounts.get(mth.moduleKey);
    if (m) m.methodCount += 1;
  }
  for (const ep of endpoints) {
    const m = moduleCounts.get(ep.moduleKey);
    if (m) m.endpointCount += 1;
  }
  const modules = moduleOrder.map((key) => {
    const m = moduleCounts.get(key);
    // 职责描述：按分层占比降序取前 2
    const total = Math.max(1, m.classCount);
    const layerLabels = {
      controller: 'API 接口', service: '业务逻辑', repository: '数据访问', mapper: 'Mapper',
      entity: '实体', dto: 'DTO-VO', config: '配置', adapter: '适配与客户端', job: '任务', util: '工具', other: '其他',
    };
    const resp = Object.entries(m.layerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([lk, cnt]) => `${layerLabels[lk] || lk} ${Math.round((cnt / total) * 100)}%`)
      .join(', ');
    return {
      id: `module:${key}`,
      key,
      label: m.label,
      packagePrefix: m.prefix,
      packageCount: m.packageCount,
      classCount: m.classCount,
      interfaceCount: m.interfaceCount,
      methodCount: m.methodCount,
      endpointCount: m.endpointCount,
      responsibility: resp,
    };
  });

  // ---- 分层聚合 ----
  const layerOrder = ['controller', 'service', 'repository', 'mapper', 'entity', 'dto', 'config', 'adapter', 'job', 'util', 'other'];
  const layerAgg = new Map(layerOrder.map((key) => [key, { classCount: 0, interfaceCount: 0, methodCount: 0, endpointCount: 0, packages: new Set(), classIds: [] }]));
  for (const s of classSummaries) {
    const l = layerAgg.get(s.layerKey);
    if (!l) continue;
    l.classCount += 1;
    if (l.classIds.length < LAYER_CLASS_ID_CAP) l.classIds.push(s.id);
    const pkg = packageById.get(s.packageId);
    if (pkg) l.packages.add(pkg.id);
  }
  for (const i of interfaceSummaries) {
    const l = layerAgg.get(i.layerKey);
    if (l) l.interfaceCount += 1;
  }
  for (const mth of methodSummaries) {
    const l = layerAgg.get(mth.layerKey);
    if (l) l.methodCount += 1;
  }
  for (const ep of endpoints) {
    const l = layerAgg.get(ep.layerKey);
    if (l) l.endpointCount += 1;
  }
  const layers = layerOrder
    .filter((key) => layerAgg.get(key).classCount > 0 || layerAgg.get(key).interfaceCount > 0)
    .map((key) => {
      const l = layerAgg.get(key);
      return {
        id: `layer:${key}`,
        key,
        label: { controller: '接口层', service: '业务层', repository: '数据访问', mapper: 'Mapper', entity: '实体', dto: 'DTO-VO', config: '配置', adapter: '适配与客户端', job: '任务', util: '工具', other: '其他' }[key],
        packageCount: l.packages.size,
        classCount: l.classCount,
        interfaceCount: l.interfaceCount,
        methodCount: l.methodCount,
        endpointCount: l.endpointCount,
        classIds: l.classIds,
      };
    });

  // ---- 图谱数据：模块依赖图 / 分层调用流 ----
  const moduleGraph = (() => {
    // 模块依赖边：包级 dependsOnPackageIds（dep）+ 跨模块方法调用（call）聚合到模块级；
    // 排除 other 模块（catch-all 噪声枢纽）与自环
    const moduleEdgeMap = new Map();
    const addModuleEdge = (srcKey, dstKey, kind) => {
      if (!srcKey || !dstKey || srcKey === dstKey || srcKey === 'other' || dstKey === 'other') return;
      const key = kind + '|' + srcKey + '>' + dstKey;
      const e = moduleEdgeMap.get(key) ?? { source: `module:${srcKey}`, target: `module:${dstKey}`, kind, weight: 0 };
      e.weight += 1;
      moduleEdgeMap.set(key, e);
    };
    for (const pkg of packages) {
      const srcKey = pkg._module?.key;
      if (!srcKey) continue;
      for (const depPkgId of pkg.dependsOnPackageIds || []) {
        addModuleEdge(srcKey, packageById.get(depPkgId)?._module?.key, 'dep');
      }
    }
    const methodModuleById = new Map();
    for (const m of methods) {
      const cls = classById.get(m.classId);
      methodModuleById.set(m.id, cls?._module?.key || 'other');
    }
    for (const m of methods) {
      if (m.isTest) continue;
      const srcMod = methodModuleById.get(m.id);
      for (const callId of m.callsMethodIds || []) {
        if (String(callId).startsWith('ext:')) continue;
        addModuleEdge(srcMod, methodModuleById.get(callId), 'call');
      }
    }
    const moduleNodes = modules.filter((m) => m.key !== 'other').map((m) => ({
      id: m.id, key: m.key, name: m.label, classCount: m.classCount,
      endpointCount: m.endpointCount, packageCount: m.packageCount,
    }));
    const moduleView = moduleNodes.length
      ? {
          nodes: moduleNodes,
          edges: [...moduleEdgeMap.values()].sort((a, b) => b.weight - a.weight),
        }
      : null;
    if (moduleView) {
      moduleView.nodeCount = moduleView.nodes.length;
      moduleView.edgeCount = moduleView.edges.length;
    }

    // 分层调用流：非测试方法的内部方法调用 → 跨层聚合（排除自环与外部 ext: 调用）
    const methodLayerById = new Map();
    for (const m of methods) {
      const cls = classById.get(m.classId);
      methodLayerById.set(m.id, cls?._layerKey || 'other');
    }
    const layerEdgeMap = new Map();
    for (const m of methods) {
      if (m.isTest) continue;
      const srcLayer = methodLayerById.get(m.id);
      for (const callId of m.callsMethodIds || []) {
        if (String(callId).startsWith('ext:')) continue;
        const dstLayer = methodLayerById.get(callId);
        if (!dstLayer || dstLayer === srcLayer) continue;
        const key = srcLayer + '>' + dstLayer;
        const e = layerEdgeMap.get(key) ?? { source: `layer:${srcLayer}`, target: `layer:${dstLayer}`, weight: 0 };
        e.weight += 1;
        layerEdgeMap.set(key, e);
      }
    }
    const layerView = {
      nodes: layers.map((l) => ({
        id: l.id, key: l.key, name: l.label, classCount: l.classCount,
        methodCount: l.methodCount, endpointCount: l.endpointCount,
      })),
      edges: [...layerEdgeMap.values()].sort((a, b) => b.weight - a.weight),
    };
    layerView.nodeCount = layerView.nodes.length;
    layerView.edgeCount = layerView.edges.length;

    // 模块 × 技术栈：包级 dependencyIds → 技术栈分类，聚合到模块（二分图）
    const depIdToCategory = new Map();
    const techNodeInfo = new Map(); // key -> { key, label, count }
    for (const d of dependencies) {
      const cat = detectTechCategory(d.name);
      if (cat.key === 'other') continue;
      depIdToCategory.set(d.id, cat.key);
      const cur = techNodeInfo.get(cat.key) || { key: cat.key, label: cat.label, count: 0 };
      cur.count += 1;
      techNodeInfo.set(cat.key, cur);
    }
    const techEdgeMap = new Map();
    for (const pkg of packages) {
      const srcKey = pkg._module?.key;
      if (!srcKey || srcKey === 'other') continue;
      for (const depId of pkg.dependencyIds || []) {
        const catKey = depIdToCategory.get(depId);
        if (!catKey) continue;
        const key = srcKey + '>' + catKey;
        const e = techEdgeMap.get(key) ?? { source: `module:${srcKey}`, target: `tech:${catKey}`, weight: 0 };
        e.weight += 1;
        techEdgeMap.set(key, e);
      }
    }
    const techView = {
      nodes: [
        ...moduleNodes,
        ...[...techNodeInfo.values()].map((t) => ({
          id: `tech:${t.key}`, key: t.key, name: t.label, classCount: t.count, count: t.count,
        })),
      ],
      edges: [...techEdgeMap.values()].sort((a, b) => b.weight - a.weight),
    };
    techView.nodeCount = techView.nodes.length;
    techView.edgeCount = techView.edges.length;

    return { moduleView, layerView, techView };
  })();

  // ---- 数据层：表 / 外键 / FK 链 / 孤儿表 ----
  const tables = [];
  const seenTables = new Set();
  let tableDedupedCount = 0;
  for (const t of tablesRaw) {
    if (seenTables.has(t.name)) { tableDedupedCount += 1; continue; }
    seenTables.add(t.name);
    const fkCount = (t.fkDetails || []).length;
    const matchedEntityClass = t.matchedEntityClass || '';
    const isOrphan = !matchedEntityClass && fkCount === 0;
    tables.push({
      id: t.id,
      name: t.name,
      schema: t.schema,
      comment: t.comment || '',
      engine: t.engine || '',
      charset: t.charset || '',
      primaryKey: t.primaryKey || '',
      columnCount: (t.columns || []).length,
      fkCount,
      matchedEntityClass,
      isOrphan,
      orphanReason: isOrphan ? 'no_entity_no_fk' : null,
    });
  }

  const foreignKeys = [];
  const fkTableNames = new Set();
  for (const t of tablesRaw) {
    if (fkTableNames.has(t.name)) continue; // 同名多视图表只取首个
    fkTableNames.add(t.name);
    for (const fk of t.fkDetails || []) {
      foreignKeys.push({
        id: `fk:${t.name}.${fk.columnName}`,
        tableName: t.name,
        columnName: fk.columnName,
        refTable: fk.refTable,
        refColumn: fk.refColumn,
        fkName: fk.fkName || '',
      });
    }
  }

  // FK 链：从每张表沿 refTable 向后追踪，depth >= 2 记为链。
  // 每表只沿首条外键（展示用"主链"启发式）：全组合 BFS 在宽外键表上会组合爆炸
  const fkChains = [];
  const tableByName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables) {
    const chain = [t.name];
    let current = t.name;
    const guard = new Set([current]);
    let hops = 0;
    while (hops < 10) {
      const next = foreignKeys.find((fk) => fk.tableName === current)?.refTable;
      if (!next || next === current || guard.has(next)) break;
      guard.add(next);
      chain.push(next);
      current = next;
      hops += 1;
    }
    if (chain.length >= 2 && fkChains.length < FK_CHAIN_CAP) {
      fkChains.push({ startTable: t.name, chain, depth: chain.length });
    }
  }

  // ---- 依赖 / 技术栈 ----
  const depSummaries = dependencies.map((d) => {
    const cat = detectTechCategory(d.name);
    return {
      id: d.id,
      name: d.name,
      version: d.version || '',
      scope: d.scope || '',
      source: d.source || '',
      category: cat.key,
      label: cat.label,
    };
  });
  const techStack = [];
  for (const rule of TECH_STACK_RULES) {
    const matched = depSummaries.filter((d) => d.category === rule.key);
    if (matched.length === 0) continue;
    techStack.push({
      key: rule.key,
      label: rule.label,
      detected: true,
      count: matched.length,
      dependencyIds: matched.map((d) => d.id),
    });
  }
  const otherDeps = depSummaries.filter((d) => d.category === 'other');
  if (otherDeps.length > 0) {
    techStack.push({ key: 'other', label: '其他', detected: true, count: otherDeps.length, dependencyIds: otherDeps.map((d) => d.id) });
  }

  // ---- Mapper ----
  const mapperSummaries = mappersRaw.map((m) => ({
    id: m.id,
    name: m.name || '',
    namespace: m.namespace || '',
    mappedTable: m.mappedTable || '',
    mappedEntityClass: m.mappedEntityClass || '',
    resultMapId: m.resultMapId || '',
    sourceFile: m.sourceFile || '',
  }));

  // ---- 数据模型 ----
  const dataModels = classSummaries
    .filter((c) => c.isDataModel)
    .map((c) => ({
      id: c.id,
      className: c.name,
      dataModelType: c.dataModelType,
      tableName: c.tableName,
      entityName: c.entityName,
      layerKey: c.layerKey,
      moduleKey: c.moduleKey,
    }));

  // ---- 复杂度热点 ----
  hotspotCandidates.sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);
  const complexityHotspots = hotspotCandidates.slice(0, HOTSPOT_CAP);

  // ---- 测试统计 ----
  const testByClass = new Map();
  for (const mth of methodSummaries) {
    if (!mth.isTest && !mth.isTestSetup) continue;
    const summary = classBySummaryId.get(mth.classId);
    const key = summary?.name || mth.classId || 'unknown';
    if (!testByClass.has(key)) testByClass.set(key, { className: key, methodCount: 0, unitTest: 0, integrationTest: 0 });
    const entry = testByClass.get(key);
    entry.methodCount += 1;
    if (mth.isTest) {
      if (mth.testType === 'IntegrationTest') entry.integrationTest += 1;
      else if (mth.testType === 'UnitTest') entry.unitTest += 1;
    }
  }
  const testStats = {
    total: testMethodCount,
    unitTest: unitTestCount,
    integrationTest: integrationTestCount,
    testSetup: testSetupCount,
    testClassCount: testByClass.size,
    byClass: [...testByClass.values()].sort((a, b) => b.methodCount - a.methodCount).slice(0, TEST_CLASS_CAP),
  };

  // ---- 统计 ----
  const endpointByMethod = {};
  for (const ep of endpoints) endpointByMethod[ep.httpMethod] = (endpointByMethod[ep.httpMethod] || 0) + 1;
  const enumCount = classSummaries.filter((c) => c.type === 'enum').length;
  const classCount = classSummaries.filter((c) => c.type === 'class').length;
  const stats = {
    repositoryCount: repos.length,
    fileCount: repos.reduce((s, r) => s + (r.fileCount || 0), 0) || packages.length,
    packageCount: packages.length,
    classCount,
    enumCount,
    interfaceCount: interfaceSummaries.length,
    methodCount: methodSummaries.length,
    dependencyCount: depSummaries.length,
    tableCount: tables.length,
    mapperCount: mapperSummaries.length,
    endpointCount: endpoints.length + skippedEndpointCount,
    testMethodCount,
    analysisErrorCount: repos.reduce((s, r) => s + (r.analysisErrors || []).length, 0),
    totalLineCount,
    avgCyclomatic: methodsWithComplexity > 0 ? Math.round((totalCyclomatic / methodsWithComplexity) * 10) / 10 : 0,
    endpointByMethod,
    layerCount: layers.length,
    moduleCount: modules.length,
  };

  const repo = repos[0] || {};
  return {
    repositories: repos.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      language: r.language,
      commitHash: r.commitHash,
      branch: r.branch,
      fileCount: r.fileCount,
      // 与 stats.classCount 同口径：不含枚举
      classCount: classSummaries.filter((c) => c.type === 'class' && packageById.get(c.packageId)?._module && packageById.get(c.packageId).repoId === r.id).length,
      analysisErrorCount: (r.analysisErrors || []).length,
    })),
    modules,
    layers,
    moduleGraph,
    classes: classSummaries,
    interfaces: interfaceSummaries,
    methods: methodSummaries,
    endpoints,
    tables,
    foreignKeys,
    fkChains,
    dependencies: depSummaries,
    mappers: mapperSummaries,
    techStack,
    dataModels,
    complexityHotspots,
    testStats,
    stats,
    _meta: {
      ...SERVICE_MODEL_META,
      scannedAt: new Date().toISOString(),
      snapshotPath: null,
      repositoryName: repo.name || '',
      durationMs: Date.now() - startedAt,
      modulePrefixSource,
      totalLineCount,
      skippedEndpointCount,
      tableDedupedCount,
      ...(repo.language && repo.language !== 'Java' ? { warn: `repository language is not Java: ${repo.language}` } : {}),
    },
  };
}

// 读取模块配置文件 → 规则数组
export function loadModuleConfig(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`模块配置文件不是合法 JSON（${filePath}）: ${err.message}`);
  }
  if (!Array.isArray(raw.rules)) {
    throw new Error(`模块配置文件缺少 rules 数组（${filePath}）`);
  }
  return raw;
}

// 写入模块配置文件（动态推导结果落盘，供后续构建加载与人工定制）
export function saveModuleConfig(filePath, rules, extra = {}) {
  const payload = {
    version: '1.0',
    description: '后端服务模块规则：由 asdm-aos 快照包结构动态推导，可人工编辑 label/prefixes 后由 service 命令加载',
    derivedAt: new Date().toISOString(),
    ...extra,
    rules,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

// 解析模块规则：--module-prefix > 模块配置文件 > 动态推导（推导结果写入配置文件）
// 返回 { compiledRules, source, configFile, warning }；warning 在配置文件属其他仓库（跨项目残留）时非空
function resolveModuleConfig(snapshotObj, opts = {}) {
  // 1) CLI 显式规则优先
  if (opts.modulePrefixes && opts.modulePrefixes.length) {
    return { compiledRules: compileModuleRules(opts.modulePrefixes), source: 'cli', configFile: null, warning: null };
  }
  // 2) 模块配置文件（默认 <serviceSnapshotDir>/service-modules.json，可用 --module-config 覆盖）；
  //    配置记录的 repositoryName 与快照不符时视为其他项目的残留，忽略并重新推导，避免旧前缀静默错配新仓库
  const configPath = opts.moduleConfigPath || getServiceModuleConfigPath();
  const existing = configPath ? loadModuleConfig(configPath) : null;
  let staleWarning = null;
  if (existing && Array.isArray(existing.rules) && existing.rules.length > 0) {
    const configRepo = existing.repositoryName || '';
    const snapshotRepo = snapshotObj.Repository?.[0]?.name || '';
    if (configRepo && snapshotRepo && configRepo !== snapshotRepo) {
      staleWarning = `模块配置文件属仓库 ${configRepo}，与快照仓库 ${snapshotRepo} 不符，已忽略并重新推导（${configPath}）`;
    } else {
      return { compiledRules: compileModuleRules(existing.rules), source: 'config', configFile: configPath, warning: null };
    }
  }
  // 3) 动态推导并落盘
  const pkgNames = (snapshotObj.Package || []).map((p) => p.name || p.fullPath || '').filter(Boolean);
  const derived = deriveModuleRules(pkgNames, opts.deriveOptions);
  let configFile = null;
  if (configPath && derived.length > 0) {
    try {
      configFile = saveModuleConfig(configPath, derived, { repositoryName: snapshotObj.Repository?.[0]?.name || '' });
    } catch {
      configFile = null; // 配置目录不可写时不阻断构建
    }
  }
  return { compiledRules: compileModuleRules(derived), source: 'derived', configFile, warning: staleWarning };
}

// 从文件路径构建服务模型（自动解析模块规则并加载/写入模块配置文件）
export function buildServiceModelFromFile(snapshotPath, opts = {}) {
  const snapshot = loadAosSnapshot(snapshotPath);
  const { compiledRules, source, configFile, warning } = resolveModuleConfig(snapshot, opts);
  const model = buildServiceModel(snapshot, {
    ...opts,
    moduleRules: compiledRules,
    modulePrefixSource: source,
  });
  model._meta.snapshotPath = snapshotPath;
  model._meta.moduleConfigFile = configFile || null;
  if (warning) model._meta.moduleConfigWarning = warning;
  return model;
}
