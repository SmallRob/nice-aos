import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import { loadSnapshot, saveSnapshot } from '../../ontology/snapshot.js';
import { createBlueprint, ACTION_NAMES } from '../../ontology/blueprint.js';
import { buildOntologyData, buildSingleFileOntology } from '../../ontology/builder.js';
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
      // 借鉴 asdm-aos 的 6 步流水线进度（action.ts doRefreshRepo）：
      // scan:start → scan:done → parse:done → resolve:done → build:done → save:done
      // silent=true（默认）时只输出最终 JSON；silent=false 时输出每步耗时。
      const silent = params.silent !== false; // 默认 silent（保持 JSON 单一输出，向后兼容）
      const stepLog = [];
      const dataMap = await buildOntologyData(projectPath, {
        ...params,
        onProgress: silent ? null : (step, payload) => {
          const ms = payload?.at ?? 0;
          const line = `[${step}] ${ms}ms${payload?.fileCount != null ? ` files=${payload.fileCount}` : ''}${payload?.errorCount != null ? ` err=${payload.errorCount}` : ''}`;
          stepLog.push(line);
          console.error(line);
        },
      });
      const snapshotPath = saveSnapshot(dataMap);
      const meta = dataMap._meta;
      const project = dataMap.Project[0];
      if (!silent) {
        // 步骤汇总（人类可读）
        console.error('');
        console.error('┌─────────────────────────────────────────────┐');
        console.error('│  本体生成完成                                 │');
        console.error('└─────────────────────────────────────────────┘');
        console.error(`仓库: ${project.name}（${project.fileCount} 个源文件）`);
        console.error(`分支: ${project.branch || 'unknown'}, commit: ${(project.commitHash ?? '').substring(0, 8) || 'unknown'}`);
        console.error(`耗时: ${meta.durationMs}ms`);
        console.error(`循环依赖: ${meta.cycles.length}, 死代码候选: ${meta.orphanCandidates.length + meta.deadExportCandidates.length}`);
        if (project.analysisErrors?.length > 0) {
          console.error(`⚠ 分析错误: ${project.analysisErrors.length} 个文件（建议查看 Project.analysisErrors[]）`);
        }
        console.error('');
      }
      console.log(JSON.stringify({
        ok: true,
        message: `已成功导入 ${project.name}（${project.fileCount} 个源文件，${meta.durationMs}ms）`,
        snapshot: snapshotPath,
        stats: meta.objectCounts,
        cycles: meta.cycles.length,
        orphanCandidates: meta.orphanCandidates.length,
        analysisErrors: project.analysisErrors?.length ?? 0,
        ...(silent ? {} : { steps: stepLog }),
      }, null, 2));
      return;
    }

    if (name === 'analyzeFile') {
      const file = params.file ?? params.path;
      if (!file) fail('缺少参数 file（相对 cwd 或绝对路径，支持 .ts/.tsx/.js/.jsx/.mjs/.vue/.rs/.dart）');
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        fail(`文件不存在或不是普通文件: ${filePath}`);
      }
      const dataMap = await buildSingleFileOntology(filePath);
      console.log(JSON.stringify(dataMap, null, 2));
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
