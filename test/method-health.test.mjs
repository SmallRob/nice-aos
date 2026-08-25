// methodHealth 单元测试：复杂度 / lambda / 测试方法识别
// 借鉴 asdm-aos 的 4 项能力,验证 nice-aos 的 Method.health 子对象输出正确
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzeMethodHealth, placeholderHealth } from '../src/analyzers/methodHealth.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function parse(src) {
  const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true);
  // 取第一个 function-like 节点
  let fn = null;
  function walk(n) {
    if (fn) return;
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) { fn = n; return; }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { fn = n; return; }
    ts.forEachChild(n, walk);
  }
  walk(sf);
  if (!fn) throw new Error('no function in: ' + src);
  return { sf, fn };
}

test('placeholder: available=false / risk=unknown', () => {
  const h = placeholderHealth();
  assert.equal(h.available, false);
  assert.equal(h.risk, 'unknown');
  assert.equal(h.testInfo.isTest, false);
});

test('简单方法: 圈复杂度=1, 无 lambda, 无测试调用 → risk=low', () => {
  const { sf, fn } = parse(`function add(a, b) { return a + b; }`);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.available, true);
  assert.equal(h.complexity.cyclomatic, 1);
  assert.equal(h.complexity.branches, 0);
  assert.equal(h.lambdas.count, 0);
  assert.equal(h.testInfo.isTest, false);
  assert.equal(h.risk, 'low');
});

test('if/else 分支: 圈复杂度=2, branches=1', () => {
  const { sf, fn } = parse(`function pick(x) { if (x > 0) return 'pos'; else return 'neg'; }`);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.complexity.cyclomatic, 2);
  assert.equal(h.complexity.branches, 1);
  assert.equal(h.risk, 'low'); // 1 个分支不够 medium
});

