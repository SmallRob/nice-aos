// ioRegistry + ioScanner 单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IO_SINKS,
  getSink,
  scanSource,
  extractDeclaredLocals,
  DANGER_LEVELS,
  RESOURCE_KINDS,
  DANGER_RANK,
} from '../src/ontology/ioRegistry.js';
import { scanMethodIO, scanSnapshotIOWithContent } from '../src/analyzers/ioScanner.js';

test('IO_SINKS 至少 30 个（油猴 + 浏览器）', () => {
  assert.ok(IO_SINKS.length >= 30, `应 ≥30 个 sink,实际 ${IO_SINKS.length}`);
});

test('getSink 查找 GM_setValue', () => {
  const s = getSink('GM_setValue');
  assert.ok(s);
  assert.equal(s.kind, RESOURCE_KINDS.STORAGE);
  assert.equal(s.direction, 'WRITE');
  assert.equal(s.danger, DANGER_LEVELS.MEDIUM);
});

test('getSink 查找 fetch', () => {
  const s = getSink('fetch');
  assert.ok(s);
  assert.equal(s.kind, RESOURCE_KINDS.NETWORK);
});

test('getSink 查找 eval', () => {
  const s = getSink('eval');
  assert.ok(s);
  assert.equal(s.danger, DANGER_LEVELS.CRITICAL);
});

test('scanMethodIO 找 fetch + GM_* 调用', () => {
  const src = `
function sync(t) {
  const data = GM_getValue("cache");
  const r = fetch("/api/x", { method: "POST", body: t });
  GM_setValue("cache", data);
  return r;
}
  `;
  const hits = scanMethodIO(src);
  const apis = hits.map((h) => h.sink.callee);
  assert.ok(apis.includes('GM_getValue'));
  assert.ok(apis.includes('GM_setValue'));
  assert.ok(apis.includes('fetch'));
});

test('scanMethodIO 行号正确', () => {
  const src = `function f() {
  GM_log("a");
  if (true) {
    fetch("/x");
  }
}
`;
  const hits = scanMethodIO(src);
  const fetchHit = hits.find((h) => h.sink.callee === 'fetch');
  assert.ok(fetchHit);
  assert.equal(fetchHit.line, 4);
});

test('scanMethodIO shadow check：local var 同名不污染', () => {
  const src = `function f() {
  const fetch = "shadow";
  fetch("/local");  // 这是字符串调用,不该匹配
}
`;
  const hits = scanMethodIO(src);
  // 应该有 0 个 fetch 命中（因为 local fetch 覆盖了 global fetch）
  // 实际：我们的实现是 "declaredLocals.includes(short)" 才跳过
  // short = 'fetch',local 有 fetch → 跳过
  const fetchHits = hits.filter((h) => h.sink.callee === 'fetch');
  assert.equal(fetchHits.length, 0, 'local fetch shadow 应跳过');
});

test('scanMethodIO 不应匹配 myFetch（边界）', () => {
  const src = `function f() { myFetch("/x"); }`;
  const hits = scanMethodIO(src);
  const fetchHits = hits.filter((h) => h.sink.callee === 'fetch');
  assert.equal(fetchHits.length, 0, 'myFetch 不应触发 fetch 命中');
});

test('scanMethodIO 不应匹配 consoleFetch（边界）', () => {
  const src = `function f() { consoleFetch("/x"); }`;
  const hits = scanMethodIO(src);
  const fetchHits = hits.filter((h) => h.sink.callee === 'fetch');
  assert.equal(fetchHits.length, 0);
});

test('extractDeclaredLocals 提取 var/let/const', () => {
  const src = `var a = 1; let b; const c = 2; const { d, e } = obj; const [f, g] = arr;`;
  const locals = extractDeclaredLocals(src);
  assert.ok(locals.includes('a'));
  assert.ok(locals.includes('b'));
  assert.ok(locals.includes('c'));
  assert.ok(locals.includes('d'));
  assert.ok(locals.includes('e'));
  assert.ok(locals.includes('f'));
  assert.ok(locals.includes('g'));
});

test('extractDeclaredLocals 提取函数声明', () => {
  const src = `function inner() {}; const obj = { method() {} }`;
  const locals = extractDeclaredLocals(src);
  assert.ok(locals.includes('inner'));
});

