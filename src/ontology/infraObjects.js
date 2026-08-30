// v0.38.0: Shell 脚本 / CMake / PKGBUILD / Nix 对象转换
// 4 个 buildXxxObjects 共用模式：facts → (主对象 + 子对象集合 + 边集合)
// 边以 SourceFile 容器下挂 (边字段为 IDs 数组),跨类型边独立收集
// 原为 builder.js 内部函数，拆分时收敛于此（纯函数迁移，逻辑不变）。

import path from 'node:path';
import { uniqueId } from './builderUtils.js';

export function buildShellScriptObjects(relPath, facts) {
  const isPs = facts.shellLanguage === 'powershell';
  const scriptId = isPs ? `ps:${relPath}` : `sh:${relPath}`;
  const fnIdMap = new Map();
  const fnIds = [];
  const fnIdUsed = new Set();
  for (const fn of facts.functions ?? []) {
    const fnId = isPs
      ? uniqueId(`psfn:${relPath}#${fn.name}`, fnIdUsed)
      : uniqueId(`bashfn:${relPath}#${fn.name}`, fnIdUsed);
    fnIdMap.set(fn.name, fnId);
    fnIds.push(fnId);
  }
  const fnObjects = [];
  for (const fn of facts.functions ?? []) {
    fnObjects.push({
      id: fnIdMap.get(fn.name),
      name: fn.name,
      kind: isPs ? 'PsFunction' : 'BashFunction',
      startLine: fn.startLine,
      endLine: fn.endLine,
      role: fn.role ?? 'logic',
      callTargets: fn.callTargets ?? [],
      builtinCount: isPs ? (fn.cmdletCount ?? 0) : (fn.builtinCount ?? 0),
      scriptId,
      scriptName: facts.name ?? relPath,
      filePath: relPath,
      // v0.40.0 跨语言脚本匹配键
      verbNoun: fn.verbNoun ?? null,
      crossLangKey: fn.crossLangKey ?? null,
      reviewed: false, notes: null,
    });
  }
  // 边:from=fnId, to=fnId
  const callsFunction = [];
  for (const edge of facts.callEdges ?? []) {
    const fromId = fnIdMap.get(edge.from);
    if (!fromId) continue;
    for (const t of edge.to) {
      const toId = fnIdMap.get(t);
      if (!toId || toId === fromId) continue;
      callsFunction.push({ from: fromId, to: toId });
    }
  }

  // BashBuiltin / Cmdlet 聚合(整个脚本一份,记 count)
  const builtinObjects = [];
  const builtinKind = isPs ? 'Cmdlet' : 'BashBuiltin';
  const builtinPrefix = isPs ? 'cmd:' : 'bashb:';
  const builtinIdUsed = new Set();
  const builtinIds = [];
  const builtinList = facts.builtinCalls ?? facts.cmdletCalls ?? [];
  for (const b of builtinList) {
    const id = uniqueId(`${builtinPrefix}${relPath}#${b.name}`, builtinIdUsed);
    builtinIds.push(id);
    builtinObjects.push({
      id,
      name: b.name,
      kind: builtinKind,
      callCount: b.count,
      ...(b.category ? { category: b.category } : {}),
      ...(b.isNet != null ? { isNetwork: b.isNet } : {}),
      scriptId,
      filePath: relPath,
      reviewed: false, notes: null,
    });
  }
  // 边:fn → builtin (usesBuiltin)。依据 analyzer 记录的每函数实际调用名单（builtinNames/cmdletNames）,
  // 只连真实出现的命令;顶层调用（不属于任何函数）不建边,仅计入脚本级 builtin 聚合
  const builtinIdByName = new Map(builtinList.map((b, i) => [b.name, builtinIds[i]]));
  const usesBuiltin = [];
  for (const fn of facts.functions ?? []) {
    const fromId = fnIdMap.get(fn.name);
    if (!fromId) continue;
    for (const n of fn.builtinNames ?? fn.cmdletNames ?? []) {
      const toId = builtinIdByName.get(n);
      if (toId) usesBuiltin.push({ from: fromId, to: toId });
    }
  }

  // CLI 参数对象
  const cliParamObjects = [];
  for (const p of facts.cliParams ?? []) {
    const paramId = isPs
      ? uniqueId(`psparam:${relPath}#${p.name}`, new Set())
      : uniqueId(`bashparam:${relPath}#${p.name}`, new Set());
    cliParamObjects.push({
      id: paramId,
      name: p.name,
      kind: isPs ? 'PsParam' : 'BashParam',
      type: p.type ?? null,
      mandatory: p.mandatory ?? false,
      position: p.position ?? null,
      defaultValue: p.defaultValue ?? null,
      hasValue: p.hasValue ?? false,
      description: p.description ?? null,
      scriptId,
      filePath: relPath,
      reviewed: false, notes: null,
    });
  }
  // 边:fn → param (readsCliParam)。依据 analyzer 记录的每函数实际引用名单（cliParamNames，
  // Bash 按 --name 文本关联 / PS 按 $Name 引用关联），顶层 param() 声明本身不建边
  const paramIdByName = new Map(cliParamObjects.map((p) => [p.name, p.id]));
  const readsCliParam = [];
  for (const fn of facts.functions ?? []) {
    const fromId = fnIdMap.get(fn.name);
    if (!fromId) continue;
    for (const n of fn.cliParamNames ?? []) {
      const toId = paramIdByName.get(n);
      if (toId) readsCliParam.push({ from: fromId, to: toId });
    }
  }

  // 下载/校验事实(行内信息,挂在 script 上)
  const downloadFacts = (facts.downloadUrls ?? []).map((u, i) => ({
    id: isPs ? `psnet:${relPath}#${i}` : `shnet:${relPath}#${i}`,
    name: u.url,
    kind: 'url',
    scriptId,
    filePath: relPath,
    reviewed: false, notes: null,
  }));

  // 主对象
  const mainObj = {
    id: scriptId,
    name: facts.name ?? path.posix.basename(relPath),
    filePath: relPath,
    language: facts.shellLanguage,
    shebang: facts.shebang ?? null,
    description: facts.description ?? null,
    notes: facts.notes ?? null,
    examples: facts.examples ?? [],
    hasCmdletBinding: facts.hasCmdletBinding ?? false,
    hasMainEntry: facts.hasMainEntry ?? false,
    hasTopLevelDispatch: facts.hasTopLevelDispatch ?? false,
    fnCount: facts.fnCount ?? 0,
    cliParamCount: facts.cliParamCount ?? 0,
    builtinCount: facts.builtinCount ?? facts.cmdletCount ?? 0,
    risks: facts.risks ?? [],
    riskLevel: facts.riskLevel ?? 'none',
    fnIds,
    cliParamIds: cliParamObjects.map((p) => p.id),
    builtinIds,
    downloadFactIds: downloadFacts.map((d) => d.id),
    callCount: callsFunction.length,
    reviewed: false, notes: null,
  };
  return { mainObj, fnObjects, builtinObjects, cliParamObjects, downloadFacts, callsFunction, usesBuiltin, readsCliParam };
}

