import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { OBJECT_TYPES } from '../../ontology/blueprint.js';
import { parseWhere, matchesWhere, fail } from '../shared.js';

// ADR 0012 D2（借鉴 asdm-aos count）：按类型计数，单行紧凑 JSON 供 agent 聚合 / jq 管道
export const countCommand = new Command('count')
  .description('按类型计数（单行 JSON：{"ok":true,"type":...,"total":N}）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件，如 "layer=components,kind=page"')
  .action((type, opts) => {
    const dataMap = loadSnapshot();
    const objects = dataMap[type];
    if (!objects) {
      fail(`未知对象类型: ${type}。可用类型: ${OBJECT_TYPES.map((t) => t.type).join(', ')}`);
    }
    const conditions = parseWhere(opts.where);
    const total = objects.filter((o) => matchesWhere(o, conditions)).length;
    console.log(JSON.stringify({ ok: true, type, ...(opts.where ? { where: opts.where } : {}), total }));
  });
