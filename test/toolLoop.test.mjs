// x-1 ask --tool-call 工具循环单测：
//   - 协议解析（fenced 块提取 / 最后块优先 / 非法形态分类）
//   - ReAct 循环（fake chatFn 序列）：取证回填、收敛终止、上限强制收尾、异常兜底
//   - createCliTools 子进程冒烟（自仓库真实 CLI）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP = path.join(ROOT, 'src/cli/commands/toolLoop.js');

const TOOL_BLOCK_Q = '```aos-tool\n{"tool":"query","args":{"type":"Component","where":"name~steam"}}\n```';
const TOOL_BLOCK_L = '```aos-tool\n{"tool":"link","args":{"linkType":"importedBy","src":"file:src/services/ai.ts"}}\n```';
const FINAL = '根据取证，答案是 42。';

describe('extractToolCall 协议解析', () => {
  test('无块 → 最终回答语义', async () => {
    const { extractToolCall } = await import(LOOP);
    const r = extractToolCall(`好的，直接回答：\n${FINAL}`);
    assert.equal(r.call, null);
    assert.equal(r.rawBlock, null);
    assert.equal(r.parseError, null);
  });

  test('单个合法块：args 缺省补 {}；多个块取最后一个', async () => {
    const { extractToolCall } = await import(LOOP);
    const r1 = extractToolCall(` thinking...\n${TOOL_BLOCK_Q}`);
    assert.equal(r1.call.tool, 'query');
    assert.deepEqual(r1.call.args, { type: 'Component', where: 'name~steam' });
    assert.equal(r1.parseError, null);

    const r2 = extractToolCall(`${TOOL_BLOCK_Q}\n再想想\n${TOOL_BLOCK_L}`);
    assert.equal(r2.call.tool, 'link');
    assert.deepEqual(r2.call.args, { linkType: 'importedBy', src: 'file:src/services/ai.ts' });
  });

  test('非法 JSON / 未注册 tool → parseError 分类', async () => {
    const { extractToolCall } = await import(LOOP);
    const badJson = extractToolCall('```aos-tool\n{nope\n```');
    assert.equal(badJson.call, null);
    assert.match(badJson.parseError, /JSON 解析失败/);

    const badTool = extractToolCall('```aos-tool\n{"tool":"rm -rf"}\n```');
    assert.match(badTool.parseError, /tool 仅允许 query \| link \| output/);

    const badArgs = extractToolCall('```aos-tool\n{"tool":"query","args":[1]}\n```');
    assert.match(badArgs.parseError, /args 须为对象/);
  });
});

describe('runToolLoop ReAct 循环', () => {
  function makeFakeChat(script) {
    const prompts = [];
    let i = 0;
    return {
      chatFn: async (fullPrompt) => {
        prompts.push(fullPrompt);
        const step = script[Math.min(i, script.length - 1)];
        i += 1;
        return typeof step === 'function' ? step(fullPrompt) : step;
      },
      prompts,
      callsMade: () => i,
    };
  }

  test('两步取证后收敛：工具结果回填进下一轮 prompt；最终回答无协议噪声', async () => {
    const { runToolLoop } = await import(LOOP);
    const fake = makeFakeChat([
      `需要查一下。\n${TOOL_BLOCK_Q}`,
      (p) => {
        // 第二轮 prompt 应含第一轮的 assistant 输出与 query 结果回填
        assert.match(p, /<assistant_output>/);
        assert.match(p, /<tool_result step=1>/);
        assert.match(p, /"ok": ?true/);
        return `还要看引用。\n${TOOL_BLOCK_L}`;
      },
      FINAL,
    ]);
    const r = await runToolLoop({
      initialPrompt: 'BASE_PROMPT',
      chatFn: fake.chatFn,
      tools: async (call) => ({ ok: true, output: `mock-result:${call.tool}` }),
      onEvent: undefined,
    });
    assert.equal(r.answer, FINAL);
    assert.equal(r.steps, 2);
    assert.deepEqual(r.toolCalls.map((c) => c.tool), ['query', 'link']);
    assert.ok(fake.prompts[0].includes('自治工具循环'), '初始 prompt 应带工具说明');
  });

  test('工具抛异常不崩循环：error 回填后模型直接收敛', async () => {
    const { runToolLoop } = await import(LOOP);
    const fake = makeFakeChat([TOOL_BLOCK_Q, FINAL]);
    const r = await runToolLoop({
      initialPrompt: 'X',
      chatFn: fake.chatFn,
      tools: async () => { throw new Error('boom'); },
    });
    assert.equal(r.answer, FINAL);
    assert.match(fake.prompts[1], /工具执行异常: boom/);
  });

  test('达到 maxSteps 上限 → 强制收尾指令出现且最终回答剥离协议围栏', async () => {
    const { runToolLoop } = await import(LOOP);
    const fake = makeFakeChat([() => `继续取证\n${TOOL_BLOCK_L}`]);
    const r = await runToolLoop({
      initialPrompt: 'X',
      chatFn: fake.chatFn,
      tools: async () => ({ ok: true, output: 'x'.repeat(20) }),
      maxSteps: 2,
    });
    assert.ok(fake.prompts.some((p) => p.includes('已达步数上限')));
    assert.doesNotMatch(r.answer, /aos-tool/);
    assert.equal(r.steps, 2);
  });

  test('超大工具结果被截断到 ≤8KB+提示', async () => {
    const { runToolLoop } = await import(LOOP);
    const fake = makeFakeChat([TOOL_BLOCK_Q, FINAL]);
    await runToolLoop({
      initialPrompt: 'X',
      chatFn: fake.chatFn,
      tools: async () => ({ ok: true, output: 'y'.repeat(64 * 1024) }),
    });
    const secondPrompt = fake.prompts[1];
    const m = secondPrompt.match(/<tool_result step=1>\n([\s\S]*?)\n<\/tool_result>/);
    assert.ok(m && m[1].length <= 8 * 1024 + 100, `结果段应被截断（实际 ${m?.[1].length}）`);
    assert.match(m[1], /已截断/);
  });
});

describe('createCliTools 子进程冒烟（自仓库）', () => {
  test('执行真实 nice-aos query Project 并回包', async () => {
    const { createCliTools } = await import(LOOP);
    const runTool = createCliTools({ cwd: ROOT, cliEntry: path.join(ROOT, 'src/cli/index.js'), timeoutMs: 30_000 });
    const r = await runTool({ tool: 'query', args: { type: 'Project', limit: '5' } });
    assert.equal(r.ok, true, String(r.error ?? '').slice(0, 200));
    assert.match(r.output, /nice-aos|name/);
  }, 60_000);

  test('非法参数走子进程失败路径 → ok:false 带错误', async () => {
    const { createCliTools } = await import(LOOP);
    const runTool = createCliTools({ cwd: ROOT, cliEntry: path.join(ROOT, 'src/cli/index.js'), timeoutMs: 30_000 });
    const r = await runTool({ tool: 'link', args: { linkType: '__bogus__', src: 'nowhere' } });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /sub-command 失败/);
  }, 60_000);
});
