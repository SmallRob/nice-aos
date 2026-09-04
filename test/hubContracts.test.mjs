// 高扇入枢纽契约测试（对应架构评审 F5 / remediation-plan 第 7 条）。
// cli/shared.js、paths.js、ontology/snapshot.js、themes/index.js、ontology/blueprint.js
// 是全仓扇入最高的五个枢纽，其导出名与快照格式被 serve / mcp / CLI 命令 / viewer / storage 同时依赖：
// 任何重命名或删减都必须在这里显式确认，故意改任一导出名时本测试必须失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as cliShared from '../src/cli/shared.js';
import * as paths from '../src/paths.js';
import * as snapshot from '../src/ontology/snapshot.js';
import * as themes from '../src/themes/index.js';
import * as blueprint from '../src/ontology/blueprint.js';

const sortedKeys = (ns) => Object.keys(ns).sort();

test('cli/shared.js：导出名清单冻结', () => {
  assert.deepEqual(sortedKeys(cliShared), [
    'fail', 'loadSnapshotFile', 'matchesWhere', 'outputJson',
    'outputPretty', 'parseFields', 'parseWhere', 'projectObjects',
    'resolveSnapshotDirs', 'succeed',
  ]);
});

test('paths.js：导出名清单冻结', () => {
  assert.deepEqual(sortedKeys(paths), [
    'ENV_VAR', 'getSnapshotDir', 'getSnapshotDirOverride', 'setSnapshotDir',
  ]);
  assert.equal(paths.ENV_VAR, 'NICE_AOS_SNAPSHOT_DIR');
});

test('ontology/snapshot.js：导出名清单冻结', () => {
  assert.deepEqual(sortedKeys(snapshot), [
    'getSnapshotDir', 'getSnapshotDirOverride', 'getSnapshotPath',
    'loadSnapshot', 'saveSnapshot', 'setSnapshotDir',
  ]);
});

test('themes/index.js：导出名清单冻结', () => {
  assert.deepEqual(sortedKeys(themes), [
    'DEFAULT_THEMES', 'THEMES', 'buildThemeCss', 'getUserThemesDir',
    'listThemeNames', 'registerTheme', 'resetUserThemesCache',
    'resolveTheme', 'syncUserThemes',
  ]);
});

test('ontology/blueprint.js：导出名清单冻结', () => {
  assert.deepEqual(sortedKeys(blueprint), [
    'ACTION_NAMES', 'BLUEPRINT_SCHEMA', 'LINK_TYPES', 'OBJECT_TYPES',
    'ONTOLOGY_META', 'createBlueprint', 'createBlueprintV2', 'createIndex',
  ]);
});

test('快照格式：OBJECT_TYPES 对象类型键集合冻结（= 快照顶层键契约）', () => {
  const types = blueprint.OBJECT_TYPES.map((t) => t.type).sort();
  assert.deepEqual(types, [
    'ArchPackage', 'ArchPackageFunction', 'BashBuiltin', 'BashFunction',
    'CMakeFunction', 'CMakeModule', 'CMakeOption', 'CMakeTarget',
    'Class', 'Cmdlet', 'Component', 'Dependency', 'Domain', 'GmApiUsage',
    'Hook', 'InjectionPoint', 'Interface', 'Method', 'Module',
    'NetworkEndpoint', 'NixFlake', 'NixInput', 'NixPackage', 'Project',
    'PropEdge', 'PsFunction', 'PsScript', 'RosChannel', 'RosLaunch',
    'RosNode', 'Route', 'ScriptFunction', 'Service', 'ShellScript',
    'SourceFile', 'Store', 'Trait', 'UserScript',
  ]);
  for (const t of blueprint.OBJECT_TYPES) {
    assert.ok(
      t.type && t.prefix && t.category && t.level && t.description,
      `OBJECT_TYPES 条目缺失必备字段: ${JSON.stringify(t)}`,
    );
  }
});

test('快照格式：LINK_TYPES 无重复且核心链接类型仍在', () => {
  const set = new Set(blueprint.LINK_TYPES);
  assert.equal(set.size, blueprint.LINK_TYPES.length, 'LINK_TYPES 出现重复');
  for (const core of ['contains', 'imports', 'importedBy', 'renders', 'calls', 'calledBy', 'mapsToTable', 'callsApi']) {
    assert.ok(set.has(core), `LINK_TYPES 缺少核心类型: ${core}`);
  }
});

// save/load 契约：临时目录 round-trip，结束后恢复目录覆盖与环境变量
function withTempSnapshotDir(fn) {
  const prevOverride = paths.getSnapshotDirOverride();
  const prevEnv = process.env[paths.ENV_VAR];
  delete process.env[paths.ENV_VAR];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hub-contract-'));
  try {
    snapshot.setSnapshotDir(tmpDir);
    return fn(tmpDir);
  } finally {
    snapshot.setSnapshotDir(prevOverride);
    if (prevEnv !== undefined) process.env[paths.ENV_VAR] = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('快照格式：saveSnapshot/loadSnapshot round-trip 保持数据不变', () => {
  withTempSnapshotDir((tmpDir) => {
    assert.equal(snapshot.getSnapshotPath(), path.join(tmpDir, 'snapshot.json'));
    const dataMap = {
      _meta: { generatedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, cycles: [], orphanCandidates: [], deadExportCandidates: [] },
      Module: [{ id: 'mod:a', name: 'a' }],
    };
    const written = snapshot.saveSnapshot(dataMap);
    assert.equal(written, path.join(tmpDir, 'snapshot.json'));
    assert.deepEqual(snapshot.loadSnapshot(), dataMap);
  });
});

test('快照格式：快照缺失时 loadSnapshot 抛 NO_SNAPSHOT（CLI 依赖该错误码给出指引）', () => {
  withTempSnapshotDir(() => {
    assert.throws(
      () => snapshot.loadSnapshot(),
      (err) => err.code === 'NO_SNAPSHOT',
    );
  });
});

// 真实自扫描快照（若已构建）顶层键必须符合 _meta + OBJECT_TYPES 子集
const REAL_SNAPSHOT = path.resolve('.nice-aos/data/snapshot.json');
test(
  '真实自扫描快照：顶层键 = _meta + OBJECT_TYPES 键集合子集',
  { skip: fs.existsSync(REAL_SNAPSHOT) ? false : '无快照（先运行 npm run aos:self）' },
  () => {
    const snap = JSON.parse(fs.readFileSync(REAL_SNAPSHOT, 'utf-8'));
    const typeNames = new Set(blueprint.OBJECT_TYPES.map((t) => t.type));
    for (const key of Object.keys(snap)) {
      assert.ok(key === '_meta' || typeNames.has(key), `快照出现未登记的顶层键: ${key}`);
    }
    assert.ok(snap._meta && typeof snap._meta.generatedAt === 'string', '_meta.generatedAt 缺失');
    assert.ok(Array.isArray(snap._meta.cycles), '_meta.cycles 必须是数组');
    assert.ok(Array.isArray(snap._meta.orphanCandidates), '_meta.orphanCandidates 必须是数组');
    assert.ok(Array.isArray(snap._meta.deadExportCandidates), '_meta.deadExportCandidates 必须是数组');
  },
);
