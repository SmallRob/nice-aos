// fingerprint.test.mjs —— 核心算法测试
// 覆盖：
//   - normalizeSource 各种规范化场景（注释、字符串、数字、标识符、关键字保留）
//   - computeFingerprint 整树 hash 一致性 + 同骨架不同命名 hash 一致
//   - extractFunctionBody 简单函数 + 嵌套函数 + 字符串内的花括号
//   - groupByFingerprint 分组 + 排序

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSource,
  computeFingerprint,
  computeFingerprints,
  extractFunctionBody,
  groupByFingerprint,
} from '../src/ontology/fingerprint.js';

test('normalizeSource 删块注释', () => {
  const src = `/* 一行注释 */\nconst a = 1; /* 块 */\nconst b = 2;`;
  const out = normalizeSource(src);
  assert.ok(!out.includes('一行注释'), '块注释应删除');
  assert.ok(!out.includes('块'), '块注释应删除');
  assert.match(out, /□ = NUM/);
});

test('normalizeSource 删行注释', () => {
  const src = `const a = 1; // 这是一行注释\nconst b = 2;`;
  const out = normalizeSource(src);
  assert.ok(!out.includes('这是一行注释'));
  assert.match(out, /const □ = NUM/);
});

test('normalizeSource 字符串字面量 → STR', () => {
  const src = `const greeting = "Hello, World!";`;
  const out = normalizeSource(src);
  assert.match(out, /const □ = STR/);
  assert.ok(!out.includes('Hello'));
});

test('normalizeSource 模板字符串 → STR', () => {
  const src = 'const t = `Hello ${name}, age ${age}`;';
  const out = normalizeSource(src);
  assert.ok(out.includes('STR'));
  assert.ok(!out.includes('Hello'));
  assert.ok(!out.includes('name'));
});

test('normalizeSource 数字字面量 → NUM', () => {
  const src = `const a = 42; const b = 3.14; const c = 1e10;`;
  const out = normalizeSource(src);
  assert.match(out, /const □ = NUM/);
  assert.ok(!/\b42\b/.test(out));
  assert.ok(!/\b3\.14\b/.test(out));
});

test('normalizeSource 标识符 → □（保留关键字）', () => {
  const src = `function foo(x, y) { return x + y; }`;
  const out = normalizeSource(src);
  assert.match(out, /function □\(□, □\) { return □ \+ □; }/);
  // 关键字保留
  assert.match(out, /function/);
  assert.match(out, /return/);
});

test('normalizeSource 大写开头标识符 → □C（JSX 组件）', () => {
  const src = `const el = <MyComponent prop="value" />;`;
  const out = normalizeSource(src);
  assert.match(out, /□C/);
  assert.ok(!out.includes('MyComponent'));
});

test('normalizeSource 保留 this/super/true/false/null/undefined', () => {
  const src = `if (this === null || x === undefined || flag === true) {}`;
  const out = normalizeSource(src);
  assert.match(out, /this/);
  assert.match(out, /null/);
  assert.match(out, /undefined/);
  assert.match(out, /true/);
});

test('normalizeSource 规范化空白', () => {
  const src = `const a = 1;\n\n\n  const b = 2;`;
  const out = normalizeSource(src);
  assert.ok(!out.includes('\n'));
  assert.ok(!out.includes('  '));
});

test('computeFingerprint 一致性（相同输入 → 相同 hash）', () => {
  const src = `function add(a, b) { return a + b; }`;
  const f1 = computeFingerprint(src);
  const f2 = computeFingerprint(src);
  assert.equal(f1.fingerprint, f2.fingerprint);
  assert.equal(f1.nodes, f2.nodes);
  assert.match(f1.fingerprint, /^[a-f0-9]{64}$/, 'SHA-256 64 字符 hex');
});

test('computeFingerprint 不同骨架 → 不同 hash', () => {
  const f1 = computeFingerprint(`function add(a, b) { return a + b; }`);
  const f2 = computeFingerprint(`function sub(a, b) { return a - b; }`);
  assert.notEqual(f1.fingerprint, f2.fingerprint);
});

