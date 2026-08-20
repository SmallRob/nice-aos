import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { createBlueprint, LINK_TYPES } from '../../ontology/blueprint.js';
import { outputJson, outputPretty, fail } from '../shared.js';

export const linkCommand = new Command('link')
  .description('遍历链接关系（类型: ' + LINK_TYPES.join('/') + '）')
  .argument('<linkType>', '链接类型')
  .requiredOption('--src <id>', '源对象 ID，如 route:steam_dashboard / comp:HealthStatsPage / store:useThemeStore')
  .option('--pretty', '人类可读表格输出')
  .action((linkType, opts) => {
    const dataMap = loadSnapshot();
    if (!LINK_TYPES.includes(linkType)) {
      fail(`未知链接类型: ${linkType}。可用类型: ${LINK_TYPES.join(', ')}`);
    }
    const blueprint = createBlueprint(dataMap);
    let result;
    try {
      result = blueprint.link(linkType, opts.src);
    } catch (err) {
      fail(err.message);
    }
    if (opts.pretty) outputPretty(result);
    else outputJson(result);
  });
