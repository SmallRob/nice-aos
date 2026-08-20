import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import { loadSnapshot, saveSnapshot } from '../../ontology/snapshot.js';
import { createBlueprint, ACTION_NAMES } from '../../ontology/blueprint.js';
import { buildOntologyData } from '../../ontology/builder.js';
import { fail } from '../shared.js';

export const actionCommand = new Command('action')
  .description('执行受控动作（' + ACTION_NAMES.join('/') + '）')
  .argument('<name>', '动作名称')
  .option('--params <json>', '动作参数 JSON', '{}')
  .action(async (name, opts) => {
    let params = {};
    try {
      params = JSON.parse(opts.params ?? '{}');
    } catch {
      fail(`--params 不是合法 JSON: ${opts.params}`);
    }

    if (name === 'refreshRepo') {
      const projectPath = path.resolve(params.repoPath ?? params.projectPath ?? process.cwd());
      // 纯油猴脚本仓库可无 package.json，改用目录存在性校验（扫描器对缺失的 package.json 已有兜底）
      if (!fs.existsSync(projectPath)) {
        fail(`路径不存在: ${projectPath}`);
      }
      if (!fs.statSync(projectPath).isDirectory()) {
        fail(`路径不是目录: ${projectPath}`);
      }
      const dataMap = await buildOntologyData(projectPath, params);
      const snapshotPath = saveSnapshot(dataMap);
      const meta = dataMap._meta;
      console.log(JSON.stringify({
        ok: true,
        message: `已成功导入 ${dataMap.Project[0].name}（${dataMap.Project[0].fileCount} 个源文件，${meta.durationMs}ms）`,
        snapshot: snapshotPath,
        stats: meta.objectCounts,
        cycles: meta.cycles.length,
        orphanCandidates: meta.orphanCandidates.length,
        analysisErrors: dataMap.Project[0].analysisErrors.length,
      }, null, 2));
      return;
    }

    if (!ACTION_NAMES.includes(name)) {
      fail(`未知动作: ${name}。可用动作: ${ACTION_NAMES.join(', ')}`);
    }

    const dataMap = loadSnapshot();
    const blueprint = createBlueprint(dataMap);

    if (name === 'markReviewed') {
      const { objectId } = params;
      if (!objectId) fail('缺少参数 objectId');
      const obj = blueprint.find(objectId);
      if (!obj) fail(`对象不存在: ${objectId}`);
      obj.reviewed = true;
      obj.reviewedAt = new Date().toISOString();
      saveSnapshot(dataMap);
      console.log(JSON.stringify({ ok: true, message: `已标记 ${objectId} 为已审查` }, null, 2));
      return;
    }

    if (name === 'addNote') {
      const { objectId, note } = params;
      if (!objectId) fail('缺少参数 objectId');
      if (!note) fail('缺少参数 note（不可为空）');
      const obj = blueprint.find(objectId);
      if (!obj) fail(`对象不存在: ${objectId}`);
      obj.notes = obj.notes ? `${obj.notes}\n${note}` : note;
      saveSnapshot(dataMap);
      console.log(JSON.stringify({ ok: true, message: `已为 ${objectId} 添加注释` }, null, 2));
    }
  });