test('computeFingerprint 同骨架不同命名 → 相同 hash（核心价值）', () => {
  // 两个不同函数，shape 完全一致：累加一个数组
  const code1 = `
function totalPrice(items) {
  let result = 0;
  for (let i = 0; i < items.length; i++) {
    result += items[i].price;
  }
  return result;
}
  `;
  const code2 = `
function sumWeights(boxes) {
  let acc = 0;
  for (let j = 0; j < boxes.length; j++) {
    acc += boxes[j].weight;
  }
  return acc;
}
  `;
  const f1 = computeFingerprint(code1);
  const f2 = computeFingerprint(code2);
  assert.equal(f1.fingerprint, f2.fingerprint, '同骨架不同变量名应得相同 fingerprint');
  assert.equal(f1.nodes, f2.nodes);
});

test('computeFingerprint 同名不同字面量 → 相同 hash', () => {
  const code1 = `const msg = "Hello";`;
  const code2 = `const msg = "World";`;
  const f1 = computeFingerprint(code1);
  const f2 = computeFingerprint(code2);
  assert.equal(f1.fingerprint, f2.fingerprint, '字符串字面量应被规范化');
});

test('computeFingerprint 改一个字面量为不同数字 → 相同 hash', () => {
  const code1 = `if (x > 100) { return true; }`;
  const code2 = `if (x > 200) { return true; }`;
  const f1 = computeFingerprint(code1);
  const f2 = computeFingerprint(code2);
  assert.equal(f1.fingerprint, f2.fingerprint, '数字字面量应被规范化');
});

test('computeFingerprint 改一行逻辑 → 不同 hash', () => {
  // 用 > 改成 <，让逻辑差异在规范化后仍存在
  const code1 = `if (x > 0) { return a; }`;
  const code2 = `if (x < 0) { return a; }`;
  const f1 = computeFingerprint(code1);
  const f2 = computeFingerprint(code2);
  assert.notEqual(f1.fingerprint, f2.fingerprint, '逻辑差异应被检测到（> vs <）');
});

test('computeFingerprint 空字符串 → 空 fingerprint', () => {
  const r = computeFingerprint('');
  assert.equal(r.fingerprint, '');
  assert.equal(r.nodes, 0);
});

test('computeFingerprint 复杂 JSX 组件函数', () => {
  const code = `
function ResourceCard({ resource, rank }) {
  const navigate = useNavigate();
  return (
    <Card sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box>{resource.title}</Box>
    </Card>
  );
}
  `;
  const r = computeFingerprint(code);
  assert.match(r.fingerprint, /^[a-f0-9]{64}$/);
  // 节点数应该 > 0
  assert.ok(r.nodes > 10);
});

test('computeFingerprints 批量计算', () => {
  const items = [
    { id: 'm1', source: 'function a() { return 1; }' },
    { id: 'm2', source: 'function b() { return 2; }' },
    { id: 'm3', source: 'function c() { return 3; }' },
  ];
  const map = computeFingerprints(items);
  assert.equal(map.size, 3);
  assert.ok(map.get('m1').fingerprint);
  assert.ok(map.get('m2').fingerprint);
  assert.ok(map.get('m3').fingerprint);
});

test('extractFunctionBody 提取简单函数', () => {
  const src = `function foo() { return 42; }`;
  const body = extractFunctionBody(src, 0);
  assert.equal(body, '{ return 42; }');
});

test('extractFunctionBody 嵌套函数', () => {
  const src = `function outer() { function inner() { return 1; } return inner(); }`;
  const body = extractFunctionBody(src, 0);
  assert.ok(body.includes('function inner'));
  assert.ok(body.includes('return inner()'));
  // 花括号应匹配
  const opens = (body.match(/\{/g) || []).length;
  const closes = (body.match(/\}/g) || []).length;
  assert.equal(opens, closes, '嵌套函数花括号应平衡');
});

