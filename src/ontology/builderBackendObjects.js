// 相位 3（buildOntologyData 拆分）：后端调用链（Dart/Go/Python）+ 导出索引 + 死代码重判
// + 多语言对象族（油猴/Shell/CMake/PKGBUILD/Nix）+ Vue vclass 类视图实体
// 原为 builder.js 内联代码段（"5b-0b. Dart 方法调用链" 至 "5f. Nix" + "6a. Vue 组件类视图实体" 创建部分），逻辑不变。
// vclass 实体创建保持原有顺序约束：死代码检测与 methodKey 构建之后、renders 回填之前。
import path from 'node:path';
import { uniqueId, dirOf } from './builderUtils.js';
import { buildUserScriptObjects } from './scriptObjects.js';
import { buildPythonOutboundEndpoints } from './outboundEndpoints.js';
import {
  buildShellScriptObjects, buildCMakeObjects, buildArchPackageObjects, buildNixObjects,
} from './infraObjects.js';

export function builderBackendPhase(ctx) {
  const {
    scan, factsMap, fileObjectByPath, resolutionStats, resolver, goResolver,
    resolveRustImport, rustFiles, testNamedRefs,
    compIdByName, componentsByFile,
    interfaces, classes, methods, typeSpanById, refsOutsideSpan,
  } = ctx;

  // 5b-0b. Dart 方法调用链（dartAnalyzer 的 callEdges → Method.callIds / calledByIds / compCallIds）
  // self：本类方法或本文件顶层函数；static：owner 类方法（本文件优先，导入解析/全仓库唯一名兜底）；
  // widget：组件构造调用 → compCallIds（渲染链，蓝图展示）
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const methodKey = new Map(); // `${filePath}#${ownerName ?? ''}#${name}` → id
  for (const m of methods) {
    m.callIds = m.callIds ?? [];
    m.calledByIds = m.calledByIds ?? [];
    m.compCallIds = m.compCallIds ?? [];
    methodKey.set(`${m.filePath}#${m.ownerName ?? ''}#${m.name}`, m.id);
  }
  const resolveCallTarget = (relPath, clsName, c) => {
    if (c.kind === 'widget') {
      return { type: 'component', id: compIdByName.get(c.to) ?? null };
    }
    const owner = c.kind === 'static' ? (c.owner ?? clsName) : clsName;
    const local = methodKey.get(`${relPath}#${owner}#${c.to}`);
    if (local) return { type: 'method', id: local };
    const facts = factsMap.get(relPath);
    if (c.kind === 'static' && c.owner && facts) {
      // 跨文件静态调用：importMap 定位导入文件
      const spec = facts.importMap.get(c.owner);
      if (spec) {
        const r = resolver.resolve(relPath, spec);
        if (r.kind === 'internal') {
          const id = methodKey.get(`${r.file}#${c.owner}#${c.to}`);
          if (id) return { type: 'method', id };
        }
      }
      const uniq = methods.filter((m) => m.ownerKind === 'class' && m.ownerName === c.owner && m.name === c.to);
      if (uniq.length === 1) return { type: 'method', id: uniq[0].id };
    }
    // 顶层函数兜底：本文件 / 全仓库唯一
    const topLocal = methodKey.get(`${relPath}##${c.to}`);
    if (topLocal) return { type: 'method', id: topLocal };
    if (c.kind === 'self') {
      const tops = methods.filter((m) => m.ownerKind === 'module' && m.name === c.to);
      if (tops.length === 1) return { type: 'method', id: tops[0].id };
    }
    return null;
  };
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.callEdges?.length) continue;
    for (const edge of facts.callEdges) {
      let fromId = null;
      let clsName = null;
      if (edge.from.includes('.')) {
        const dot = edge.from.lastIndexOf('.');
        clsName = edge.from.slice(0, dot);
        fromId = methodKey.get(`${relPath}#${clsName}#${edge.from.slice(dot + 1)}`) ?? null;
      } else {
        fromId = methodKey.get(`${relPath}##${edge.from}`) ?? null;
      }
      if (!fromId) continue;
      const fromMethod = methodById.get(fromId);
      if (!fromMethod) continue;
      const seen = new Set();
      for (const c of edge.to) {
        const hit = resolveCallTarget(relPath, clsName, c);
        if (!hit || !hit.id || hit.id === fromId || seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (hit.type === 'method') {
          if (!fromMethod.callIds.includes(hit.id)) fromMethod.callIds.push(hit.id);
          const toM = methodById.get(hit.id);
          if (toM && !toM.calledByIds.includes(fromId)) toM.calledByIds.push(fromId);
        } else {
          if (!fromMethod.compCallIds.includes(hit.id)) fromMethod.compCallIds.push(hit.id);
        }
      }
    }
  }

  // 5b-0c. Go 调用链聚合（goAnalyzer callEdges → Method.callIds / calledByIds）
  // Go 包 = 目录：同包跨文件互调无需 import；跨包调用 pkgAlias.Func() 经 importMap 定位目标包目录；
  // pkgchain（pkg.Var.Chain.Method / baseApi := pkg.Chain 后 baseApi.M）：目标包子树内按方法名搜索（gin-vue-admin ApiGroupApp 惯例）
  {
    const goDirModuleFns = new Map();    // `${dir}#${fnName}` → [methodId]（ownerKind=module）
    const goDirClassMethods = new Map(); // `${dir}#${className}#${methodName}` → methodId
    const goMethodNameIndex = new Map(); // 方法名 → [{ id, filePath }]（pkgchain 子树搜索，词法近似）
    for (const m of methods) {
      if (!m.filePath?.endsWith('.go')) continue;
      const dir = dirOf(m.filePath);
      if (m.ownerKind === 'module') {
        const key = `${dir}#${m.name}`;
        if (!goDirModuleFns.has(key)) goDirModuleFns.set(key, []);
        goDirModuleFns.get(key).push(m.id);
      } else if (m.ownerKind === 'class' && m.ownerName) {
        goDirClassMethods.set(`${dir}#${m.ownerName}#${m.name}`, m.id);
      }
      if (!goMethodNameIndex.has(m.name)) goMethodNameIndex.set(m.name, []);
      goMethodNameIndex.get(m.name).push({ id: m.id, filePath: m.filePath });
    }
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.go') || !facts.callEdges?.length) continue;
      const dir = dirOf(relPath);
      for (const edge of facts.callEdges) {
        let fromId = null;
        if (edge.from.includes('.')) {
          const dot = edge.from.lastIndexOf('.');
          fromId = methodKey.get(`${relPath}#${edge.from.slice(0, dot)}#${edge.from.slice(dot + 1)}`) ?? null;
        } else {
          fromId = methodKey.get(`${relPath}##${edge.from}`) ?? null;
        }
        const fromMethod = fromId ? methodById.get(fromId) : null;
        if (!fromMethod) continue;
        const seen = new Set();
        for (const c of edge.to) {
          let toId = null;
          if (c.kind === 'pkg' || c.kind === 'pkgchain') {
            const r = goResolver.resolve(c.toPkg);
            if (r.kind === 'internal') {
              toId = (goDirModuleFns.get(`${r.dir}#${c.to}`) ?? [])[0] ?? null;
              if (!toId && c.kind === 'pkgchain') {
                // 目标包目录子树内同名方法（任意接收者）：ApiGroupApp.SystemApiGroup.BaseApi.Register 形态
                for (const cand of goMethodNameIndex.get(c.to) ?? []) {
                  if (cand.filePath.startsWith(`${r.dir}/`)) { toId = cand.id; break; }
                }
              }
            }
          } else if (c.kind === 'local') {
            toId = methodKey.get(`${relPath}##${c.to}`) ?? null;
            if (!toId) {
              // 同包其他文件的同名顶层函数（Go 包级可见性，无 import 记录）
              for (const id of goDirModuleFns.get(`${dir}#${c.to}`) ?? []) {
                const m = methodById.get(id);
                if (m && m.filePath !== relPath) { toId = id; break; }
              }
            }
          } else if (c.kind === 'method') {
            toId = goDirClassMethods.get(`${dir}#${c.receiverType}#${c.to}`) ?? null;
          }
          if (!toId || toId === fromId || seen.has(toId)) continue;
          seen.add(toId);
          if (!fromMethod.callIds.includes(toId)) fromMethod.callIds.push(toId);
          const toM = methodById.get(toId);
          if (toM && !toM.calledByIds.includes(fromId)) toM.calledByIds.push(fromId);
        }
      }
    }
  }

  // 5b-0d. Python 调用链聚合（pythonAnalyzer callEdges → Method.callIds / calledByIds）
  // Python 包 = 目录树（与 Go 类似但无 module 声明）：同包跨文件互调无需 import；
  // self.method / cls.method → 同类方法；Class.method → 静态方法 / 跨类调用；local → 同文件顶层 def；
  // pkg.func → 经 importMap 定位目标模块文件
  {
    // 索引：同目录内顶层函数 / 类方法（用于同包跨文件互调）
    const pyDirModuleFns = new Map();    // `${dir}#${fnName}` → [methodId]
    const pyDirClassMethods = new Map(); // `${dir}#${className}#${methodName}` → methodId
    const pyMethodNameIndex = new Map(); // 方法名 → [{ id, filePath }]
    const pyClassNameIndex = new Map();  // 类名 → [{ id, filePath }]
    for (const m of methods) {
      if (!m.filePath?.endsWith('.py')) continue;
      const dir = dirOf(m.filePath);
      if (m.ownerKind === 'module') {
        const key = `${dir}#${m.name}`;
        if (!pyDirModuleFns.has(key)) pyDirModuleFns.set(key, []);
        pyDirModuleFns.get(key).push(m.id);
      } else if (m.ownerKind === 'class' && m.ownerName) {
        pyDirClassMethods.set(`${dir}#${m.ownerName}#${m.name}`, m.id);
      }
      if (!pyMethodNameIndex.has(m.name)) pyMethodNameIndex.set(m.name, []);
      pyMethodNameIndex.get(m.name).push({ id: m.id, filePath: m.filePath });
    }
    for (const c of classes) {
      if (!c.filePath?.endsWith('.py')) continue;
      if (!pyClassNameIndex.has(c.name)) pyClassNameIndex.set(c.name, []);
      pyClassNameIndex.get(c.name).push({ id: c.id, filePath: c.filePath });
    }
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.py') || !facts.callEdges?.length) continue;
      const dir = dirOf(relPath);
      for (const edge of facts.callEdges) {
        let fromId = null;
        let clsName = null;
        if (edge.from.includes('.')) {
          const dot = edge.from.lastIndexOf('.');
          clsName = edge.from.slice(0, dot);
          fromId = methodKey.get(`${relPath}#${clsName}#${edge.from.slice(dot + 1)}`) ?? null;
        } else {
          fromId = methodKey.get(`${relPath}##${edge.from}`) ?? null;
        }
        const fromMethod = fromId ? methodById.get(fromId) : null;
        if (!fromMethod) continue;
        const seen = new Set();
        for (const c of edge.to) {
          let toId = null;
          if (c.kind === 'self' || c.kind === 'cls') {
            // 同类方法（self/cls.method）：先看本类；找不到则全仓库同名方法
            const owner = clsName ?? fromMethod.ownerName;
            if (owner) toId = pyDirClassMethods.get(`${dir}#${owner}#${c.to}`) ?? null;
            if (!toId && owner) {
              for (const cand of pyMethodNameIndex.get(c.to) ?? []) {
                const m2 = methodById.get(cand.id);
                if (m2 && m2.ownerName === owner) { toId = cand.id; break; }
              }
            }
          } else if (c.kind === 'static' && c.owner) {
            // Class.method → 类方法（@staticmethod / @classmethod / 实例方法同名约定）
            toId = pyDirClassMethods.get(`${dir}#${c.owner}#${c.to}`) ?? null;
            if (!toId) {
              for (const cand of pyMethodNameIndex.get(c.to) ?? []) {
                const m2 = methodById.get(cand.id);
                if (m2 && m2.ownerName === c.owner) { toId = cand.id; break; }
              }
            }
          } else if (c.kind === 'ctor') {
            // ClassName(...) 构造：定位类
            const cands = pyClassNameIndex.get(c.to) ?? [];
            toId = cands[0]?.id ?? null;
          } else if (c.kind === 'pkg' && c.owner) {
            // pkg.func → 经 importMap 定位目标文件 → 顶层函数
            const spec = facts.importMap?.get(c.owner) ?? null;
            if (spec) {
              // 简化：用 importMap 命中文件 → 找该文件顶层 def
              const targetFile = (() => {
                // spec 可能为 'package.sub' / 'fromX' / '.' / '..'（相对导入）等
                // 本简化为 spec 末段作为模块名 → 同目录或子目录同名 .py
                const last = spec.split('.').pop();
                if (spec === '.' || spec === '..') return null; // 相对导入需更复杂解析
                if (spec.startsWith('.')) return null;
                for (const f of scan.files) {
                  if (!f.endsWith('.py')) continue;
                  if (f === `${last}.py`) return f;
                  if (f.endsWith(`/${last}.py`)) return f;
                }
                return null;
              })();
              if (targetFile) {
                toId = methodKey.get(`${targetFile}##${c.to}`) ?? null;
                if (!toId) {
                  // 跨目录同包：dirOf(targetFile) 同名顶层函数
                  toId = (pyDirModuleFns.get(`${dirOf(targetFile)}#${c.to}`) ?? [])[0] ?? null;
                }
              }
            }
            // 兜底：当前目录顶层 def
            if (!toId) toId = (pyDirModuleFns.get(`${dir}#${c.to}`) ?? [])[0] ?? null;
          } else if (c.kind === 'local') {
            // 本文件顶层 def / 同包其他文件顶层 def
            toId = methodKey.get(`${relPath}##${c.to}`) ?? null;
            if (!toId) {
              for (const id of pyDirModuleFns.get(`${dir}#${c.to}`) ?? []) {
                const m = methodById.get(id);
                if (m && m.filePath !== relPath) { toId = id; break; }
              }
            }
          }
          if (!toId || toId === fromId || seen.has(toId)) continue;
          seen.add(toId);
          if (!fromMethod.callIds.includes(toId)) fromMethod.callIds.push(toId);
          const toM = methodById.get(toId);
          if (toM && !toM.calledByIds.includes(fromId)) toM.calledByIds.push(fromId);
        }
      }
    }
  }

  // 导出符号的全仓库导入索引（export * 再导出 / 命名空间导入 / 动态 import 的目标文件——无法按名追踪，整文件豁免）
  const indirectlyReferencedFiles = new Set();
  const importedTypeRefs = new Set(); // `targetFile#importedName`
  const rustUsedNames = new Set(); // Rust use 名字全局集合（路径解析失败时的名字级兜底豁免）
  for (const [relPath, facts] of factsMap) {
    const isRust = relPath.endsWith('.rs');
    for (const imp of facts.imports) {
      if (isRust) {
        const r = imp.resolved ?? resolveRustImport(relPath, imp.specifier);
        if (r.kind === 'internal') {
          for (const n of imp.names ?? []) {
            if (n.imported === '*') {
              // 通配 use（use crate::db_v2::*）：mod.rs 可能 re-export 子模块名字（pub use schema::*），
              // 名字不可静态枚举 → 目标文件及其所在目录全部 .rs 文件豁免（宁可漏报不误报）
              indirectlyReferencedFiles.add(r.file);
              const dir = path.posix.dirname(r.file);
              for (const f of rustFiles) {
                if (f.startsWith(dir + '/')) indirectlyReferencedFiles.add(f);
              }
            } else if (n.imported) {
              importedTypeRefs.add(`${r.file}#${n.imported}`);
              rustUsedNames.add(n.imported);
            }
          }
        } else {
          for (const n of imp.names ?? []) {
            if (n.imported && n.imported !== '*') rustUsedNames.add(n.imported);
          }
        }
        continue;
      }
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind !== 'internal') continue;
      if (!imp.names || imp.names.length === 0) {
        indirectlyReferencedFiles.add(r.file);
        continue;
      }
      for (const n of imp.names) {
        if (n.imported === '*') indirectlyReferencedFiles.add(r.file);
        else if (n.imported) importedTypeRefs.add(`${r.file}#${n.imported}`);
      }
    }
  }
  // 导出 Interface/Class/模块函数 的全仓库零导入检测
  const exportedModuleFns = methods.filter((m) => m.ownerKind === 'module' && m.exported);
  for (const e of [...interfaces, ...classes, ...exportedModuleFns]) {
    if (!e.exported || e.deadCandidate) continue;
    if (testNamedRefs.has(`${e.filePath}#${e.name}`)) continue; // 外部测试具名引用 → 真实使用，不判死
    if (e.filePath.endsWith('.go')) continue; // Go 跨包引用走 pkg.Name 标识符（无 import 名记录），由下方包级重判段处理
    if (indirectlyReferencedFiles.has(e.filePath)) continue;
    if (importedTypeRefs.has(`${e.filePath}#${e.name}`)) continue;
    if (e.filePath.endsWith('.rs') && rustUsedNames.has(e.name)) continue; // Rust use 名字级兜底豁免
    const span = typeSpanById.get(e.id);
    if (span && refsOutsideSpan(e.filePath, e.name, span.pos, span.end) === 0) {
      e.deadCandidate = true;
      e.deadReason = '导出但全仓库零导入且本文件零引用';
    }
  }

  // 5b-0d. Go 死代码重判（包级标识符引用）：Go 包 = 目录，同包跨文件共享符号且无 import 记录，
  // 泛 TS 判定（本文件零引用 / 全仓库零导入）对 Go 失真——按「声明至少出现一次」的计数语义重判：
  //   未导出（小写）：包内（同目录全部 .go 文件）引用计数 ≤ 1（仅声明自身）→ 死；
  //   导出（大写）：包内 ≤ 1 且全仓库 ≤ 1 → 死（跨包引用以标识符出现为准，词法近似、宁漏报不误报）
  {
    const goFilesList = scan.files.filter((f) => f.endsWith('.go'));
    if (goFilesList.length > 0) {
      const totalByName = new Map(); // name → 全仓库 .go 标识符出现计数
      const byDirByName = new Map(); // `${dir}#${name}` → 该目录出现计数
      for (const f of goFilesList) {
        const facts = factsMap.get(f);
        const dir = dirOf(f);
        for (const [name, positions] of facts.nameReferences ?? []) {
          totalByName.set(name, (totalByName.get(name) ?? 0) + positions.length);
          const key = `${dir}#${name}`;
          byDirByName.set(key, (byDirByName.get(key) ?? 0) + positions.length);
        }
      }
      const judge = (e, exported) => {
        const dir = dirOf(e.filePath);
        const inPkg = byDirByName.get(`${dir}#${e.name}`) ?? 0;
        if (!exported) {
          e.deadCandidate = inPkg <= 1;
          e.deadReason = e.deadCandidate ? '包内（同目录）零引用' : null;
          return;
        }
        const total = totalByName.get(e.name) ?? 0;
        e.deadCandidate = inPkg <= 1 && total <= 1;
        e.deadReason = e.deadCandidate ? '导出但全仓库零引用' : null;
      };
      for (const e of methods) {
        if (!e.filePath?.endsWith('.go') || e.ownerKind === 'interface') continue; // 接口方法为契约声明，不判死
        // 类方法的 exported 沿用 Go 可见性（首字母大写），collectTypeEntities 的恒 false 仅适用 TS
        judge(e, e.ownerKind === 'module' ? e.exported : /^[A-Z]/.test(e.name));
      }
      for (const e of [...interfaces, ...classes]) {
        if (e.language !== 'go') continue;
        judge(e, e.exported);
      }
    }
  }

  // 5b. 油猴脚本对象（UserScript / GmApiUsage / InjectionPoint / NetworkEndpoint / ScriptFunction）
  // 与 React/Vue 组件体系并存：油猴脚本不产出 Component/Store，而是产出注入点、网络端点与脚本函数
  const userScripts = [];
  const gmApiUsages = [];
  const injectionPoints = [];
  const networkEndpoints = [];
  const scriptFunctions = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isUserScript) continue;
    const set = buildUserScriptObjects(relPath, facts, fileObjectByPath.get(relPath));
    userScripts.push(set.userScript);
    gmApiUsages.push(...set.gmApiUsages);
    injectionPoints.push(...set.injectionPoints);
    networkEndpoints.push(...set.networkEndpoints);
    scriptFunctions.push(...set.scriptFunctions);
  }

  // 5b-1. v0.41.0: Python HTTP 客户端（requests / urllib / httpx / aiohttp）→ outbound NetworkEndpoint
  // 还 v0.40.0 的技术债：D3 已在 analyzer 层抽出 httpClientCalls，但本体层从未消费，
  // 导致 iDRAC 一类仓库的 2000+ outbound URL 全部不进图谱。此处接上本体层。
  {
    const usedIds = new Set(networkEndpoints.map((n) => n.id));
    const pyOutbound = buildPythonOutboundEndpoints(scan.files, factsMap, fileObjectByPath, usedIds);
    networkEndpoints.push(...pyOutbound);
  }

  // 5c. v0.38.0: Shell 脚本（ShellScript / PsScript / BashFunction / PsFunction / BashBuiltin / Cmdlet + 边）
  const shellScripts = [];
  const psScripts = [];
  const bashFunctions = [];
  const psFunctions = [];
  const bashBuiltins = [];
  const cmdlets = [];
  const shellCliParams = [];
  const shellDownloadFacts = [];
  const callsFunction = [];
  const usesBuiltin = [];
  const readsCliParam = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isShellScript) continue;
    const set = buildShellScriptObjects(relPath, facts);
    if (facts.shellLanguage === 'powershell') {
      psScripts.push(set.mainObj);
      psFunctions.push(...set.fnObjects);
      cmdlets.push(...set.builtinObjects);
    } else {
      shellScripts.push(set.mainObj);
      bashFunctions.push(...set.fnObjects);
      bashBuiltins.push(...set.builtinObjects);
    }
    shellCliParams.push(...set.cliParamObjects);
    shellDownloadFacts.push(...set.downloadFacts);
    callsFunction.push(...set.callsFunction);
    usesBuiltin.push(...set.usesBuiltin);
    readsCliParam.push(...set.readsCliParam);
  }

  // 5d. v0.38.0: CMake 模块（CMakeModule / CMakeTarget / CMakeFunction / CMakeOption + 边）
  const cmakeModules = [];
  const cmakeTargets = [];
  const cmakeFunctions = [];
  const cmakeOptions = [];
  const subdirIncludes = [];
  const declaresOption = [];
  const addsDependency = [];
  const targetsInclude = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isCMake) continue;
    const set = buildCMakeObjects(relPath, facts);
    cmakeModules.push(set.mainObj);
    cmakeTargets.push(...set.targetObjects);
    cmakeFunctions.push(...set.fnObjects);
    cmakeOptions.push(...set.optionObjects);
    subdirIncludes.push(...set.subdirIncludes);
    declaresOption.push(...set.declaresOption);
    addsDependency.push(...set.addsDependency);
    targetsInclude.push(...set.targetsInclude);
    callsFunction.push(...set.callsFunction);
  }

  // 5e. v0.38.0: Arch PKGBUILD
  const archPackages = [];
  const archPackageFunctions = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isPkgbuild) continue;
    const set = buildArchPackageObjects(relPath, facts);
    archPackages.push(set.mainObj);
    archPackageFunctions.push(...set.fnObjects);
  }

  // 5f. v0.38.0: Nix flake / *.nix
  const nixFlakes = [];
  const nixPackages = [];
  const nixInputs = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isNix) continue;
    const set = buildNixObjects(relPath, facts);
    nixFlakes.push(set.mainObj);
    nixInputs.push(...set.inputObjects);
    nixPackages.push(...set.pkgObjects);
  }

  // 6a. Vue 组件类视图实体：.vue 主组件 → kind='component' 的 Class 实体
  // props 为字段、computed/methods 为方法；renders 组合边回填（目标同为 vclass 才成边）——回填在 renders 关系之后（builderLinksPhase）
  // 插在死代码检测之后，vclass 恒不判死（组件被模板引用，无 import 记录属常态）
  const vclassByCompId = new Map(); // comp:xxx → vclass:xxx
  {
    const vclassIdUsed = new Set();
    const vmethodIdUsed = new Set();
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.vue')) continue;
      const facts = factsMap.get(relPath);
      const fileObj = fileObjectByPath.get(relPath);
      if (!fileObj || !facts?.vueOptions) continue;
      const primary = (componentsByFile.get(relPath) ?? []).find((c) => c.isPrimary)
        ?? (componentsByFile.get(relPath) ?? [])[0];
      if (!primary) continue;
      const opts = facts.vueOptions;
      const id = uniqueId(`vclass:${primary.name}`, vclassIdUsed);
      const entity = {
        id, name: primary.name,
        fileId: fileObj.id, filePath: relPath,
        line: facts.components.find((c) => c.name === primary.name)?.line ?? 1,
        exported: true,
        language: 'vue',
        kind: 'component',
        derives: [],
        fields: opts.propsDefs.map((p) => ({ name: p.name, type: p.type ?? null })),
        variants: [],
        isSingleton: false,
        isWidget: false,
        widgetBase: null,
        isStore: false,
        withNames: [],
        methodIds: [],
        implementsIds: [],
        implementsNames: [],
        extendsId: null, extendsName: null,
        rendersIds: [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const key of [...opts.computedKeys, ...opts.methodKeys]) {
        const mid = uniqueId(`vmethod:${primary.name}.${key}`, vmethodIdUsed);
        methods.push({
          id: mid, name: key,
          ownerKind: 'class', ownerId: id, ownerName: primary.name,
          fileId: fileObj.id, filePath: relPath,
          line: null,
          isStatic: false, isAsync: false, isOverride: false, exported: false,
          signature: null,
          overridesId: null, overriddenByIds: [],
          callIds: [], calledByIds: [], compCallIds: [],
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        });
        entity.methodIds.push(mid);
      }
      classes.push(entity);
      vclassByCompId.set(primary.id, id);
    }
  }

  Object.assign(ctx, {
    methodById, methodKey,
    indirectlyReferencedFiles, importedTypeRefs, rustUsedNames,
    userScripts, gmApiUsages, injectionPoints, networkEndpoints, scriptFunctions,
    shellScripts, psScripts, bashFunctions, psFunctions, bashBuiltins, cmdlets,
    shellCliParams, shellDownloadFacts, callsFunction, usesBuiltin, readsCliParam,
    cmakeModules, cmakeTargets, cmakeFunctions, cmakeOptions,
    subdirIncludes, declaresOption, addsDependency, targetsInclude,
    archPackages, archPackageFunctions, nixFlakes, nixPackages, nixInputs,
    vclassByCompId,
  });
}
