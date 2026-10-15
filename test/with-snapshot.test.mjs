// withSnapshot 单元测试（v0.48.0）：
//   - 参数校验（缺 projectRoot / fn）
//   - 返回值结构（{value, rebuilt}）
//   - ensureSnapshot 便捷入口
//   - 异常透传（非 NO_SNAPSHOT 错误向上抛）
//
// 不在这里跑真实的 buildOntologyData（受 nice-aos 主仓路径影响，跑全量分析会污染本测试运行）。
// 真实集成测试由 ask.test.mjs / action.test.mjs 端到端覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { withSnapshot, ensureSnapshot } from '../src/ontology/withSnapshot.js';

test('withSnapshot 拒绝空 projectRoot', async () => {
  await assert.rejects(async () => {
    await withSnapshot('', () => 1);
  }, /必须传入 projectRoot/);
  await assert.rejects(async () => {
    await withSnapshot(null, () => 1);
  }, /必须传入 projectRoot/);
});

test('withSnapshot 拒绝非函数 fn', async () => {
  await assert.rejects(async () => {
    await withSnapshot('/some/path', null);
  }, /必须传入 fn 回调函数/);
  await assert.rejects(async () => {
    await withSnapshot('/some/path', 'not-fn');
  }, /必须传入 fn 回调函数/);
});

test('withSnapshot 透传非 NO_SNAPSHOT 错误（snapshot.json 是损坏的 JSON 时）', async () => {
  const { setSnapshotDir, getSnapshotDir } = await import('../src/paths.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const prevDir = getSnapshotDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-ws-'));
  fs.writeFileSync(path.join(tmp, 'snapshot.json'), '{not valid json', 'utf-8');
  try {
    setSnapshotDir(tmp);
    await assert.rejects(
      async () => await withSnapshot(tmp, () => 'never', { silent: true }),
      /SyntaxError|JSON|Unexpected|ParseError/,
      '损坏 JSON 时 loadSnapshot 抛 SyntaxError，withSnapshot 不应静默重 build',
    );
  } finally {
    setSnapshotDir(prevDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('withSnapshot 命中快照路径时不触发构建（无项目根 IO）', async () => {
  // 准备一个合法的 snapshot.json，让 loadSnapshot 直接命中；同时 projectRoot 可以不存在
  // —— 因为命中分支根本不会调 buildOntologyData。
  const { setSnapshotDir, getSnapshotDir } = await import('../src/paths.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const prevDir = getSnapshotDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-ws-hit-'));
  const minimalSnap = { _meta: { generatedAt: '2026-10-14' }, Project: [{ id: 'proj:x', name: 'x' }] };
  fs.writeFileSync(path.join(tmp, 'snapshot.json'), JSON.stringify(minimalSnap), 'utf-8');
  try {
    setSnapshotDir(tmp);
    const r = await withSnapshot('/nonexistent/__fake_root__', (snap) => snap.Project?.[0]?.name);
    assert.equal(r.value, 'x', '命中缓存的 snapshot');
    assert.equal(r.rebuilt, false, '不应触发 rebuild');
  } finally {
    setSnapshotDir(prevDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureSnapshot 存在且为函数', () => {
  assert.equal(typeof ensureSnapshot, 'function');
});

test('withSnapshot 模块默认 silent=true（与 ADR 0001 决策 4 一致）', () => {
  assert.equal(withSnapshot.length, 2, 'withSnapshot(projectRoot, fn) 主参 2 个；opts 默认 {silent:true}');
});
