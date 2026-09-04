import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { OBJECT_TYPES } from '../../ontology/blueprint.js';
import { parseWhere, matchesWhere, parseFields, projectObjects, outputJson, outputPretty, fail } from '../shared.js';

const DEFAULT_LIMIT = 50;

export const queryCommand = new Command('query')
  .description('查询本体对象（类型: ' + OBJECT_TYPES.map((t) => t.type).join('/') + '）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件，如 "layer=components,kind=page"')
  .option('--all', '返回全部（默认仅前 50 条）')
  .option('--limit <n>', '限制返回条数')
  .option('--field <fields>', '字段投影，逗号分隔，如 "id,name,filePath"（id 恒保留；在 where/limit 之后应用）')
  .option('--pretty', '人类可读表格输出')
  .action((type, opts) => {
    const dataMap = loadSnapshot();
    const objects = dataMap[type];
    if (!objects) {
      fail(`未知对象类型: ${type}。可用类型: ${OBJECT_TYPES.map((t) => t.type).join(', ')}`);
    }
    const conditions = parseWhere(opts.where);
    let result = objects.filter((o) => matchesWhere(o, conditions));
    const total = result.length;
    if (!opts.all) {
      const limit = opts.limit ? parseInt(opts.limit, 10) : DEFAULT_LIMIT;
      result = result.slice(0, limit);
    }
    const fields = parseFields(opts.field);
    if (fields) result = projectObjects(result, fields);
    if (opts.pretty) outputPretty(result);
    else outputJson(result);
    if (total > result.length) {
      console.error(`# 共 ${total} 条，当前返回 ${result.length} 条（--all 查看全部）`);
    }
  });
