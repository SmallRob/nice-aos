// v0.47 分析器注册表测试：分发链收敛（builderScan / buildSingleFileOntology 共用）+ 进程内扩展点
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAnalyzer, registerAnalyzer, resetRegisteredAnalyzers, listAnalyzers } from '../src/analyzers/analyzerRegistry.js';
import { buildSingleFileOntology } from '../src/ontology/builder.js';

test('注册表：按序判定命中正确的分析器（单文件模式）', () => {
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.go', ext: '.go', scan: null })?.name, 'go');
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.rs', ext: '.rs', scan: null })?.name, 'rust');
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.py', ext: '.py', scan: null })?.name, 'python');
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.vue', ext: '.vue', scan: null })?.name, 'vue');
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.user.js', ext: '.js', scan: null })?.name, 'user-script');
  assert.equal(resolveAnalyzer({ diskPath: '/x/tool.sh', ext: '.sh', scan: null })?.name, 'shell');
  // config 仅在全量扫描链生效（单文件模式保持历史默认路径）
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.yaml', ext: '.yaml', scan: null }), null);
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.yaml', ext: '.yaml', scan: { yamlHint: true } })?.name, 'config');
  // 默认路径
  assert.equal(resolveAnalyzer({ diskPath: '/x/a.ts', ext: '.ts', scan: null }), null);
});

test('注册表：registerAnalyzer 扩展点注入新语言', () => {
  const dispose = registerAnalyzer({
    name: 'mylang',
    match: ({ diskPath }) => diskPath.endsWith('.mylang'),
    fromDisk: () => ({ path: 'x.mylang', ext: 'mylang', lineCount: 1, imports: [], exportNames: [] }),
  });
  try {
    assert.equal(resolveAnalyzer({ diskPath: '/x/a.mylang', ext: '.mylang', scan: null })?.name, 'mylang');
    assert.ok(listAnalyzers().includes('mylang'));
    // 既有路由不受影响
    assert.equal(resolveAnalyzer({ diskPath: '/x/a.go', ext: '.go', scan: null })?.name, 'go');
    // 非法条目报错
    assert.throws(() => registerAnalyzer({ name: 'bad' }));
  } finally {
    dispose();
    assert.equal(resolveAnalyzer({ diskPath: '/x/a.mylang', ext: '.mylang', scan: null }), null);
  }
  resetRegisteredAnalyzers();
});

test('集成：buildSingleFileOntology 经注册表分发（.go 单文件）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-reg-'));
  try {
    const file = path.join(dir, 'main.go');
    fs.writeFileSync(file, [
      'package main',
      '',
      'func main() {',
      '    println("hi")',
      '}',
    ].join('\n'));
    const dm = await buildSingleFileOntology(file);
    assert.equal(dm.SourceFile.length, 1);
    assert.equal(dm._meta.mode, 'single-file');
    assert.ok(dm._meta.objectCounts.Method >= 1, 'go 函数应产出 Method');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