export function buildCMakeObjects(relPath, facts) {
  const isLists = facts.isCMakeLists;
  const moduleId = `cmm:${relPath}`;
  const moduleName = isLists ? 'CMakeLists' : path.posix.basename(relPath, '.cmake');
  // 目标
  const targetIdUsed = new Set();
  const targetIds = [];
  const targetObjects = [];
  for (const t of facts.targets ?? []) {
    const id = uniqueId(`cmt:${relPath}#${t.name}`, targetIdUsed);
    targetIds.push(id);
    targetObjects.push({ id, name: t.name, kind: t.kind, line: t.line, moduleId, filePath: relPath, reviewed: false, notes: null });
  }
  // 函数
  const fnIdUsed = new Set();
  const fnIds = [];
  const fnObjects = [];
  for (const f of facts.functions ?? []) {
    const id = uniqueId(`cmf:${relPath}#${f.name}`, fnIdUsed);
    fnIds.push(id);
    fnObjects.push({ id, name: f.name, kind: f.kind, params: f.params ?? [], line: f.line, moduleId, filePath: relPath, reviewed: false, notes: null });
  }
  // option
  const optionIdUsed = new Set();
  const optionIds = [];
  const optionObjects = [];
  for (const o of facts.options ?? []) {
    const id = uniqueId(`cmo:${relPath}#${o.name}`, optionIdUsed);
    optionIds.push(id);
    optionObjects.push({ id, name: o.name, description: o.description, default: o.default, line: o.line, moduleId, filePath: relPath, reviewed: false, notes: null });
  }
  // 边
  const subdirIncludes = (facts.subdirectories ?? []).map((s) => ({ from: moduleId, target: s.dir, line: s.line }));
  const declaresOption = optionIds.map((id) => ({ from: moduleId, to: id }));
  const addsDependency = [];
  for (const dep of facts.targetDependencies ?? []) {
    for (const d of dep.deps) addsDependency.push({ from: dep.target, to: d, line: dep.line });
  }
  const targetsInclude = [];
  for (const ti of facts.targetIncludes ?? []) {
    for (const d of ti.dirs) targetsInclude.push({ from: ti.target, to: d, line: ti.line });
  }
  // 函数间调用边（facts.callEdges 的 from/to 是函数名，换算为 CMakeFunction 对象 ID）
  const fnIdMap = new Map(fnObjects.map((f) => [f.name, f.id]));
  const callsFunction = [];
  for (const e of facts.callEdges ?? []) {
    const fromId = fnIdMap.get(e.from);
    if (!fromId) continue;
    for (const t of e.to ?? []) {
      const toId = fnIdMap.get(t);
      if (!toId || toId === fromId) continue;
      callsFunction.push({ from: fromId, to: toId });
    }
  }
  // 主对象
  const mainObj = {
    id: moduleId,
    name: moduleName,
    filePath: relPath,
    isCMakeLists: isLists,
    targetCount: facts.targetCount ?? 0,
    functionCount: facts.functionCount ?? 0,
    optionCount: facts.optionCount ?? 0,
    fetchContentCount: facts.fetchContentCount ?? 0,
    packageCount: facts.packageCount ?? 0,
    targetIds, fnIds, optionIds,
    subdirectoryDirs: (facts.subdirectories ?? []).map((s) => s.dir),
    fetchContent: facts.fetchContent ?? [],
    packages: facts.packages ?? [],
    includes: facts.includes ?? [],
    risks: facts.risks ?? [],
    riskLevel: facts.riskLevel ?? 'none',
    reviewed: false, notes: null,
  };
  return { mainObj, targetObjects, fnObjects, optionObjects, subdirIncludes, declaresOption, addsDependency, targetsInclude, callsFunction };
}

