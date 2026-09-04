// 相位 4（buildOntologyData 拆分）：全路由族（Overlay/JSX/Vue/Flutter/Python/PHP/Go/Next）
// + ROS 2 实体聚合 + 前后端逻辑映射 + RPC 双向链
// 原为 builder.js 内联代码段（"7. Overlay 路由" 至 "7e. Next.js App Router 路由"），逻辑不变。
import path from 'node:path';
import fs from 'node:fs';
import { analyzeOverlayRoutes, analyzeJsxRoutes, analyzeDataRouterRoutes } from '../analyzers/overlayAnalyzer.js';
import { analyzeNextAppRoutes } from '../analyzers/nextAppAnalyzer.js';
import { uniqueId } from './builderUtils.js';
import { SERVER_API_ROUTE_TYPES, apiPathSegments, matchApiRoute, matchApiRouteEx, linkRouteToEndpoint } from './rpcMatch.js';
import { loadApiRouteRules } from './apiRouteRules.js';

export function builderRoutesPhase(ctx) {
  const {
    projectRoot, scan, factsMap, fileObjectByPath, components, componentsByFile,
    resolutionStats, resolver, getFacts, methodKey, goResolver, methods, networkEndpoints,
  } = ctx;

  // 7. Overlay 路由（自定义 overlayGroups/lazyImports 体系）+ React JSX 声明式路由（react-router <Routes>/<Route>）
  const rawRoutes = [
    ...analyzeOverlayRoutes(projectRoot, resolver, getFacts, scan.files),
    ...analyzeJsxRoutes(projectRoot, resolver, getFacts, scan.files),
    ...analyzeDataRouterRoutes(projectRoot, resolver, getFacts, scan.files),
  ];
  const knownRouteIds = new Set(rawRoutes.map((r) => r.overlayId));
  const routeIdsUsed = new Set();
  const routes = [];
  const lazyReferencedFiles = new Set();
  for (const [relPath, facts] of factsMap) {
    for (const w of facts.lazyWrappers) {
      const r = resolver.resolve(relPath, w.importPath);
      if (r.kind === 'internal') lazyReferencedFiles.add(r.file);
      else resolutionStats.unresolvedDynamicImportsCount += 1;
    }
  }
  for (const route of rawRoutes) {
    const componentFile = route.componentFile;
    if (componentFile) lazyReferencedFiles.add(componentFile);
    let navigatesTo = [...route.factoryNavigatesTo];
    if (componentFile && factsMap.has(componentFile)) {
      navigatesTo.push(...factsMap.get(componentFile).overlayOpens.map((o) => o.target));
    }
    // 布局外壳导航（数据路由）：布局 componentFile 及其直接 import 的内部文件（如 Sidebar）
    // 的 overlayOpens 并入子路由——侧边栏导航对所有子页面可达
    for (const lf of route.layoutFiles ?? []) {
      if (lf === componentFile) continue;
      if (factsMap.has(lf)) navigatesTo.push(...factsMap.get(lf).overlayOpens.map((o) => o.target));
      const layoutFileObj = fileObjectByPath.get(lf);
      for (const impId of layoutFileObj?.importIds ?? []) {
        if (!impId.startsWith('file:')) continue;
        const impFile = impId.slice('file:'.length);
        if (impFile === componentFile || !factsMap.has(impFile)) continue;
        navigatesTo.push(...factsMap.get(impFile).overlayOpens.map((o) => o.target));
      }
    }
    navigatesTo = [...new Set(navigatesTo)].filter((id) => knownRouteIds.has(id));
    const compId = componentFile
      ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
        ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
      : null;
    const routeId = uniqueId(`route:${route.overlayId}`, routeIdsUsed);
    routes.push({
      id: routeId,
      overlayId: route.overlayId,
      name: route.overlayId,
      routePath: route.routePath,
      backTarget: route.backTarget,
      hidesNav: route.hidesNav,
      domain: route.domain,
      group: route.group,
      componentRef: route.componentRef,
      componentFileId: componentFile ? `file:${componentFile}` : null,
      componentId: compId,
      navigatesToIds: navigatesTo.map((id) => `route:${id}`),
      hasPropsFactory: route.hasPropsFactory,
      factoryProps: route.factoryProps ?? [],
      routeType: route.routeType ?? 'overlay',
      rawPath: null, layoutFileIds: [], specialFiles: [],
      isDynamic: null, isClient: null, apiMethods: null,
      reviewed: false, notes: null,
    });
    if (compId) {
      const comp = components.find((c) => c.id === compId);
      if (comp) {
        comp.routeIds.push(routeId);
        // React 页面组件升级：pages/ 目录下被路由直接引用的 common 组件视为 page
        if (route.routeType === 'react' && comp.kind === 'common' && comp.filePath?.includes('/pages/')) {
          comp.kind = 'page';
        }
      }
    }
  }

  // 7b. Vue Router 路由：RouteRecordRaw 显式声明 + views/pages 下 .vue 文件路由推导
  const vueRoutes = [];
  const explicitRouteFiles = new Set();
  for (const [relPath, facts] of factsMap) {
    for (const vr of facts.vueRoutes ?? []) {
      let componentFile = null;
      if (vr.specifier) {
        const r = resolver.resolve(relPath, vr.specifier);
        if (r.kind === 'internal') componentFile = r.file;
      }
      if (componentFile) explicitRouteFiles.add(componentFile);
      vueRoutes.push({ ...vr, componentFile, fromFile: relPath, fileBased: false });
    }
  }
  for (const relPath of scan.files) {
    if (!relPath.endsWith('.vue')) continue;
    if (explicitRouteFiles.has(relPath)) continue;
    const m = relPath.match(/^src\/(views|pages)\/(.+\.vue)$/);
    if (!m) continue;
    let rest = m[2].replace(/\/index\.vue$/, '').replace(/\.vue$/, '');
    if (rest === 'index') rest = ''; // src/views/index.vue → 根路径 '/'
    let routePath = rest ? `/${rest}` : '/';
    if (rest.includes('[')) routePath = '/:pathMatch(.*)*'; // [...all].vue catch-all
    const facts = factsMap.get(relPath);
    vueRoutes.push({
      path: routePath,
      name: facts.vueRouteMeta?.name ?? null,
      metaTitle: facts.vueRouteMeta?.title ?? null,
      componentRef: relPath,
      specifier: null,
      componentFile: relPath,
      fromFile: relPath,
      fileBased: true,
    });
  }
  const vueRouteIds = new Set();
  const vueRouteByPath = new Map();
  for (const vr of vueRoutes) {
    const id = uniqueId(`route:${vr.path}`, vueRouteIds);
    vueRouteByPath.set(vr.path, id);
    const compId = vr.componentFile
      ? ((componentsByFile.get(vr.componentFile) ?? []).find((c) => c.isPrimary)?.id
        ?? (componentsByFile.get(vr.componentFile) ?? [])[0]?.id ?? null)
      : null;
    const seg = vr.path.split('/').filter(Boolean)[0];
    // 顶层段为动态参数（:id）或 catch-all（(.*)）时无稳定语义，归入 root
    const domain = !seg || seg.startsWith(':') || seg.includes('(') ? 'root' : seg;
    routes.push({
      id,
      overlayId: vr.path,
      name: vr.name ?? vr.path,
      routePath: vr.path,
      backTarget: null,
      hidesNav: null,
      domain,
      group: vr.fromFile,
      componentRef: vr.componentRef,
      componentFileId: vr.componentFile ? `file:${vr.componentFile}` : null,
      componentId: compId,
      navigatesToIds: [],
      hasPropsFactory: false,
      factoryProps: [],
      routeType: 'vue',
      rawPath: null, layoutFileIds: [], specialFiles: [],
      isDynamic: null, isClient: null, apiMethods: null,
      description: vr.metaTitle ?? null,
      reviewed: false, notes: null,
    });
    if (compId) {
      const comp = components.find((c) => c.id === compId);
      if (comp) comp.routeIds.push(id);
    }
  }

  // 7c. vue-router 导航边：文件内 router.push('/path') 调用 → 文件所属路由 → 目标路由
  const vueRouteOwner = new Map();
  for (const vr of vueRoutes) {
    if (!vr.componentFile) continue;
    if (!vueRouteOwner.has(vr.componentFile)) vueRouteOwner.set(vr.componentFile, []);
    vueRouteOwner.get(vr.componentFile).push(vueRouteByPath.get(vr.path));
  }
  for (const [relPath, facts] of factsMap) {
    const ownerIds = vueRouteOwner.get(relPath);
    if (!ownerIds || ownerIds.length === 0) continue;
    for (const o of facts.overlayOpens) {
      if (!o.target.startsWith('/')) continue; // 仅 Vue 路由 path（React overlay id 不参与）
      const toId = vueRouteByPath.get(o.target);
      if (!toId) continue;
      for (const ownerId of ownerIds) {
        const route = routes.find((r) => r.id === ownerId);
        if (route && !route.navigatesToIds.includes(toId)) route.navigatesToIds.push(toId);
      }
    }
  }

  // 7c-b. Flutter GoRoute 路由（dartRoutes：path/builderWidget，跨文件组件解析 + 导航边）
  const dartRouteIds = new Set(routes.map((r) => r.id));
  const dartRouteByPath = new Map();
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.dartRoutes?.length) continue;
    for (const dr of facts.dartRoutes) {
      if (!dr.path) continue;
      // builderWidget → 导入来源文件中的组件（具名导入优先；通配导入按目标文件组件名匹配；本文件组件兜底）
      let componentFile = null;
      if (dr.builderWidget && facts.imports) {
        for (const imp of facts.imports) {
          const named = (imp.names ?? []).find((n) => (n.imported === dr.builderWidget || n.local === dr.builderWidget) && n.imported !== '*');
          if (named) {
            const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
            if (r.kind === 'internal') { componentFile = r.file; break; }
          }
        }
        if (!componentFile) {
          for (const imp of facts.imports) {
            const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
            if (r.kind !== 'internal') continue;
            if ((componentsByFile.get(r.file) ?? []).some((c) => c.name === dr.builderWidget)) {
              componentFile = r.file;
              break;
            }
          }
        }
        if (!componentFile && (componentsByFile.get(relPath) ?? []).some((c) => c.name === dr.builderWidget)) {
          componentFile = relPath;
        }
      }
      const id = uniqueId(`route:${dr.path}`, dartRouteIds);
      dartRouteByPath.set(dr.path, id);
      const compId = componentFile
        ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.name === dr.builderWidget)?.id
          ?? (componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
          ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
        : null;
      const seg = dr.path.split('/').filter(Boolean)[0];
      const domain = !seg || seg.startsWith(':') ? 'root' : seg;
      routes.push({
        id,
        overlayId: dr.path,
        name: dr.name ?? dr.path,
        routePath: dr.path,
        backTarget: null,
        hidesNav: null,
        domain,
        group: relPath,
        componentRef: dr.builderWidget,
        componentFileId: componentFile ? `file:${componentFile}` : null,
        componentId: compId,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: 'flutter',
        rawPath: null, layoutFileIds: [], specialFiles: [],
        isDynamic: null, isClient: null, apiMethods: null,
        reviewed: false, notes: null,
      });
      if (compId) {
        const comp = components.find((c) => c.id === compId);
        if (comp) comp.routeIds.push(id);
      }
    }
  }

  // 7d. Python 路由：FastAPI / Flask / aiohttp / Sanic（pythonAnalyzer.pythonRoutes → Route 实体）
  // 路径前缀：FastAPI APIRouter(prefix='/x') → 所有该文件路由加前缀；Flask Blueprint url_prefix 同理
  {
    const pyRouterPrefix = new Map(); // 变量名 → '/prefix'
    const pyRouteIds = new Set();
    const pyRouteByPath = new Map();
    // 先扫描 router/blueprint 变量定义（顶层赋值）
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.py')) continue;
      // 通过源码内容扫描：facts 不存 stripped 全文，仅有 moduleDocstring / imports / routes
      // 直接尝试从 facts.pythonRoutes 倒推前缀（FastAPI router prefix 体现在 path 上不一定有前缀，
      // 此处用最简单的字符串正则扫描事实中已知的注释/原始结构无法恢复）
      // 改为：直接通过 facts.pythonModuleDocstring + importMap 仍无法获取 prefix
      // 简化为：扫描源文件原始内容（在 getFacts 缓存中可取——但不在 factsMap 中）。fallback：用路由 path 的常量字符串合并启发式
    }
    // 由于 facts 未保留原始 stripped / clean 全文，无法在 builder 阶段解析 router 变量定义。
    // 替代方案：直接读 scan.files 源文件，按行扫描 router/blueprint 变量定义。
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.py')) continue;
      let content;
      try { content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8'); } catch { continue; }
      // 顶层赋值：^name = APIRouter(...) 或 ^name = Blueprint(...)
      const reRouter = /^[ \t]*([A-Za-z_][\w]*)\s*=\s*(?:APIRouter|Blueprint)\s*\(([^)]*)\)/gm;
      let m;
      while ((m = reRouter.exec(content))) {
        const name = m[1];
        const args = m[2];
        const prefixM = /prefix\s*=\s*['"]([^'"]+)['"]/.exec(args);
        const urlPrefixM = /url_prefix\s*=\s*['"]([^'"]+)['"]/.exec(args);
        const prefix = (prefixM?.[1] ?? urlPrefixM?.[1] ?? '').replace(/\/+$/, '');
        if (name && prefix) pyRouterPrefix.set(name, prefix);
      }
    }
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.py') || !facts.pythonRoutes?.length) continue;
      for (const pr of facts.pythonRoutes) {
        const basePath = pyRouterPrefix.get(pr.target) ?? '';
        const fullPath = basePath + pr.path;
        const id = uniqueId(`route:${fullPath}`, pyRouteIds);
        pyRouteByPath.set(fullPath, id);
        const handlerId = methodKey.get(`${relPath}#${pr.handler}`) ?? methodKey.get(`${relPath}##${pr.handler}`) ?? null;
        // FastAPI 端点常见 handler 直接是模块函数（def gpt_search(...)）；按 ownerKind=module 查找
        let compId = handlerId;
        const seg = fullPath.split('/').filter(Boolean)[0];
        const domain = !seg || seg.startsWith(':') || seg.startsWith('{') ? 'root' : seg;
        routes.push({
          id,
          overlayId: fullPath,
          name: pr.handler,
          routePath: fullPath,
          backTarget: null,
          hidesNav: null,
          domain,
          group: relPath,
          componentRef: pr.handler,
          componentFileId: `file:${relPath}`,
          componentId: compId,
          navigatesToIds: [],
          hasPropsFactory: false,
          factoryProps: [],
          routeType: 'python',
          rawPath: pr.path, layoutFileIds: [], specialFiles: [],
          isDynamic: fullPath.includes(':') || fullPath.includes('{'),
          isClient: null,
          apiMethods: pr.method,
          description: null,
          reviewed: false, notes: null,
        });
      }
    }
  }

  // v0.39.0 ROS 2 实体聚合：pythonAnalyzer.ros2NodeClasses / .pythonLaunch / .channels
  //   RosNode（rosnode:）：节点类 + 节点名（super().__init__('name')）+ channels 索引
  //   RosChannel（roschan:）：publisher / subscriber / service / client / timer / action / parameter
  //   RosLaunch（roslaunch:）：launch 文件 + 嵌套节点清单 + args + includeLaunch
  // 节点名（topic / service name）以原始字面量保留（无内联解析；上游 yaml/config 解析留给 agent）
  const rosNodes = [];
  const rosChannels = [];
  const rosLaunches = [];
  const rosNodeKey = new Map(); // `${relPath}#${className}` → RosNode
  const rosChanIds = new Set();
  const rosLaunchIds = new Set();
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.py')) continue;
    // 节点 → RosNode + RosChannel
    for (const nc of facts.ros2NodeClasses ?? []) {
      const nodeId = `rosnode:${relPath}#${nc.name}`;
      const nodeNameHint = (nc.bases ?? []).find((b) => b === 'Node' || b === 'LifecycleNode' || b === 'ComposableNode') ?? null;
      rosNodes.push({
        id: nodeId,
        name: nc.name,
        relPath,
        line: nc.line,
        baseClass: nc.baseClass,
        bases: nc.bases,
        rosHint: nc.rosHint,
        nodeNameHint,
        channelCount: (nc.channels?.publishers?.length ?? 0)
          + (nc.channels?.subscribers?.length ?? 0)
          + (nc.channels?.services?.length ?? 0)
          + (nc.channels?.clients?.length ?? 0)
          + (nc.channels?.timers?.length ?? 0)
          + (nc.channels?.actions?.length ?? 0)
          + (nc.channels?.parameters?.length ?? 0),
        language: 'python',
      });
      rosNodeKey.set(`${relPath}#${nc.name}`, { id: nodeId, channels: nc.channels ?? {} });
      // 通道 → RosChannel
      const pushChannels = (kindArr, chanKind) => {
        if (!kindArr) return;
        for (let i = 0; i < kindArr.length; i += 1) {
          const ch = kindArr[i];
          const id = uniqueId(`roschan:${relPath}#${nc.name}#${chanKind}#${i}`, rosChanIds);
          const chName = ch.topic || ch.name || ch.srvType || ch.actionType || ch.period || ch.name || `${chanKind}#${i}`;
          rosChannels.push({
            id,
            kind: chanKind,
            nodeId,
            relPath,
            line: ch.line,
            msgType: ch.msgType ?? null,
            srvType: ch.srvType ?? null,
            actionType: ch.actionType ?? null,
            name: chName,
            topic: ch.topic ?? null,
            period: ch.period ?? null,
            callback: ch.callback ?? null,
            qos: ch.qos ?? null,
            default: ch.default ?? null,
            language: 'python',
          });
        }
      };
      pushChannels(nc.channels?.publishers, 'publisher');
      pushChannels(nc.channels?.subscribers, 'subscription');
      pushChannels(nc.channels?.services, 'service');
      pushChannels(nc.channels?.clients, 'client');
      pushChannels(nc.channels?.timers, 'timer');
      pushChannels(nc.channels?.actions, 'action');
      pushChannels(nc.channels?.parameters, 'parameter');
    }
    // launch 文件 → RosLaunch
    if (facts.pythonLaunch?.isLaunch) {
      const lf = facts.pythonLaunch;
      const launchId = `roslaunch:${relPath}`;
      rosLaunches.push({
        id: launchId,
        name: lf.entry ?? 'generate_launch_description',
        relPath,
        line: 1,
        entry: lf.entry,
        nodeCount: lf.nodes?.length ?? 0,
        argCount: lf.args?.length ?? 0,
        includeCount: lf.includeLaunch?.length ?? 0,
        processCount: lf.executeProcess?.length ?? 0,
        actionCount: lf.actions?.length ?? 0,
        nodes: lf.nodes ?? [],
        args: lf.args ?? [],
        includeLaunch: lf.includeLaunch ?? [],
        executeProcess: lf.executeProcess ?? [],
        actions: lf.actions ?? [],
        language: 'python',
      });
    }
  }

  // PHP 路由（zentaopms 惯例）：module/<x>/control.php 内 public function xxx → Route(routeType='php')
  // path = /<module>-<method>（与 zentaopms createLink('module','method') 的 URL 形态一致）
  {
    const phpRouteIds = new Set();
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.php') || !facts.routes?.length) continue;
      // handler Method 关联：control 类名 = module 名（zentaopms 命名惯例），按类名查 methodKey
      const ctrlClassMatch = /module\/([^/]+)\/control\.php$/.exec(relPath.replace(/\\/g, '/'));
      const ctrlClass = ctrlClassMatch ? ctrlClassMatch[1] : null;
      for (const r of facts.routes) {
        const id = uniqueId(`route:${r.path}`, phpRouteIds);
        const handlerId = (ctrlClass && methodKey.get(`${relPath}#${ctrlClass}#${r.handler}`)) ?? null;
        routes.push({
          id,
          overlayId: r.path,
          name: r.handler,
          routePath: r.path,
          backTarget: null,
          hidesNav: null,
          domain: r.module ?? 'root',
          group: relPath,
          componentRef: r.handler,
          componentFileId: `file:${relPath}`,
          componentId: handlerId,
          navigatesToIds: [],
          hasPropsFactory: false,
          factoryProps: [],
          routeType: 'php',
          rawPath: r.path, layoutFileIds: [], specialFiles: [],
          isDynamic: false,
          isClient: null,
          apiMethods: null,
          description: null,
          reviewed: false, notes: null,
        });
      }
    }
  }

  // GoRouter 导航边：任意 .dart 文件内 context.go('/path') / context.push(AppRouter.xxx) → 该文件组件所属路由 → 目标路由
  // 常量引用参数（AppRouter.fengshui / home）用全仓库路由常量表回填；动态变量（feature.route）查不到即忽略
  const dartConstPathByName = new Map(); // 全仓库路由常量名 → path（跨文件常量引用回填）
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.dartRouteConstants) continue;
    for (const [name, p] of facts.dartRouteConstants) {
      if (!dartConstPathByName.has(name)) dartConstPathByName.set(name, p);
    }
  }
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart')) continue;
    const opens = (facts.overlayOpens ?? [])
      .map((o) => {
        let t = o.target;
        if (!t.startsWith('/')) {
          const name = t.includes('.') ? t.split('.').pop() : t;
          t = dartConstPathByName.get(name) ?? facts.dartRouteConstants?.get(name) ?? '';
        }
        return t;
      })
      .filter((t) => t.startsWith('/'));
    if (!opens.length) continue;
    const ownerIds = routes.filter((r) => r.componentFileId === `file:${relPath}`).map((r) => r.id);
    for (const o of opens) {
      const toId = dartRouteByPath.get(o);
      if (!toId) continue;
      for (const ownerId of ownerIds) {
        const route = routes.find((r) => r.id === ownerId);
        if (route && !route.navigatesToIds.includes(toId)) route.navigatesToIds.push(toId);
      }
    }
  }

  // 7c-c. Go cobra CLI 命令树 + gin HTTP 路由 → Route
  // cobra：var xxxCmd = &cobra.Command{Use/Short} + AddCommand 边 → 命令链路径（routeType='go-cli'）
  // gin：Group 前缀累积 + .GET/.POST(...) → 完整路径（routeType='go'，apiMethods/middlewares/handler Method 关联）
  const goRouteIds = new Set(routes.map((r) => r.id));
  {
    // --- cobra 命令树（varName 全局首见优先——cobra 命令 var 惯例全仓库唯一，cmd/ 先于 internal/ 扫描） ---
    const commandByVar = new Map();
    const commandByDirVar = new Map(); // `${dir}#${varName}` → varName（跨包限定子命令解析用）
    const commands = [];
    const edgeFiles = []; // {relPath, edges}（命令声明可能晚于 AddCommand 边出现，两遍处理）
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      for (const cmd of facts.goCommands ?? []) {
        if (!commandByVar.has(cmd.varName)) {
          commandByVar.set(cmd.varName, { ...cmd, file: relPath });
          commands.push(commandByVar.get(cmd.varName));
        }
        const dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
        commandByDirVar.set(`${dir}#${cmd.varName}`, cmd.varName);
      }
      if (facts.goCommandEdges?.length) edgeFiles.push({ relPath, facts });
    }
    const cmdEdges = [];
    for (const { facts } of edgeFiles) {
      for (const e of facts.goCommandEdges) {
        if (!e.childPkg) { cmdEdges.push(e); continue; }
        // 跨包限定子命令 host.HostGetCmd → importMap 定位目录 → 该目录声明的命令 var
        let resolved = e.childVar;
        const spec = facts.importMap.get(e.childPkg);
        if (spec) {
          const r = goResolver.resolve(spec);
          if (r.kind === 'internal') {
            const target = commandByDirVar.get(`${r.dir}#${e.childName}`);
            if (target) resolved = target;
          }
        }
        cmdEdges.push({ parentVar: e.parentVar, childVar: resolved });
      }
    }
    const childrenOf = new Map();
    const childVars = new Set();
    for (const e of cmdEdges) {
      if (e.parentVar === e.childVar) continue;
      if (!childrenOf.has(e.parentVar)) childrenOf.set(e.parentVar, []);
      childrenOf.get(e.parentVar).push(e.childVar);
      childVars.add(e.childVar);
    }
    const walkCmd = (varName, chain, depth) => {
      if (depth > 8) return; // 防御环
      const cmd = commandByVar.get(varName);
      if (!cmd) return;
      const use = cmd.use || varName;
      const routePath = chain ? `${chain} ${use}` : use;
      routes.push({
        id: uniqueId(`route:go-cli:${routePath}`, goRouteIds),
        overlayId: `go-cli:${routePath}`,
        name: use,
        routePath,
        backTarget: null, hidesNav: null,
        domain: 'cli',
        group: cmd.file,
        componentRef: cmd.varName,
        componentFileId: `file:${cmd.file}`,
        componentId: null,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: 'go-cli',
        rawPath: null, layoutFileIds: [],
        specialFiles: (cmd.flags ?? []).map((f) => (f.shorthand ? `-${f.shorthand}/--${f.name}` : `--${f.name}`)),
        isDynamic: null, isClient: null, apiMethods: null,
        description: cmd.short,
        reviewed: false, notes: null,
      });
      for (const child of childrenOf.get(varName) ?? []) walkCmd(child, routePath, depth + 1);
    };
    for (const cmd of commands) {
      if (!childVars.has(cmd.varName)) walkCmd(cmd.varName, '', 0);
    }

    // --- gin 路由（handler 'controller.Register' → importMap 定位包目录 → Register 顶层函数 Method） ---
    // 方法名 → [{ id, filePath }]：handlerChain（v1.ApiGroupApp...BaseApi.Register）子树搜索用
    const goRouteMethodNameIndex = new Map();
    for (const m of methods) {
      if (!m.filePath?.endsWith('.go')) continue;
      if (!goRouteMethodNameIndex.has(m.name)) goRouteMethodNameIndex.set(m.name, []);
      goRouteMethodNameIndex.get(m.name).push({ id: m.id, filePath: m.filePath });
    }
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      for (const gr of facts.goRoutes ?? []) {
        let handlerMethodId = null;
        let handlerFile = null;
        // handler 解析三级：pkg.Fn（importMap 直达顶层函数）→ handlerChain（v1.ApiGroupApp...BaseApi.Register
        // 链首 import 别名 → 目标包子树内同名方法搜索，gin-vue-admin 惯例）
        const hm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(gr.handlers?.[0] ?? '');
        if (hm) {
          const spec = facts.importMap.get(hm[1]);
          if (spec) {
            const r = goResolver.resolve(spec);
            if (r.kind === 'internal') {
              handlerFile = r.file;
              for (const f of r.files) {
                const mid = methodKey.get(`${f}##${hm[2]}`);
                if (mid) { handlerMethodId = mid; handlerFile = f; break; }
              }
            }
          }
        }
        if (!handlerMethodId && gr.handlerChain) {
          const cm = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)+)\.([A-Za-z_]\w*)$/.exec(gr.handlerChain);
          if (cm) {
            const spec = facts.importMap.get(cm[1]);
            if (spec) {
              const r = goResolver.resolve(spec);
              if (r.kind === 'internal') {
                for (const f of r.files) {
                  const mid = methodKey.get(`${f}##${cm[3]}`);
                  if (mid) { handlerMethodId = mid; handlerFile = f; break; }
                }
                if (!handlerMethodId) {
                  // 子树内同名方法（任意接收者）；同时记录最近声明文件供跳转
                  for (const cand of goRouteMethodNameIndex.get(cm[3]) ?? []) {
                    if (cand.filePath.startsWith(`${r.dir}/`)) { handlerMethodId = cand.id; handlerFile = cand.filePath; break; }
                  }
                }
              }
            }
          }
        }
        // 域取首个业务段：跳过 api/v1 等网关前缀（后续仍有静态段时）；动态段开头归 root
        const segs = gr.path.split('/').filter(Boolean);
        let si = 0;
        while (si < segs.length - 1 && /^(api|apis|v\d+)$/i.test(segs[si])) si += 1;
        const seg = segs[si] ?? null;
        const domain = !seg || seg.startsWith(':') || seg.startsWith('*') ? 'root' : seg;
        routes.push({
          id: uniqueId(`route:${gr.method} ${gr.path}`, goRouteIds),
          overlayId: `${gr.method} ${gr.path}`,
          name: gr.path,
          routePath: gr.path,
          backTarget: null, hidesNav: null,
          domain,
          group: relPath,
          componentRef: gr.handlers?.[0] ?? null,
          componentFileId: `file:${handlerFile ?? relPath}`,
          componentId: handlerMethodId, // 复用 componentId 承载 handler Method（viewer 按 routeType='go' 渲染方法链接）
          navigatesToIds: [],
          hasPropsFactory: false,
          factoryProps: [],
          routeType: 'go',
          rawPath: null, layoutFileIds: [],
          specialFiles: [],
          middlewares: gr.middlewares ?? [],
          isDynamic: /\/[:*]/.test(gr.path),
          isClient: null,
          apiMethods: gr.method === 'ANY' ? ['*'] : [gr.method],
          reviewed: false, notes: null,
        });
      }
    }
  }

  // 7c-d. 前后端逻辑映射：tsAnalyzer httpCalls（前端 API.get / axios.x / fetch）↔ go 路由路径匹配
  // :param / *wildcard 通配前端任意段；去 query、尾斜杠归一；method 不一致仍记录（详情可见）
  const unmatchedFrontendCalls = [];
  {
    const goApiRoutes = routes.filter((r) => r.routeType === 'go');
    if (goApiRoutes.length > 0) {
      // v0.42.0: 匹配逻辑上提为公共函数（apiPathSegments / matchApiRoute），供 Python 端点复用
      const routeSegs = goApiRoutes.map((r) => ({ r, segs: apiPathSegments(r.routePath) ?? [] }));
      for (const [relPath, facts] of factsMap) {
        if (/\.(go|rs|dart)$/.test(relPath)) continue;
        for (const call of facts.httpCalls ?? []) {
          const feSegs = apiPathSegments(call.path);
          const route = feSegs ? matchApiRoute(feSegs, routeSegs) : null;
          const fileObj = fileObjectByPath.get(relPath);
          const entry = { fileId: fileObj?.id ?? `file:${relPath}`, filePath: relPath, line: call.line, method: call.method };
          if (route) {
            if (!route.frontendCalls) route.frontendCalls = [];
            if (!route.frontendCalls.some((c) => c.filePath === relPath && c.line === call.line)) {
              route.frontendCalls.push(entry);
            }
            resolutionStats.matchedRouteCount += 1;
          } else {
            unmatchedFrontendCalls.push({ ...entry, path: call.path });
            resolutionStats.unmatchedFrontendCallsCount += 1;
          }
        }
      }
    }
  }

  // 7c-d2. v0.42.0: Python outbound 端点 ↔ 服务端 API 路由 —— 双向 RPC 链
  // 与 7c-d 同源的匹配逻辑，但源侧是 NetworkEndpoint（跨文件聚合后的端点），
  // 目标侧扩到 go + python 两类服务端路由。
  // method 仍为软校验：路径命中即建链，method 是否一致记在 apiMatch.methodMatches
  // （与 7c-d 的"method 不一致仍记录"同哲学，并为候选 3 的跨语言 API diff 留数据）。
  // v0.44.0（ADR 0012 D3/D4）：method 升级为同路径多路由的消解优先级（matchApiRouteEx 阶梯，
  // 不做硬门）；自动未命中后重试人工规则（.nice-aos/api-routes.json），规则命中记 apiMatch.matchedVia。
  let rpcChainStats = null;
  {
    const serverRoutes = routes.filter((r) => SERVER_API_ROUTE_TYPES.includes(r.routeType));
    const pyEndpoints = networkEndpoints.filter((n) => n.direction === 'outbound' && n.lang === 'python');
    if (serverRoutes.length > 0 && pyEndpoints.length > 0) {
      const { rules, warnings: rulesWarnings } = loadApiRouteRules(projectRoot);
      const routeSegsList = serverRoutes.map((r) => ({ r, segs: apiPathSegments(r.routePath) ?? [] }));
      let matched = 0;
      let methodMismatch = 0;
      let ruleMatched = 0;
      for (const ep of pyEndpoints) {
        const segs = apiPathSegments(ep.url);
        if (!segs) continue; // 纯变量 URL，静态不可解析
        const hit = matchApiRouteEx(segs, routeSegsList, { method: ep.methods[0], rules });
        if (!hit) continue;
        const route = hit.route;
        // apiMethods 口径不统一：Go 路由是数组 [method]，Python 路由是裸字符串。
        // 归一为数组，否则字符串上的 includes 会退化成子串匹配（如 'POST'.includes('OST') 误为 true）
        const rawMethods = route.apiMethods ?? [];
        const routeMethods = Array.isArray(rawMethods) ? rawMethods : (rawMethods ? [rawMethods] : []);
        const methodMatches = routeMethods.length === 0 || routeMethods.includes('*') || routeMethods.includes(ep.methods[0]);
        // v0.42.1: 双向字段集中到 helper，避免单边赋值失败导致反向查询失配
        // v0.44.0: 规则命中附 matchedVia 回执（自动命中无该字段）
        const apiMatch = { methodMatches, routeMethods, endpointMethod: ep.methods[0] };
        if (hit.via) apiMatch.matchedVia = hit.via;
        linkRouteToEndpoint(route, ep, apiMatch);
        matched += 1;
        if (hit.via) ruleMatched += 1;
        if (!methodMatches) methodMismatch += 1;
      }
      rpcChainStats = {
        serverRouteCount: serverRoutes.length,
        endpointCount: pyEndpoints.length,
        matched,
        methodMismatch,
        unresolved: pyEndpoints.length - matched,
        ruleMatched,
        rulesCount: rules.length,
        ...(rulesWarnings.length ? { rulesWarnings } : {}),
      };
    }
  }

  // 7e. Next.js App Router 路由（文件约定式：page/route/layout）
  //     导航边仅归属 page 文件内的 Link href / router.push（layout/共享组件文件不归属，避免边爆炸）
  if (scan.framework === 'next') {
    const nextRawRoutes = analyzeNextAppRoutes(projectRoot, scan, resolver, factsMap);
    const nextRouteIds = new Set(routes.map((r) => r.id));
    const nextRouteByPath = new Map();
    for (const route of nextRawRoutes) {
      const componentFile = route.componentFile;
      if (componentFile) lazyReferencedFiles.add(componentFile);
      const compId = componentFile
        ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
          ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
        : null;
      const routeId = uniqueId(`route:${route.overlayId}`, nextRouteIds);
      nextRouteByPath.set(route.routePath, routeId);
      routes.push({
        id: routeId,
        overlayId: route.overlayId,
        name: route.overlayId,
        routePath: route.routePath,
        rawPath: route.rawPath,
        backTarget: route.backTarget,
        hidesNav: route.hidesNav,
        domain: route.domain,
        group: route.group,
        componentRef: route.componentRef,
        componentFileId: componentFile ? `file:${componentFile}` : null,
        componentId: compId,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: route.routeType,
        layoutFileIds: route.layoutFileIds.map((f) => `file:${f}`),
        specialFiles: route.specialFiles,
        isDynamic: route.isDynamic,
        isClient: route.isClient,
        apiMethods: route.apiMethods,
        reviewed: false, notes: null,
      });
      if (compId) {
        const comp = components.find((c) => c.id === compId);
        if (comp) {
          comp.routeIds.push(routeId);
          if (route.routeType === 'next' && comp.kind === 'common') comp.kind = 'page';
        }
      }
    }
    for (const route of nextRawRoutes) {
      if (route.routeType !== 'next') continue;
      const routeObj = routes.find((r) => r.id === nextRouteByPath.get(route.routePath));
      const facts = factsMap.get(route.componentFile);
      if (!routeObj || !facts) continue;
      for (const o of facts.overlayOpens) {
        if (!o.target.startsWith('/')) continue;
        const toId = nextRouteByPath.get(o.target);
        if (!toId || toId === routeObj.id) continue;
        if (!routeObj.navigatesToIds.includes(toId)) routeObj.navigatesToIds.push(toId);
      }
    }
  }

  Object.assign(ctx, {
    routes, lazyReferencedFiles, rosNodes, rosChannels, rosLaunches,
    unmatchedFrontendCalls, rpcChainStats,
  });
}
