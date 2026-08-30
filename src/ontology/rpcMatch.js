// 前后端 RPC 链公共匹配（v0.42.0/v0.42.1）：
// TS 前端 httpCalls ↔ Go 路由、Python outbound 端点 ↔ 服务端 API 路由共用这一套逻辑。
// 原为 builder.js 内部函数（SERVER_API_ROUTE_TYPES / apiPathOf / apiPathSegments /
// matchApiRoute / linkRouteToEndpoint），拆分时收敛于此（纯函数迁移，逻辑不变）。

// 服务端 API 路由类型：routePath 具备真实 URL path 语义。
// 不含 'php'（zentaopms 形态是 `/<module>-<method>` 的 query 式 URL，path 段匹配会误命中），
// 不含 'next-api'（构建于 7e 段，晚于匹配点；且 Next 项目的 Python 客户端场景罕见）。
export const SERVER_API_ROUTE_TYPES = ['go', 'python'];

// 从 URL / 路径中取 path 部分。
//   'https://host/a/b?x=1' → '/a/b'      （host 含 %s / {} 占位符也能正确切到首个 '/'）
//   '/api/user/'           → '/api/user/'
//   'url' / 'uri'          → null        （纯变量名，静态不可解析，不参与匹配）
function apiPathOf(urlOrPath) {
  const s = String(urlOrPath ?? '');
  const m = /^https?:\/\/[^/]*(\/[^?#]*)?/i.exec(s);
  if (m) return m[1] ?? '/';
  return s.startsWith('/') ? s.split('?')[0] : null;
}

// 去 query、尾斜杠归一后切段；无法解析为路径时返回 null
export function apiPathSegments(urlOrPath) {
  const p = apiPathOf(urlOrPath);
  if (p == null) return null;
  return p.replace(/\/+$/, '').split('/').filter(Boolean);
}

// 段级匹配：支持 Go 的 :param / *wildcard、FastAPI 的 {param}，以及字面量相等
// v0.42.1: 字面量优先 —— 先扫所有"全字面量命中"的路由，再退化到通配。
//   原因：Gin / FastAPI 等框架的字面量路由应优先于通配（`/self` vs `/:id`），
//   即便通配路由在源码中先声明。原实现是按 routes 数组顺序遍历，遇到 `/:id` 在
//   `self` 之前会错误匹配。修复后顺序无关（routeSegsList 的稳定性由 builder 入口
//   的 sort 保证，且匹配函数自身也兜底字面量优先）。
export function matchApiRoute(reqSegs, routeSegsList) {
  const isParam = (s) => s.startsWith(':') || s.startsWith('*') || (s.startsWith('{') && s.endsWith('}'));
  const segMatches = (s, fe) => isParam(s) || s === fe;
  // 第一轮：字面量全匹配（所有段都是字面量且与请求段完全相等）。
  //         这一轮排除了带参数的路由，确保 `/self` 永远不被 `/:id` 抢匹配。
  for (const { r, segs } of routeSegsList) {
    if (segs.length === reqSegs.length && segs.every((s) => !isParam(s)) && segs.every((s, i) => s === reqSegs[i])) {
      return r;
    }
  }
  // 第二轮：原匹配逻辑（参数通配 + 尾段 *wildcard 吞剩余）
  for (const { r, segs } of routeSegsList) {
    if (segs.length === reqSegs.length) {
      if (segs.every((s, i) => segMatches(s, reqSegs[i]))) return r;
    } else if (segs.length < reqSegs.length && segs.some((s) => s.startsWith('*'))) {
      // 后端尾段 *wildcard 可吞掉请求剩余段
      const prefix = segs.slice(0, -1);
      if (prefix.length <= reqSegs.length && prefix.every((s, i) => segMatches(s, reqSegs[i]))) return r;
    }
  }
  return null;
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
