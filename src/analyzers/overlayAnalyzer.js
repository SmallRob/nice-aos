import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let ts;
function getTs(projectRoot) {
  if (!ts) {
    for (const base of [projectRoot, process.cwd(), import.meta.url]) {
      try {
        ts = createRequire(base)('typescript');
        return ts;
      } catch { /* 尝试下一个解析路径 */ }
    }
    throw new Error('无法加载 typescript 模块（请先在 nice-aos/ 下执行 npm install）');
  }
  return ts;
}

// props 工厂提取：props: (app) => ({...}) 箭头/函数体为对象字面量时取属性名
function extractFactoryProps(ts, propsProp, sourceFile) {
  const init = propsProp.initializer;
  if (!init || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init))) return [];
  let body = init.body;
  if (ts.isBlock(body)) {
    body = body.statements.find((s) => ts.isReturnStatement(s) && s.expression)?.expression ?? null;
  }
  while (body && ts.isParenthesizedExpression(body)) body = body.expression;
  if (!body || !ts.isObjectLiteralExpression(body)) return [];
  const names = [];
  for (const prop of body.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.name?.getText(sourceFile);
    if (name) names.push(name);
  }
  return names;
}

// 从扫描文件中自动探测 overlay 路由结构（对无该体系的普通 React 项目返回空列表）
// 探测规则：路径含 /overlayGroups/ 或以 overlayGroup.ts 结尾 → group 文件；
//           路径含 /lazyImports/ 或以 lazyImports.ts 结尾 → lazy 文件
function detectOverlayFiles(allFiles) {
  const isTs = (f) => f.endsWith('.ts') && !f.endsWith('.d.ts');
  const groupFiles = allFiles.filter((f) => isTs(f) && (f.includes('/overlayGroups/') || f.endsWith('overlayGroup.ts')));
  const lazyFiles = allFiles.filter((f) => isTs(f) && (f.includes('/lazyImports/') || f.endsWith('lazyImports.ts')));
  return { groupFiles, lazyFiles };
}

