// buildOntologyData：相位编排层（各相位实现见 builderScan/builderFrontendObjects/builderBackendObjects/
// builderBackendRoutes/builderLinks/builderAudit/builderAssemble，按 ctx 对象接力，拆分逻辑不变）
// buildSingleFileOntology：单文件分析（不落盘快照），action analyzeFile 的核心实现。
import path from 'node:path';
import fs from 'node:fs';
import { analyzeFileFromDisk } from '../analyzers/tsAnalyzer.js';
import { analyzeVueFileFromDisk } from '../analyzers/vueAnalyzer.js';
import { analyzeUserScriptFromDisk, isUserScriptCandidate } from '../analyzers/userScriptAnalyzer.js';
import { analyzeRustFile } from '../analyzers/rustAnalyzer.js';
import { analyzeDartFile } from '../analyzers/dartAnalyzer.js';
import { analyzeGoFile } from '../analyzers/goAnalyzer.js';
import { analyzePythonFile } from '../analyzers/pythonAnalyzer.js';
import { analyzeKotlinFile } from '../analyzers/kotlinAnalyzer.js';
import { analyzePhpFile } from '../analyzers/phpAnalyzer.js';
import { analyzeShellScriptFromDisk, isShellScriptCandidate } from '../analyzers/shellScriptAnalyzer.js';
import { analyzeCMakeFromDisk, isCMakeCandidate } from '../analyzers/cmakeAnalyzer.js';
import { analyzePkgbuildFromDisk, isPkgbuildCandidate } from '../analyzers/pkgbuildAnalyzer.js';
import { analyzeNixFromDisk, isNixCandidate } from '../analyzers/nixAnalyzer.js';
import { ENTRY_BASENAMES } from './builderUtils.js';
import { collectTypeEntities, linkMethodOverrides } from './typeEntities.js';
import { SERVER_API_ROUTE_TYPES } from './rpcMatch.js';
import { buildPythonOutboundEndpoints } from './outboundEndpoints.js';
import { buildUserScriptObjects } from './scriptObjects.js';
import {
  buildShellScriptObjects, buildCMakeObjects, buildArchPackageObjects, buildNixObjects,
} from './infraObjects.js';
import { builderScanPhase } from './builderScan.js';
import { builderFrontendPhase } from './builderFrontendObjects.js';
import { builderBackendPhase } from './builderBackendObjects.js';
import { builderRoutesPhase } from './builderBackendRoutes.js';
import { builderLinksPhase } from './builderLinks.js';
import { builderAuditPhase } from './builderAudit.js';
import { builderAssemblePhase } from './builderAssemble.js';

export { SERVER_API_ROUTE_TYPES }; // 保持既有公共 API 兼容

export async function buildOntologyData(projectRoot, options = {}) {
  const startedAt = Date.now();
  // 借鉴 asdm-aos 的 6 步进度机制：通过 onProgress(step, payload) 回调上报，action.js 消费
  // 不传 onProgress 时静默运行（向后兼容 test/库调用）
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const report = (step, payload = {}) => { if (onProgress) onProgress(step, { ...payload, at: Date.now() - startedAt }); };
  // ctx 接力：每个相位从 ctx 解构输入，末尾 Object.assign 挂回输出
  const ctx = { projectRoot, options, report, startedAt };
  builderScanPhase(ctx);
  builderFrontendPhase(ctx);
  builderBackendPhase(ctx);
  builderRoutesPhase(ctx);
  builderLinksPhase(ctx);
  builderAuditPhase(ctx);
  return builderAssemblePhase(ctx);
}

