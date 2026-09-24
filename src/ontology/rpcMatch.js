// 前后端 RPC 链公共匹配（v0.42.0/v0.42.1）：
// TS 前端 httpCalls ↔ Go 路由、Python outbound 端点 ↔ 服务端 API 路由共用这一套逻辑。
// 原为 builder.js 内部函数（SERVER_API_ROUTE_TYPES / apiPathOf / apiPathSegments /
// matchApiRoute / linkRouteToEndpoint），拆分时收敛于此（纯函数迁移，逻辑不变）。

// 服务端 API 路由类型：routePath 具备真实 URL path 语义。
// v0.47: 纳入 'next-api'（7e 段已前移至匹配点之前，Next route.ts 的 URL path 语义成立）。
// 不含 'php'（zentaopms 形态是 `/<module>-<method>` 的 query 式 URL，path 段匹配会误命中）；
// php 可经 .nice-aos/api-routes.json 的 {"serverRouteTypes":["php"]} 显式开启。
export const SERVER_API_ROUTE_TYPES = ['go', 'python', 'next-api'];

// 从 URL / 路径中取 path 部分。
//   'https://host/a/b?x=1' → '/a/b'      （host 含 %s / {} 占位符也能正确切到首个 '/'）
//   '/api/user/'           → '/api/user/'
//   'url' / 'uri'          → null        （纯变量名，静态不可解析，不参与匹配）
// v0.47（借鉴 asdm-aos endpointSignature）：剥离全大写环境变量模板前缀
//   `${API_BASE_URL}/users` → '/users' —— 前缀差异交给人工规则（阶梯 5）解释，不猜。
function apiPathOf(urlOrPath) {
  const s = String(urlOrPath ?? '');
  const m = /^https?:\/\/[^/]*(\/[^?#]*)?/i.exec(s);
  if (m) return m[1] ?? '/';
  if (/^\$\{[A-Z][A-Z0-9_]*\}\/./.test(s)) {
    // 全大写环境变量模板前缀：剥离前缀参与匹配，前缀差异交给人工规则（阶梯 5）解释
    return s.slice(s.indexOf('}/') + 1);
  }
  if (s.startsWith('${')) {
    // 其它模板串（如 ${baseUrl}/v1/users）：坍缩为占位段后按路径处理
    const collapsed = s.replace(/\$\{[^}]*\}/g, '{param}');
    return collapsed.includes('/') ? `/${collapsed}` : null;
  }
  return s.startsWith('/') ? s.split('?')[0].split('#')[0] : null;
}

// 占位符段归一（v0.47，借鉴 asdm-aos toSegments 的段签名思想）：
// 两侧统一到 `:param`（单段占位）/ `*all`（尾段吞剩余）两种规范形后再比较，
// 参数名不参与匹配（与 isWildHit 的"param 位任意"语义一致）：
//   Go `:id` / `*file`            → 原样（已是规范形）
//   FastAPI `{user_id}`           → `:param`
//   printf `%s` / `%d` / `%1$s`   → `:param`（iDRAC 脚本惯用 URL 形态）
//   Next `[id]`                   → `:param`；`[...slug]` / `[[...slug]]` → `*all`
//   `<id>` / `${expr}` 模板表达式  → `:param`
function normalizeSeg(seg) {
  if (/^%(\d+\$)?[sd]$/.test(seg)) return ':param';
  if (/^\[\[\.\.\..*\]\]$/.test(seg) || /^\[\.\.\..*\]$/.test(seg)) return '*all';
  if (/^\[[^\[\]]+\]$/.test(seg)) return ':param';
  if (/^<[^<>]+>$/.test(seg)) return ':param';
  if (/^\{[^{}]+\}$/.test(seg)) return ':param';
  return seg;
}

// 去 query、尾斜杠归一后切段；无法解析为路径时返回 null。
// v0.47: 段内模板表达式 `${...}` 先坍缩为 `{param}` 再切段（`/api/${x}/users` 与 `/api/{id}/users` 同形）。
export function apiPathSegments(urlOrPath) {
  const p = apiPathOf(urlOrPath);
  if (p == null) return null;
  return p
    .replace(/\$\{[^}]*\}/g, '{param}')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map(normalizeSeg);
}

// method 命中判定（ADR 0012 D3）：空 apiMethods / '*'（ANY）/ 显式相等视为命中。
// apiMethods 口径不统一（Go 数组、Python 曾是裸字符串，v0.42.0 已归一），此处再兜底一次。
function routeMethodHit(route, method) {
  const raw = route.apiMethods ?? [];
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.length === 0 || arr.includes('*') || arr.includes(method);
}

// 同一轮扫描的路径形态判定（与 v0.42.1 字面量优先逻辑一致）
// v0.47: 兼容直接传入的原始占位形态（apiPathSegments 已归一为 :param/*all，此处兜底）
const isParamSeg = (s) =>
  s.startsWith(':') || s.startsWith('*')
  || (s.startsWith('{') && s.endsWith('}'))
  || /^\[\[\.\.\..*\]\]$/.test(s) || /^\[\.\.\..*\]\]$/.test(s) || /^\[[^\[\]]+\]$/.test(s)
  || /^<[^<>]+>$/.test(s) || /^%(\d+\$)?[sd]$/.test(s);
const isLiteralHit = (segs, reqSegs) =>
  segs.length === reqSegs.length && segs.every((s) => !isParamSeg(s)) && segs.every((s, i) => s === reqSegs[i]);
