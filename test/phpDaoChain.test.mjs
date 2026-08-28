// PHP DAO 链抽取回归测试（v0.36.1 候选 4，Phase-2）：
// sqlQueries 通道（借鉴 pythonAnalyzer/tsAnalyzer 契约 {kind, table, dynamic}）+
// TABLE_X 常量经 define 解析 + blueprint mapsToTable/mappedFromCode 链接消费。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePhpFile } from '../src/analyzers/phpAnalyzer.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint } from '../src/ontology/blueprint.js';

test('phpAnalyzer：DAO 链 sqlQueries 提取（select/from、update/insert 内联、join、字符串表）', () => {
  const facts = analyzePhpFile('model.php', `<?php
class bugModel extends model
{
    public function getById($id)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->where('id', $id)->fetch();
    }

    public function updateBug($id, $data)
    {
        $this->dao->update(TABLE_BUG)->set('title', $data)->where('id', $id)->exec();
    }

    public function insertLog($data)
    {
        $this->dao->insert('zt_action')->data($data)->exec();
    }

    public function listJoin($productID)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->leftJoin(TABLE_USER)->where('product', $productID)->fetchAll();
    }

    public function remove($id)
    {
        $this->dao->delete()->from(TABLE_BUG)->where('id', $id)->exec();
    }

    public function noDao()
    {
        return 1 + 1;
    }
}
`);
  const cls = facts.classes[0];
  const q = (name) => cls.methods.find((m) => m.name === name)?.sqlQueries ?? [];
  // select ... from(TABLE_BUG) → SELECT + 常量 dynamic
  assert.deepEqual(q('getById'), [{ kind: 'SELECT', table: 'TABLE_BUG', dynamic: true }]);
  // update(TABLE_BUG) 内联
  assert.deepEqual(q('updateBug'), [{ kind: 'UPDATE', table: 'TABLE_BUG', dynamic: true }]);
  // insert('zt_action') 字符串字面量 → 静态
  assert.deepEqual(q('insertLog'), [{ kind: 'INSERT', table: 'zt_action', dynamic: false }]);
  // join 捕获（SELECT + JOIN 两条）
  const joinQ = q('listJoin');
  assert.ok(joinQ.some((x) => x.kind === 'SELECT' && x.table === 'TABLE_BUG'));
  assert.ok(joinQ.some((x) => x.kind === 'JOIN' && x.table === 'TABLE_USER'), 'leftJoin(TABLE_USER) → JOIN');
  // delete ... from
  assert.deepEqual(q('remove'), [{ kind: 'DELETE', table: 'TABLE_BUG', dynamic: true }]);
  // 无 DAO 调用方法为空
  assert.deepEqual(q('noDao'), []);
});

test('phpAnalyzer：defines 提取（含反引号剥离）', () => {
  const facts = analyzePhpFile('config.php', `<?php
define('TABLE_BUG', \`zt_bug\`);
define('TABLE_USER', 'zt_user');
define('NOISE', 'not-a-table');
`);
  assert.equal(facts.defines.TABLE_BUG, 'zt_bug');
  assert.equal(facts.defines.TABLE_USER, 'zt_user');
  assert.equal(facts.defines.NOISE, 'not-a-table');
});

test('e2e：buildOntologyData → Method.sqlQueries 常量解析 + mapsToTable 链接', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-dao-'));
  try {
    fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ name: 'zentao/sample', require: {} }));
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'config.php'), `<?php
define('TABLE_BUG', \`zt_bug\`);
define('TABLE_USER', 'zt_user');
`);
    fs.mkdirSync(path.join(root, 'module', 'bug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'module', 'bug', 'model.php'), `<?php
class bugModel extends model
{
    public function getById($id)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->where('id', $id)->fetch();
    }

    public function byUser($user)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->leftJoin(TABLE_USER)->where('assignedTo', $user)->fetchAll();
    }
}
`);
    const dataMap = await buildOntologyData(root, { report: () => {} });
    // Method.sqlQueries：TABLE_BUG → zt_bug（define 解析，dynamic 清除）
    const getById = (dataMap.Method ?? []).find((m) => m.name === 'getById');
    assert.ok(getById, 'getById 方法实体存在');
    assert.deepEqual(getById.sqlQueries, [{ kind: 'SELECT', table: 'zt_bug', dynamic: false }]);

    // blueprint mapsToTable：注入 Table 对象后类 → 表链接（通道 2b 聚合子方法 sqlQueries）
    dataMap.Table = [
      { id: 'table:zt_bug', name: 'zt_bug', columnCount: 5, reviewed: false, notes: null },
      { id: 'table:zt_user', name: 'zt_user', columnCount: 3, reviewed: false, notes: null },
    ];
    const bp = createBlueprint(dataMap);
    const bugModel = (dataMap.Class ?? []).find((c) => c.name === 'bugModel');
    const tables = bp.link('mapsToTable', bugModel.id);
    const tableNames = tables.map((t) => t.name).sort();
    assert.deepEqual(tableNames, ['zt_bug', 'zt_user'], 'bugModel → zt_bug/zt_user（JOIN 也计入）');
    // 对称：mappedFromCode
    const src = bp.link('mappedFromCode', 'table:zt_bug');
    assert.ok(src.some((o) => o.id === bugModel.id), 'zt_user ← mappedFromCode(bugModel)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
