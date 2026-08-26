import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import { loadSnapshot, saveSnapshot } from '../../ontology/snapshot.js';
import { createBlueprint, ACTION_NAMES } from '../../ontology/blueprint.js';
import { buildOntologyData, buildSingleFileOntology } from '../../ontology/builder.js';
import { detectProjectRoot } from '../../analyzers/projectRootDetector.js';
import { fail } from '../shared.js';
import { applyOverlay, saveSnapshot as sqlSaveSnapshot } from '../../storage/index.js';
import { parseObjectId } from '../../storage/objectId.js';

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
      // 借鉴 asdm-aos v0.0.12 projectDetector：自动检测项目根
      // 优先级：显式 repoPath/projectPath > 文件路径（向上找） > cwd（向上找） > 报清晰错
      let projectPath;
      let projectRootMeta = null;
      const explicitPath = params.repoPath ?? params.projectPath;

      if (explicitPath) {
        const resolved = path.resolve(explicitPath);
        if (fs.existsSync(resolved)) {
          const stat = fs.statSync(resolved);
          if (stat.isFile()) {
            // 文件路径 → 向上找项目根
            const detected = detectProjectRoot(resolved);
            if (detected) {
              projectPath = detected.root;
              projectRootMeta = { source: 'file-path', from: resolved, ...detected };
            } else {
              // 找不到 marker 时使用文件所在目录（兼容无 marker 的简单项目）
              projectPath = path.dirname(resolved);
              projectRootMeta = { source: 'file-dir-fallback', from: resolved };
            }
          } else {
            // 目录路径 → 先尝试作为项目根；若不是项目根则向上找
            const detected = detectProjectRoot(resolved);
            if (detected) {
              projectPath = detected.root;
              projectRootMeta = { source: 'explicit', from: resolved, ...detected };
            } else {
              projectPath = resolved; // 目录无 marker 仍允许（如纯油猴脚本）
              projectRootMeta = { source: 'explicit-no-marker', from: resolved };
            }
          }
        } else {
          fail(`路径不存在: ${resolved}`);
        }
      } else {
        // 未传 repoPath → 从 cwd 向上找
        const detected = detectProjectRoot('', { cwd: process.cwd() });
        if (detected) {
          projectPath = detected.root;
          projectRootMeta = { source: 'cwd-detected', ...detected };
        } else {
          // 找不到 marker → 退到 cwd 本身
          projectPath = process.cwd();
          projectRootMeta = { source: 'cwd-fallback' };
        }
      }

      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        fail(`项目路径不是目录: ${projectPath}`);
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
        // 项目根来源（借鉴 asdm-aos projectDetector；方便 agent 复盘）
        projectRoot: projectRootMeta
          ? {
              path: projectPath,
              source: projectRootMeta.source,
              marker: projectRootMeta.marker ?? null,
              description: projectRootMeta.description ?? null,
            }
          : { path: projectPath, source: 'unset' },
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
      // v0.31 双写：SQLite overlay 增量追加（no-snapshot 时先镜像当前 dataMap 再写 overlay）
      try {
        const { type, id } = parseObjectId(objectId);
        let r = applyOverlay({ kind: 'code', type, id, patch: { reviewed: true, reviewedAt: obj.reviewedAt } });
        if (r && r.ok === false && r.reason === 'no-snapshot') {
          const w = sqlSaveSnapshot({ kind: 'code', dataMap });
          if (w.ok) r = applyOverlay({ kind: 'code', type, id, patch: { reviewed: true, reviewedAt: obj.reviewedAt } });
        }
        if (r && r.ok === false) console.error(`⚠️ SQLite 双写失败: ${r.reason}（JSON 快照已更新，不影响本次结果）`);
      } catch (err) {
        console.error(`⚠️ SQLite 双写异常: ${err.message}`);
      }
      console.log(JSON.stringify({ ok: true, message: `已标记 ${objectId} 为已审查` }, null, 2));
      return;
    }

    if (name === 'addNote') {
      const { objectId, note } = params;
      if (!objectId) fail('缺少参数 objectId');
      if (!note) fail('缺少参数 note（不可为空）');
      const obj = blueprint.find(objectId);
      if (!obj) fail(`对象不存在: ${objectId}`);
      const existing = obj.notes;
      obj.notes = existing ? `${existing}\n${note}` : note;
      saveSnapshot(dataMap);
      // v0.31 双写：SQLite overlay 增量追加（no-snapshot 时先镜像当前 dataMap 再写 overlay）
      try {
        const { type, id } = parseObjectId(objectId);
        let r = applyOverlay({ kind: 'code', type, id, patch: { notes: obj.notes } });
        if (r && r.ok === false && r.reason === 'no-snapshot') {
          const w = sqlSaveSnapshot({ kind: 'code', dataMap });
          if (w.ok) r = applyOverlay({ kind: 'code', type, id, patch: { notes: obj.notes } });
        }
        if (r && r.ok === false) console.error(`⚠️ SQLite 双写失败: ${r.reason}（JSON 快照已更新，不影响本次结果）`);
      } catch (err) {
        console.error(`⚠️ SQLite 双写异常: ${err.message}`);
      }
      console.log(JSON.stringify({ ok: true, message: `已为 ${objectId} 添加注释` }, null, 2));
    }
  });
