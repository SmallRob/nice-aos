// 相位 1（buildOntologyData 拆分）：项目扫描 + 逐文件解析 + 依赖对象 + 模块树 + SourceFile 对象
// 原为 builder.js 内联代码段（"1. 逐文件解析" 至 "4. SourceFile 对象"），拆分时收敛于此（逻辑不变）。
import path from 'node:path';
import { scanProject } from '../analyzers/projectScanner.js';
import { createResolver } from '../analyzers/importResolver.js';
import { analyzeFileFromDisk } from '../analyzers/tsAnalyzer.js';
import { analyzeVueFileFromDisk } from '../analyzers/vueAnalyzer.js';
import { analyzeUserScriptFromDisk } from '../analyzers/userScriptAnalyzer.js';
import { analyzeRustFileFromDisk, resolveRustUse } from '../analyzers/rustAnalyzer.js';
import { analyzeDartFileFromDisk } from '../analyzers/dartAnalyzer.js';
import { analyzeGoFileFromDisk } from '../analyzers/goAnalyzer.js';
import { analyzePythonFileFromDisk, checkPythonSyntaxBulk } from '../analyzers/pythonAnalyzer.js';
import { analyzeKotlinFileFromDisk } from '../analyzers/kotlinAnalyzer.js';
import { analyzePhpFileFromDisk } from '../analyzers/phpAnalyzer.js';
import { analyzeShellScriptFromDisk } from '../analyzers/shellScriptAnalyzer.js';
import { analyzeCMakeFromDisk } from '../analyzers/cmakeAnalyzer.js';
import { analyzePkgbuildFromDisk } from '../analyzers/pkgbuildAnalyzer.js';
import { analyzeNixFromDisk } from '../analyzers/nixAnalyzer.js';
import { createPhpImportResolver, createKotlinImportResolver } from '../analyzers/phpKotlinImportResolver.js';
import { analyzeConfigFileFromDisk } from '../analyzers/configAnalyzer.js';
import { CONFIG_EXTS, isEntryFile, moduleLayerOf, createGoImportResolver, isTestFile } from './builderUtils.js';