export function analyzeOverlayRoutes(projectRoot, resolver, getFacts, allFiles = []) {
  const ts = getTs(projectRoot);
  const { groupFiles, lazyFiles } = detectOverlayFiles(allFiles);

  // name -> { importPath, fromFile } 聚合所有 lazy 包装器
  const lazyMap = new Map();
  for (const file of lazyFiles) {
    const facts = getFacts(file);
    for (const w of facts.lazyWrappers) {
      if (w.name) lazyMap.set(w.name, { importPath: w.importPath, fromFile: file });
    }
  }

  const routes = [];
  for (const groupFile of groupFiles) {
    const facts = getFacts(groupFile);
    const content = fs.readFileSync(path.join(projectRoot, groupFile), 'utf-8').replace(/^\uFEFF/, '');
    const sourceFile = ts.createSourceFile(groupFile, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // 本地包装组件（const XxxRoute: React.FC = ...）的声明范围
    const localDeclarations = new Map();
    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            localDeclarations.set(decl.name.text, { start: stmt.getStart(sourceFile), end: stmt.end });
          }
        }
      }
    }

    function strProp(props, name) {
      const p = props.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === name);
      if (p && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
      return null;
    }

    // 在本地包装组件范围内找 lazyImports.X 引用与导航调用
    function analyzeLocalWrapper(name) {
      const decl = localDeclarations.get(name);
      if (!decl) return { componentFile: null, opens: [] };
      const text = content.slice(decl.start, decl.end);
      const tryResolve = (lazyName) => {
        const lw = lazyMap.get(lazyName);
        const r = resolver.resolve(lw.fromFile, lw.importPath);
        return r.kind === 'internal' ? r.file : null;
      };
      let componentFile = null;
      // 优先精确匹配 lazyImports.X，其次裸标识符；都取文本中最早出现者（条件渲染的主分支）
      const earliest = (pattern) => {
        let best = null;
        for (const lazyName of lazyMap.keys()) {
          const m = text.match(new RegExp(pattern(lazyName)));
          if (m && (best === null || m.index < best.index)) best = { index: m.index, name: lazyName };
        }
        return best?.name ?? null;
      };
      const lazyName = earliest((n) => `\\blazyImports\\.${n}\\b`) ?? earliest((n) => `\\b${n}\\b`);
      if (lazyName) componentFile = tryResolve(lazyName);
      const opens = facts.overlayOpens
        .filter((o) => o.pos >= decl.start && o.pos < decl.end)
        .map((o) => o.target);
      return { componentFile, opens };
    }

    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const idProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'id' && ts.isStringLiteralLike(x.initializer));
        const compProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'component');
        if (idProp && compProp) {
          const start = node.getStart(sourceFile);
          const end = node.end;
          const componentRef = compProp.initializer.getText(sourceFile);
          let componentFile = null;
          let wrapperOpens = [];
          const init = compProp.initializer;

          if (ts.isPropertyAccessExpression(init) && lazyMap.has(init.name.text)) {
            const lw = lazyMap.get(init.name.text);
            componentFile = resolver.resolve(lw.fromFile, lw.importPath);
          } else if (ts.isIdentifier(init) && lazyMap.has(init.text)) {
            const lw = lazyMap.get(init.text);
            componentFile = resolver.resolve(lw.fromFile, lw.importPath);
          } else if (ts.isIdentifier(init) && facts.importMap.has(init.text)) {
            componentFile = resolver.resolve(groupFile, facts.importMap.get(init.text));
          } else if (ts.isCallExpression(init)) {
            const inner = init.arguments.find((a) => ts.isArrowFunction(a));
            const imp = inner && ts.isCallExpression(inner.body) ? inner.body.arguments[0] : null;
            if (imp && ts.isStringLiteralLike(imp)) componentFile = resolver.resolve(groupFile, imp.text);
          } else if (ts.isIdentifier(init)) {
            // 本地包装组件（const XxxRoute: React.FC = ...）
            const wrapper = analyzeLocalWrapper(init.text);
            componentFile = wrapper.componentFile ? { kind: 'internal', file: wrapper.componentFile } : null;
            wrapperOpens = wrapper.opens;
          }
          componentFile = componentFile && componentFile.kind === 'internal' ? componentFile.file : null;

          const navigatesFromFactory = [
            ...facts.overlayOpens
              .filter((o) => o.pos >= start && o.pos < end)
              .map((o) => o.target),
            ...wrapperOpens,
          ];

          const backTargetRaw = strProp(node.properties, 'backTarget');
          const hidesNavProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'hidesNav');
          const hidesNav = hidesNavProp ? hidesNavProp.initializer.getText(sourceFile) === 'true' : true;

          const propsFactoryProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'props');
          const factoryProps = propsFactoryProp ? extractFactoryProps(ts, propsFactoryProp, sourceFile) : [];

          routes.push({
            overlayId: idProp.initializer.text,
            routePath: strProp(node.properties, 'routePath'),
            backTarget: backTargetRaw,
            hidesNav,
            domain: path.basename(groupFile).replace(/\.ts$/, ''),
            group: groupFile,
            componentRef,
            componentFile,
            factoryNavigatesTo: navigatesFromFactory,
            hasPropsFactory: !!propsFactoryProp,
            factoryProps,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return routes;
}

// ---- React JSX 声明式路由（react-router v6/v7 的 <Routes>/<Route path element> 模式）----
// 参考 asdm-admin-web 的 src/AppRoutes.tsx：布局 Route（无 path）+ 绝对/相对 children、
// index 路由、element 嵌套包装（<Guard><Page/></Guard>）、element 变量（createElement 布局）、
// <Navigate to> 重定向（含相对路径，基于所属路由 path 归一为绝对 overlayId）

// 探测候选路由文件：内容同时含 <Routes 与 <Route 的 tsx/jsx 文件
function detectJsxRouteFiles(allFiles, projectRoot) {
  const candidates = [];
  for (const f of allFiles) {
    if (!/\.(tsx|jsx)$/.test(f) || f.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.|__tests__\//.test(f)) continue; // 测试文件中的 mock 路由不参与
    let content;
    try {
      content = fs.readFileSync(path.join(projectRoot, f), 'utf-8');
    } catch {
      continue;
    }
    if (/<Routes\b/.test(content) && /<Route\b/.test(content)) candidates.push(f);
  }
  return candidates;
}

// 函数体内第一个 return 的 JSX（若有）
function findReturnJsx(body) {
  if (!body) return null;
  let found = null;
  (function walk(node) {
    if (found) return;
    if (ts && node.kind === ts.SyntaxKind.ReturnStatement && node.expression) {
      let expr = node.expression;
      if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) found = expr;
    } else {
      node.forEachChild(walk);
    }
  })(body);
  return found;
}

// JSX 树中最深的组件标签（大写开头，PascalCase 组件）
function deepestComponentJsx(jsx) {
  if (!jsx) return null;
  let best = null;
  (function walk(node, depth) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text) && (best === null || depth > best.depth)) {
        best = { name: tag.text, depth, node };
      }
    }
    if (ts.isJsxElement(node)) {
      for (const c of node.children) walk(c, depth + 1);
    } else if (ts.isJsxFragment(node)) {
      for (const c of node.children) walk(c, depth + 1);
    } else if (ts.isJsxExpression(node) && node.expression) {
      walk(node.expression, depth);
    }
  })(jsx, 0);
  return best;
}

