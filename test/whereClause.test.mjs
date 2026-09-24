// v0.47 --where 扩展测试（借鉴 asdm-aos whereClause）：数值比较 + 点路径嵌套字段
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhere, matchesWhere } from '../src/cli/shared.js';

test('parseWhere：四类操作符解析（首个操作符胜出）', () => {
  assert.deepEqual(parseWhere('k=5'), [{ key: 'k', op: 'eq', value: '5' }]);
  assert.deepEqual(parseWhere('k~abc'), [{ key: 'k', op: 'contains', value: 'abc' }]);
  assert.deepEqual(parseWhere('k>5'), [{ key: 'k', op: 'gt', value: '5' }]);
  assert.deepEqual(parseWhere('k>=5'), [{ key: 'k', op: 'gte', value: '5' }]);
  assert.deepEqual(parseWhere('k<5'), [{ key: 'k', op: 'lt', value: '5' }]);
  assert.deepEqual(parseWhere('k<=5'), [{ key: 'k', op: 'lte', value: '5' }]);
  // 多条件 AND + 混合操作符
  assert.deepEqual(parseWhere('kind=page,callCount>3'), [
    { key: 'kind', op: 'eq', value: 'page' },
    { key: 'callCount', op: 'gt', value: '3' },
  ]);
  // 值内再出现 = 不拆分（首个操作符胜出，与既有语义一致）
  assert.deepEqual(parseWhere('k=a=b'), [{ key: 'k', op: 'eq', value: 'a=b' }]);
  assert.deepEqual(parseWhere('novalue'), [], '无操作符时为空条件数组（既有语义）');
  assert.equal(parseWhere(''), null);
  assert.equal(parseWhere(null), null);
});

test('matchesWhere：数值比较（含数字字符串 / 非数值不命中 / 边界）', () => {
  const obj = { callCount: 5, name: 'x', health: { cyclomatic: 7 } };
  assert.equal(matchesWhere(obj, parseWhere('callCount>3')), true);
  assert.equal(matchesWhere(obj, parseWhere('callCount>=5')), true);
  assert.equal(matchesWhere(obj, parseWhere('callCount>5')), false);
  assert.equal(matchesWhere(obj, parseWhere('callCount<10')), true);
  assert.equal(matchesWhere(obj, parseWhere('callCount<=4')), false);
  // 非数值字段 / 缺失字段 → 不命中（不做字符串字典序）
  assert.equal(matchesWhere(obj, parseWhere('name>3')), false);
  assert.equal(matchesWhere(obj, parseWhere('nope>0')), false);
  // 点路径
  assert.equal(matchesWhere(obj, parseWhere('health.cyclomatic>5')), true);
  assert.equal(matchesWhere(obj, parseWhere('health.cyclomatic<=7')), true);
  assert.equal(matchesWhere(obj, parseWhere('health.nope>0')), false);
  assert.equal(matchesWhere(obj, parseWhere('nope.deeper=1')), false);
});

test('matchesWhere：既有语义零回归（eq/contains/数组）', () => {
  const obj = { kind: 'page', names: ['a', 'Bc'], apiMatch: { methodMatches: true } };
  assert.equal(matchesWhere(obj, parseWhere('kind=page')), true);
  assert.equal(matchesWhere(obj, parseWhere('kind:page')), true);
  assert.equal(matchesWhere(obj, parseWhere('kind~PAG')), true);
  assert.equal(matchesWhere(obj, parseWhere('names=Bc')), true, '数组精确为成员包含（大小写敏感）');
  assert.equal(matchesWhere(obj, parseWhere('names~bc')), true, '数组模糊为任一成员包含（忽略大小写）');
  assert.equal(matchesWhere(obj, parseWhere('apiMatch.methodMatches=true')), true, '布尔嵌套字段字符串相等');
});
