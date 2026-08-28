// PHP / Kotlin 内部导入解析器（v0.36.1）：
//   PHP    — composer.json autoload.psr-4 / psr-0 前缀映射（最长前缀优先）+ 全仓库声明限定名兜底
//   Kotlin — 声明 package + 限定类名 + 源码路径后缀匹配（等效覆盖自定义 sourceSets srcDir，无需解析 gradle）
// 输出契约与 importResolver / goResolver 对齐：{ kind: 'internal', file|files } | { kind: 'external', package, ecosystem }

import fs from 'node:fs';
import path from 'node:path';

const dotted = (s) => String(s).replace(/\\/g, '.');

/** composer.json autoload PSR-4/PSR-0 前缀表（最长前缀优先排序） */
export function parseComposerPsr4(projectRoot) {
  const composerPath = path.join(projectRoot, 'composer.json');
  let autoload;
  try {
    autoload = JSON.parse(fs.readFileSync(composerPath, 'utf-8'))?.autoload;
  } catch {
    return [];
  }
  if (!autoload || typeof autoload !== 'object') return [];
  const out = [];
  for (const section of ['psr-4', 'psr-0']) {
    const map = autoload[section];
    if (!map || typeof map !== 'object') continue;
    for (const [rawPrefix, dirs] of Object.entries(map)) {
      const list = Array.isArray(dirs) ? dirs : [dirs];
      for (const d of list) {
        if (typeof d !== 'string') continue;
        out.push({ prefix: rawPrefix.replace(/\\+$/, ''), dir: d.replace(/\\/g, '/').replace(/\/+$/, '') });
      }
    }
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * PHP use 导入解析。
 * @param {{projectRoot: string, phpFiles: string[], phpFacts: Map<string, object>}} input
 *   phpFiles：扫描到的 .php 相对路径（存在性判定）；phpFacts：file → facts（限定名兜底索引）
 */
export function createPhpImportResolver({ projectRoot, phpFiles, phpFacts }) {
  const psr = parseComposerPsr4(projectRoot);
  const fileSet = new Set(phpFiles);
  // 声明限定名兜底：namespace + class/interface/trait（小写归一，PHP 类加载大小写不敏感）
  const declared = new Map();
  for (const [relPath, facts] of phpFacts) {
    const ns = facts.moduleName ? dotted(facts.moduleName) : null;
    for (const t of [...(facts.classes ?? []), ...(facts.interfaces ?? []), ...(facts.traits ?? [])]) {
      const q = t.qualifiedName ?? (ns ? `${ns}.${t.name}` : t.name);
      const key = dotted(q).toLowerCase();
      if (!declared.has(key)) declared.set(key, relPath);
    }
  }
  return {
    resolve(specifier) {
      const spec = String(specifier).replace(/^\\+/, '');
      // 1. composer PSR-4/PSR-0：前缀 → 目录，余部反斜杠转目录
      for (const { prefix, dir } of psr) {
        if (spec === prefix || spec.startsWith(`${prefix}\\`)) {
          const rest = spec.slice(prefix.length).replace(/^\\+/, '');
          const rel = `${dir === '' ? '' : `${dir}/`}${rest.replace(/\\/g, '/')}.php`;
          if (fileSet.has(rel)) return { kind: 'internal', file: rel };
        }
      }
      // 2. 全仓库声明限定名兜底（无 composer 映射的遗留代码库，如 zentaopms）
      const hit = declared.get(dotted(spec).toLowerCase());
      if (hit) return { kind: 'internal', file: hit };
      // 3. 外部：命名空间首段归并（vendor 依赖）
      return { kind: 'external', package: spec.split('\\')[0] || null, ecosystem: 'php' };
    },
  };
}

/**
 * Kotlin import 解析。
 * @param {{ktFiles: string[], ktFacts: Map<string, object>}} input
 */
export function createKotlinImportResolver({ ktFiles, ktFacts }) {
  // 包 → 文件列表（通配 import a.b.* 关联整包）
  const packageFiles = new Map();
  // 限定类名 → 文件（精确匹配 import a.b.C）
  const declared = new Map();
  // basename → 文件列表（路径后缀匹配的候选收窄）
  const byBasename = new Map();
  for (const [relPath, facts] of ktFacts) {
    const pkg = facts.moduleName ?? null;
    if (pkg) {
      if (!packageFiles.has(pkg)) packageFiles.set(pkg, []);
      packageFiles.get(pkg).push(relPath);
    }
    for (const t of [...(facts.classes ?? []), ...(facts.interfaces ?? [])]) {
      const q = t.qualifiedName ?? (pkg ? `${pkg}.${t.name}` : t.name);
      if (!declared.has(q)) declared.set(q, relPath);
    }
  }
  for (const f of ktFiles) {
    const b = path.posix.basename(f);
    if (!byBasename.has(b)) byBasename.set(b, []);
    byBasename.get(b).push(f);
  }
  return {
    resolve(specifier) {
      const spec = String(specifier).trim();
      // 通配 import a.b.*：关联包内全部文件（file=首个，兼容单文件消费者；files 数组供文件边全量关联）
      if (spec.endsWith('.*')) {
        const pkg = spec.slice(0, -2);
        const files = packageFiles.get(pkg);
        if (files && files.length > 0) return { kind: 'internal', file: files[0], files: [...files] };
        return { kind: 'external', package: spec.split('.')[0] || null, ecosystem: 'kotlin' };
      }
      // 1. 限定类名精确匹配
      const hit = declared.get(spec);
      if (hit) return { kind: 'internal', file: hit };
      // 2. 路径后缀匹配：import a.b.C → 任意源码根下的 a/b/C.kt（覆盖自定义 srcDir，无需解析 gradle）
      const last = spec.split('.').pop();
      for (const ext of ['.kt', '.kts']) {
        const base = `${last}${ext}`;
        const suffix = `/${spec.replace(/\./g, '/')}${ext}`;
        const candidates = byBasename.get(base) ?? [];
        const m = candidates.find((f) => f === suffix.slice(1) || f.endsWith(suffix));
        if (m) return { kind: 'internal', file: m };
      }
      // 3. 外部：首段归并（java / javax / kotlin / androidx / com.squareup...）
      return { kind: 'external', package: spec.split('.')[0] || null, ecosystem: 'kotlin' };
    },
  };
}
