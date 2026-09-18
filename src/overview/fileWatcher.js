// 文件监听核心（overview watch 子命令基石，v0.45.0）
//
// 设计动机：
//   nice-aos export 写盘后会主动 notifyServe 广播 report:changed（v0.34.0 已实现），
//   但需要人手跑命令；overview watch 想把"代码库改了 → 报告 + 蓝图自动重生成 → 通知 serve"串成一条龙。
//
// 关键问题：
//   - 编辑器（VSCode/WebStorm）保存动作常一次性触发数十个 fs.watch 事件
//   - git checkout / git pull 会在极短时间内改一堆文件
//   - node 进程冷启动时若监听器挂得比 baseline 扫描慢，已存在的变更应被忽略（去重）
//   - 监听器挂上后用户 Ctrl+C 必须立刻退出，不能僵在 setTimeout / setInterval 里
//
// 解决方案：
//   1) 防抖（debounce）：N ms 内只触发一次回调；默认 1500ms，CLI 可覆盖
//   2) 去重（baseline）：启动时扫一遍所有目标路径的 (mtime, size) 指纹并写入 lastFp；
//      fire 时重算指纹并对比 lastFp，只把"真的变了"的路径交给 onChange
//   3) burst 检测：连续 N 次触发间隔过短（< interval/4）时延后到 2× interval，吸收连击
//   4) 优雅退出：close() → 清 timer + 关闭所有 fs.watch / fs.watchFile handle；调用方捕获 SIGINT/SIGTERM 后调一次 close()
//
// 不依赖 chokidar：项目保持零三方依赖（仅 commander + yaml + @modelcontextprotocol/sdk + typescript）
// 也避免 fs.watch recursive 选项（macOS / Linux / Windows 行为不一致，递归自己实现）

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INTERVAL_MS = 1500;
const MIN_INTERVAL_MS = 200;
const BURST_DIVISOR = 4; // 间隔 < interval / BURST_DIVISOR 视为 burst
const MAX_DEPTH = 8;
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'out', '.cache', '.turbo']);

/**
 * 递归收集目录内所有文件的指纹 {path, mtime, size}
 * 默认跳过 node_modules / .git / dist / build / target / .next 等常见构建/版本目录
 */
export async function collectFingerprint(root, { skipDirs = null, maxDepth = MAX_DEPTH } = {}) {
  const skip = skipDirs ?? DEFAULT_SKIP_DIRS;
  const out = [];
  const rootAbs = path.resolve(root);
  if (!fs.existsSync(rootAbs)) return out;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; /* 权限/IO 错误跳过；不阻断整体扫描 */ }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const s = fs.statSync(full);
          out.push({ path: full, mtime: s.mtimeMs, size: s.size });
        } catch { /* race: 文件已被删，跳过 */ }
      }
    }
  };
  walk(rootAbs, 0);
  return out;
}

function indexFingerprints(list) {
  const map = new Map();
  for (const fp of list) map.set(fp.path, { mtime: fp.mtime, size: fp.size });
  return map;
}

/**
 * 创建文件监听器实例
 *
 * @param {Object} opts
 * @param {string[]} opts.targets            要监听的根路径（文件或目录）。目录会递归。
 * @param {string[]} [opts.skipDirs]          要跳过的目录名集合（默认走 DEFAULT_SKIP_DIRS）
 * @param {number} [opts.interval]            防抖窗口毫秒（默认 1500，下限 200）
 * @param {(changedPaths: string[]) => void | Promise<void>} opts.onChange
 *           触发回调；参数为"相对 baseline 真正变化的路径"数组（已去重）。
 *           返回 Promise 时下一次触发等其 settle，避免并发重扫。
 * @param {(err: Error) => void} [opts.onError] fs.watch 异常兜底（默认 console.error）
 * @returns {{
 *   start: () => Promise<{baselineFiles: number, watching: number}>,
 *   close: () => void,
 *   state: () => { watching: number, intervalMs: number, lastFireTs: number,
 *                  totalFires: number, lastChangedPaths: number, uptimeMs: number },
 *   // 测试 hooks（仅测试用；产品代码不要碰）
 *   __test: { fireNow: () => Promise<void> }
 * }}
 */