// 相对导航目标归一：基于所属路由 path 拼接为绝对 overlayId（/:scopeUid + _settings → /:scopeUid/_settings）
function normalizeNavTarget(to, routePath) {
  if (!to || !routePath || routePath === '*' || to.startsWith('/') || to === '.') return to;
  while (to.startsWith('../')) to = to.slice(3);
  const base = routePath.endsWith('/') ? routePath.slice(0, -1) : routePath;
  return `${base}/${to}`;
}

export function analyzeJsxRoutes(projectRoot, resolver, getFacts, allFiles = []) {
  const tsMod = getTs(projectRoot);
  const routeFiles = detectJsxRouteFiles(allFiles, projectRoot);
  if (routeFiles.length === 0) return [];

  // 文件 AST 缓存：file -> { sourceFile, importMap, localFns, navigates }
  const fileCache = new Map();
  function parseFile(file) {
    if (fileCache.has(file)) return fileCache.get(file);
    const content = fs.readFileSync(path.join(projectRoot, file), 'utf-8').replace(/^\uFEFF/, '');
    const sourceFile = tsMod.createSourceFile(file, content, tsMod.ScriptTarget.Latest, true, tsMod.ScriptKind.TSX);
    const importMap = new Map();
    const localFns = new Map(); // 名 -> { start, end, returnJsx }
    const navigates = []; // { to, pos }（全部 <Navigate> 出现点）
    (function scan(node) {
      if (tsMod.isImportDeclaration(node) && node.importClause && tsMod.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause.name) importMap.set(clause.name.text, node.moduleSpecifier.text);
        const bindings = clause.namedBindings;
        if (bindings && tsMod.isNamedImports(bindings)) {
          for (const el of bindings.elements) importMap.set(el.name.text, node.moduleSpecifier.text);
        }
      } else if (tsMod.isFunctionDeclaration(node) && node.name) {
        localFns.set(node.name.text, {
          start: node.getStart(sourceFile), end: node.end, returnJsx: findReturnJsx(node.body),
        });
      } else if (tsMod.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (tsMod.isIdentifier(decl.name) && decl.initializer && tsMod.isArrowFunction(decl.initializer)) {
            localFns.set(decl.name.text, {
              start: decl.getStart(sourceFile), end: decl.end, returnJsx: findReturnJsx(decl.initializer.body),
            });
          }
        }
      } else if (tsMod.isJsxSelfClosingElement(node) || tsMod.isJsxOpeningElement(node)) {
        const tag = node.tagName;
        if (tsMod.isIdentifier(tag) && tag.text === 'Navigate') {
          const toAttr = (node.attributes?.properties ?? [])
            .find((p) => tsMod.isJsxAttribute(p) && p.name?.getText(sourceFile) === 'to');
          if (toAttr?.initializer && tsMod.isStringLiteral(toAttr.initializer)) {
            navigates.push({ to: toAttr.initializer.text, pos: node.getStart(sourceFile) });
          }
        }
      }
      tsMod.forEachChild(node, scan);
    })(sourceFile);
    const info = { sourceFile, content, importMap, localFns, navigates };
    fileCache.set(file, info);
    return info;
  }

  // 名称 → { componentFile, navigates }：navigates 为所属函数范围内的 <Navigate> 原始 to
  function resolveByName(name, fromFile, importMap, unwrapFn) {
    const spec = importMap.get(name);
    let targetFile = null;
    if (spec) {
      const r = resolver.resolve(fromFile, spec);
      if (r.kind === 'internal') targetFile = r.file;
    }
    if (!targetFile) {
      // 路由文件内的本地组件（如 NewWorkspaceRedirect）：无 import 但有函数声明
      const info = parseFile(fromFile);
      const fn = info.localFns.get(name);
      if (!fn) return { componentFile: null, navigates: [] };
      return {
        componentFile: null,
        navigates: info.navigates.filter((n) => n.pos >= fn.start && n.pos < fn.end).map((n) => n.to),
      };
    }
    const info = parseFile(targetFile);
    const fn = info.localFns.get(name);
    if (!fn) {
      return { componentFile: targetFile, navigates: [] };
    }
    const navs = info.navigates.filter((n) => n.pos >= fn.start && n.pos < fn.end).map((n) => n.to);
    if (!fn.returnJsx) {
      return { componentFile: targetFile, navigates: navs };
    }
    if (!unwrapFn) {
      // element={<X />} 直接标签：X 即组件本体，函数范围仅用于收集重定向
      return { componentFile: targetFile, navigates: navs };
    }
    // element={variable} / createElement(Fn)：变量可能是布局包装函数，取其 return JSX 最深组件
    const dc = deepestComponentJsx(fn.returnJsx);
    if (!dc) return { componentFile: targetFile, navigates: navs };
    const inner = resolveByName(dc.name, targetFile, info.importMap, false);
    return { componentFile: inner.componentFile ?? targetFile, navigates: navs };
  }

  function resolveElement(initializer, fromFile, importMap) {
    let expr = initializer;
    if (!expr) return { componentFile: null, navigates: [] };
    if (tsMod.isJsxExpression(expr)) expr = expr.expression;
    if (!expr) return { componentFile: null, navigates: [] };
    if (tsMod.isJsxElement(expr) || tsMod.isJsxSelfClosingElement(expr) || tsMod.isJsxFragment(expr)) {
      const dc = deepestComponentJsx(expr);
      if (!dc) return { componentFile: null, navigates: [] };
      return resolveByName(dc.name, fromFile, importMap, false);
    }
    if (tsMod.isCallExpression(expr) && expr.expression.getText() === 'createElement') {
      const arg = expr.arguments[0];
      if (arg && tsMod.isIdentifier(arg)) return resolveByName(arg.text, fromFile, importMap, true);
      return { componentFile: null, navigates: [] };
    }
    if (tsMod.isIdentifier(expr)) return resolveByName(expr.text, fromFile, importMap, true);
    return { componentFile: null, navigates: [] };
  }

  const routes = [];
  for (const routeFile of routeFiles) {
    const info = parseFile(routeFile);
    const sourceFile = info.sourceFile;

    // 递归收集 <Route> 元素：parentPath 为布局上下文的绝对 path
    // 基于 JsxElement/JsxSelfClosingElement 识别（单路径遍历），嵌套 children 直接递归
    function walkRoutes(node, parentPath) {
      if (!(tsMod.isJsxElement(node) || tsMod.isJsxSelfClosingElement(node))) {
        tsMod.forEachChild(node, (c) => walkRoutes(c, parentPath));
        return;
      }
      const tagNode = tsMod.isJsxElement(node) ? node.openingElement : node;
      const tag = tagNode.tagName;
      if (!tsMod.isIdentifier(tag) || tag.text !== 'Route') {
        tsMod.forEachChild(node, (c) => walkRoutes(c, parentPath));
        return;
      }
      const attrs = tagNode.attributes?.properties ?? [];
      const attrText = (n) => (attrs.find((p) => tsMod.isJsxAttribute(p) && p.name?.getText(sourceFile) === n));
      const pathAttr = attrText('path');
      const indexAttr = attrText('index');
      const elementAttr = attrText('element');
      const rawPath = pathAttr?.initializer && tsMod.isStringLiteral(pathAttr.initializer)
        ? pathAttr.initializer.text
        : null;
      const isIndex = indexAttr !== undefined;

      let overlayId = null;
      if (rawPath !== null) {
        overlayId = rawPath.startsWith('/') ? rawPath : (parentPath ? normalizeNavTarget(rawPath, parentPath) : `/${rawPath}`);
      } else if (isIndex && parentPath) {
        overlayId = parentPath;
      }

      const elem = resolveElement(elementAttr?.initializer, routeFile, info.importMap);

      if (overlayId) {
        const navigates = elem.navigates.map((to) => normalizeNavTarget(to, overlayId)).filter(Boolean);
        routes.push({
          overlayId,
          routePath: overlayId,
          backTarget: null,
          hidesNav: false,
          domain: overlayId === '/' ? 'root' : overlayId.split('/').filter(Boolean)[0] ?? 'root',
          group: routeFile,
          componentRef: elementAttr ? elementAttr.initializer?.getText(sourceFile) ?? null : null,
          componentFile: elem.componentFile,
          factoryNavigatesTo: navigates,
          hasPropsFactory: false,
          factoryProps: [],
          routeType: 'react',
        });
      }

      // 无 path 的布局 Route：自身不生成对象，children 继承其 path 上下文
      const childParent = overlayId ?? parentPath;
      if (tsMod.isJsxElement(node)) {
        for (const c of node.children) walkRoutes(c, childParent);
      }
    }
    walkRoutes(sourceFile, null);
  }
  return routes;
}
