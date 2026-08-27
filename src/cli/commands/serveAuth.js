// serve 的 Bearer 鉴权工具（v0.33.0+ 从 serve.js 抽出）
//
// 设计：
//   - checkAuth(req, expectedToken) 返回 { ok: true } 或 { ok: false, reason }
//     expectedToken 为 null/undefined 时所有请求都通过（向后兼容）
//   - 提取顺序：query ?token= → Authorization: Bearer <token> 头
//   - token 比较走 timingSafeEqual（先 SHA-256 成 32 字节），防 timing attack，
//     也兼容不同长度的 token
//   - 不依赖 http 模块，方便单测直接传 { url, headers } 对象

import crypto from 'node:crypto';

/**
 * 时间常数比较两个字符串（先 hash 到 32 字节再 timingSafeEqual）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf-8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf-8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 检查请求是否携带有效 token。
 * @param {{ url?: string, headers?: Record<string, string|string[]> }} req
 * @param {string|null|undefined} expectedToken
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkAuth(req, expectedToken) {
  if (!expectedToken) return { ok: true };
  // query 参数优先（curl / 油猴脚本容易构造）
  try {
    const url = new URL(req.url || '/', 'http://x');
    const qToken = url.searchParams.get('token');
    if (qToken && timingSafeEqualStr(qToken, expectedToken)) return { ok: true };
  } catch { /* ignore parse error */ }
  // Authorization 头
  const authHeader = req.headers?.authorization;
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
    if (token && timingSafeEqualStr(token, expectedToken)) return { ok: true };
  }
  return { ok: false, reason: '需要 Authorization: Bearer <token> 或 ?token=<secret>' };
}

// ---------- srv-6（v0.34.0）：端点分级 read / write / admin ----------

/** 角色秩：数值越大权限越高。read < write < admin */
export const ROLES = Object.freeze({ read: 0, write: 1, admin: 2 });

/**
 * 解析 token 配置为 [{ secret, role }]。
 * 兼容三种形态：
 *   - 单个 --token <secret>                  → 全部 admin（v0.33 用法不变）
 *   - NICE_AOS_SERVE_TOKEN=<secret>          → 同上
 *   - NICE_AOS_SERVE_TOKENS="s1,s2:read,s3:admin"
 *     （逗号分隔；缺省角色 read？——否，缺省 admin 与单 token 语义一致，
 *       需要低权 token 请显式 :role）
 * @param {string|string[]|null|undefined} raw
 * @returns {{ secret: string, role: keyof typeof ROLES }[]}
 */
export function parseTokens(raw) {
  const parts = Array.isArray(raw)
    ? raw.flatMap((s) => String(s).split(','))
    : String(raw ?? '').split(',');
  const out = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(':');
    let secret = t;
    let role = 'admin';
    if (idx > 0 && idx < t.length - 1) {
      const r = t.slice(idx + 1).toLowerCase();
      if (r in ROLES) {
        secret = t.slice(0, idx);
        role = r;
      }
    }
    out.push({ secret, role });
  }
  return out;
}

/** 从请求提取 token（query ?token= 优先，其次 Bearer 头）；无则 null */
export function extractToken(req) {
  try {
    const url = new URL(req.url || '/', 'http://x');
    const qToken = url.searchParams.get('token');
    if (qToken) return qToken;
  } catch { /* ignore */ }
  const h = req.headers?.authorization;
  if (h && /^Bearer\s+/i.test(h)) return String(h).replace(/^Bearer\s+/i, '').trim() || null;
  return null;
}

/**
 * 校验请求满足最低角色要求。tokens 为空数组 = 鉴权关闭（全部放行，向后兼容）。
 * @param {{ url?: string, headers?: object }} req
 * @param {{secret:string, role:string}[]} tokens
 * @param {keyof typeof ROLES} minRole 该端点要求的最低角色
 * @returns {{ ok: true, role: string } | { ok: false, reason: string }}
 */
export function authorizeRole(req, tokens, minRole) {
  if (!tokens || tokens.length === 0) return { ok: true, role: 'public' };
  const provided = extractToken(req);
  if (!provided) {
    return { ok: false, reason: `该端点需要 ${minRole} 级 token：Authorization: Bearer <token> 或 ?token=` };
  }
  for (const { secret, role } of tokens) {
    if (timingSafeEqualStr(provided, secret)) {
      if (ROLES[role] >= ROLES[minRole]) return { ok: true, role };
      return { ok: false, reason: `token 权限不足（当前 ${role}，端点要求 ${minRole}）` };
    }
  }
  return { ok: false, reason: '无效 token' };
}

/**
 * 端点最低角色表（单一事实源：serve 路由、/api/status、openapi 共用）。
 * 未见条目默认 'read'；static 端点（/ /snapshot.json /blueprint.html）豁免鉴权不在此表语义内。
 * @param {string} method
 * @param {string} urlPath 已去 query 的路径
 * @returns {'read'|'write'|'admin'}
 */
export function minRoleFor(method, urlPath) {
  if (method === 'POST' && urlPath === '/api/ask') return 'write';
  if (method === 'POST' && urlPath === '/internal/broadcast') return 'write';
  // v0.35.0（E-3）：POST /action 会写快照（markReviewed/addNote）或触发重扫（refreshRepo）→ write
  if (method === 'POST' && urlPath === '/action') return 'write';
  if (urlPath.startsWith('/api/admin/')) return 'admin';
  return 'read';
}

