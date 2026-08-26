// askSession 单元测试：多轮会话的 JSONL 存储 + 格式化
// 覆盖：session id 校验 / 读写 / 损坏行跳过 / list 排序 / clear / formatHistory 截断
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidSessionId,
  loadSession,
  appendTurn,
  listSessions,
  clearSession,
  formatHistory,
  getSessionsDir,
} from '../src/cli/commands/askSession.js';

// 每个测试用独立 tmp 配置目录（避免污染 home / 互相干扰）
function withTmpConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-'));
  const old = process.env.NICE_AOS_CONFIG_DIR;
  process.env.NICE_AOS_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (old === undefined) delete process.env.NICE_AOS_CONFIG_DIR;
    else process.env.NICE_AOS_CONFIG_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// 1. session id 校验
// =============================================================================

test('isValidSessionId：合法 id', () => {
  for (const id of ['s1', 'session-001', 'user.chat', 'a', 'A_b-c.0']) {
    assert.ok(isValidSessionId(id), `应合法: ${id}`);
  }
});

test('isValidSessionId：非法 id', () => {
  for (const id of ['', '../etc', 'foo/bar', 'a'.repeat(65), 'foo bar', 'foo$bar', null, undefined, 123]) {
    assert.equal(isValidSessionId(id), false, `应非法: ${id}`);
  }
});

// =============================================================================
// 2. 读写 + 损坏行跳过
// =============================================================================

test('loadSession：不存在的 session 返回空 turns', () => {
  withTmpConfigDir(() => {
    const r = loadSession('ghost');
    assert.deepEqual(r, { turns: [], corrupted: 0 });
  });
});

test('appendTurn + loadSession：基本读写 + 计数', () => {
  withTmpConfigDir(() => {
    appendTurn('s1', { question: 'Q1', answer: 'A1' });
    appendTurn('s1', { question: 'Q2', answer: 'A2', agent: 'api', model: 'deepseek-chat', durationMs: 100 });
    const { turns, corrupted } = loadSession('s1');
    assert.equal(corrupted, 0);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].question, 'Q1');
    assert.equal(turns[0].answer, 'A1');
    assert.equal(turns[1].question, 'Q2');
    assert.equal(turns[1].agent, 'api');
    assert.equal(turns[1].model, 'deepseek-chat');
    assert.equal(turns[1].durationMs, 100);
    // ts 应被自动填为数字
    assert.equal(typeof turns[0].ts, 'number');
  });
});

test('appendTurn：非法 turn 抛错（缺 question/answer）', () => {
  withTmpConfigDir(() => {
    assert.throws(() => appendTurn('s1', { question: 'Q' }), /answer/);
    assert.throws(() => appendTurn('s1', { answer: 'A' }), /question/);
    assert.throws(() => appendTurn('s1', null), /question/);
  });
});

test('appendTurn：非法 session id 抛错（防止路径穿越）', () => {
  withTmpConfigDir(() => {
    assert.throws(() => appendTurn('../escape', { question: 'Q', answer: 'A' }), /非法/);
  });
});

test('loadSession：损坏行（非 JSON / 缺字段）跳过 + corrupted 计数', () => {
  withTmpConfigDir(() => {
    // 手动写入混合内容
    const p = path.join(getSessionsDir(), 'mix.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      JSON.stringify({ ts: 1, question: 'Q1', answer: 'A1' }),  // OK
      'this is not json',                                       // 损坏
      JSON.stringify({ ts: 3, question: 'Q3' }),                // 缺 answer
      JSON.stringify({ ts: 4, answer: 'A4' }),                  // 缺 question
      '',                                                       // 空行
      JSON.stringify({ ts: 6, question: 'Q6', answer: 'A6' }),  // OK
    ].join('\n'));
    const { turns, corrupted } = loadSession('mix');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.question), ['Q1', 'Q6']);
    assert.equal(corrupted, 3, '3 行损坏（非 JSON + 2 个缺字段）');
  });
});

test('loadSession：opts.since 增量读', () => {
  withTmpConfigDir(() => {
    appendTurn('s', { ts: 100, question: 'Q1', answer: 'A1' });
    appendTurn('s', { ts: 200, question: 'Q2', answer: 'A2' });
    appendTurn('s', { ts: 300, question: 'Q3', answer: 'A3' });
    const { turns } = loadSession('s', { since: 200 });
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.question), ['Q2', 'Q3']);
  });
});

// =============================================================================
// 3. list / clear
// =============================================================================

test('listSessions：空目录返回空数组', () => {
  withTmpConfigDir(() => {
    assert.deepEqual(listSessions(), []);
  });
});

test('listSessions：多个 session 按 lastTs 倒序', () => {
  withTmpConfigDir(() => {
    appendTurn('a', { ts: 100, question: 'q', answer: 'a' });
    appendTurn('b', { ts: 200, question: 'q', answer: 'a' });
    appendTurn('c', { ts: 300, question: 'q', answer: 'a' });
    const list = listSessions();
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.id), ['c', 'b', 'a']);
    assert.equal(list[0].turnCount, 1);
    assert.equal(list[0].lastTs, 300);
  });
});

test('clearSession：存在 → true；不存在 → false', () => {
  withTmpConfigDir(() => {
    appendTurn('s', { question: 'q', answer: 'a' });
    assert.equal(clearSession('s'), true);
    assert.equal(clearSession('s'), false);
    const { turns } = loadSession('s');
    assert.equal(turns.length, 0);
  });
});

// =============================================================================
// 4. formatHistory
// =============================================================================

test('formatHistory：空历史只输出"当前问题"节', () => {
  const out = formatHistory({ sessionId: 's', turns: [], question: 'Q' });
  assert.equal(out, '## 当前问题\nQ');
});

test('formatHistory：单轮历史格式（## 对话历史 + ## 当前问题）', () => {
  const out = formatHistory({
    sessionId: 's1',
    turns: [{ question: 'Q1', answer: 'A1' }],
    question: 'Q2',
  });
  assert.match(out, /## 对话历史（session: s1，已 1 轮）/);
  assert.match(out, /### 轮 1/);
  assert.match(out, /\*\*用户\*\*: Q1/);
  assert.match(out, /\*\*助手\*\*: A1/);
  assert.match(out, /## 当前问题\nQ2/);
});

test('formatHistory：maxTurns 截断（带 skipNote）', () => {
  const out = formatHistory({
    sessionId: 's1',
    turns: [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
      { question: 'Q3', answer: 'A3' },
    ],
    question: 'Q4',
    maxTurns: 2,
  });
  // 应只含 Q2/Q3（轮 2 / 轮 3）+ skipNote；Q4 在"## 当前问题"节，不带轮次编号
  assert.match(out, /已省略前 1 轮/);
  assert.match(out, /### 轮 2/);
  assert.match(out, /### 轮 3/);
  assert.doesNotMatch(out, /### 轮 1\n/);
  assert.doesNotMatch(out, /### 轮 4/);
  // Q4 必须在 ## 当前问题 节里
  assert.match(out, /## 当前问题\nQ4/);
});

test('formatHistory：maxTurns=0 等同不截断（带 0 不视为有效）', () => {
  const out = formatHistory({
    sessionId: 's1',
    turns: [{ question: 'Q1', answer: 'A1' }],
    question: 'Q2',
    maxTurns: 0,
  });
  // maxTurns=0 → 不截断 → 不带"省略"
  assert.doesNotMatch(out, /已省略/);
  assert.match(out, /### 轮 1/);
});
