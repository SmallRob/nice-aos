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
