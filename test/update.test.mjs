// update 命令测试：版本比较纯函数 + update --check 输出契约（网络依赖用例容忍离线）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/cli/commands/update.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

test('compareVersions：三段语义版本比较', () => {
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0, '0.9.0 < 0.10.0（非字符串比较）');
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.9.1', '0.9.0') > 0);
  // 仓库源码版本领先 registry（开发中版本）→ 不视为过期
  assert.ok(compareVersions('0.11.0', '0.10.0') > 0);
});

test('update --check：输出 JSON 契约（current/latest/upToDate/installMode）', () => {
  let stdout;
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [CLI, 'update', '--check'], { encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    stdout = err.stdout ?? '';
    exitCode = err.status ?? 1;
  }
  const payload = JSON.parse(stdout);
  if (payload.ok) {
    assert.match(payload.current, /^\d+\.\d+\.\d+/);
    assert.match(payload.latest, /^\d+\.\d+\.\d+/);
    assert.equal(payload.upgraded, false, '--check 不得执行升级');
    assert.ok(['global', 'npx', 'local', 'repo'].includes(payload.installMode));
    assert.equal(payload.upToDate, compareVersions(payload.current, payload.latest) >= 0);
    assert.equal(payload.installMode, 'repo', '测试从仓库源码运行，应判定为 repo 模式');
  } else {
    // 离线 / registry 不可达：错误输出也应带 current 字段，可被 agent 识别
    assert.ok(payload.error);
    assert.match(payload.current, /^\d+\.\d+\.\d+/);
  }
});
