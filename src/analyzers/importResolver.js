import path from 'node:path';

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.less', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4',
  '.wav', '.json', '.wasm', '.yaml', '.yml', '.md', '.txt', '.csv',
]);
const PROBE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.vue', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.vue'];

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
      return { prefix, targetPrefix, isWildcard, projectRoot };
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return aliases;
}

export function createResolver(projectRoot, tsconfigPaths, knownFiles) {
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
    const ext = path.posix.extname(specifier);
    if (ASSET_EXTENSIONS.has(ext)) {
      return { kind: 'asset', specifier };
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
        candidateRel = path.posix.normalize(hit.targetPrefix + rest);
      }
    }

    if (candidateRel !== null) {
      const resolved = probe(candidateRel);
      if (resolved) return { kind: 'internal', file: resolved };
      return { kind: 'unresolved', specifier, attempted: candidateRel };
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