// 尾段吞剩余判定：Go `*wildcard`、Next `:slug*`（[...slug]）/ `:slug?`（[[...slug]]）皆可吞掉请求剩余段
const isTrailingCatchAll = (s) => s.startsWith('*') || /^:\w+[*?]$/.test(s);
const isWildHit = (segs, reqSegs) => {
  if (segs.length === reqSegs.length) return segs.every((s, i) => (isParamSeg(s) || s === reqSegs[i]));
  // 后端尾段 catch-all 可吞掉请求剩余段（v0.44.1 审核 S1：仅限尾段；
  // 中间段通配走等长 isParamSeg 语义、不吞段，防 /api/*x/users 式误配）
  if (segs.length < reqSegs.length && isTrailingCatchAll(segs.at(-1) ?? '')) {
    const prefix = segs.slice(0, -1);
    return prefix.length <= reqSegs.length && prefix.every((s, i) => (isParamSeg(s) || s === reqSegs[i]));
  }
  return false;
};

// 阶梯匹配（ADR 0012 D3）：method 仅作同路径多路由的消解优先级，不做硬门——
//   路径唯一命中时 method 不一致仍返回该路由（ADR 0010 D3 软校验哲学不变）。
// 阶梯：1 字面量+method → 2 字面量 → 3 通配+method → 4 通配；
//       method 为空 / 'MIXED'（未定）时退化为 1 字面量 → 2 通配（与 v0.42.1 行为一致）。
// v0.47: 返回 { route, tier }——tier（1-4）记入 matchedVia/apiMatch，供覆盖度归因
// （asdm-aos matchedVia 同思路：命中要有可审计凭据）。
const TIER_LABELS = { 1: 'literal+method', 2: 'literal', 3: 'wildcard+method', 4: 'wildcard' };
export { TIER_LABELS };

function matchApiRouteTiers(reqSegs, routeSegsList, method) {
  if (method) {
    for (const { r, segs } of routeSegsList) {
      if (isLiteralHit(segs, reqSegs) && routeMethodHit(r, method)) return { route: r, tier: 1 };
    }
  }
  for (const { r, segs } of routeSegsList) {
    if (isLiteralHit(segs, reqSegs)) return { route: r, tier: 2 };
  }
  if (method) {
    for (const { r, segs } of routeSegsList) {
      if (isWildHit(segs, reqSegs) && routeMethodHit(r, method)) return { route: r, tier: 3 };
    }
  }
  for (const { r, segs } of routeSegsList) {
    if (isWildHit(segs, reqSegs)) return { route: r, tier: 4 };
  }
  return null;
}

// 段级前缀改写：请求段前缀等于 rule.fromSegs 时替换为 rule.toSegs，余段保留
function rewriteByRule(reqSegs, rule) {
  const from = rule.fromSegs;
  if (reqSegs.length < from.length) return null;
  for (let i = 0; i < from.length; i++) {
    if (reqSegs[i] !== from[i]) return null;
  }
  return [...rule.toSegs, ...reqSegs.slice(from.length)];
}

// 扩展匹配（ADR 0012 D3/D4）：
//   opts.method    端点 method（'MIXED' 视为未定，跳过 method 阶梯）
//   opts.rules     人工路由规则（apiRouteRules.js 产出），在自动阶梯全部未命中后重试
//                  （asdm-aos 阶梯 5 语义），避免规则劫持本可自动匹配的路径
// 返回 { route, via, tier }：via 为 null 表示自动命中；规则命中为 'rule:<from>→<to>'（可审计）；
//   tier 为命中阶梯 1-4（规则命中时为重写后命中的阶梯）。未命中返回 null。
export function matchApiRouteEx(reqSegs, routeSegsList, opts = {}) {
  const method = opts.method && opts.method !== 'MIXED' ? opts.method : null;
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  const direct = matchApiRouteTiers(reqSegs, routeSegsList, method);
  if (direct) return { route: direct.route, via: null, tier: direct.tier };
  for (const rule of rules) {
    const rewritten = rewriteByRule(reqSegs, rule);
    if (!rewritten) continue;
    const hit = matchApiRouteTiers(rewritten, routeSegsList, method);
    if (hit) return { route: hit.route, via: `rule:${rule.from}→${rule.to}`, tier: hit.tier };
  }
  return null;
}

// 段级匹配：支持 Go 的 :param / *wildcard、FastAPI 的 {param}，以及字面量相等
// v0.42.1: 字面量优先 —— 先扫所有"全字面量命中"的路由，再退化到通配。
//   原因：Gin / FastAPI 等框架的字面量路由应优先于通配（`/self` vs `/:id`），
//   即便通配路由在源码中先声明。原实现是按 routes 数组顺序遍历，遇到 `/:id` 在
//   `self` 之前会错误匹配。修复后顺序无关（routeSegsList 的稳定性由 builder 入口
//   的 sort 保证，且匹配函数自身也兜底字面量优先）。
// v0.44.0: 改为 matchApiRouteEx 薄包装（既有调用方行为零变化）
export function matchApiRoute(reqSegs, routeSegsList) {
  return matchApiRouteEx(reqSegs, routeSegsList)?.route ?? null;
}

// v0.42.1: 前后端 RPC 链双向字段原子赋值
// 7c-d2 段同时维护三组双向字段（端点侧 serverRouteId/serverRoutePath/apiMatch +
// 路由侧 clientEndpointIds）。原实现分散赋值，未来若重跑 / 加新匹配规则易出现
// 单边赋值失败。集中到 helper 保持 invariant：调用即双向更新。
export function linkRouteToEndpoint(route, ep, apiMatch) {
  if (!route || !ep) return;
  ep.serverRouteId = route.id;
  ep.serverRoutePath = route.routePath;
  ep.apiMatch = apiMatch;
  if (!Array.isArray(route.clientEndpointIds)) route.clientEndpointIds = [];
  if (!route.clientEndpointIds.includes(ep.id)) route.clientEndpointIds.push(ep.id);
}
