// builder 共享工具：入口识别 / 组件 kind / 命名转换 / 模块层级 / id 生成 / Go import 解析 / 循环检测。
// 原为 builder.js 顶部的内部工具函数，拆分 builder 相位模块时收敛于此（纯函数迁移，逻辑不变）。

import path from 'node:path';

// 配置/视图/SQL/部署文件扩展名：这些文件由 configAnalyzer 轻量级处理（行数 + 顶层 key/标签/对象名）
// 不参与主 analyzer 的 AST 解析、import 解析、类型实体提取
export const CONFIG_EXTS = new Set(['.css', '.html', '.sql', '.yml', '.yaml', '.conf', '.toml', '.ini', '.env']);

const KIND_SUFFIXES = [
  ['Page', 'page'], ['Modal', 'modal'], ['Dialog', 'dialog'], ['Card', 'card'],
  ['Chart', 'chart'], ['Form', 'form'], ['Detail', 'detail'], ['Details', 'detail'],
  ['Panel', 'panel'], ['Section', 'section'], ['List', 'list'], ['Item', 'item'],
  ['Button', 'button'], ['Widget', 'widget'], ['View', 'view'], ['Provider', 'provider'],
  ['Overlay', 'overlay'], ['Tab', 'tab'], ['Picker', 'picker'], ['Badge', 'badge'],
];
export const ENTRY_BASENAMES = new Set(['App.tsx', 'index.tsx', 'main.tsx', 'index.ts', 'main.ts', 'main.js', 'App.vue', 'main.dart', 'main.go']);
export const SERVICE_NAME_RE = /(Service|Engine|Manager|Repository|Factory)$/;

// 入口识别：位于任一扫描根顶层的常见入口文件名（多根 monorepo 每个根均可有自己的入口）
export function isEntryFile(relPath, roots) {
  if (!ENTRY_BASENAMES.has(path.posix.basename(relPath))) return false;
  if (relPath.endsWith('.go')) return true; // Go 每个 main.go 都是二进制入口（cmd/<name>/main.go 惯例）
  const dir = path.posix.dirname(relPath);
  return roots.some((r) => dir === r || dir === r.replace(/\/+$/, ''));
}

export function componentKind(name) {
  for (const [suffix, kind] of KIND_SUFFIXES) {
    if (name.endsWith(suffix)) return kind;
  }
  return 'common';
}

// kebab-case / camelCase → PascalCase（Vue 标签/注册键/导入名统一规范形式）
export function pascalCaseName(s) {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export function moduleLayerOf(dir) {
  const parts = dir.split('/');
  if (parts[0] === 'src') return parts[1] ?? 'src';
  return parts[0];
}

export function dirOf(relPath) {
  const d = path.posix.dirname(relPath);
  return d === '.' ? '' : d;
}

// Go import 解析（URL 风格路径语义与 npm 不同，不走通用 resolver）：
//   module 前缀命中 → internal（目标 = package 目录下全部 .go 文件，Go 包以目录为单位）；
//   首段不含 '.' → 标准库 builtin；其余 → external（go.mod require 最长前缀匹配定包名，未声明取整路径）。
// goModuleDir 为 go.mod 所在目录（相对 projectRoot）：''（根）/ 'server'（子目录）/
// '../..'（用户定位到 module 子目录，基准在上级）——import 目录用 path.resolve 折叠后转回相对路径
export function createGoImportResolver(goFiles, goModuleName, goDepNames, goModuleDir, projectRoot) {
  const dirFilesCache = new Map();
  const filesOfDir = (dir) => {
    if (dirFilesCache.has(dir)) return dirFilesCache.get(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const files = [...goFiles]
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .sort();
    dirFilesCache.set(dir, files);
    return files;
  };
  const moduleDirOf = (rel) => {
    if (!rel) return goModuleDir || '';
    if (!goModuleDir) return rel;
    const abs = path.resolve(projectRoot, goModuleDir, rel);
    return path.relative(path.resolve(projectRoot), abs).split(path.sep).join('/');
  };
  return {
    filesOfDir,
    resolve(specifier) {
      if (goModuleName && (specifier === goModuleName || specifier.startsWith(`${goModuleName}/`))) {
        const rel = specifier === goModuleName ? '' : specifier.slice(goModuleName.length + 1);
        const dir = moduleDirOf(rel);
        const files = filesOfDir(dir);
        if (files.length > 0) return { kind: 'internal', files, file: files[0], dir };
        // 目录无直下 .go 文件但子树有（纯分组目录，handlerChain 子树搜索仍可用）
        const subtree = [...goFiles].some((f) => f.startsWith(`${dir}/`));
        if (subtree) return { kind: 'internal', files: [], file: null, dir };
        return { kind: 'unresolved', specifier, attempted: dir };
      }
      const first = specifier.split('/')[0];
      if (!first.includes('.')) return { kind: 'builtin', module: specifier };
      let pkg = null;
      for (const dep of goDepNames) {
        if ((specifier === dep || specifier.startsWith(`${dep}/`)) && (!pkg || dep.length > pkg.length)) pkg = dep;
      }
      return { kind: 'external', package: pkg ?? specifier, specifier };
    },
  };
}

export function isTestFile(relPath) {
  if (relPath.endsWith('_test.go')) return true; // Go 测试文件惯例
  return /(__tests__|\.test\.|\.spec\.)/.test(relPath) || relPath.startsWith('src/tests/') || relPath.startsWith('src/e2e/');
}

export function uniqueId(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}@${i}`)) i += 1;
  const id = `${base}@${i}`;
  used.add(id);
  return id;
}

// Tarjan 强连通分量（循环依赖检测）
export function findCycles(fileObjects) {
  const graph = new Map();
  for (const f of fileObjects) graph.set(f.id, (f.importIds ?? []).filter((id) => id.startsWith('file:')));
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let counter = 0;
  const cycles = [];

  function strongConnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) cycles.push(scc.map((id) => id.slice(5)).sort());
    }
  }
  for (const v of graph.keys()) {
    if (!index.has(v)) strongConnect(v);
  }
  return cycles;
}
