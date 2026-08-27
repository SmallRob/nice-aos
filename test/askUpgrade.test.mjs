// ask 命令 v0.34.0 升级单测：
//   - agentRunner：注册表扩展（trae/qoder/...）、resolveAgent 报错指引、--agent-cmd 模板编译
//   - askEval：scoreAnswer 纯函数评分、loadCases JSONL 解析、runEval 批量执行
//   - askSave：resolveSavePath / formatAskArchive
//   - askDiffContext：buildSinceContext（临时 git 仓库，无变更→null；untracked 变更→对象折叠）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RUNNER = path.join(ROOT, 'src/cli/commands/agentRunner.js');
const EVAL = path.join(ROOT, 'src/cli/commands/askEval.js');
const SAVE = path.join(ROOT, 'src/cli/commands/askSave.js');
const DIFF = path.join(ROOT, 'src/cli/commands/askDiffContext.js');

// ---------- agentRunner ----------

describe('agentRunner 注册表', () => {
  test('注册表包含 trae / qoder 等新增 CLI，实验性条目带标记', async () => {
    const m = await import(RUNNER);
    for (const name of ['codebuddy', 'opencode', 'trae', 'qoder', 'claude', 'codex', 'qwen', 'aider']) {
      const probe = m.AGENT_PROBES.find((p) => p.name === name);
      assert.ok(probe, `缺少 ${name}`);
      if (!['codebuddy', 'opencode'].includes(name)) {
        assert.equal(probe.experimental, true, `${name} 应标记 experimental`);
      }
    }
  });

  test('resolveAgent("trae") 返回探针且 buildArgs 注入 prompt 到位', async () => {
    const { resolveAgent } = await import(RUNNER);
    const probe = resolveAgent('trae');
    assert.equal(probe.binary, 'trae');
    assert.deepEqual(probe.buildArgs('你好'), ['-p', '你好']);
  });

  test('resolveAgent 未知名字报错并列出注册名与 --agent-cmd 指引', async () => {
    const { resolveAgent } = await import(RUNNER);
    assert.throws(() => resolveAgent('nope'), /--agent-cmd/);
  });

  test('--agent-cmd 模板编译：{prompt} 占位注入（可多处）', async () => {
    const { compileAgentCmd } = await import(RUNNER);
    const probe = compileAgentCmd('myai --ask {prompt} --lang zh-{prompt}');
    assert.deepEqual(probe.buildArgs('Q'), ['--ask', 'Q', '--lang', 'zh-Q']);
  });

  test('--agent-cmd 模板编译：无占位符时 prompt 追加末尾；空模板报错', async () => {
    const { compileAgentCmd } = await import(RUNNER);
    const probe = compileAgentCmd('myai --ask');
    assert.deepEqual(probe.buildArgs('Q'), ['--ask', 'Q']);
    assert.match(probe.name, /^myai/);
    assert.throws(() => compileAgentCmd('   '), /不能为空/);
    assert.throws(() => compileAgentCmd('{prompt} run'), /二进制段不可含/);
  });
});

// ---------- askEval ----------

describe('askEval 评测 harness', () => {
  test('scoreAnswer：字符串关键词全部命中才算过；数组关键词任选其一', async () => {
    const { scoreAnswer } = await import(EVAL);
    assert.equal(scoreAnswer({ mustInclude: ['功能域'] }, '本项目有 5 个功能域').passed, true);
    assert.equal(scoreAnswer({ mustInclude: ['功能域'] }, '看不懂').passed, false);
    const r1 = scoreAnswer({ mustInclude: [['Tarjan', '环']] }, '检测到循环依赖（环）');
    assert.equal(r1.passed, true);
    const r2 = scoreAnswer({ mustInclude: [['Tarjan', '环']] }, '什么都没发现');
    assert.equal(r2.passed, false);
    // 大小写不敏感
    assert.equal(scoreAnswer({ mustInclude: ['GraphQL'] }, '用了 graphql.js').passed, true);
  });

  test('scoreAnswer：mustExclude 命中即违规', async () => {
    const { scoreAnswer } = await import(EVAL);
    const r = scoreAnswer(
      { mustInclude: ['死代码'], mustExclude: ['我无法回答'] },
      '死代码候选如下，但我无法回答细节',
    );
    assert.equal(r.passed, false);
    assert.deepEqual(r.violated, ['我无法回答']);
  });

  test('loadCases：跳过注释行，坏行带行号报错，缺断言的用例拒绝', async () => {
    const { loadCases } = await import(EVAL);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-eval-'));
    const file = path.join(dir, 'cases.jsonl');
    fs.writeFileSync(file, [
      '# 注释行',
      JSON.stringify({ id: 'a', question: 'Q1?', mustInclude: ['k'] }),
      '',
      '{bad json',
    ].join('\n'));
    assert.throws(() => loadCases(file), /第 4 行.*JSON/);

    fs.writeFileSync(file, [JSON.stringify({ id: 'b', question: 'Q?' })].join('\n'));
    assert.throws(() => loadCases(file), /mustInclude \/ mustExclude 至少需要一个/);

    fs.writeFileSync(file, [
      JSON.stringify({ id: 'x', question: 'Q1?', mustExclude: ['bad'] }),
      JSON.stringify({ question: 'Q2?', mustInclude: [['A', 'B']] }),
    ].join('\n'));
    const cases = loadCases(file);
    assert.equal(cases.length, 2);
    assert.equal(cases[1].id, 'case-2'); // 缺 id 自动编号
  });

  test('runEval：pass / fail / 调用异常三类汇总与通过率', async () => {
    const { runEval } = await import(EVAL);
    const report = await runEval({
      cases: [
        { id: 'ok', question: 'q', mustInclude: ['good'] },
        { id: 'miss', question: 'q', mustInclude: ['never'] },
        { id: 'boom', question: 'q', mustInclude: ['x'] },
      ],
      invoke: async (tc) => {
        if (tc.id === 'boom') throw new Error('agent 全挂');
        return { answer: tc.id === 'ok' ? '回答里有 good 词' : '', meta: { agent: 'fake' } };
      },
    });
    assert.equal(report.total, 3);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 2);
    assert.equal(report.passRate, 0.3333);
    const boom = report.results.find((r) => r.id === 'boom');
    assert.match(boom.error, /agent 全挂/);
  });
});

