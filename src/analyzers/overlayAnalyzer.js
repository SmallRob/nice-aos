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
            hasPropsFactory: node.properties.some((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'props'),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return routes;
}
