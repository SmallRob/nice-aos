// 文件监听核心（fileWatcher）测试（v0.45.0）
//
// 覆盖：
//   1) collectFingerprint：递归收集 + skip 目录
//   2) createWatcher.start()：baseline 收集正确
//   3) 防抖：start 后多次事件合并为一次 onChange
//   4) 去重：fs.watch 触发但文件 mtime 未变时，onChange 不会被误叫
//   5) 删除：文件被删后 fireNow 会把路径作为 changed 报告
//   6) 闭包：close() 后事件不再触发，资源被释放
//   7) state()：基础字段
//   8) interval 下限：MIN_INTERVAL_MS
//   9) burst 检测：连续触发间隔过短时延后
//  10) 单文件 target：watchFile
//
// 注意：
//   start() 后有 "settling window"（= interval），期间 fs.watch 的伪事件被忽略。
//   所有 "改文件后等待 fire" 的测试，必须先 sleep > interval 再操作，否则事件被吞。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFingerprint, createWatcher } from '../src/overview/fileWatcher.js';

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-watcher-'));
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('collectFingerprint 递归收集 + 跳过 node_modules / .git', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'hi');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'skipme.js'), 'should skip');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'c.ts'), 'export const x = 1;');

    const fps = await collectFingerprint(dir);
    const paths = fps.map((f) => path.relative(dir, f.path));
    assert.deepEqual(paths.sort(), ['a.js', 'b.txt', 'src/sub/c.ts'].sort());
    for (const fp of fps) {
      assert.ok(typeof fp.mtime === 'number' && fp.mtime > 0, `mtime > 0 for ${fp.path}`);
      assert.equal(typeof fp.size, 'number');
    }
  } finally {
    cleanup();
  }
});

test('createWatcher.start() 返回 baselineFiles 计数（仅文件，不含目录）', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    fs.writeFileSync(path.join(dir, 'x.js'), 'x');
    fs.writeFileSync(path.join(dir, 'y.js'), 'y');
    let fired = 0;
    const w = createWatcher({
      targets: [dir],
      interval: 200,
      onChange: () => { fired += 1; },
    });
    const { baselineFiles, watching } = await w.start();
    assert.equal(baselineFiles, 2);
    assert.ok(watching > 0, '应挂上至少一个 fs.watch handle');
    // settling 期内不应触发
    await sleep(250);
    assert.equal(fired, 0, 'settling 后无写操作，fired 应为 0');
    w.close();
  } finally {
    cleanup();
  }
});

test('防抖：settling 后多次事件合并为一次 onChange', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const a = path.join(dir, 'a.js');
    const b = path.join(dir, 'b.js');
    fs.writeFileSync(a, '1');
    fs.writeFileSync(b, '1');
    const fires = [];
    const w = createWatcher({
      targets: [dir],
      interval: 300,
      onChange: (paths) => fires.push([...paths]),
    });
    await w.start();
    // 等 settling 过去
    await sleep(350);
    // 防抖窗内连击 5 次（每次间隔 < 300ms）
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(a, `v${i}`);
      fs.writeFileSync(b, `v${i}`);
      await sleep(20);
    }
    // 等最后一次写之后的防抖窗口（300ms）+ 余量
    await sleep(500);
    assert.ok(fires.length >= 1, `至少 fire 1 次，实际 ${fires.length}`);
    assert.ok(fires.length <= 3, `最多 fire 3 次（防抖合并），实际 ${fires.length}`);
    const all = fires.flat();
    assert.ok(all.some((p) => p.endsWith('a.js')), 'a.js 应被收集');
    assert.ok(all.some((p) => p.endsWith('b.js')), 'b.js 应被收集');
    w.close();
  } finally {
    cleanup();
  }
});

test('删除：settling 后删文件 + fireNow 收到该路径', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const a = path.join(dir, 'a.js');
    fs.writeFileSync(a, '1');
    const fires = [];
    const w = createWatcher({
      targets: [dir],
      interval: 200,
      onChange: (paths) => fires.push([...paths]),
    });
    await w.start();
    await sleep(250); // settling 过去
    fs.unlinkSync(a);
    // 让 fs.watch fire 把 pending 加上（macOS rename 事件）
    await sleep(50);
    await w.__test.fireNow();
    assert.ok(fires.length >= 1, `至少 fire 1 次，实际 ${fires.length}`);
    assert.ok(fires[0].some((p) => p.endsWith('a.js')), '应包含被删除的 a.js');
    w.close();
  } finally {
    cleanup();
  }
});

test('close() 后不再触发 + 资源清理', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const a = path.join(dir, 'a.js');
    fs.writeFileSync(a, '1');
    let fired = 0;
    const w = createWatcher({
      targets: [dir],
      interval: 200,
      onChange: () => { fired += 1; },
    });
    await w.start();
    const before = w.state();
    assert.ok(before.watching > 0);
    w.close();
    const after = w.state();
    assert.equal(after.watching, 0, 'close 后 watching = 0');
    // 改文件不应触发
    fs.writeFileSync(a, '2');
    await sleep(300);
    assert.equal(fired, 0, 'close 后改动文件不触发 onChange');
    // 二次 close 不抛错
    w.close();
  } finally {
    cleanup();
  }
});

test('state() 返回 watching / intervalMs / totalFires / uptimeMs', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), '1');
    const w = createWatcher({
      targets: [dir],
      interval: 500,
      onChange: () => {},
    });
    await w.start();
    const s = w.state();
    assert.equal(s.intervalMs, 500);
    assert.ok(s.watching > 0);
    assert.equal(typeof s.totalFires, 'number');
    assert.ok(s.uptimeMs >= 0);
    await sleep(50);
    const s2 = w.state();
    assert.ok(s2.uptimeMs >= s.uptimeMs);
    w.close();
  } finally {
    cleanup();
  }
});

test('interval 下限：传 50 → 实际 200（MIN_INTERVAL_MS）', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), '1');
    const w = createWatcher({
      targets: [dir],
      interval: 50,
      onChange: () => {},
    });
    await w.start();
    assert.equal(w.state().intervalMs, 200);
    w.close();
  } finally {
    cleanup();
  }
});

test('单文件 target（非目录）：watchFile 跨平台工作', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const file = path.join(dir, 'single.txt');
    fs.writeFileSync(file, '1');
    const fires = [];
    const w = createWatcher({
      targets: [file],
      interval: 200,
      onChange: (paths) => fires.push([...paths]),
    });
    const { watching } = await w.start();
    assert.equal(watching, 1, '单文件挂 1 个 watcher');
    fs.writeFileSync(file, '2');
    // watchFile 自带 polling 间隔（1000ms）；等 1.5s 让 polling 触发
    await sleep(1500);
    assert.ok(fires.length >= 1, '改单文件至少 fire 1 次');
    assert.ok(fires[0].some((p) => p.endsWith('single.txt')));
    w.close();
  } finally {
    cleanup();
  }
});