test('循环 + 三元 + 短路: 圈复杂度>=4', () => {
  const { sf, fn } = parse(`
    function f(arr) {
      for (const x of arr) {
        const v = x > 0 ? x : -x;
        if (v && arr.length) return v;
      }
      return 0;
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  // for: +1, ternary: +1, &&: +1, if: +1 = 4 + 基础 1 = 5
  assert.equal(h.complexity.cyclomatic, 5);
  assert.ok(h.complexity.branches >= 3, `branches=${h.complexity.branches}`);
});

test('嵌套深度: maxNesting 正确推断', () => {
  const { sf, fn } = parse(`
    function f() {
      if (a) {
        if (b) {
          if (c) {
            return;
          }
        }
      }
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.ok(h.complexity.maxNesting >= 3, `maxNesting=${h.complexity.maxNesting}`);
});

test('lambda 计数: 含 .map(.filter(.reduce 链', () => {
  const { sf, fn } = parse(`
    function f(arr) {
      return arr.map(x => x * 2).filter(x => x > 0);
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  // .map 回调、.filter 回调 = 2 个箭头函数
  assert.equal(h.lambdas.count, 2);
});

test('await 计数: 链式 await 正确累加', () => {
  const { sf, fn } = parse(`
    async function f() {
      const a = await fetchA();
      const b = await fetchB();
      const c = await fetchC();
      return [a, b, c];
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.complexity.awaits, 3);
});

test('测试方法识别: describe/it/expect 调用 → isTest=true', () => {
  // 测试模块级函数体（模拟 tsAnalyzer 实际传入的 FunctionDeclaration）
  const { sf, fn } = parse(`
    function testWork() {
      const x = 1;
      expect(x).toBe(1);
      return x;
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.testInfo.isTest, true);
  assert.equal(h.testInfo.testType, null); // 直接调用 expect 不属于 it 上下文，testType 留空
  assert.ok(h.testInfo.callsExpect >= 1, `callsExpect=${h.testInfo.callsExpect}`);
});

test('测试方法识别: 含 it/test 调用的函数体 → testType=unit', () => {
  // 模拟 tsAnalyzer：检测到箭头函数是 it() 的 callback，传 enclosingCallName='it'
  const src = `const testWork = () => { const x = 1; expect(x).toBe(1); };`;
  const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true);
  let arrow = null;
  function find(n) {
    if (arrow) return;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { arrow = n; return; }
    ts.forEachChild(n, find);
  }
  find(sf);
  const h = analyzeMethodHealth({ ts, node: arrow, sourceFile: sf, options: { enclosingCallName: 'it' } });
  assert.equal(h.testInfo.isTest, true);
  assert.equal(h.testInfo.testType, 'unit');
  assert.ok(h.testInfo.callsExpect >= 1, `callsExpect=${h.testInfo.callsExpect}`);
});

test('test callback 类型推断: describe → suite / beforeEach → setup', () => {
  // 直接传 options.enclosingCallName
  const { sf, fn } = parse(`function f() { /* ... */ return 1; }`);
  const hDescribe = analyzeMethodHealth({ ts, node: fn, sourceFile: sf, options: { enclosingCallName: 'describe' } });
  assert.equal(hDescribe.testInfo.testType, 'suite');
  const hBefore = analyzeMethodHealth({ ts, node: fn, sourceFile: sf, options: { enclosingCallName: 'beforeEach' } });
  assert.equal(hBefore.testInfo.testType, 'setup');
});

test('mock 识别: vi.mock 调用 → usesMock=true', () => {
  const { sf, fn } = parse(`
    function mockTest() {
      vi.mock('./foo');
      const x = bar();
      expect(x).toBe(1);
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.testInfo.usesMock, true);
  assert.equal(h.testInfo.testFramework, 'vitest');
});

test('risk 评级: 高复杂度方法 → high 或 critical', () => {
  // 20+ 分支
  const cases = Array.from({ length: 25 }, (_, i) => `if (x === ${i}) return ${i};`).join('\n      ');
  const { sf, fn } = parse(`
    function huge(x) {
      ${cases}
      return -1;
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.ok(h.complexity.cyclomatic >= 20, `cyclomatic=${h.complexity.cyclomatic}`);
  assert.equal(h.risk, 'critical');
});

test('risk 评级: 5-9 复杂度 → medium', () => {
  const { sf, fn } = parse(`
    function m(x, y) {
      if (x > 0) return 1;
      if (y > 0) return 2;
      if (x < 0 && y < 0) return 3;
      if (x === 0 || y === 0) return 4;
      return 0;
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  // 4 个 if + 1 个 && + 1 个 || = 6
  assert.ok(h.complexity.cyclomatic >= 5, `cyclomatic=${h.complexity.cyclomatic}`);
  assert.equal(h.risk, 'medium');
});

test('arrow function (无 body 块) → available=false, reason=expression-body', () => {
  const { sf, fn } = parse(`const add = (a, b) => a + b;`);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.available, false);
  assert.equal(h.reason, 'expression-body');
});

test('throw 计数: 多 throw 正确累加', () => {
  const { sf, fn } = parse(`
    function f(x) {
      if (!x) throw new Error('a');
      if (x < 0) throw new Error('b');
      throw new Error('c');
    }
  `);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.complexity.throws, 3);
});

// === P1 修复回归测试 ===

test('修复: inferTestFramework 区分 vitest / jest / mocha', () => {
  // vitest: vi.mock
  const v = parse(`function t() { vi.mock('./x'); }`);
  const hv = analyzeMethodHealth({ ts, node: v.fn, sourceFile: v.sf });
  assert.equal(hv.testInfo.testFramework, 'vitest');

  // jest: jest.mock
  const j = parse(`function t() { jest.mock('./x'); }`);
  const hj = analyzeMethodHealth({ ts, node: j.fn, sourceFile: j.sf });
  assert.equal(hj.testInfo.testFramework, 'jest');

  // 无 mock 工具调用时,框架不再强行猜 → null(避免把 jest 标成 vitest)
  const n = parse(`function t() { expect(1).toBe(1); }`);
  const hn = analyzeMethodHealth({ ts, node: n.fn, sourceFile: n.sf });
  assert.equal(hn.testInfo.testFramework, null);
});

test('修复: earlyReturns 精确计数(单 return 末位 = 0;非末位 = 1;多 return = n-1)', () => {
  // 末位 return(在 try/finally 后):不算 early
  const a = parse(`function f() { try { return 1; } finally {} }`);
  // try 块内 return 算 if-体内风格,不算方法顶层 early
  const ha = analyzeMethodHealth({ ts, node: a.fn, sourceFile: a.sf });
  assert.equal(ha.complexity.earlyReturns, 0, `a: ${ha.complexity.earlyReturns}`);

  // 单个方法顶层 return 且非末位:算 1
  const b = parse(`function f(x) { return 1; console.log(x); }`);
  const hb = analyzeMethodHealth({ ts, node: b.fn, sourceFile: b.sf });
  assert.equal(hb.complexity.earlyReturns, 1, `b: ${hb.complexity.earlyReturns}`);

  // 多个方法顶层 return(均非末位):除末位外都算 early
  const d = parse(`
    function f(x) {
      if (x < 0) return -1;
      return x * 2;
    }
  `);
  // 这两个 return 都在 if-体内(前者)和末位(后者) → 方法顶层 early=0
  const hd = analyzeMethodHealth({ ts, node: d.fn, sourceFile: d.sf });
  assert.equal(hd.complexity.earlyReturns, 0, `d: ${hd.complexity.earlyReturns}`);

  // 真正的多顶层 return:全部提前(在末位前)
  const e = parse(`
    function f(x) {
      return 1;
      return 2;
      return 3;
    }
  `);
  const he = analyzeMethodHealth({ ts, node: e.fn, sourceFile: e.sf });
  // 3 个 return,末位是 return 3,前 2 个算 early → 2
  assert.equal(he.complexity.earlyReturns, 2, `e: ${he.complexity.earlyReturns}`);
});

test('修复: inJsx 正确识别 JSX 属性中的内联回调', () => {
  // 找含 JSX 的函数
  const src = `
    function C() {
      return <button onClick={() => 1} onChange={(e) => e.target}>x</button>;
    }
  `;
  const sf = ts.createSourceFile('t.tsx', src, ts.ScriptTarget.Latest, true);
  let fn = null;
  function walk(n) {
    if (fn) return;
    if (ts.isFunctionDeclaration(n)) { fn = n; return; }
    ts.forEachChild(n, walk);
  }
  walk(sf);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  // onClick + onChange = 2 个 JSX 内联 lambda
  assert.equal(h.lambdas.count, 2, `count: ${h.lambdas.count}`);
  assert.equal(h.lambdas.inJsx, 2, `inJsx: ${h.lambdas.inJsx}`);
});

test('修复: 非 JSX 上下文的 lambda 不计入 inJsx', () => {
  const src = `function f() { const a = [1,2].map(x => x * 2); return a; }`;
  const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true);
  let fn = null;
  function walk(n) {
    if (fn) return;
    if (ts.isFunctionDeclaration(n)) { fn = n; return; }
    ts.forEachChild(n, walk);
  }
  walk(sf);
  const h = analyzeMethodHealth({ ts, node: fn, sourceFile: sf });
  assert.equal(h.lambdas.count, 1);
  assert.equal(h.lambdas.inJsx, 0, `inJsx 应为 0, 实际: ${h.lambdas.inJsx}`);
});
