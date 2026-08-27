// ask eval —— 评测 harness（v0.35.0 P2）
//
// 用例文件为 JSONL（每行一个用例）：
//   {"id":"q1","question":"这个项目有哪些功能域？","mustInclude":["功能域"],"mustExclude":["我不知道"]}
//
// 评分规则（纯函数，可单测）：
//   - mustInclude：每个关键词都必须出现在回答中（忽略大小写）→ 任一缺失记 miss
//   - mustExclude：任一关键词出现即违规
//   - 通过 = 无缺失且无违规；关键词支持数组形式的"任选其一"（["A","B"] 表示 A 或 B 至少其一）
//
// 运行：
//   nice-aos ask eval --cases cases.jsonl                # 默认 --agent auto
//   nice-aos ask eval --cases c.jsonl --agent api        # 固定走模型服务，便于对比模型
//   nice-aos ask eval --cases c.jsonl --out report.json  # 结果落盘

import fs from 'node:fs';
import path from 'node:path';
import { fail, succeed } from '../shared.js';

/**
 * 纯函数评分：single case + answer → { passed, missing, violated }
 * 关键词形态：string（必须包含）或 string[]（任选其一）
 */
export function scoreAnswer(testCase, answer) {
  const text = String(answer ?? '');
  const lower = text.toLowerCase();
  const missing = [];
  const violated = [];
  for (const kw of testCase.mustInclude ?? []) {
    const list = Array.isArray(kw) ? kw : [kw];
    if (!list.some((k) => lower.includes(String(k).toLowerCase()))) missing.push(list);
  }
  for (const kw of testCase.mustExclude ?? []) {
    if (lower.includes(String(kw).toLowerCase())) violated.push(kw);
  }
  return { passed: missing.length === 0 && violated.length === 0, missing, violated };
}

/** 解析 JSONL 用例文件（空行/注释行跳过；损坏行报错带行号） */
export function loadCases(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const cases = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`用例文件第 ${i + 1} 行不是合法 JSON: ${err.message}`);
    }
    if (!obj.question || typeof obj.question !== 'string') {
      throw new Error(`用例文件第 ${i + 1} 行缺少 question 字段`);
    }
    if ((obj.mustInclude?.length ?? 0) === 0 && (obj.mustExclude?.length ?? 0) === 0) {
      throw new Error(`用例文件第 ${i + 1} 行 mustInclude / mustExclude 至少需要一个（否则无法判定）`);
    }
    obj.id = obj.id ?? `case-${cases.length + 1}`;
    cases.push(obj);
  }
  if (cases.length === 0) throw new Error('用例文件没有任何有效用例');
  return cases;
}

/**
 * 批量执行评测。
 * @param {{cases: object[], invoke: (testCase: object)=>Promise<{answer:string, meta?:object}>, onProgress?: (r:object)=>void}} opts
 *   invoke 由调用方提供（ask.js 注入真实 doAsk 包装；测试注入 fake），抛错视为该用例失败
 */
export async function runEval({ cases, invoke, onProgress }) {
  const results = [];
  for (const tc of cases) {
    const t0 = Date.now();
    try {
      const { answer, meta = {} } = await invoke(tc);
      const scored = scoreAnswer(tc, answer);
      results.push({
        id: tc.id,
        question: tc.question,
        ...scored,
        agent: meta.agent ?? null,
        durationMs: Date.now() - t0,
        answerExcerpt: answer.slice(0, 200),
      });
    } catch (err) {
      results.push({
        id: tc.id,
        question: tc.question,
        passed: false,
        error: err.message,
        durationMs: Date.now() - t0,
      });
    }
    if (onProgress) onProgress(results[results.length - 1]);
  }
  const passedCount = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    passRate: results.length ? Number((passedCount / results.length).toFixed(4)) : 0,
    results,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * commander 子命令工厂（由 ask.js 挂载：nice-aos ask eval ...）
 * @param {(question: string) => Promise<{answer: string, meta?: object}>} doAskFn 上层注入的问答执行器
 */
export function registerEvalCommand(askCommand, doAskFn) {
  askCommand.command('eval')
    .description('评测 harness：跑 JSONL 用例集（question + mustInclude/mustExclude 关键词断言），输出通过率与逐例报告。问答回答方沿用 --agent/--timeout 等选项')
    .requiredOption('--cases <path>', 'JSONL 用例文件路径')
    .option('--out <path>', '评测报告 JSON 输出路径（缺省打印 stdout）')
    .option('--json', 'stdout 输出 JSON 报告（默认即 JSON；保留开关对称性）', true)
    .action(async (opts) => {
      if (!fs.existsSync(opts.cases)) fail(`用例文件不存在: ${opts.cases}`);
      let cases;
      try {
        cases = loadCases(path.resolve(opts.cases));
      } catch (err) {
        fail(err.message);
      }

      // eval 场景静默：吞掉 doAsk 的 stderr 过程信息不可行（子进程共享 stderr），
      // 但结果只以最终 report 为准
      const report = await runEval({
        cases,
        invoke: (tc) => doAskFn(tc.question),
        onProgress: (r) => process.stderr.write(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id}${r.error ? ` — ${r.error}` : ''}\n`),
      });

      const outPayload = JSON.stringify(report, null, 2);
      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(opts.out, outPayload, 'utf-8');
        succeed({ ok: true, reportPath: opts.out, total: report.total, passed: report.passed, failed: report.failed, passRate: report.passRate });
      } else {
        console.log(outPayload);
        if (report.failed > 0) process.exitCode = 1; // CI 友好：存在失败即非零退出
      }
    });
}
