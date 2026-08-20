import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let ts;
// 解析顺序：宿主项目 → 当前工作目录 → nice-aos 自身依赖
function getTs(projectRoot) {
  if (ts) return ts;
  for (const base of [projectRoot, process.cwd(), import.meta.url]) {
    try {
      ts = createRequire(base)('typescript');
      return ts;
    } catch { /* 尝试下一个解析路径 */ }
  }
  throw new Error('无法加载 typescript 模块（请先在 nice-aos/ 下执行 npm install）');
}

const OVERLAY_OPENER_FUNCS = new Set([
  'setActiveOverlay', 'openOverlay', 'pushOverlay', 'navigateToOverlay', 'showOverlay',
]);
const REACT_LAZY_WRAPPERS = new Set(['lazy', 'memo', 'forwardRef', 'React.memo', 'React.forwardRef']);
// vue-router 导航方法（仅当调用主体是 useRouter() 声明的变量时才计入）
const VUE_ROUTER_NAV_METHODS = new Set(['push', 'replace']);

function hasExportModifier(ts, node) {
  if (!ts.canHaveModifiers?.(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(ts, node) {
  if (!ts.canHaveModifiers?.(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function extractJsdoc(ts, node, sourceText) {
  try {
    const docs = ts.getJSDocCommentsAndTags(node);
    for (const doc of docs) {
      if (doc.comment == null) continue;
      if (typeof doc.comment === 'string') return doc.comment.replace(/\s+/g, ' ').trim().slice(0, 200);
      const text = doc.comment.map((part) => part.text ?? '').join('').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 200);
    }
  } catch { /* jsdoc 提取失败不影响主流程 */ }
  return '';
}

function isZustandCreateCall(ts, node, importMap) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return false;
  const source = importMap.get(callee.text);
  return !!source && (source === 'zustand' || source.startsWith('zustand/'));
}

function isPiniaDefineStoreCall(ts, node, importMap) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return false;
  const source = importMap.get(callee.text);
  // auto-import 场景（unplugin-auto-import）无 import 记录；defineStore 是 Pinia 专有 API 名
  return !source || source === 'pinia';
}

// 从节点子树中找第一个动态 import 的模块字符串（路由懒加载 component: () => import('...')）
function findDynamicImportSpec(ts, node) {
  let found = null;
  function visit(n) {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) found = arg.text;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function unwrapStateObject(ts, factoryNode) {
  let body = null;
  if (ts.isArrowFunction(factoryNode) || ts.isFunctionExpression(factoryNode)) {
    body = factoryNode.body;
    if (ts.isBlock(body)) {
      body = body.statements.find((s) => ts.isReturnStatement(s) && s.expression)?.expression ?? null;
    }
  }
  // () => ({...}) 的 body 是 ParenthesizedExpression
  while (body && ts.isParenthesizedExpression(body)) body = body.expression;
  if (body && ts.isObjectLiteralExpression(body)) return body;
  return null;
}

function objectPropKeys(ts, objectNode, sourceFile) {
  const keys = [];
  if (!objectNode) return keys;
  for (const prop of objectNode.properties) {
    if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      // 对象字面量方法简写：login() {} / get x() {}
      const name = prop.name?.getText(sourceFile);
      if (name) keys.push(name);
      continue;
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
      ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
      : prop.name?.getText(sourceFile);
    if (key) keys.push(key);
  }
  return keys;
}

// Pinia defineStore('id', setup | { state, getters, actions }, options?) → 与 zustand 同构的 store 事实
function extractPiniaStore(ts, callNode, sourceFile) {
  const storeId = callNode.arguments[0] && ts.isStringLiteralLike(callNode.arguments[0])
    ? callNode.arguments[0].text
    : null;
  const stateKeys = [];
  const actionKeys = [];
  let hasPersist = false;
  let storageKey = null;

  const setupOrOptions = callNode.arguments[1];
  if (setupOrOptions && (ts.isArrowFunction(setupOrOptions) || ts.isFunctionExpression(setupOrOptions))) {
    // setup store：返回对象中的函数值 → action，其余 → state；shorthand 需回溯 setup 函数体内的函数声明
    const fnNames = new Set();
    const collectFnDecls = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name) {
        fnNames.add(n.name.text);
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const init = n.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fnNames.add(n.name.text);
      } else {
        ts.forEachChild(n, collectFnDecls);
      }
    };
    collectFnDecls(setupOrOptions);
    const returned = unwrapStateObject(ts, setupOrOptions);
    if (returned) {
      for (const prop of returned.properties) {
        if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
          const name = prop.name?.getText(sourceFile);
          if (name) actionKeys.push(name);
          continue;
        }
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
          ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
          : prop.name?.getText(sourceFile);
        if (!key) continue;
        const isAction = (ts.isPropertyAssignment(prop)
            && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)))
          || (ts.isShorthandPropertyAssignment(prop) && fnNames.has(key));
        (isAction ? actionKeys : stateKeys).push(key);
      }
    }
  } else if (setupOrOptions && ts.isObjectLiteralExpression(setupOrOptions)) {
    // options store：state/getters 归 state，actions 归 action
    for (const prop of setupOrOptions.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const section = prop.name?.getText(sourceFile);
      if (section === 'state') {
        stateKeys.push(...objectPropKeys(ts, unwrapStateObject(ts, prop.initializer), sourceFile));
      } else if (section === 'getters' && ts.isObjectLiteralExpression(prop.initializer)) {
        stateKeys.push(...objectPropKeys(ts, prop.initializer, sourceFile));
      } else if (section === 'actions' && ts.isObjectLiteralExpression(prop.initializer)) {
        actionKeys.push(...objectPropKeys(ts, prop.initializer, sourceFile));
      }
    }
  }

  // persist 插件配置（pinia-plugin-persistedstate）：第三参数，或第二参数对象内的 persist 字段
  const persistSources = [callNode.arguments[2], setupOrOptions].filter((x) => x && ts.isObjectLiteralExpression(x));
  for (const src of persistSources) {
    for (const prop of src.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name?.getText(sourceFile) === 'persist') {
        const init = prop.initializer;
        if (init.kind === ts.SyntaxKind.TrueKeyword) {
          hasPersist = true;
        } else if (ts.isObjectLiteralExpression(init)) {
          hasPersist = true;
          for (const p of init.properties) {
            if (ts.isPropertyAssignment(p) && p.name?.getText(sourceFile) === 'key'
                && ts.isStringLiteralLike(p.initializer)) {
              storageKey = p.initializer.text;
            }
          }
        }
      }
    }
  }
  return { id: storeId, stateKeys, actionKeys, hasPersist, storageKey };
}

