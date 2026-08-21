import path from 'node:path';

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4',
  '.wav', '.json', '.wasm', '.yaml', '.yml', '.md', '.txt', '.csv',
]);
const PROBE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.vue', '.dart', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.vue', '/index.dart'];

// Node 内置模块：非 npm 包，不参与依赖清单与未声明依赖统计
const NODE_BUILTINS = new Set([
  'fs', 'path', 'url', 'os', 'crypto', 'util', 'http', 'https', 'stream', 'buffer',
  'zlib', 'querystring', 'assert', 'string_decoder', 'timers', 'net', 'tls', 'dns',
  'dgram', 'cluster', 'readline', 'readline/promises', 'repl', 'vm', 'worker_threads', 'perf_hooks',
  'async_hooks', 'process', 'console', 'module', 'punycode', 'v8', 'tty', 'events',
  'child_process', 'constants', 'inspector', 'wasi', 'diagnostics_channel', 'trace_events',
  'node:test', 'node:assert', 'node:sea', 'node:sqlite',
]);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  // 子路径导入：fs/promises、readline/promises、dns/promises 等
  if (NODE_BUILTINS.has(specifier)) return true;
  const [base, sub] = specifier.split('/');
  if (!sub || sub === 'promises') return NODE_BUILTINS.has(base);
  return false;
}

// Vite 虚拟模块（virtual:generated-pages / virtual:app-loading 等）：构建时生成，非 npm 包
function isVirtualModule(specifier) {
  return specifier.startsWith('virtual:');
}

// 将 tsconfig paths（如 "@/*": "./src/*"）编译为前缀匹配规则，长前缀优先
function compileAliases(tsconfigPaths, projectRoot) {
  const aliases = Object.entries(tsconfigPaths)
    .map(([pattern, target]) => {
      const isWildcard = pattern.endsWith('/*');
      const prefix = isWildcard ? pattern.slice(0, -1) : pattern;
      // 去掉相对前缀（./ 或 ../ 链）；注意 slice(2) 而非 slice(1)，
      // 否则 ./src/* 会残留为 /src/*，normalize 后变成绝对路径导致所有别名解析失败
      let targetPrefix = target;
      while (targetPrefix.startsWith('./')) targetPrefix = targetPrefix.slice(2);
      while (targetPrefix.startsWith('../')) targetPrefix = targetPrefix.slice(3);
      targetPrefix = path.posix.normalize(targetPrefix);
      if (isWildcard && targetPrefix.endsWith('/*')) {
        targetPrefix = targetPrefix.slice(0, -1);
      }
      // 重定基后的 "./*" 目标（扫描宿主子目录场景）：目标即扫描根本身，前缀为空
      if (targetPrefix === '*' || targetPrefix === '.') targetPrefix = '';
      return { prefix, targetPrefix, isWildcard, projectRoot };
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return aliases;
}

export function createResolver(projectRoot, tsconfigPaths, knownFiles, dartPackageName = null) {
  const knownSet = new Set(knownFiles);
  const aliases = compileAliases(tsconfigPaths, projectRoot);

  function probe(relPath) {
    for (const suffix of PROBE_SUFFIXES) {
      const candidate = relPath + suffix;
      if (knownSet.has(candidate)) return candidate;
    }
    // 允许 .js 导入实际 .ts 文件的场景（build 产物式导入）
    const stripped = relPath.replace(/\.js$/, '');
    if (stripped !== relPath) {
      for (const ext of ['.ts', '.tsx']) {
        if (knownSet.has(stripped + ext)) return stripped + ext;
      }
    }
    return null;
  }

  function resolve(fromFile, specifier) {
    // Dart SDK 内置库：dart:core / dart:async / dart:convert 等，非 pub 包
    if (specifier.startsWith('dart:')) {
      return { kind: 'builtin', module: specifier };
    }
    // Dart package: 导入：package:自身包名/... → 项目内 lib/ 相对路径；其余 → pub 依赖
    if (specifier.startsWith('package:')) {
      const rest = specifier.slice('package:'.length);
      const slash = rest.indexOf('/');
      const pkg = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? '' : rest.slice(slash + 1);
      if (dartPackageName && pkg === dartPackageName && sub) {
        const candidateRel = path.posix.normalize(path.posix.join('lib', sub));
        const resolved = probe(candidateRel);
        if (resolved) return { kind: 'internal', file: resolved };
        return { kind: 'unresolved', specifier, attempted: candidateRel };
      }
      return { kind: 'external', package: pkg, specifier };
    }
    const ext = path.posix.extname(specifier);
    if (ASSET_EXTENSIONS.has(ext)) {
      return { kind: 'asset', specifier };
    }
    if (isNodeBuiltin(specifier)) {
      return { kind: 'builtin', module: specifier };
    }
    if (isVirtualModule(specifier)) {
      return { kind: 'virtual', module: specifier };
    }

    let candidateRel = null;
    if (specifier.startsWith('.')) {
      const fromDir = path.posix.dirname(fromFile);
      candidateRel = path.posix.normalize(path.posix.join(fromDir, specifier));
    } else {
      const hit = aliases.find((a) => {
        if (a.isWildcard) return specifier.startsWith(a.prefix);
        return specifier === a.prefix || specifier.startsWith(a.prefix + '/');
      });
      if (hit) {
        const rest = specifier.slice(hit.prefix.length);
        // join 而非字符串拼接：目标前缀为空（重定基到扫描根）时消除 rest 的前导斜杠
        candidateRel = path.posix.normalize(path.posix.join(hit.targetPrefix, rest));
      }
    }

    if (candidateRel !== null) {
      const resolved = probe(candidateRel);
      if (resolved) return { kind: 'internal', file: resolved };
      return { kind: 'unresolved', specifier, attempted: candidateRel };
    }

    // Dart 裸相对导入：import 'pages/home_page.dart';（无 ./ 前缀）——Dart 语法允许且常见，
    // 非 package:/dart: 前缀的裸说明符一律按相对路径解析（TS 不适用此规则，避免把 npm 包名误判为本地文件）
    if (fromFile.endsWith('.dart') && !specifier.startsWith('@')) {
      const fromDir = path.posix.dirname(fromFile);
      const bareRel = path.posix.normalize(path.posix.join(fromDir, specifier));
      const resolved = probe(bareRel);
      if (resolved) return { kind: 'internal', file: resolved };
      return { kind: 'unresolved', specifier, attempted: bareRel };
    }

    return { kind: 'external', package: packageName(specifier) };
  }

  return { resolve };
}

export function packageName(specifier) {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/');
  return segments[0];
}