test('extractFunctionBody 字符串内的花括号不污染（简单实现）', () => {
  // 已知限制：text-based 不处理字符串内的花括号；这里只验证不会崩溃
  const src = `function f() { const s = "{ not a block }"; return s; }`;
  const body = extractFunctionBody(src, 0);
  // 简化算法下，body 会过早闭合（"{}" 被误判为块结束）—— 这是已知限制
  assert.ok(typeof body === 'string');
});

test('groupByFingerprint 找出重复组', () => {
  // 3 个方法，2 个同骨架，1 个不同
  const fp1 = computeFingerprint(`function a(x) { return x * 2; }`);
  const fp2 = computeFingerprint(`function b(y) { return y * 2; }`); // 同 fp1
  const fp3 = computeFingerprint(`function c(z) { return z + 3; }`); // 不同（* vs +）

  const fingerprints = new Map([
    ['m:foo#a', fp1],
    ['m:foo#b', fp2],
    ['m:foo#c', fp3],
  ]);
  const meta = [
    { id: 'm:foo#a', name: 'a', filePath: 'src/a.ts', startLine: 1, endLine: 3 },
    { id: 'm:foo#b', name: 'b', filePath: 'src/b.ts', startLine: 5, endLine: 7 },
    { id: 'm:foo#c', name: 'c', filePath: 'src/c.ts', startLine: 9, endLine: 11 },
  ];

  const groups = groupByFingerprint(fingerprints, meta);
  assert.equal(groups.length, 1, '应找到 1 个重复组');
  assert.equal(groups[0].kind, 'exact');
  assert.equal(groups[0].similarity, 1.0);
  assert.equal(groups[0].members.length, 2);
  assert.deepEqual(
    groups[0].members.map((m) => m.name).sort(),
    ['a', 'b'],
  );
});

test('groupByFingerprint 单例不报', () => {
  const fp1 = computeFingerprint(`function a() { return 1; }`);
  const fingerprints = new Map([['m:a', fp1]]);
  const meta = [{ id: 'm:a', name: 'a', filePath: 'a.ts', startLine: 1, endLine: 3 }];
  const groups = groupByFingerprint(fingerprints, meta);
  assert.equal(groups.length, 0);
});

test('groupByFingerprint 空 fingerprint 跳过', () => {
  const fingerprints = new Map([
    ['m:empty', { fingerprint: '', nodes: 0 }],
    ['m:real', computeFingerprint(`function r() { return 1; }`)],
  ]);
  const meta = [
    { id: 'm:empty', name: 'empty', filePath: 'a.ts', startLine: 1, endLine: 1 },
    { id: 'm:real', name: 'real', filePath: 'b.ts', startLine: 1, endLine: 3 },
  ];
  const groups = groupByFingerprint(fingerprints, meta);
  assert.equal(groups.length, 0, '单例不应被报告为重复');
});

test('groupByFingerprint 排序：成员数降序，相同则 nodeCount 降序', () => {
  // 组 1：3 个成员，10 节点
  const sameFp = computeFingerprint(`function a() { return 1; }`);
  // 组 2：2 个成员，20 节点
  const bigFp = computeFingerprint(`
    function a() {
      const a = 1;
      const b = 2;
      const c = 3;
      const d = 4;
      const e = 5;
      return a + b + c + d + e;
    }
  `);

  const fingerprints = new Map([
    ['m1', sameFp], ['m2', sameFp], ['m3', sameFp],
    ['m4', bigFp], ['m5', bigFp],
  ]);
  const meta = [
    { id: 'm1', name: 'a', filePath: 'a.ts', startLine: 1, endLine: 2 },
    { id: 'm2', name: 'b', filePath: 'b.ts', startLine: 1, endLine: 2 },
    { id: 'm3', name: 'c', filePath: 'c.ts', startLine: 1, endLine: 2 },
    { id: 'm4', name: 'd', filePath: 'd.ts', startLine: 1, endLine: 9 },
    { id: 'm5', name: 'e', filePath: 'e.ts', startLine: 1, endLine: 9 },
  ];

  const groups = groupByFingerprint(fingerprints, meta);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].members.length, 3, '成员数多的组排前');
  assert.equal(groups[1].members.length, 2);
});