export function buildArchPackageObjects(relPath, facts) {
  const pkgId = `arch:${relPath}`;
  const mainObj = {
    id: pkgId,
    name: facts.pkgname ?? path.posix.basename(path.dirname(relPath)),
    filePath: relPath,
    pkgname: facts.pkgname,
    pkgver: facts.pkgver,
    pkgrel: facts.pkgrel,
    pkgdesc: facts.pkgdesc,
    url: facts.url,
    license: facts.license,
    arch: facts.arch,
    depends: facts.depends,
    makedepends: facts.makedepends,
    checkdepends: facts.checkdepends,
    optdepends: facts.optdepends,
    source: facts.source,
    sha256sums: facts.sha256sums,
    sourceIsRemote: facts.sourceIsRemote,
    sha256Skip: facts.sha256Skip,
    functionCount: facts.functionCount ?? 0,
    risks: facts.risks ?? [],
    riskLevel: facts.riskLevel ?? 'none',
    reviewed: false, notes: null,
  };
  const fnIdUsed = new Set();
  const fnIds = [];
  const fnObjects = [];
  for (const f of facts.functions ?? []) {
    const id = uniqueId(`archfn:${relPath}#${f.name}`, fnIdUsed);
    fnIds.push(id);
    fnObjects.push({ id, name: f.name, startLine: f.startLine, endLine: f.endLine, bodyLineCount: f.bodyLineCount, packageId: pkgId, filePath: relPath, reviewed: false, notes: null });
  }
  mainObj.fnIds = fnIds;
  return { mainObj, fnObjects };
}

export function buildNixObjects(relPath, facts) {
  const isFlake = facts.isFlake;
  const mainId = `nix:${relPath}`;
  const inputIdUsed = new Set();
  const inputIds = [];
  const inputObjects = [];
  for (const i of facts.inputs ?? []) {
    const id = uniqueId(`nixin:${relPath}#${i.name}`, inputIdUsed);
    inputIds.push(id);
    inputObjects.push({ id, name: i.name, url: i.url, hasFlakeAttr: i.hasFlakeAttr, flakeId: mainId, filePath: relPath, reviewed: false, notes: null });
  }
  const pkgIdUsed = new Set();
  const pkgIds = [];
  const pkgObjects = [];
  for (const p of facts.outputsPackages ?? []) {
    const id = uniqueId(`nixpkg:${relPath}#${p.system}.${p.name}`, pkgIdUsed);
    pkgIds.push(id);
    pkgObjects.push({ id, name: p.name, system: p.system, line: p.line, flakeId: mainId, filePath: relPath, reviewed: false, notes: null });
  }
  const mainObj = {
    id: mainId,
    name: isFlake ? 'flake.nix' : path.posix.basename(relPath, '.nix'),
    filePath: relPath,
    isFlake,
    description: facts.description,
    inputCount: facts.inputCount ?? 0,
    packageCount: facts.packageCount ?? 0,
    derivationCount: facts.derivationCount ?? 0,
    buildInputs: facts.buildInputs ?? {},
    fetchers: facts.fetchers ?? [],
    risks: facts.risks ?? [],
    riskLevel: facts.riskLevel ?? 'none',
    inputIds,
    packageIds: pkgIds,
    reviewed: false, notes: null,
  };
  return { mainObj, inputObjects, pkgObjects };
}