// ---------- askSave ----------

describe('askSave 回答落盘', () => {
  test('resolveSavePath：显式路径优先；默认落 <baseDir>/answers/ask-<ts>.md', async () => {
    const { resolveSavePath } = await import(SAVE);
    assert.equal(resolveSavePath('out/r.md', '/tmp/x').filePath, path.resolve('out/r.md'));
    const def = resolveSavePath(undefined, '/base/snap');
    assert.match(def.filePath, /^\/base\/snap[\\/]answers[\\/]ask-\d{4}-\d{2}-\d{2}T/);
  });

  test('formatAskArchive：元信息头 + 问题 + 回答；降级链/增量范围可选行', async () => {
    const { formatAskArchive } = await import(SAVE);
    const md = formatAskArchive({
      question: '这个项目？',
      answer: '答案正文',
      agent: 'api',
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextSource: 'sqlite',
      durationMs: 1500,
      fallbackFrom: ['codebuddy'],
      since: { spec: 'HEAD~1' },
      tools: true,
    });
    assert.match(md, /# nice-aos ask 回答存档/);
    assert.match(md, /deepseek · deepseek-chat/);
    assert.match(md, /降级链\*\*: codebuddy/);
    assert.match(md, /增量范围\*\*: HEAD~1/);
    assert.match(md, /自治工具\*\*: 已启用/);
    assert.match(md, /## 问题[\s\S]+这个项目？[\s\S]+## 回答[\s\S]+答案正文/);
  });

  test('writeAskArchive：父目录自动创建', async () => {
    const { writeAskArchive } = await import(SAVE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-save-'));
    const p = path.join(dir, 'nested', 'dir', 'answer.md');
    writeAskArchive(p, '# 内容');
    assert.equal(fs.readFileSync(p, 'utf-8'), '# 内容');
  });
});

// ---------- askDiffContext ----------

describe('askDiffContext 跨快照 diff 问答', () => {
  function makeTempGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-diff-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir });
    return dir;
  }

  test('干净仓库 since HEAD → 无变更 section=null', async () => {
    const { buildSinceContext } = await import(DIFF);
    const repo = makeTempGitRepo();
    const origCwd = process.cwd();
    process.chdir(repo);
    try {
      const r = buildSinceContext({}, { since: 'HEAD' });
      assert.equal(r.section, null);
      assert.deepEqual(r.files, []);
    } finally {
      process.chdir(origCwd);
    }
  });

  test('untracked 变更文件命中本体对象 → 折叠为 prompt 段落', async () => {
    const { buildSinceContext } = await import(DIFF);
    const repo = makeTempGitRepo();
    const compDir = path.join(repo, 'src', 'components');
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(path.join(compDir, 'NewWidget.tsx'), 'export const NewWidget = () => null;\n');

    const dataMap = {
      Component: [{ id: 'comp:NewWidget', name: 'NewWidget', filePath: 'src/components/NewWidget.tsx' }],
      Store: [{ id: 'store:useOtherStore', name: 'useOtherStore', filePath: 'src/stores/other.ts' }],
    };
    const origCwd = process.cwd();
    process.chdir(repo);
    try {
      const r = buildSinceContext(dataMap, { since: 'HEAD' });
      assert.notEqual(r.section, null);
      assert.deepEqual(r.files, ['src/components/NewWidget.tsx']);
      assert.match(r.section, /增量变更上下文（since=HEAD）/);
      assert.match(r.section, /src\/components\/NewWidget\.tsx/);
      assert.match(r.section, /\*\*Component\*\* `comp:NewWidget`/);
      assert.doesNotMatch(r.section, /useOtherStore/); // 未变更文件的对象不入段
    } finally {
      process.chdir(origCwd);
    }
  });

  test('不在 git 仓库内 → 抛错并提示', async () => {
    const { buildSinceContext } = await import(DIFF);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-nogit-'));
    const origCwd = process.cwd();
    process.chdir(plain);
    try {
      assert.throws(() => buildSinceContext({}, { since: 'HEAD' }), /git 仓库内运行/);
    } finally {
      process.chdir(origCwd);
    }
  });
});