// 单文件分析（不落盘快照）：action analyzeFile 的核心实现
// 原子性：分析即输出 dataMap 形状 JSON，供 jq/findstr 管道组合；场景工作流（油猴审计/死代码清理）由 skill 编排
export async function buildSingleFileOntology(absFilePath) {
  const startedAt = Date.now();
  const fileName = path.basename(absFilePath);
  const dir = path.dirname(absFilePath);

  // 路由与全仓库扫描一致：.rs → rustAnalyzer；.go → goAnalyzer；.dart → dartAnalyzer；.py → pythonAnalyzer；
  // .kt/.kts → kotlinAnalyzer；.php → phpAnalyzer；.vue → vueAnalyzer；油猴脚本 → userScriptAnalyzer；
  // .sh/.bash/.zsh/.ps1/.psm1 → shellScriptAnalyzer；.cmake/CMakeLists.txt → cmakeAnalyzer；
  // PKGBUILD → pkgbuildAnalyzer；.nix → nixAnalyzer；其余 → tsAnalyzer
  let facts;
  if (fileName.endsWith('.rs')) {
    facts = analyzeRustFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.go')) {
    facts = analyzeGoFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.dart')) {
    facts = analyzeDartFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.py')) {
    facts = analyzePythonFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.kt') || fileName.endsWith('.kts')) {
    facts = analyzeKotlinFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.php')) {
    facts = analyzePhpFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.vue')) {
    facts = analyzeVueFileFromDisk(fileName, dir);
  } else if (isUserScriptCandidate(absFilePath)) {
    facts = analyzeUserScriptFromDisk(fileName, dir);
  } else if (isShellScriptCandidate(absFilePath)) {
    facts = analyzeShellScriptFromDisk(fileName, dir);
  } else if (isCMakeCandidate(absFilePath)) {
    facts = analyzeCMakeFromDisk(fileName, dir);
  } else if (isPkgbuildCandidate(absFilePath)) {
    facts = analyzePkgbuildFromDisk(fileName, dir);
  } else if (isNixCandidate(absFilePath)) {
    facts = analyzeNixFromDisk(fileName, dir);
  } else {
    facts = analyzeFileFromDisk(fileName, dir);
  }

  const fileObj = {
    id: `file:${fileName}`,
    name: fileName,
    path: fileName,
    ext: facts.ext,
    module: '',
    moduleId: null,
    layer: 'root',
    lineCount: facts.lineCount,
    isTest: false,
    isEntry: !!facts.isUserScript || ENTRY_BASENAMES.has(fileName),
    isPageFile: false,
    importIds: [],
    typeImportCount: 0,
    unresolvedImports: [],
    exportNames: facts.exportNames ?? [],
    opensOverlayIds: [],
    unusedExports: [], // 单文件模式无法判定跨文件使用，导出级判定仅全仓库扫描提供
    reviewed: false,
    notes: null,
  };
  const factsMap = new Map([[fileName, facts]]);
  const fileObjectByPath = new Map([[fileName, fileObj]]);

  // 类型实体：非导出实体按本文件引用计数判死；导出实体不判死（单文件模式无法判定跨文件使用）
  const { interfaces, classes, traits, methods, localTypesByFile } = collectTypeEntities([fileName], factsMap, fileObjectByPath);

  // PHP DAO 链常量解析（单文件模式：define 仅本文件可见，跨文件常量表在全仓库扫描解析）
  const phpDefines = facts.defines ?? {};
  for (const m of methods) {
    for (const q of m.sqlQueries ?? []) {
      if (!q.dynamic) continue;
      const resolved = phpDefines[q.table];
      if (resolved) { q.table = resolved; q.dynamic = false; }
    }
  }

  // 本文件内 implements/extends 解析（本文件声明的类型；跨文件导入名留存原名不报错）
  const localType = (name) => localTypesByFile.get(fileName)?.get(name) ?? null;
  for (const iface of interfaces) {
    iface.extendsIds = iface.extendsNames.map(localType).filter(Boolean);
  }
  for (const cls of classes) {
    cls.implementsIds = (cls.implementsNames ?? []).map(localType).filter(Boolean);
    if (cls.extendsName) cls.extendsId = localType(cls.extendsName);
    // 本文件内 trait use 回填（单文件模式）
    if (cls.usesTraits && cls.usesTraits.length > 0) {
      for (const name of cls.usesTraits) {
        const t = traits.find((x) => x.name === name);
        if (t) {
          cls.usesTraitIds.push(t.id);
          if (!t.usedByIds.includes(cls.id)) t.usedByIds.push(cls.id);
        }
      }
    }
  }
  linkMethodOverrides(interfaces, classes, methods);

  // 油猴文件：五类脚本对象（含函数级死代码候选）
  const us = facts.isUserScript
    ? buildUserScriptObjects(fileName, facts, fileObj)
    : { userScript: null, gmApiUsages: [], injectionPoints: [], networkEndpoints: [], scriptFunctions: [] };

  // v0.41.0: Python 文件的 outbound HTTP 端点（单文件模式，与全仓库扫描同聚合逻辑）
  const pyOutbound = facts.httpClientCalls && facts.httpClientCalls.length > 0
    ? buildPythonOutboundEndpoints([fileName], factsMap, fileObjectByPath, new Set())
    : [];
  const networkEndpoints = [...us.networkEndpoints, ...pyOutbound];

  // v0.38.0: 单文件模式下的 Shell / CMake / PKGBUILD / Nix 分支
  let shellSet = null, cmakeSet = null, archSet = null, nixSet = null;
  if (facts.isShellScript) shellSet = buildShellScriptObjects(fileName, facts);
  else if (facts.isCMake) cmakeSet = buildCMakeObjects(fileName, facts);
  else if (facts.isPkgbuild) archSet = buildArchPackageObjects(fileName, facts);
  else if (facts.isNix) nixSet = buildNixObjects(fileName, facts);

  const dataMap = {
    _meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      mode: 'single-file',
      file: absFilePath,
      objectCounts: {
        SourceFile: 1,
        Interface: interfaces.length,
        Class: classes.length,
        Trait: traits.length,
        Method: methods.length,
        UserScript: us.userScript ? 1 : 0,
        GmApiUsage: us.gmApiUsages.length,
        InjectionPoint: us.injectionPoints.length,
        NetworkEndpoint: networkEndpoints.length,
        ScriptFunction: us.scriptFunctions.length,
        // v0.38.0
        ShellScript: shellSet && shellSet.mainObj && facts.shellLanguage !== 'powershell' ? 1 : 0,
        PsScript: shellSet && shellSet.mainObj && facts.shellLanguage === 'powershell' ? 1 : 0,
        BashFunction: shellSet ? shellSet.fnObjects.filter((f) => f.kind === 'BashFunction').length : 0,
        PsFunction: shellSet ? shellSet.fnObjects.filter((f) => f.kind === 'PsFunction').length : 0,
        BashBuiltin: shellSet ? shellSet.builtinObjects.filter((b) => b.kind === 'BashBuiltin').length : 0,
        Cmdlet: shellSet ? shellSet.builtinObjects.filter((b) => b.kind === 'Cmdlet').length : 0,
        CMakeModule: cmakeSet ? 1 : 0,
        CMakeTarget: cmakeSet ? cmakeSet.targetObjects.length : 0,
        CMakeFunction: cmakeSet ? cmakeSet.fnObjects.length : 0,
        CMakeOption: cmakeSet ? cmakeSet.optionObjects.length : 0,
        ArchPackage: archSet ? 1 : 0,
        ArchPackageFunction: archSet ? archSet.fnObjects.length : 0,
        NixFlake: nixSet ? 1 : 0,
        NixPackage: nixSet ? nixSet.pkgObjects.length : 0,
        NixInput: nixSet ? nixSet.inputObjects.length : 0,
      },
    },
    SourceFile: [fileObj],
    Interface: interfaces,
    Class: classes,
    Trait: traits,
    Method: methods,
    UserScript: us.userScript ? [us.userScript] : [],
    GmApiUsage: us.gmApiUsages,
    InjectionPoint: us.injectionPoints,
    NetworkEndpoint: networkEndpoints,
    ScriptFunction: us.scriptFunctions,
    // v0.38.0
    ShellScript: shellSet && shellSet.mainObj && facts.shellLanguage !== 'powershell' ? [shellSet.mainObj] : [],
    PsScript: shellSet && shellSet.mainObj && facts.shellLanguage === 'powershell' ? [shellSet.mainObj] : [],
    BashFunction: shellSet ? shellSet.fnObjects.filter((f) => f.kind === 'BashFunction') : [],
    PsFunction: shellSet ? shellSet.fnObjects.filter((f) => f.kind === 'PsFunction') : [],
    BashBuiltin: shellSet ? shellSet.builtinObjects.filter((b) => b.kind === 'BashBuiltin') : [],
    Cmdlet: shellSet ? shellSet.builtinObjects.filter((b) => b.kind === 'Cmdlet') : [],
    CMakeModule: cmakeSet ? [cmakeSet.mainObj] : [],
    CMakeTarget: cmakeSet ? cmakeSet.targetObjects : [],
    CMakeFunction: cmakeSet ? cmakeSet.fnObjects : [],
    CMakeOption: cmakeSet ? cmakeSet.optionObjects : [],
    ArchPackage: archSet ? [archSet.mainObj] : [],
    ArchPackageFunction: archSet ? archSet.fnObjects : [],
    NixFlake: nixSet ? [nixSet.mainObj] : [],
    NixInput: nixSet ? nixSet.inputObjects : [],
    NixPackage: nixSet ? nixSet.pkgObjects : [],
  };
  return dataMap;
}
