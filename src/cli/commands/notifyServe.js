// serve 运行时发现与跨命令通知（x-3，v0.34.0）
//
// 链路：serve 启动时写 <dataDir>/serve-runtime.json {pid,port}（退出清理）；
// output/export 写文件完成后调 notifyServe()——探测运行中的 serve 并 POST
// /internal/broadcast 触发 WebSocket 广播 {type:'report:changed', paths}。
// serve 未运行（无记录/进程已死）时静默跳过，零副作用。

import fs from 'node:fs';
import path from 'node:path';

export const SERVE_RUNTIME_FILE = 'serve-runtime.json';

/** 探测记录文件内容；pid 已死则视为陈旧返回 null（不主动删文件，避免与运行中 serve 竞争） */
export function readServeRuntime(dataDir) {
  const filePath = path.join(dataDir, SERVE_RUNTIME_FILE);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let rt;
  try {
    rt = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Number.isInteger(rt?.pid) || !Number.isInteger(rt?.port)) return null;
  // pid 存活探测：向 pid 发信号 0
  try {
    process.kill(rt.pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH' || err.code === 'EINVAL') return null; // 进程不存在 / pid 非法 → 陈旧
    // EPERM 等：进程存在（权限不够发信号），视为存活
  }
  return { pid: rt.pid, port: rt.port };
}

/**
 * 通知运行中的 serve 广播事件。
 * @param {{ dataDir: string, event?: string, paths?: string[], timeoutMs?: number }} opts
 * @returns {Promise<{ notified: boolean, reason?: string }>}
 */
export async function notifyServe(opts) {
  const { dataDir, event = 'report:changed', paths = [], timeoutMs = 800 } = opts ?? {};
  const rt = readServeRuntime(dataDir);
  if (!rt) return { notified: false, reason: 'serve-not-running' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${rt.port}/internal/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, paths }),
      signal: controller.signal,
    });
    if (!res.ok) return { notified: false, reason: `http-${res.status}` };
    return { notified: true };
  } catch (err) {
    return { notified: false, reason: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** serve 进程侧写入运行时记录；返回文件路径 */
export function writeServeRuntime(dataDir, { pid, port }) {
  const filePath = path.join(dataDir, SERVE_RUNTIME_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), 'utf-8');
  return filePath;
}

/** serve 进程退出时清理（同步删除以兼容 process.on('exit')） */
export function cleanupServeRuntime(dataDir) {
  try {
    fs.rmSync(path.join(dataDir, SERVE_RUNTIME_FILE), { force: true });
  } catch { /* ignore */ }
}
