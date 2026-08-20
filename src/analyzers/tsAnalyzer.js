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
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && OVERLAY_OPENER_FUNCS.has(node.expression.name.text)) {
        // app.setActiveOverlay('xxx') 形式
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
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
  delete facts.zustandCreates;

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
