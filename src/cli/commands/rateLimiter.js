// serve 滑动窗口限流器（srv-4，v0.34.0）
//
// 设计要点：
//   - 每 key（IP 维度，取 x-forwarded-for 首段 → socket 地址）保留一个命中时间戳数组；
//     check 时裁掉窗口外旧值后追加，判定 len > max
//   - 内存防膨胀：maxIps 容量上限（默认 5000），超容时丢弃"最久未活跃"的 IP
//   - 纯函数风格无 I/O，注入 now 可测；默认关闭由 CLI 层控制（--rate-limit 不传不启用）

/**
 * @param {{ windowMs?: number, max?: number, maxIps?: number, now?: () => number }} opts
 *   windowMs 窗口时长（默认 60000）；max 窗口内最大请求数（默认 120）；maxIps 追踪的 IP 容量
 */
export function createRateLimiter(opts = {}) {
  const windowMs = Math.max(1000, opts.windowMs ?? 60_000);
  const max = Math.max(1, opts.max ?? 120);
  const maxIps = Math.max(2, opts.maxIps ?? 5_000);
  const nowFn = opts.now ?? (() => Date.now());
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  /**
   * 判定某 key 本次请求是否放行。
   * @returns {{ allowed: true, remaining: number } | { allowed: false, retryAfterSec: number }}
   */
  function check(key) {
    const now = nowFn();
    let list = hits.get(key);
    if (!list) {
      if (hits.size >= maxIps) evictOldest(now);
      list = [];
      hits.set(key, list);
    }
    // 裁剪窗口外时间戳（时间有序，仅前缀需要移除）
    while (list.length > 0 && now - list[0] >= windowMs) list.shift();
    if (list.length >= max) {
      const retryAfterMs = windowMs - (now - list[0]);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    list.push(now);
    return { allowed: true, remaining: max - list.length };
  }

  /** 超容驱逐：淘汰最早最近活跃（数组末值最小）的 IP */
  function evictOldest(now) {
    void now;
    let oldestKey = null;
    let oldestLast = Infinity;
    for (const [k, list] of hits) {
      const last = list.length ? list[list.length - 1] : 0;
      if (last < oldestLast) { oldestLast = last; oldestKey = k; }
      if (oldestLast === 0) break;
    }
    if (oldestKey !== null) hits.delete(oldestKey);
  }

  /** 观测数据（/api/status 展示） */
  function stats() {
    const now = nowFn();
    let activeKeys = 0;
    let reqsInWindow = 0;
    for (const list of hits.values()) {
      while (list.length > 0 && now - list[0] >= windowMs) list.shift();
      if (list.length > 0) activeKeys += 1;
      reqsInWindow += list.length;
    }
    return { enabled: true, windowMs, max, trackedIps: hits.size, activeIps: activeKeys, requestsInWindow: reqsInWindow };
  }

  return { check, stats };
}

/** 请求方标识：x-forwarded-for 首段（若有）→ socket 远端地址 → 'unknown' */
export function clientKeyOf(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  const addr = req.socket?.remoteAddress;
  return addr || 'unknown';
}