export function analyzeFile(filePath, content, projectRoot) {
  const ts = getTs(projectRoot);
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content.replace(/^\uFEFF/, ''), ts.ScriptTarget.Latest, true, scriptKind);

  const facts = {
    path: filePath,
    ext: path.extname(filePath).slice(1),
    lineCount: content.split('\n').length,
    imports: [],
    exportSymbols: [],
    jsxTags: new Set(),
    useCalls: [],
    overlayOpens: [],
    zustandCreates: [],
    piniaCreates: [],
    vueRoutes: [],
    lazyWrappers: [],
    hasSingletonClass: false,
    hasClassExport: false,
    importMap: new Map(),
  };

  const recordImport = (node, specifier, isTypeOnly, isDynamic, names) => {
    facts.imports.push({ specifier, isTypeOnly, isDynamic, names, pos: node.getStart(sourceFile) });
  };

  const collectNamedImports = (clause) => {
    const names = [];
    if (clause.name) names.push({ imported: 'default', local: clause.name.text });
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        names.push({ imported: '*', local: bindings.name.text });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          names.push({ imported: el.propertyName?.text ?? el.name.text, local: el.name.text });
        }
      }
    }
    return names;
  };

  // useRouter() 声明的变量名（含解构 { push }），用于归属 vue-router 导航调用
  const routerVarDecls = [];
  const pendingNavCalls = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = collectNamedImports(node.importClause);
      recordImport(node, node.moduleSpecifier.text, !!node.importClause.isTypeOnly, false, names);
      for (const n of names) {
        if (n.imported !== '*') facts.importMap.set(n.local, node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          names.push({ imported: el.propertyName?.text ?? el.name.text, local: null });
        }
      }
      recordImport(node, node.moduleSpecifier.text, !!node.isTypeOnly, false, names);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) recordImport(node, arg.text, false, true, []);
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (OVERLAY_OPENER_FUNCS.has(name)) {
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) {
            facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
          }
        } else if (name === 'useRouter') {
          // 记录 useRouter() 声明的变量（const router = useRouter() / const { push } = useRouter()）
          // 注意：必须置于 /^use[A-Z]/ 分支之前，否则被 useCalls 提前吞掉
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent)) {
            if (ts.isIdentifier(parent.name)) {
              routerVarDecls.push({ name: parent.name.text, pos: node.getStart(sourceFile) });
            } else if (ts.isObjectBindingPattern(parent.name)) {
              for (const el of parent.name.elements) {
                if (ts.isIdentifier(el.name)) routerVarDecls.push({ name: el.name.text, pos: node.getStart(sourceFile) });
              }
            }
          }
        } else if (VUE_ROUTER_NAV_METHODS.has(name)) {
          // push('/path') / replace('/path') 形式（解构自 useRouter 时计入导航）
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) {
            pendingNavCalls.push({ calleeName: name, isProp: false, target: first.text, pos: node.getStart(sourceFile) });
          }
        } else if (/^use[A-Z]/.test(name)) {
          facts.useCalls.push({ name, pos: node.getStart(sourceFile) });
        } else if (name === 'create' || name === 'createStore') {
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            facts.zustandCreates.push({
              varName: parent.name.text,
              callNode: node,
              pos: parent.getStart(sourceFile),
              end: parent.end,
            });
          }
        } else if (name === 'defineStore') {
          // Pinia store：export const useXxxStore = defineStore('id', ...)
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            facts.piniaCreates.push({
              varName: parent.name.text,
              callNode: node,
              pos: parent.getStart(sourceFile),
              end: parent.end,
            });
          }
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && OVERLAY_OPENER_FUNCS.has(node.expression.name.text)) {
        // app.setActiveOverlay('xxx') 形式
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && VUE_ROUTER_NAV_METHODS.has(node.expression.name.text)
        && ts.isIdentifier(node.expression.expression)) {
        // router.push('/path') 形式（router 来自 useRouter() 时计入导航）
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          pendingNavCalls.push({
            calleeName: node.expression.expression.text,
            isProp: true,
            target: first.text,
            pos: node.getStart(sourceFile),
          });
        }
      }
      const calleeText = node.expression.getText(sourceFile);
      if (REACT_LAZY_WRAPPERS.has(calleeText) && facts.importMap.get(calleeText.split('.').pop()) === 'react') {
        const arg = node.arguments[0];
        if (arg && ts.isArrowFunction(arg)) {
          const inner = arg.body;
          if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const spec = inner.arguments[0];
            if (spec && ts.isStringLiteralLike(spec)) {
              const vd = node.parent;
              const varName = vd && ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name) ? vd.name.text : null;
              facts.lazyWrappers.push({ name: varName, importPath: spec.text, pos: node.getStart(sourceFile) });
            }
          }
        }
      }
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) facts.jsxTags.add(tag.text);
      // <Navigate to="/path" /> 重定向（react-router），计入 overlayOpens 供路由导航边使用
      if (tag.text === 'Navigate' && /react-router/.test(facts.importMap.get('Navigate') ?? '')) {
        const attrs = node.attributes?.properties ?? [];
        const toAttr = attrs.find((p) => ts.isJsxAttribute(p) && p.name?.getText(sourceFile) === 'to');
        if (toAttr?.initializer && ts.isStringLiteral(toAttr.initializer)) {
          facts.overlayOpens.push({ target: toAttr.initializer.text, pos: node.getStart(sourceFile) });
        }
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      const exported = hasExportModifier(ts, node);
      if (exported) facts.hasClassExport = true;
      if (node.members.some((m) => ts.isMethodDeclaration(m) && m.name?.getText(sourceFile) === 'getInstance')) {
        facts.hasSingletonClass = true;
      }
    } else if (ts.isExportAssignment(node)) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr) ? expr.text : '<default-anonymous>';
      facts.exportSymbols.push({
        name, kind: ts.isIdentifier(expr) ? 'reexport' : 'default',
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        isDefault: true, isExported: true,
      });
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(ts, node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const initializer = decl.initializer;
        const kind = initializer
          ? (ts.isArrowFunction(initializer) ? 'arrow'
            : ts.isObjectLiteralExpression(initializer) ? 'object'
            : ts.isCallExpression(initializer) ? 'call'
            : 'const')
          : 'const';
        facts.exportSymbols.push({
          name: decl.name.text, kind,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          isDefault: false, isExported: exported,
          node: decl, statementNode: node,
          description: exported ? extractJsdoc(ts, node, content) : '',
        });
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const exported = hasExportModifier(ts, node);
      if (exported || hasDefaultModifier(ts, node)) {
        facts.exportSymbols.push({
          name: node.name.text, kind: 'function',
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          isDefault: hasDefaultModifier(ts, node), isExported: exported,
          node, statementNode: node,
          description: exported ? extractJsdoc(ts, node, content) : '',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // vue-router 导航调用归属：callee 名与更早出现的 useRouter 声明匹配才计入 overlayOpens
  for (const nav of pendingNavCalls) {
    const hit = routerVarDecls.find((d) => d.name === nav.calleeName && d.pos < nav.pos);
    if (hit) facts.overlayOpens.push({ target: nav.target, pos: nav.pos });
  }

  // 「const X = ...; export default X;」分离导出模式：末尾 default 引用回填导出标记
  const defaultReferenced = new Set(
    facts.exportSymbols.filter((s) => s.kind === 'reexport').map((s) => s.name),
  );
  if (defaultReferenced.size > 0) {
    for (const s of facts.exportSymbols) {
      if (defaultReferenced.has(s.name) && !s.isExported) {
        s.isExported = true;
        s.isDefault = true;
      }
    }
  }

  // zustand store 详情（importMap 此刻已完整，import 具有提升语义）
  facts.stores = [];
  for (const entry of facts.zustandCreates) {
    if (!isZustandCreateCall(ts, entry.callNode, facts.importMap)) continue;
    let target = entry.callNode;
    // create<State>()(...) 形式
    if (ts.isCallExpression(target.expression)) target = target.expression;
    let factory = target.arguments[0];
    let hasPersist = false;
    let storageKey = null;
    if (factory && ts.isCallExpression(factory) && ts.isIdentifier(factory.expression)
        && (factory.expression.text === 'persist' || factory.expression.text === 'devtools')) {
      hasPersist = factory.expression.text === 'persist';
      const opts = factory.arguments[1];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name?.getText(sourceFile) === 'name'
              && ts.isStringLiteralLike(prop.initializer)) {
            storageKey = prop.initializer.text;
          }
        }
      }
      factory = factory.arguments[0];
    }
    const stateObj = factory ? unwrapStateObject(ts, factory) : null;
    const stateKeys = [];
    const actionKeys = [];
    if (stateObj) {
      for (const prop of stateObj.properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
            ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
            : prop.name?.getText(sourceFile);
          if (!key) continue;
          const isAction = ts.isPropertyAssignment(prop)
            && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer));
          (isAction ? actionKeys : stateKeys).push(key);
        }
      }
    }
    facts.stores.push({
      name: entry.varName,
      stateKeys, actionKeys,
      hasPersist, storageKey,
      line: sourceFile.getLineAndCharacterOfPosition(entry.pos).line + 1,
      lineCount: sourceFile.text.slice(entry.pos, entry.end).split('\n').length,
    });
  }

  // Pinia store 详情（defineStore 调用，importMap 提升语义同上）
  for (const entry of facts.piniaCreates) {
    if (!isPiniaDefineStoreCall(ts, entry.callNode, facts.importMap)) continue;
    const pinia = extractPiniaStore(ts, entry.callNode, sourceFile);
    facts.stores.push({
      name: entry.varName,
      stateKeys: pinia.stateKeys,
      actionKeys: pinia.actionKeys,
      hasPersist: pinia.hasPersist,
      storageKey: pinia.storageKey,
      line: sourceFile.getLineAndCharacterOfPosition(entry.pos).line + 1,
      lineCount: sourceFile.text.slice(entry.pos, entry.end).split('\n').length,
    });
  }
  delete facts.zustandCreates;
  delete facts.piniaCreates;

  // Vue Router 路由提取：router/ 目录（或导入 vue-router）文件中 path+component 对象 → RouteRecordRaw
  if (filePath.includes('/router/') || [...facts.importMap.values()].some((s) => s === 'vue-router' || s.startsWith('vue-router/'))) {
    const localFunctions = new Map();
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) localFunctions.set(stmt.name.text, stmt);
    }
    const resolveComponentRef = (init) => {
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const spec = findDynamicImportSpec(ts, init);
        if (spec) return { ref: `() => import('${spec}')`, specifier: spec };
      } else if (ts.isIdentifier(init)) {
        if (facts.importMap.has(init.text)) return { ref: init.text, specifier: facts.importMap.get(init.text) };
        const fn = localFunctions.get(init.text);
        if (fn) {
          const spec = findDynamicImportSpec(ts, fn);
          if (spec) return { ref: init.text, specifier: spec };
        }
      }
      return { ref: init.getText(sourceFile), specifier: null };
    };
    const visited = new Set();
    const collectRouteObject = (node, parentPath) => {
      if (visited.has(node)) return;
      visited.add(node);
      const pathProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'path');
      const compProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'component');
      if (!pathProp || !ts.isStringLiteralLike(pathProp.initializer) || !compProp) return;
      const childPath = pathProp.initializer.text;
      const fullPath = childPath.startsWith('/') ? childPath : parentPath + childPath;
      const nameProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'name');
      const metaProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'meta');
      let metaTitle = null;
      if (metaProp && ts.isObjectLiteralExpression(metaProp.initializer)) {
        const titleProp = metaProp.initializer.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'title');
        if (titleProp) {
          if (ts.isStringLiteralLike(titleProp.initializer)) {
            metaTitle = titleProp.initializer.text;
          } else if (ts.isArrowFunction(titleProp.initializer)) {
            // () => t('menu.steamData') 形式取 i18n key
            const body = titleProp.initializer.body;
            if (ts.isCallExpression(body) && body.arguments[0] && ts.isStringLiteralLike(body.arguments[0])) {
              metaTitle = body.arguments[0].text;
            }
          }
        }
      }
      const { ref, specifier } = resolveComponentRef(compProp.initializer);
      facts.vueRoutes.push({
        path: fullPath,
        name: nameProp && ts.isStringLiteralLike(nameProp.initializer) ? nameProp.initializer.text : null,
        metaTitle,
        componentRef: ref,
        specifier,
        pos: node.getStart(sourceFile),
        end: node.end,
      });
      const childrenProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'children');
      if (childrenProp && ts.isArrayLiteralExpression(childrenProp.initializer)) {
        for (const el of childrenProp.initializer.elements) {
          if (ts.isObjectLiteralExpression(el)) collectRouteObject(el, fullPath);
        }
      }
    };
    const collectVisit = (node) => {
      if (ts.isObjectLiteralExpression(node)) collectRouteObject(node, '');
      ts.forEachChild(node, collectVisit);
    };
    collectVisit(sourceFile);
  }

  // 组件抽取：.tsx/.jsx 中的导出 PascalCase 符号
  facts.components = [];
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
    for (const sym of facts.exportSymbols) {
      if (!sym.isExported || !/^[A-Z]/.test(sym.name)) continue;
      if (sym.kind !== 'function' && sym.kind !== 'arrow' && sym.kind !== 'call') continue;
      let fnNode = null;
      if (sym.kind === 'function') {
        fnNode = sym.node;
      } else if (sym.kind === 'arrow' && sym.node?.initializer && ts.isArrowFunction(sym.node.initializer)) {
        fnNode = sym.node.initializer;
      } else if (sym.kind === 'call' && sym.node?.initializer && ts.isCallExpression(sym.node.initializer)) {
        // memo(() => ...) / forwardRef((props) => ...)
        const init = sym.node.initializer;
        fnNode = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ?? null;
      }
      if (!fnNode || (!ts.isFunctionDeclaration(fnNode) && !ts.isArrowFunction(fnNode) && !ts.isFunctionExpression(fnNode))) continue;

      const start = sym.statementNode.getStart(sourceFile);
      const end = sym.statementNode.end;
      const params = fnNode.parameters ?? [];
      let propsCount = null;
      if (params.length > 0 && ts.isObjectBindingPattern(params[0].name)) {
        propsCount = params[0].name.elements.filter((e) => !ts.isOmittedExpression(e)).length;
      } else if (params.length > 0) {
        propsCount = 1;
      } else {
        propsCount = 0;
      }
      const inRange = facts.useCalls.filter((c) => c.pos >= start && c.pos < end);
      const hooksUsed = [...new Set(inRange.map((c) => c.name))];
      facts.components.push({
        name: sym.name,
        isDefault: sym.isDefault,
        line: sym.line,
        pos: start,
        end,
        propsCount,
        hooksUsed,
        stateCount: inRange.filter((c) => c.name === 'useState').length,
        lineCount: sourceFile.text.slice(start, end).split('\n').length,
        description: sym.description || '',
      });
    }
  }

  const defaultComp = facts.components.find((c) => c.isDefault);
  facts.primaryComponentName = defaultComp?.name ?? facts.components[0]?.name ?? null;

  // Hook 符号：导出的 useXxx
  facts.hooks = facts.exportSymbols
    .filter((s) => s.isExported && /^use[A-Z]/.test(s.name) && (s.kind === 'function' || s.kind === 'arrow'))
    .map((s) => ({
      name: s.name,
      line: s.line,
      lineCount: s.node ? sourceFile.text.slice(s.statementNode.getStart(sourceFile), s.statementNode.end).split('\n').length : null,
      description: s.description || '',
    }));

  facts.exportNames = facts.exportSymbols.filter((s) => s.isExported || s.isDefault).map((s) => s.name);
  return facts;
}

export function analyzeFileFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeFile(relPath, content, projectRoot);
}