test('DANGER_RANK 排序 critical > high > medium > low > info', () => {
  assert.ok(DANGER_RANK[DANGER_LEVELS.CRITICAL] > DANGER_RANK[DANGER_LEVELS.HIGH]);
  assert.ok(DANGER_RANK[DANGER_LEVELS.HIGH] > DANGER_RANK[DANGER_LEVELS.MEDIUM]);
  assert.ok(DANGER_RANK[DANGER_LEVELS.MEDIUM] > DANGER_RANK[DANGER_LEVELS.LOW]);
  assert.ok(DANGER_RANK[DANGER_LEVELS.LOW] > DANGER_RANK[DANGER_LEVELS.INFO]);
});

test('scanMethodIO 完整油猴脚本样例', () => {
  const src = `
function syncUserData() {
  const token = GM_getValue("auth_token");
  if (!token) {
    console.log("no token");
    return;
  }
  fetch("/api/me", { headers: { Authorization: "Bearer " + token } })
    .then(r => r.json())
    .then(d => {
      GM_setValue("user_info", JSON.stringify(d));
      document.title = d.name;
    });
}
  `;
  const hits = scanMethodIO(src);
  const apis = hits.map((h) => h.sink.callee);
  // 应该有 GM_getValue, fetch, GM_setValue
  assert.ok(apis.includes('GM_getValue'));
  assert.ok(apis.includes('fetch'));
  assert.ok(apis.includes('GM_setValue'));
  // fetch 是 high
  const fetchHit = hits.find((h) => h.sink.callee === 'fetch');
  assert.equal(fetchHit.sink.danger, DANGER_LEVELS.HIGH);
});

test('scanSnapshotIOWithContent 跨方法聚合', () => {
  const snap = {
    _meta: {},
    Method: [
      { id: 'm:a#x', name: 'x', filePath: 'a.ts', pos: 0, end: 100, line: 1 },
      { id: 'm:b#y', name: 'y', filePath: 'b.ts', pos: 0, end: 100, line: 1 },
    ],
  };
  const cache = new Map([
    ['a.ts', `function x() { const t = GM_getValue("k"); return t; }`],
    ['b.ts', `function y() { fetch("/x"); eval("malicious"); }`],
  ]);
  const result = scanSnapshotIOWithContent(snap, cache);
  assert.equal(result.summary.totalMethodsScanned, 2);
  assert.equal(result.summary.methodsWithIO, 2);
  // x 有 1 个 IO（GM_getValue）
  assert.equal(result.byMethod.get('m:a#x').length, 1);
  // y 有 2 个 IO（fetch, eval）
  assert.equal(result.byMethod.get('m:b#y').length, 2);
  // byDanger: eval critical +1, fetch high +1
  assert.equal(result.summary.byDanger.critical, 1);
  assert.equal(result.summary.byDanger.high, 1);
  assert.equal(result.summary.byDanger.low, 1); // GM_getValue
});

test('scanSnapshotIOWithContent minDanger 过滤', () => {
  const snap = {
    _meta: {},
    Method: [
      { id: 'm:a#x', name: 'x', filePath: 'a.ts', pos: 0, end: 100, line: 1 },
    ],
  };
  const cache = new Map([
    ['a.ts', `function x() { GM_getValue("k"); eval("bad"); }`],
  ]);
  // minDanger='high' 应过滤掉 GM_getValue(low)
  const result = scanSnapshotIOWithContent(snap, cache, { minDanger: 'high' });
  assert.equal(result.byMethod.get('m:a#x').length, 1);
  assert.equal(result.byMethod.get('m:a#x')[0].sink.callee, 'eval');
});

test('scanSnapshotIOWithContent kinds 过滤', () => {
  const snap = {
    _meta: {},
    Method: [
      { id: 'm:a#x', name: 'x', filePath: 'a.ts', pos: 0, end: 100, line: 1 },
    ],
  };
  const cache = new Map([
    ['a.ts', `function x() { GM_getValue("k"); fetch("/x"); }`],
  ]);
  // 只看 NETWORK
  const result = scanSnapshotIOWithContent(snap, cache, { kinds: ['NETWORK'] });
  assert.equal(result.byMethod.get('m:a#x').length, 1);
  assert.equal(result.byMethod.get('m:a#x')[0].sink.kind, 'NETWORK');
});