export function builderScanPhase(ctx) {
  const { projectRoot, options, report } = ctx;
  report('scan:start');
  const scan = scanProject(projectRoot, options);
  report('scan:done', { fileCount: scan.fileCount, rootCount: (scan.roots ?? []).length });
  // 入口识别使用实际扫描根（显式 roots 或默认 src/）；根级入口名在每个根顶层均有效
  const entryRoots = scan.roots ?? ['src'];
  const htmlEntries = new Set(scan.htmlEntryFiles ?? []);
  // Node 入口（package.json bin/main）：CLI/工具库形态的真实入口，不参与前端入口名约定
  const nodeEntries = new Set(scan.nodeEntryFiles ?? []);
  // 外部测试引用证据：根级 test/tests/__tests__/spec 目录不在扫描范围，
  // 其 import 代表真实使用 → 孤儿文件与死代码判定须豁免（消除"仅被测试使用"误报）
  const testImportedFiles = new Set(scan.testImports?.importedFiles ?? []);

  // v0.35.0 借鉴 GitNexus resolution-outcome.ts：把"解析失败的近似判定"也建成数据
  // 在 _meta.resolutionStats 暴露；MCP get_health / serve /api/stats 一并复用
  // 各计数器在对应代码路径 +1，_meta 阶段汇总
  const resolutionStats = {
    totalImportAttempts: 0,           // 所有 import 声明总数（external + internal + type）
    totalResolvedImports: 0,          // 解析成功的 import 声明
    unresolvedImportsCount: 0,        // 解析失败（无候选文件）
    unresolvedDynamicImportsCount: 0, // defineAsyncComponent / React.lazy 等动态导入解析失败
    vueGlobalFallbackCount: 0,        // renders 经 Vue.component 全局注册兜底
    vueSameFileFallbackCount: 0,      // renders 经同文件兜底（无 import 记录）
    autoImportedUsesStoreCount: 0,    // usesStore 经 unplugin-auto-import 隐式调用匹配
    propEdgeSourceMissingCount: 0,    // prop 边源/目标组件缺失
    matchedRouteCount: 0,             // 前后端路由匹配命中数
    unmatchedFrontendCallsCount: 0,   // 前端 API 调用未匹配到后端路由
    methodCallAttempts: 0,            // 方法调用边总数
    methodCallResolved: 0,            // 方法调用边解析成功数
  };
  const testNamedRefs = new Set(scan.testImports?.namedRefs ?? []);
  const resolver = createResolver(projectRoot, scan.tsconfigPaths, scan.files, scan.pubspecName ?? null);

  // 1. 逐文件解析（TypeScript Compiler API，仅词法/语法层，不做类型检查）
  // 路由：.rs → rustAnalyzer；.go → goAnalyzer；.dart → dartAnalyzer；.py → pythonAnalyzer；.vue → vueAnalyzer；油猴脚本 → userScriptAnalyzer；其余 → tsAnalyzer（平级、逻辑独立）
  const rustFiles = new Set(scan.files.filter((f) => f.endsWith('.rs')));
  const goFiles = new Set(scan.files.filter((f) => f.endsWith('.go')));
  const goResolver = createGoImportResolver(
    goFiles,
    scan.goModule?.name ?? null,
    Object.entries(scan.dependencies ?? {}).filter(([, info]) => info.registry === 'go').map(([n]) => n),
    scan.goModule?.dir || '',
    projectRoot,
  );
  const factsMap = new Map();
  const analysisErrors = [];
  // 1-pre. Python 语法批量校验（仅当项目含 .py 文件时执行）
  // pythonAnalyzer 是基于缩进的轻量级解析，对 SyntaxError 文件会"静默成功"；
  // 这里一次性调 python3 ast.parse 找出失败文件，让 analyzePythonFileFromDisk
  // 对这些文件 throw，由下方 try/catch 写入 analysisErrors。
  const pythonFiles = scan.files.filter((f) => f.endsWith('.py') && !f.endsWith('.pyc'));
  if (pythonFiles.length > 0) {
    try {
      checkPythonSyntaxBulk(pythonFiles, projectRoot);
    } catch {
      // 校验失败不影响主流程
    }
  }
  const getFacts = (relPath) => {
    if (factsMap.has(relPath)) return factsMap.get(relPath);
    // .env.* 文件被 projectScanner 加了 "#env" 后缀还原真实磁盘路径（ext 从 path.extname 提取）
    const diskPath = relPath.endsWith('#env') ? relPath.slice(0, -4) : relPath;
    const diskExt = path.extname(diskPath).toLowerCase();
    // 配置扩展名按规范化 ext 判定（.env.development 视为 .env）
    const ext = relPath.endsWith('#env') ? '.env' : diskExt;
    try {
      const facts = diskPath.endsWith('.rs')
        ? analyzeRustFileFromDisk(diskPath, projectRoot)
        : diskPath.endsWith('.go')
          ? analyzeGoFileFromDisk(diskPath, projectRoot)
          : diskPath.endsWith('.dart')
            ? analyzeDartFileFromDisk(diskPath, projectRoot)
            : diskPath.endsWith('.py')
              ? analyzePythonFileFromDisk(diskPath, projectRoot)
              : (diskPath.endsWith('.kt') || diskPath.endsWith('.kts'))
                ? analyzeKotlinFileFromDisk(diskPath, projectRoot)
                : diskPath.endsWith('.php')
                  ? analyzePhpFileFromDisk(diskPath, projectRoot)
                  : diskPath.endsWith('.vue')
                    ? analyzeVueFileFromDisk(diskPath, projectRoot)
                    : (scan.userScriptFiles?.has(diskPath)
                      ? analyzeUserScriptFromDisk(diskPath, projectRoot)
                      : scan.shellScriptFiles?.has(diskPath)
                        ? analyzeShellScriptFromDisk(diskPath, projectRoot)
                        : scan.cmakeFiles?.has(diskPath)
                          ? analyzeCMakeFromDisk(diskPath, projectRoot)
                          : scan.pkgbuildFiles?.has(diskPath)
                            ? analyzePkgbuildFromDisk(diskPath, projectRoot)
                            : scan.nixFiles?.has(diskPath)
                              ? analyzeNixFromDisk(diskPath, projectRoot)
                              : CONFIG_EXTS.has(ext)
                                ? analyzeConfigFileFromDisk(diskPath, projectRoot, ext)
                                : analyzeFileFromDisk(diskPath, projectRoot));
      factsMap.set(relPath, facts);
      return facts;
    } catch (err) {
      analysisErrors.push({ file: relPath, error: String(err.message ?? err) });
      const empty = {
        path: relPath, ext: relPath.endsWith('#env') ? 'env' : path.extname(relPath).slice(1), lineCount: 0,
        imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
        useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [], components: [],
        hooks: [], primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
        importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
        interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
      };
      factsMap.set(relPath, empty);
      return empty;
    }
  };
  for (const file of scan.files) getFacts(file);
  report('parse:done', { fileCount: scan.files.length, errorCount: analysisErrors.length });

  // Rust use 路径解析器（crate::a::b::Name → 目标 .rs 文件；serde::X → Rust 外部 crate，不进 npm 依赖体系）
  const resolveRustImport = (relPath, specifier) => resolveRustUse(relPath, specifier, rustFiles);

  // PHP / Kotlin 内部导入解析（v0.36.1）：composer PSR-4 / 声明包与限定名，区分内部（file: 边）与外部（命名空间首段归并）
  const isKtPath = (f) => f.endsWith('.kt') || f.endsWith('.kts');
  const phpImportResolver = createPhpImportResolver({
    projectRoot: scan.root,
    phpFiles: scan.files.filter((f) => f.endsWith('.php')),
    phpFacts: new Map([...factsMap].filter(([f]) => f.endsWith('.php'))),
  });
  const kotlinImportResolver = createKotlinImportResolver({
    ktFiles: scan.files.filter(isKtPath),
    ktFacts: new Map([...factsMap].filter(([f]) => isKtPath(f))),
  });

  // 2. 依赖对象（package.json 声明 + 代码中实际导入；Rust 外部 crate 为 Cargo.toml 管辖，不计入）
  const depUsedCount = new Map();
  const externalImports = new Map(); // package -> Set<specifier>
  for (const [relPath, facts] of factsMap) {
    const isRust = relPath.endsWith('.rs');
    const isGo = relPath.endsWith('.go');
    // PHP use / Kotlin import：命名空间导入，不走 TS resolver（避免 Foo\Bar 误判为 npm 包）
    // PHP 的 module:xxx / lang:xxx 跨模块引用与 Kotlin 的 java.* 依赖体系由各自生态管辖，统一标记 unresolved
    const isPhp = relPath.endsWith('.php');
    const isKotlin = relPath.endsWith('.kt') || relPath.endsWith('.kts');
    for (const imp of facts.imports) {
      if (isRust) {
        const r = resolveRustImport(relPath, imp.specifier);
        imp.resolved = r.kind === 'internal' || r.kind === 'unresolved' ? r : { kind: 'rust-external', package: r.package };
        continue;
      }
      if (isGo) {
        const r = goResolver.resolve(imp.specifier);
        imp.resolved = r;
        if (r.kind === 'external') {
          depUsedCount.set(r.package, (depUsedCount.get(r.package) ?? 0) + 1);
          if (!externalImports.has(r.package)) externalImports.set(r.package, new Set());
          externalImports.get(r.package).add(imp.specifier);
        }
        continue;
      }
      if (isPhp || isKotlin) {
        // v0.36.1：内部（PSR-4 / 包限定名命中）与外部（首段归并，php: foo\bar → foo；kotlin: java.net.Proxy → java）
        imp.resolved = (isPhp ? phpImportResolver : kotlinImportResolver).resolve(imp.specifier);
        continue;
      }
      const resolved = resolver.resolve(relPath, imp.specifier);
      imp.resolved = resolved;
      if (resolved.kind === 'external') {
        depUsedCount.set(resolved.package, (depUsedCount.get(resolved.package) ?? 0) + 1);
        if (!externalImports.has(resolved.package)) externalImports.set(resolved.package, new Set());
        externalImports.get(resolved.package).add(imp.specifier);
      }
    }
  }
  // 借鉴 asdm-aos dependsOn 去噪：标记纯类型定义依赖（@types/*）
  // @types/* 是类型声明包，运行时不存在，业务图谱中通常是噪音
  // 不在 link 默认行为中隐藏（避免破坏向后兼容），改用 isTypeDefinition 字段让 query --where 过滤
  function isTypeOnlyPackage(name) {
    return name.startsWith('@types/') || name === 'typescript';
  }
  const dependencies = [];
  for (const [name, info] of Object.entries(scan.dependencies)) {
    dependencies.push({
      id: `dep:${name}`, name,
      version: info.version, scope: info.scope,
      source: info.registry === 'pub' ? 'pub' : (info.registry === 'go' ? 'go' : (info.version.startsWith('file:') ? 'workspace' : 'npm')),
      importCount: depUsedCount.get(name) ?? 0,
      used: (depUsedCount.get(name) ?? 0) > 0,
      // 类型定义包标记：@types/* / typescript（仅 devDependency；运行时 import 不影响）
      isTypeDefinition: isTypeOnlyPackage(name) && (info.scope === 'dev' || !depUsedCount.has(name)),
    });
  }
  for (const [name, count] of depUsedCount) {
    if (scan.dependencies[name]) continue;
    dependencies.push({
      id: `dep:${name}`, name, version: null, scope: null,
      source: 'undeclared', importCount: count, used: true,
      isTypeDefinition: isTypeOnlyPackage(name),
    });
  }

  // 3. 模块树
  const modules = [];
  const moduleIds = new Set();
  function ensureModule(dir) {
    if (!dir || dir === '.') return null;
    if (moduleIds.has(`mod:${dir}`)) return `mod:${dir}`;
    const parent = path.posix.dirname(dir);
    const parentId = parent === '.' ? null : ensureModule(parent);
    modules.push({
      id: `mod:${dir}`,
      name: path.posix.basename(dir),
      path: dir,
      layer: moduleLayerOf(dir),
      depth: dir.split('/').length,
      parentId,
      fileCount: 0,
    });
    moduleIds.add(`mod:${dir}`);
    return `mod:${dir}`;
  }

  // 4. SourceFile 对象
  const fileObjects = [];
  const fileObjectByPath = new Map();
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    const dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    const moduleId = dir ? ensureModule(dir) : null;
    const importIds = [];
    const unresolvedImports = [];
    let typeImportCount = 0;
    const seen = new Set();
    const isRustFile = relPath.endsWith('.rs');
    const isGoFile = relPath.endsWith('.go');
    for (const imp of facts.imports) {
      if (imp.isTypeOnly) typeImportCount += 1;
      resolutionStats.totalImportAttempts += 1;
      if (isRustFile) {
        const r = imp.resolved ?? resolveRustImport(relPath, imp.specifier);
        if (r.kind === 'internal') {
          if (!seen.has(`file:${r.file}`)) { importIds.push(`file:${r.file}`); seen.add(`file:${r.file}`); }
          resolutionStats.totalResolvedImports += 1;
        } else if (r.kind === 'unresolved') {
          if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
          resolutionStats.unresolvedImportsCount += 1;
        } else {
          // rust-external: 解析成功（依赖边不进 npm 体系）
          resolutionStats.totalResolvedImports += 1;
        }
        continue;
      }
      if (isGoFile) {
        // Go import 目标是 package 目录（多文件）：关联到目录下全部 .go 文件
        const r = imp.resolved ?? goResolver.resolve(imp.specifier);
        if (r.kind === 'internal') {
          for (const tf of r.files) {
            if (tf === relPath) continue;
            if (!seen.has(`file:${tf}`)) { importIds.push(`file:${tf}`); seen.add(`file:${tf}`); }
          }
          resolutionStats.totalResolvedImports += 1;
        } else if (r.kind === 'unresolved') {
          if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
          resolutionStats.unresolvedImportsCount += 1;
        } else {
          resolutionStats.totalResolvedImports += 1;
        }
        // builtin（标准库）/ external（go.mod 依赖）不进文件边
        continue;
      }
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind === 'internal') {
        // Kotlin 通配 import a.b.* → files 数组（整包关联）；常规 internal → 单 file
        const targets = r.files ?? (r.file ? [r.file] : []);
        for (const tf of targets) {
          if (tf === relPath) continue;
          if (!seen.has(`file:${tf}`)) { importIds.push(`file:${tf}`); seen.add(`file:${tf}`); }
        }
        resolutionStats.totalResolvedImports += 1;
      } else if (r.kind === 'external') {
        if (r.package && !seen.has(`dep:${r.package}`)) { importIds.push(`dep:${r.package}`); seen.add(`dep:${r.package}`); }
        resolutionStats.totalResolvedImports += 1;
      } else if (r.kind === 'unresolved') {
        if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
        resolutionStats.unresolvedImportsCount += 1;
      }
    }
    const stem = path.posix.basename(relPath).replace(/\.(tsx?|jsx?|dart)$/, '');
    // .env.* 文件路径带 "#env" 标记，剥离后给用户显示真实文件名
    const displayPath = relPath.endsWith('#env') ? relPath.slice(0, -4) : relPath;
    const obj = {
      id: `file:${displayPath}`,
      name: path.posix.basename(displayPath),
      path: displayPath,
      ext: facts.ext,
      module: dir,
      moduleId,
      layer: dir ? moduleLayerOf(dir) : 'root',
      lineCount: facts.lineCount,
      isTest: isTestFile(relPath),
      isDeclaration: relPath.endsWith('.d.ts'),
      isEntry: htmlEntries.has(relPath) || isEntryFile(relPath, entryRoots) || nodeEntries.has(relPath),
      isPageFile: stem.endsWith('Page') || stem.endsWith('Screen') || (relPath.endsWith('.vue') && /\/(views|pages)\//.test(relPath)),
      importIds,
      typeImportCount,
      unresolvedImports,
      exportNames: facts.exportNames,
      opensOverlayIds: facts.overlayOpens.map((o) => o.target),
      // 配置文件轻量级语义提取（仅 css/html/sql/yaml/conf/toml/ini/env 会有）
      configKind: facts.configKind ?? null,
      configItems: facts.configItems ?? [],
      configTruncated: !!facts.configTruncated,
      reviewed: false,
      notes: null,
    };
    fileObjects.push(obj);
    fileObjectByPath.set(relPath, obj);
    if (moduleId) {
      const mod = modules.find((m) => m.id === moduleId);
      if (mod) mod.fileCount += 1;
    }
  }

  Object.assign(ctx, {
    scan, entryRoots, htmlEntries, nodeEntries, testImportedFiles, resolutionStats, testNamedRefs, resolver,
    rustFiles, goFiles, goResolver, factsMap, analysisErrors, getFacts, resolveRustImport, isKtPath,
    phpImportResolver, kotlinImportResolver, dependencies, modules, fileObjects, fileObjectByPath,
  });
}