export function createWatcher(opts) {
  const {
    targets = [],
    skipDirs = null,
    interval = DEFAULT_INTERVAL_MS,
    onChange,
    onError = (err) => console.error(`[fileWatcher] ${err?.message ?? err}`),
  } = opts;

  if (typeof onChange !== 'function') throw new TypeError('onChange 必须为函数');
  const safeInterval = Math.max(MIN_INTERVAL_MS, interval | 0);

  // lastFp: Map<path, {mtime, size}>，baseline 与 fire 时对比用
  let lastFp = new Map();
  // 监听事件收集的"可能变化"路径集合；fire 时统一校验
  let pending = new Set();
  let timer = null;
  let lastFireTs = 0;
  let totalFires = 0;
  let lastChangedCount = 0;
  let closed = false;
  let inflight = false; // 防止回调尚未 settle 时又被新的 timer 触发
  // settling：start 后 N ms 内忽略所有 fs.watch 事件（macOS / 部分 Linux fs.watch 会立即 fire 一次"伪事件"）
  let settleUntil = 0;
  // 资源：fs.watch handle + watchFile 路径
  const watchHandles = [];
  const watchFilePaths = [];
  // 调试：用于 fireNow 测试
  const startedAt = Date.now();

  function scheduleTimer(delay = safeInterval) {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimerFire, delay);
    timer.unref?.();
  }

  async function onTimerFire() {
    timer = null;
    if (closed || pending.size === 0) return;
    if (inflight) {
      // 上一次回调还没结束；延后 1 个 interval 再试
      scheduleTimer();
      return;
    }
    // burst 检测：连续触发间隔过短 → 延后 2× interval
    const now = Date.now();
    const elapsed = lastFireTs ? now - lastFireTs : Infinity;
    if (elapsed < safeInterval / BURST_DIVISOR) {
      scheduleTimer(safeInterval * 2);
      return;
    }
    const suspects = [...pending];
    pending = new Set();
    lastFireTs = now;
    inflight = true;
    try {
      // 重算 suspect 路径的当前指纹；与 lastFp 对比，提取真变化的路径集合
      const changed = [];
      const touched = new Set();
      for (const abs of suspects) {
        if (touched.has(abs)) continue;
        touched.add(abs);
        let s;
        try { s = fs.statSync(abs); } catch { /* 文件已被删 → 当作 changed（用户删了文件也应触发） */
          if (lastFp.has(abs)) {
            changed.push(abs);
            lastFp.delete(abs);
          }
          continue;
        }
        const prev = lastFp.get(abs);
        if (!prev || prev.mtime !== s.mtimeMs || prev.size !== s.size) {
          changed.push(abs);
          lastFp.set(abs, { mtime: s.mtimeMs, size: s.size });
        }
      }
      lastChangedCount = changed.length;
      totalFires += 1;
      if (changed.length > 0) {
        await onChange(changed);
      }
    } catch (err) {
      try { onError(err); } catch { /* swallow */ }
    } finally {
      inflight = false;
    }
  }

  function onFsEvent(_eventType, filePath) {
    if (closed) return;
    // settling 期内：fs.watch 挂监听后会立即 fire 一次伪事件（macOS 行为），忽略
    if (Date.now() < settleUntil) return;
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    pending.add(abs);
    scheduleTimer();
  }

  function attachDirRecursive(dir, depth, skip) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        // 子目录：挂监听
        try {
          const h = fs.watch(full, { persistent: true }, (eventType, fileName) => {
            if (!fileName) return;
            const childAbs = path.join(full, fileName);
            try {
              if (fs.existsSync(childAbs) && fs.statSync(childAbs).isDirectory()) {
                attachDirRecursive(childAbs, depth + 1, skip);
              }
            } catch { /* race */ }
            onFsEvent(eventType, childAbs);
          });
          h.on('error', onError);
          watchHandles.push(h);
        } catch (err) { onError(err); }
        attachDirRecursive(full, depth + 1, skip);
      }
    }
  }

  function attachOne(p, skip) {
    const abs = path.resolve(p);
    let stat;
    try { stat = fs.statSync(abs); } catch { return; /* target 不存在；启动不抛错 */ }
    if (stat.isFile()) {
      // 单文件：watchFile 跨平台最稳（基于 polling）
      try {
        fs.watchFile(abs, { interval: Math.max(safeInterval, 1000), persistent: true }, (curr, prev) => {
          if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onFsEvent('change', abs);
        });
        watchFilePaths.push(abs);
      } catch (err) { onError(err); }
      return;
    }
    // 目录：root 挂 watch + 递归挂子目录
    try {
      const h = fs.watch(abs, { persistent: true }, (eventType, fileName) => {
        if (!fileName) return;
        const childAbs = path.join(abs, fileName);
        try {
          if (fs.existsSync(childAbs) && fs.statSync(childAbs).isDirectory()) {
            attachDirRecursive(childAbs, 1, skip);
          }
        } catch { /* race */ }
        onFsEvent(eventType, childAbs);
      });
      h.on('error', onError);
      watchHandles.push(h);
    } catch (err) { onError(err); }
    attachDirRecursive(abs, 1, skip);
  }

  return {
    async start() {
      if (closed) throw new Error('watcher 已关闭，无法 start');
      const skip = skipDirs ?? DEFAULT_SKIP_DIRS;
      // 1) baseline：所有 target 的文件指纹
      const all = [];
      for (const t of targets) {
        try {
          const s = fs.statSync(t);
          if (s.isFile()) {
            all.push({ path: t, mtime: s.mtimeMs, size: s.size });
          } else {
            const fps = await collectFingerprint(t, { skipDirs: skip });
            all.push(...fps);
          }
        } catch { /* target 不存在 → 跳过；watch 期间若出现仍能监听到 */ }
      }
      lastFp = indexFingerprints(all);
      // 2) 挂监听
      for (const t of targets) attachOne(t, skip);
      // 3) settling：start 后 safeInterval ms 内忽略 fs.watch 伪事件（macOS / 部分 Linux 立即 fire 一次）
      settleUntil = Date.now() + safeInterval;
      return { baselineFiles: lastFp.size, watching: watchHandles.length + watchFilePaths.length };
    },

    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (const h of watchHandles) {
        try { h.close?.(); } catch { /* swallow */ }
      }
      for (const p of watchFilePaths) {
        try { fs.unwatchFile(p); } catch { /* swallow */ }
      }
      watchHandles.length = 0;
      watchFilePaths.length = 0;
      pending = new Set();
    },

    state() {
      return {
        watching: watchHandles.length + watchFilePaths.length,
        intervalMs: safeInterval,
        lastFireTs,
        totalFires,
        lastChangedPaths: lastChangedCount,
        uptimeMs: Date.now() - startedAt,
      };
    },

    // 仅测试用：跳过防抖窗，立即跑一次 fire 流程
    __test: {
      fireNow: async () => { await onTimerFire(); },
    },
  };
}