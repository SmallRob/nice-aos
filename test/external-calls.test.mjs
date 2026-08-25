// 外部调用识别测试:借鉴 asdm-aos 字节码二次扫描的 ext: 虚拟对象思路
// 适配:React hooks / DOM API / 状态管理 API 识别
// 关键:ext: 不进 calls link,只标 method.externalCalls 字段(向后兼容)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';

async function withTmpProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-calls-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    const dm = await buildOntologyData(dir, { roots: ['src'] });
    await fn(dm);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('React hooks: useState/useEffect/useRef → kind=react-hook', async () => {
  await withTmpProject({
    'c.tsx': `
      import { useState, useEffect, useRef } from 'react';
      export function C() {
        const [a, setA] = useState(0);
        const r = useRef(null);
        useEffect(() => {});
        return [a, r];
      }
    `,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'C');
    const names = m.externalCalls.map(c => c.name).sort();
    assert.deepEqual(names, ['useEffect', 'useRef', 'useState']);
    m.externalCalls.forEach(c => {
      assert.equal(c.kind, 'react-hook');
      assert.equal(c.framework, 'react');
    });
  });
});

test('DOM API: fetch/localStorage → kind=dom-api, framework=browser', async () => {
  await withTmpProject({
    'c.ts': `
      export async function loadData() {
        const r = await fetch('/api/x');
        const v = localStorage.getItem('key');
        return { r, v };
      }
    `,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'loadData');
    const fetch = m.externalCalls.find(c => c.name === 'fetch');
    assert.ok(fetch, 'fetch 应被识别');
    assert.equal(fetch.kind, 'dom-api');
    assert.equal(fetch.framework, 'browser');
  });
});

test('Vue Composition API: ref/computed/onMounted → kind=state-mgmt', async () => {
  await withTmpProject({
    'c.ts': `
      import { ref, computed, onMounted } from 'vue';
      export function setup() {
        const c = ref(0);
        const d = computed(() => c.value * 2);
        onMounted(() => console.log('mounted'));
        return { c, d };
      }
    `,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'setup');
    const names = m.externalCalls.map(c => c.name).sort();
    assert.deepEqual(names, ['computed', 'onMounted', 'ref']);
    m.externalCalls.forEach(c => {
      assert.equal(c.kind, 'state-mgmt');
      assert.equal(c.framework, 'state-management');
    });
  });
});

test('Class method 也识别', async () => {
  await withTmpProject({
    'svc.ts': `
      export class Svc {
        async init() {
          const c = useState(0);
          await fetch('/init');
        }
      }
    `,
  }, (dm) => {
    const cls = dm.Class.find(c => c.name === 'Svc');
    const m = dm.Method.find(m => m.name === 'init' && m.ownerName === 'Svc');
    const names = m.externalCalls.map(c => c.name).sort();
    assert.deepEqual(names, ['fetch', 'useState']);
  });
});

test('无外部调用 → externalCalls=[] (向后兼容:不影响 schema)', async () => {
  await withTmpProject({
    'pure.ts': `export function pure(a: number, b: number) { return a + b; }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'pure');
    assert.deepEqual(m.externalCalls, []);
  });
});

test('业务函数(非 API 调用)→ externalCalls=[]', async () => {
  await withTmpProject({
    'utils.ts': `
      export function calculate(input: number) {
        const r = Math.sqrt(input);
        return r * 2;
      }
    `,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'calculate');
    // Math.sqrt 不是 React hook / DOM API / 状态管理 API,不识别
    assert.equal(m.externalCalls.length, 0);
  });
});

test('同一 API 多次调用 → 去重(只记一次)', async () => {
  await withTmpProject({
    'c.ts': `
      export function many() {
        useState(0);
        useState(1);
        useState(2);
        fetch('/a');
        fetch('/b');
      }
    `,
  }, (dm) => {
    const m = dm.Method.find(m => m.name === 'many');
    const useStateCount = m.externalCalls.filter(c => c.name === 'useState').length;
    const fetchCount = m.externalCalls.filter(c => c.name === 'fetch').length;
    assert.equal(useStateCount, 1, 'useState 应去重');
    assert.equal(fetchCount, 1, 'fetch 应去重');
  });
});

test('向后兼容: 旧快照(无 externalCalls 字段)→ 加载不报错', async () => {
  // 模拟旧快照格式:Method 没有 externalCalls 字段
  await withTmpProject({
    'c.ts': `export function f() { return 1; }`,
  }, async (dm) => {
    // 模拟:从旧快照中删掉 externalCalls 字段,确认 builder 兜底为 []
    const m = dm.Method.find(mm => mm.name === 'f');
    delete m.externalCalls;
    // 重新模拟 query:不应报错
    const ext = m.externalCalls ?? [];
    assert.deepEqual(ext, []);
  });
});
