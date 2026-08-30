// 相位 7（buildOntologyData 拆分）：汇总（Project 对象 + 项目画像 + dataMap + shell/ROS/跨语言边集合）
// 原为 builder.js 内联代码段（"9. 汇总" 至 return dataMap），逻辑不变。
import { buildProjectProfile } from './semantics.js';

export function builderAssemblePhase(ctx) {
  const {
    startedAt, report, scan, resolutionStats, analysisErrors,
    modules, fileObjects, components, hooks, stores, services,
    interfaces, classes, traits, methods, propEdges, routes, dependencies,
    userScripts, gmApiUsages, injectionPoints, networkEndpoints, scriptFunctions,
    shellScripts, psScripts, bashFunctions, psFunctions, bashBuiltins, cmdlets,
    cmakeModules, cmakeTargets, cmakeFunctions, cmakeOptions,
    archPackages, archPackageFunctions, nixFlakes, nixPackages, nixInputs,
    rosNodes, rosChannels, rosLaunches, domains, cycles, orphanCandidates,
    deadExportCandidates, unmatchedFrontendCalls, rpcChainStats,
    callsFunction, usesBuiltin, readsCliParam, subdirIncludes, declaresOption,
    addsDependency, targetsInclude, factsMap,
  } = ctx;

  // 9. 汇总
  const project = {
    id: `proj:${scan.name}`,
    name: scan.name,
    version: scan.version,
    path: scan.root,
    framework: scan.framework,
    frameworkVariants: scan.frameworkVariants ?? [],
    frameworkLabel: scan.frameworkLabel ?? scan.framework,
    hostRoot: scan.hostRoot ?? null,
    hostConfigs: scan.hostConfigs ?? [],
    language: (() => {
      const parts = [];
      // TS/JS 区分：.js 文件不再无条件归入 TypeScript（纯 JS 的 CLI/工具库此前被误标）
      if ((scan.tsFileCount ?? 0) + (scan.tsxFileCount ?? 0) > 0) parts.push('TypeScript');
      else if ((scan.jsFileCount ?? 0) + (scan.vueFileCount ?? 0) > 0) parts.push('JavaScript');
      if ((scan.rustFileCount ?? 0) > 0) parts.push('Rust');
      if ((scan.dartFileCount ?? 0) > 0) parts.push('Dart');
      if ((scan.goFileCount ?? 0) > 0) parts.push('Go');
      if ((scan.pyFileCount ?? 0) > 0) parts.push('Python');
      if ((scan.pyLaunchFileCount ?? 0) > 0) parts.push('+ROS2Launch');
      if ((scan.kotlinFileCount ?? 0) > 0) parts.push('Kotlin');
      if ((scan.phpFileCount ?? 0) > 0) parts.push('PHP');
      if ((scan.shFileCount ?? 0) > 0) parts.push('Shell');
      if ((scan.ps1FileCount ?? 0) > 0) parts.push('PowerShell');
      if ((scan.cmakeExtFileCount ?? 0) > 0) parts.push('CMake');
      if ((scan.nixExtFileCount ?? 0) > 0) parts.push('Nix');
      return parts.join(' + ') || 'JavaScript';
    })(),
    commitHash: scan.commitHash,
    branch: scan.branch,
    fileCount: scan.fileCount,
    tsFileCount: scan.tsFileCount,
    tsxFileCount: scan.tsxFileCount,
    jsFileCount: scan.jsFileCount,
    vueFileCount: scan.vueFileCount,
    rustFileCount: scan.rustFileCount ?? 0,
    dartFileCount: scan.dartFileCount ?? 0,
    goFileCount: scan.goFileCount ?? 0,
    pyFileCount: scan.pyFileCount ?? 0,
    pyLaunchFileCount: scan.pyLaunchFileCount ?? 0,
    pyNodeClassCount: rosNodes.length,
    pyDetected: scan.pyDetected ?? false,
    kotlinFileCount: scan.kotlinFileCount ?? 0,
    phpFileCount: scan.phpFileCount ?? 0,
    shFileCount: scan.shFileCount ?? 0,
    ps1FileCount: scan.ps1FileCount ?? 0,
    cmakeExtFileCount: scan.cmakeExtFileCount ?? 0,
    nixExtFileCount: scan.nixExtFileCount ?? 0,
    pkgbuildFileCount: scan.pkgbuildFileCount ?? 0,
    shellScriptFileCount: scan.shellScriptFileCount ?? 0,
    cmakeFileCount: scan.cmakeFileCount ?? 0,
    nixFileCount: scan.nixFileCount ?? 0,
    goModule: scan.goModule ?? null,
    subProjects: scan.subProjects ?? [],
    siblingProjects: scan.siblingProjects ?? [],
    flutterDetected: scan.flutterDetected ?? false,
    tauriDetected: scan.tauriDetected ?? false,
    electronDetected: scan.electronDetected ?? false,
    goDetected: scan.goDetected ?? false,
    phpDetected: scan.phpDetected ?? false,
    kotlinDetected: scan.kotlinDetected ?? false,
    userScriptFileCount: scan.userScriptFileCount ?? 0,
    analysisErrors,
    reviewed: false, notes: null,
  };

  // 9b. 项目级架构画像：分层结构 / 架构风格 / 健康度 / 能力清单 / 自然语言总结
  const profile = buildProjectProfile({
    framework: scan.framework,
    frameworkLabel: project.frameworkLabel,
    fileObjects, modules, domains, routes,
    components, stores, hooks, services, userScripts,
    dependencies, cycles, orphanCandidates, analysisErrors,
    deadTypeCount: interfaces.filter((i) => i.deadCandidate).length + classes.filter((c) => c.deadCandidate).length,
    deadFunctionCount: methods.filter((m) => m.deadCandidate).length + scriptFunctions.filter((f) => f.deadCandidate).length,
    deadExportCount: deadExportCandidates.reduce((a, d) => a + d.names.length, 0),
  });
  project.architecture = profile.architecture;
  project.health = profile.health;
  project.capabilities = profile.capabilities;
  project.summary = profile.summary;

  const dataMap = {
    _meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cycles,
      orphanCandidates,
      deadExportCandidates,
      unmatchedFrontendCalls,
      // v0.42.0 RPC 链覆盖度：无服务端路由或无 Python 端点时为 null（该维度不适用）
      rpcChain: rpcChainStats,
      // v0.35.0 解析覆盖度（借鉴 GitNexus resolution-outcome.ts）
      // 关键派生指标：importResolutionRate（解析成功/总尝试）让 agent 一眼看到"图谱完整度"
      resolutionStats: {
        ...resolutionStats,
        importResolutionRate: resolutionStats.totalImportAttempts > 0
          ? Number((resolutionStats.totalResolvedImports / resolutionStats.totalImportAttempts).toFixed(4))
          : 1.0,
        fuzzyLinkCount: resolutionStats.vueGlobalFallbackCount + resolutionStats.vueSameFileFallbackCount
          + resolutionStats.autoImportedUsesStoreCount + resolutionStats.propEdgeSourceMissingCount,
      },
      objectCounts: {
        Module: modules.length, SourceFile: fileObjects.length, Component: components.length,
        Hook: hooks.length, Store: stores.length, Service: services.length,
        Interface: interfaces.length, Class: classes.length, Trait: traits.length, Method: methods.length,
        PropEdge: propEdges.length,
        Route: routes.length, Dependency: dependencies.length,
        UserScript: userScripts.length, GmApiUsage: gmApiUsages.length,
        InjectionPoint: injectionPoints.length, NetworkEndpoint: networkEndpoints.length,
        ScriptFunction: scriptFunctions.length, Domain: domains.length,
        // v0.38.0: Shell / CMake / PKGBUILD / Nix 维度
        ShellScript: shellScripts.length, PsScript: psScripts.length,
        BashFunction: bashFunctions.length, PsFunction: psFunctions.length,
        BashBuiltin: bashBuiltins.length, Cmdlet: cmdlets.length,
        CMakeModule: cmakeModules.length, CMakeTarget: cmakeTargets.length,
        CMakeFunction: cmakeFunctions.length, CMakeOption: cmakeOptions.length,
        ArchPackage: archPackages.length, ArchPackageFunction: archPackageFunctions.length,
        NixFlake: nixFlakes.length, NixPackage: nixPackages.length, NixInput: nixInputs.length,
        // v0.39.0 ROS 2 维度
        RosNode: rosNodes.length, RosChannel: rosChannels.length, RosLaunch: rosLaunches.length,
      },
    },
    Project: [project],
    Module: modules,
    SourceFile: fileObjects,
    Component: components,
    Hook: hooks,
    Store: stores,
    Service: services,
    Interface: interfaces,
    Class: classes,
    Trait: traits,
    Method: methods,
    PropEdge: propEdges,
    Route: routes,
    Dependency: dependencies,
    UserScript: userScripts,
    GmApiUsage: gmApiUsages,
    InjectionPoint: injectionPoints,
    NetworkEndpoint: networkEndpoints,
    ScriptFunction: scriptFunctions,
    // v0.38.0: Shell / CMake / PKGBUILD / Nix 维度
    ShellScript: shellScripts,
    PsScript: psScripts,
    BashFunction: bashFunctions,
    PsFunction: psFunctions,
    BashBuiltin: bashBuiltins,
    Cmdlet: cmdlets,
    CMakeModule: cmakeModules,
    CMakeTarget: cmakeTargets,
    CMakeFunction: cmakeFunctions,
    CMakeOption: cmakeOptions,
    ArchPackage: archPackages,
    ArchPackageFunction: archPackageFunctions,
    NixFlake: nixFlakes,
    NixPackage: nixPackages,
    NixInput: nixInputs,
    Domain: domains,
    // v0.39.0 ROS 2 维度
    RosNode: rosNodes,
    RosChannel: rosChannels,
    RosLaunch: rosLaunches,
  };
  // v0.38.0: 边集合(简化为 SourceFile 容器下挂,挂在 _meta 上以免破坏既有 schema)
  dataMap._meta.shellEdges = { callsFunction, usesBuiltin, readsCliParam, subdirIncludes, declaresOption, addsDependency, targetsInclude };
  // v0.39.0: ROS 2 边
  //   declaresChannel：RosNode → RosChannel（节点声明的 pub/sub/service/timer/param 等）
  //   launchesNode：RosLaunch → RosNode（launch 启动的 ROS 节点，按 package + executable 匹配到已有 RosNode）
  //   launchesLaunch：RosLaunch → RosLaunch（IncludeLaunchDescription 嵌套）
  {
    const rosEdges = { declaresChannel: [], launchesNode: [], launchesLaunch: [] };
    // declaresChannel
    for (const ch of rosChannels) {
      rosEdges.declaresChannel.push({ from: ch.nodeId, to: ch.id, line: ch.line, relPath: ch.relPath });
    }
    // launchesNode / launchesLaunch
    const rosNodeByName = new Map();
    for (const n of rosNodes) {
      const key = `${n.relPath}#${n.name}`;
      rosNodeByName.set(key, n.id);
    }
    for (const lf of rosLaunches) {
      for (const n of lf.nodes ?? []) {
        if (!n.package || !n.executable) continue;
        // 启发式匹配：同包内名字一致的 RosNode 视为 launch 启动对象
        let matched = null;
        for (const rn of rosNodes) {
          if (rn.name === n.name) { matched = rn.id; break; }
        }
        if (matched) {
          rosEdges.launchesNode.push({ from: lf.id, to: matched, line: n.line, relPath: lf.relPath, package: n.package, executable: n.executable });
        } else {
          // 未匹配到具体节点类：把 launch 节点记为待 agent 解析的占位
          rosEdges.launchesNode.push({ from: lf.id, to: null, line: n.line, relPath: lf.relPath, package: n.package, executable: n.executable, name: n.name, unresolved: true });
        }
      }
      for (const inc of lf.includeLaunch ?? []) {
        if (!inc.path) continue;
        // inc.path 形如 "os.path.join(pkg, 'launch', 'localization_launch.py')" —— 只取最后一个 .py 段
        const segM = /([\w\-]+\.launch\.py)/.exec(inc.path);
        if (segM) {
          const targetName = segM[1];
          const target = rosLaunches.find((l) => l.relPath.endsWith(targetName));
          if (target) rosEdges.launchesLaunch.push({ from: lf.id, to: target.id, line: inc.line, relPath: lf.relPath });
        }
      }
    }
    dataMap._meta.rosEdges = rosEdges;
  }
  // v0.40.0: 跨语言脚本匹配（同工作流在多语言下的并行实现）
  //   匹配键：Python 文件基名（去 .py） vs PowerShell 函数 Noun 部分
  //   例：CreateVirtualDiskREDFISH.py ↔ Invoke-CreateVirtualDiskREDFISH（verb=Invoke, noun=CreateVirtualDiskREDFISH）
  // 匹配范围：1) Python 顶层文件（含 def main() 的脚本） vs 2) PowerShell 顶层 function 节点
  {
    const crossLangEdges = [];
    // 收集 Python 端 crossLangKey 索引（用 fileObjects 的 path 反查 facts）
    const pyKeyToFile = new Map();
    for (const f of fileObjects) {
      const fPath = f.path ?? f.relPath;
      if (!fPath?.endsWith('.py')) continue;
      const pyFacts = factsMap.get(fPath);
      if (!pyFacts?.crossLangKey) continue;
      pyKeyToFile.set(pyFacts.crossLangKey, { relPath: fPath, fileId: f.id, kind: 'py' });
    }
    // 收集 PS 端 crossLangKey 索引（verbNoun.noun 或函数名）
    for (const pf of psFunctions) {
      if (!pf.crossLangKey) continue;
      const pyEntry = pyKeyToFile.get(pf.crossLangKey);
      if (!pyEntry) continue;
      crossLangEdges.push({
        from: pyEntry.fileId,
        to: pf.id,
        key: pf.crossLangKey,
        py: pyEntry.relPath,
        ps: pf.filePath ?? pf.path ?? pf.relPath ?? null,
      });
    }
    // 反向：Python 端有 key 但 PS 没有函数匹配 → 仍记为 unresolved，方便 agent 补全
    for (const [key, pyEntry] of pyKeyToFile.entries()) {
      const matched = crossLangEdges.find((e) => e.py === pyEntry.relPath);
      if (matched) continue;
      crossLangEdges.push({
        from: pyEntry.fileId,
        to: null,
        key,
        py: pyEntry.relPath,
        ps: null,
        unresolved: true,
      });
    }
    dataMap._meta.crossLangEdges = crossLangEdges;
  }
  report('build:done', {
    methodCount: methods.length,
    interfaceCount: interfaces.length,
    classCount: classes.length,
    cycles: cycles.length,
  });
  return dataMap;
}
