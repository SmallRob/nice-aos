// 类型实体收集（Interface/Class/Trait/Method）与方法级 overrides 链接。
// 原为 builder.js 的内部函数（collectTypeEntities / linkMethodOverrides），
// 单文件分析（buildSingleFileOntology）与全仓库扫描共用（纯函数迁移，逻辑不变）。

import { uniqueId } from './builderUtils.js';

// 类型实体收集（Interface/Class/Method）：单文件分析（buildSingleFileOntology）与全仓库扫描共用
// 引用计数：名字在本文件出现、且位于实体声明范围之外的位置数（排除声明自身与自递归，宁可漏报不误报）
export function collectTypeEntities(relPaths, factsMap, fileObjectByPath) {
  const interfaces = [];
  const classes = [];
  const traits = [];
  const methods = [];
  const ifaceIdUsed = new Set();
  const classIdUsed = new Set();
  const traitIdUsed = new Set();
  const methodIdUsed = new Set();
  const localTypesByFile = new Map(); // relPath -> Map(name -> id)，本文件全部类型（含未导出）
  const typeSpanById = new Map();     // id -> {pos, end}，声明范围（用于引用计数，不进快照）
  const refsOutsideSpan = (relPath, name, start, end) => {
    const positions = factsMap.get(relPath)?.nameReferences?.get(name) ?? [];
    return positions.filter((p) => p < start || p >= end).length;
  };
  const registerLocalType = (relPath, name, id) => {
    if (!localTypesByFile.has(relPath)) localTypesByFile.set(relPath, new Map());
    localTypesByFile.get(relPath).set(name, id);
  };

  for (const relPath of relPaths) {
    const facts = factsMap.get(relPath);
    const fileObj = fileObjectByPath.get(relPath);
    if (!fileObj) continue;

    for (const iface of facts.interfaces ?? []) {
      const id = uniqueId(`iface:${relPath}#${iface.name}`, ifaceIdUsed);
      registerLocalType(relPath, iface.name, id);
      typeSpanById.set(id, { pos: iface.pos, end: iface.end });
      const entity = {
        id, name: iface.name,
        fileId: fileObj.id, filePath: relPath,
        line: iface.line,
        exported: iface.exported,
        language: iface.language ?? 'ts',
        methodIds: [],
        extendsIds: [],
        extendsNames: iface.extendsNames,
        // 数据模型标识（借鉴 asdm-aos Class.isDataModel/dataModelType，适配前端启发式）
        isDataModel: !!iface.isDataModel,
        dataModelType: iface.dataModelType ?? null,
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const m of iface.methods) {
        const mid = uniqueId(`method:${relPath}#${iface.name}#${m.name}`, methodIdUsed);
        methods.push({
          id: mid, name: m.name,
          ownerKind: 'interface', ownerId: id, ownerName: iface.name,
          fileId: fileObj.id, filePath: relPath,
          line: m.line,
          isStatic: false, isAsync: false, isOverride: false, exported: false,
          signature: m.signature,
          overridesId: null, overriddenByIds: [],
          // 接口方法无 body，health 已是 placeholder；其他来源兜底
          health: m.health ?? { available: false, reason: 'no-body', complexity: {}, lambdas: {}, testInfo: { isTest: false }, risk: 'unknown' },
          deadCandidate: false, deadReason: null, // 接口方法为契约声明，永不判死
          reviewed: false, notes: null,
        });
        entity.methodIds.push(mid);
      }
      // 非导出接口：本文件内零引用 → 死代码候选（导出实体的全仓库零导入检测在调用方统一做）
      if (!iface.exported && refsOutsideSpan(relPath, iface.name, iface.pos, iface.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      interfaces.push(entity);
    }

    for (const cls of facts.classes ?? []) {
      const id = uniqueId(`class:${relPath}#${cls.name}`, classIdUsed);
      registerLocalType(relPath, cls.name, id);
      typeSpanById.set(id, { pos: cls.pos, end: cls.end });
      const entity = {
        id, name: cls.name,
        fileId: fileObj.id, filePath: relPath,
        line: cls.line,
        exported: cls.exported,
        language: cls.language ?? 'ts',
        kind: cls.kind ?? 'class',
        derives: cls.derives ?? [],
        fields: cls.fields ?? [],
        variants: cls.variants ?? [],
        isSingleton: cls.isSingleton,
        isWidget: cls.isWidget ?? false,
        widgetBase: cls.widgetBase ?? null,
        isStore: cls.isStore ?? false,
        withNames: cls.withNames ?? [],
        // Python 专有扩展（SQLAlchemy / ORM 信号 + 多基类）
        tableName: cls.tableName ?? null,
        tableArgs: cls.tableArgs ?? null,
        ormHints: cls.ormHints ?? [],
        bases: cls.bases ?? [],
        metaclassName: cls.metaclassName ?? null,
        methodIds: [],
        implementsIds: [],
        implementsNames: cls.implementsNames,
        extendsId: null, extendsName: cls.extendsName,
        // 数据模型标识（借鉴 asdm-aos Class.isDataModel/dataModelType）
        isDataModel: !!cls.isDataModel,
        dataModelType: cls.dataModelType ?? null,
        // 控制器标识（PHP control / zentaopms 惯例）
        isController: !!cls.isController,
        // PHP trait use（class 体内 `use Trait1, Trait2;`；usesTraitIds 在 linkTraitUses 阶段回填）
        usesTraitIds: [],
        usesTraits: cls.usesTraits ?? [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const m of cls.methods) {
        const mid = uniqueId(`method:${relPath}#${cls.name}#${m.name}`, methodIdUsed);
        const methodEntity = {
          id: mid, name: m.name,
          ownerKind: 'class', ownerId: id, ownerName: cls.name,
          fileId: fileObj.id, filePath: relPath,
          line: m.line,
          isStatic: m.isStatic, isAsync: m.isAsync, isOverride: m.isOverride, exported: false,
          signature: m.signature,
          // AST 位置（v0.32.0 用于挂 fingerprint + 后续 IDE 跳转）
          pos: m.pos ?? null, end: m.end ?? null,
          // SQL 表名提取（PHP DAO 链；TS 侧为空数组契约）
          sqlQueries: m.sqlQueries ?? [],
          overridesId: null, overriddenByIds: [],
          // 方法级健康度（从 tsAnalyzer 传入；非 ts 来源兜底为 placeholder）
          health: m.health ?? { available: false, reason: 'non-ts', complexity: {}, lambdas: {}, testInfo: { isTest: false }, risk: 'unknown' },
          // 外部调用（从 tsAnalyzer 传入）
          externalCalls: m.externalCalls ?? [],
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        };
        // 非导出类的方法可能仅被本文件调用：本文件内零引用才判死（导出类方法可能被外部调用，不判死）
        if (!cls.exported && refsOutsideSpan(relPath, m.name, m.pos, m.end) === 0) {
          methodEntity.deadCandidate = true;
          methodEntity.deadReason = '本文件内零引用';
        }
        methods.push(methodEntity);
        entity.methodIds.push(mid);
      }
      if (!cls.exported && refsOutsideSpan(relPath, cls.name, cls.pos, cls.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      classes.push(entity);
    }

    // PHP trait：方法复用单元（usesTrait/usedByTrait 双向链接的 trait: 端）
    for (const tr of facts.traits ?? []) {
      const id = uniqueId(`trait:${relPath}#${tr.name}`, traitIdUsed);
      registerLocalType(relPath, tr.name, id);
      typeSpanById.set(id, { pos: tr.pos, end: tr.end });
      const entity = {
        id, name: tr.name,
        fileId: fileObj.id, filePath: relPath,
        line: tr.line,
        exported: true,
        language: tr.language ?? 'php',
        methodIds: [],
        usedByIds: [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const m of tr.methods) {
        const mid = uniqueId(`method:${relPath}#${tr.name}#${m.name}`, methodIdUsed);
        methods.push({
          id: mid, name: m.name,
          ownerKind: 'trait', ownerId: id, ownerName: tr.name,
          fileId: fileObj.id, filePath: relPath,
          line: m.line,
          isStatic: m.isStatic ?? false, isAsync: false, isOverride: false, exported: false,
          signature: m.signature,
          sqlQueries: m.sqlQueries ?? [],
          overridesId: null, overriddenByIds: [],
          health: m.health ?? { available: false, reason: 'non-ts', complexity: {}, lambdas: {}, testInfo: { isTest: false }, risk: 'unknown' },
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        });
        entity.methodIds.push(mid);
      }
      traits.push(entity);
    }

    for (const fn of facts.moduleFunctions ?? []) {
      const id = uniqueId(`method:${relPath}#${fn.name}`, methodIdUsed);
      typeSpanById.set(id, { pos: fn.pos, end: fn.end });
      const entity = {
        id, name: fn.name,
        ownerKind: 'module', ownerId: fileObj.id, ownerName: null,
        fileId: fileObj.id, filePath: relPath,
        line: fn.line,
        isStatic: false, isAsync: fn.isAsync, isOverride: false,
        exported: fn.exported,
        signature: fn.signature,
        // AST 位置（v0.32.0 用于挂 fingerprint + 后续 IDE 跳转）
        pos: fn.pos ?? null, end: fn.end ?? null,
        overridesId: null, overriddenByIds: [],
        // 模块级函数健康度（从 tsAnalyzer 传入；非 ts 来源兜底为 placeholder）
        health: fn.health ?? { available: false, reason: 'non-ts', complexity: {}, lambdas: {}, testInfo: { isTest: false }, risk: 'unknown' },
        // API 端点信息（借鉴 asdm-aos Method.endpointInfo,适配 Next.js App Router / Nuxt 3）
        endpointInfo: fn.endpointInfo ?? null,
        // SQL 表名提取（借鉴 asdm-aos mapperMapsTable,用于 mapsToTable 链接）
        sqlQueries: fn.sqlQueries ?? [],
        // 外部调用识别（借鉴 asdm-aos ext: 虚拟对象,React hooks / DOM / 状态管理 API）
        externalCalls: fn.externalCalls ?? [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      // 非导出函数：本文件零引用即死；导出函数的判定在调用方全仓库零导入检测统一做
      if (!fn.exported && refsOutsideSpan(relPath, fn.name, fn.pos, fn.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      methods.push(entity);
    }
  }
  return { interfaces, classes, traits, methods, localTypesByFile, typeSpanById, refsOutsideSpan };
}

// 方法级 overrides：实现类方法与其实现接口/父类中的同名方法建立双向链接
export function linkMethodOverrides(interfaces, classes, methods) {
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const ifaceById = new Map(interfaces.map((i) => [i.id, i]));
  const classById = new Map(classes.map((c) => [c.id, c]));
  const linkOverride = (implId, contractId) => {
    const impl = methodById.get(implId);
    const contract = methodById.get(contractId);
    if (!impl || !contract || impl.id === contract.id) return;
    impl.overridesId = contract.id;
    if (!contract.overriddenByIds.includes(impl.id)) contract.overriddenByIds.push(impl.id);
  };
  for (const cls of classes) {
    const parents = [
      ...cls.implementsIds.map((id) => ifaceById.get(id)),
      ...(cls.extendsId ? [classById.get(cls.extendsId)] : []),
    ].filter(Boolean);
    for (const parent of parents) {
      for (const mid of cls.methodIds) {
        const m = methodById.get(mid);
        const parentMethod = parent.methodIds
          .map((id) => methodById.get(id))
          .find((pm) => pm && pm.name === m.name);
        if (parentMethod) linkOverride(mid, parentMethod.id);
      }
    }
  }
}
