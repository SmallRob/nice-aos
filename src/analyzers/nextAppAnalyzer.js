import fs from 'node:fs';
import path from 'node:path';

// Next.js App Router 文件约定式路由提取
// page.tsx → 页面路由（routeType 'next'）；route.ts → API 路由（routeType 'next-api'）；
// layout.tsx 不生成路由，而是记入后代路由的 layoutFileIds（沿真实目录链收集，路由组内 layout 同样生效）
// 目录段规则：(group) 与 @slot 剔除出 URL；_private 整目录不产出路由；
//             [id]→:id、[...slug]→:slug*、[[...slug]]→:slug?

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

function conventionBase(fileName) {
  const m = fileName.match(/^(page|route|layout|loading|error|not-found|template|global-error)\.(tsx|jsx|ts|js)$/);
  return m ? m[1] : null;
}

// app 目录定位：存在约定文件（page/layout/route）的 app/ 或 src/app/，src/app 优先
function findAppDir(allFiles) {
  const dirs = new Set();
  for (const f of allFiles) {
    const m = f.match(/^(src\/)?app\/(?:.+\/)?(page|layout|route)\.(?:tsx|jsx|ts|js)$/);
    if (m) dirs.add(m[1] ? 'src/app' : 'app');
  }
  if (dirs.has('src/app')) return 'src/app';
  if (dirs.has('app')) return 'app';
  return null;
}

// 目录段 → URL 段；含 _private 段返回 null（整条路由跳过）
function toUrlSegments(dirSegments) {
  const out = [];
  for (const seg of dirSegments) {
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // 路由组
    if (seg.startsWith('@')) continue; // 平行路由 slot
    if (seg.startsWith('_')) return null; // 私有目录
    let m = /^\[\[\.\.\.(.+)\]\]$/.exec(seg);
    if (m) { out.push(`:${m[1]}?`); continue; } // optional catch-all
    m = /^\[\.\.\.(.+)\]$/.exec(seg);
    if (m) { out.push(`:${m[1]}*`); continue; } // catch-all
    m = /^\[(.+)\]$/.exec(seg);
    if (m) { out.push(`:${m[1]}`); continue; } // 动态段
    out.push(seg);
  }
  return out;
}

export function analyzeNextAppRoutes(projectRoot, scan, resolver, factsMap) {
  const appDir = findAppDir(scan.files);
  if (!appDir) return [];

  // appDir 下约定文件分类：实际目录（含路由组段）→ { page, route, layout, special[] }
  const dirs = new Map();
  for (const f of scan.files) {
    if (!f.startsWith(`${appDir}/`)) continue;
    const rest = f.slice(appDir.length + 1);
    const slash = rest.lastIndexOf('/');
    const dir = slash === -1 ? '' : rest.slice(0, slash);
    const base = conventionBase(rest.slice(slash + 1));
    if (!base) continue;
    if (!dirs.has(dir)) dirs.set(dir, {});
    const rec = dirs.get(dir);
    if (base === 'page' || base === 'route' || base === 'layout') rec[base] = f;
    else (rec.special ??= []).push(f);
  }

  // layout 链：沿真实目录从 appDir 到目标目录逐层收集 layout（外→内，含路由组层）
  const layoutChainOf = (dir) => {
    const chain = [];
    const rootLayout = dirs.get('')?.layout;
    if (rootLayout) chain.push(rootLayout);
    if (!dir) return chain;
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const l = dirs.get(parts.slice(0, i).join('/'))?.layout;
      if (l) chain.push(l);
    }
    return chain;
  };

  const routes = [];
  for (const [dir, rec] of dirs) {
    if (!rec.page && !rec.route) continue;
    const urlSegs = toUrlSegments(dir ? dir.split('/') : []);
    if (urlSegs === null) continue; // 私有目录
    const routePath = urlSegs.length ? `/${urlSegs.join('/')}` : '/';
    const isDynamic = urlSegs.some((s) => s.startsWith(':'));

    for (const base of ['page', 'route']) {
      const file = rec[base];
      if (!file) continue;
      const facts = factsMap.get(file) ?? {};
      const defSym = (facts.exportSymbols ?? []).find((s) => s.isDefault);
      const componentRef = defSym?.name ?? facts.primaryComponentName ?? null;

      let isClient = null;
      try {
        const content = fs.readFileSync(path.join(projectRoot, file), 'utf-8');
        isClient = /^\s*(['"])use client\1/m.test(content);
      } catch { /* 读不到按未知处理 */ }

      let apiMethods = null;
      if (base === 'route') {
        apiMethods = (facts.exportSymbols ?? [])
          .filter((s) => s.isExported && HTTP_METHODS.has(s.name))
          .map((s) => s.name);
      }

      const firstSeg = urlSegs.find((s) => !s.startsWith(':'));
      routes.push({
        overlayId: routePath,
        routePath,
        rawPath: dir,
        routeType: base === 'page' ? 'next' : 'next-api',
        backTarget: null,
        hidesNav: null,
        domain: firstSeg ?? 'root',
        group: file,
        componentRef,
        componentFile: file,
        factoryNavigatesTo: [],
        hasPropsFactory: false,
        factoryProps: [],
        isDynamic,
        isClient,
        apiMethods,
        layoutFileIds: layoutChainOf(dir),
        specialFiles: rec.special ?? [],
      });
    }
  }
  return routes;
}
