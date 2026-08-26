// ask-1 流式输出测试：openaiCompat.invokeApiChatStream
// 覆盖：SSE 多 chunk 解析 / onToken 顺序 / [DONE] 终止 / finish_reason=stop 终止 / 错误路径
import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeApiChatStream, invokeApiChat } from '../src/cli/commands/openaiCompat.js';

// 构造一个 ReadableStream（sseChunks 是 data: ... 行数组）
function sseStream(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

// 构造一个带 status + body 的 Response
function mockResponse({ status = 200, body, contentType = 'text/event-stream' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? contentType : null },
  };
}

const BASE = 'https://api.test/chat/completions';
const KEY = 'sk-test';
const MODEL = 'test-model';
const PROMPT = 'hi';

test('invokeApiChatStream：SSE 多 chunk 解析 + onToken 顺序 + 完整文本拼接', async () => {
  // 模拟 3 个 token："你"、"好"、" world"
  const sseBody = sseStream([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const tokens = [];
  const text = await invokeApiChatStream({
    baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
    onToken: (t) => tokens.push(t),
    fetchFn: async () => mockResponse({ body: sseBody }),
  });
  assert.equal(text, '你好 world', '完整文本应按 token 顺序拼接');
  assert.deepEqual(tokens, ['你', '好', ' world'], 'onToken 应按收到顺序被调用');
});

test('invokeApiChatStream：单个 chunk 内含多 data: 行 + 跨 chunk 半行缓冲', async () => {
  // 跨 chunk 半行：把第 1 行的"你"和换行在第 2 个 chunk 里 → 测试 buffer 拼接
  const sseBody = sseStream([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',        // 缺末尾 \n
    '\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
  ]);
  const tokens = [];
  const text = await invokeApiChatStream({
    baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
    onToken: (t) => tokens.push(t),
    fetchFn: async () => mockResponse({ body: sseBody }),
  });
  assert.equal(text, '你好');
  assert.deepEqual(tokens, ['你', '好']);
});

test('invokeApiChatStream：finish_reason=stop 也终止（不发 [DONE]）', async () => {
  const sseBody = sseStream([
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);
  const tokens = [];
  const text = await invokeApiChatStream({
    baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
    onToken: (t) => tokens.push(t),
    fetchFn: async () => mockResponse({ body: sseBody }),
  });
  assert.equal(text, 'done');
  assert.deepEqual(tokens, ['done']);
});

test('invokeApiChatStream：心跳行（空 data: 开头）跳过', async () => {
  const sseBody = sseStream([
    'data: \n\n',  // 空 payload，跳过
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const tokens = [];
  const text = await invokeApiChatStream({
    baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
    onToken: (t) => tokens.push(t),
    fetchFn: async () => mockResponse({ body: sseBody }),
  });
  assert.equal(text, 'x');
  assert.deepEqual(tokens, ['x']);
});

test('invokeApiChatStream：0 token 报错（服务端可能不支持 stream）', async () => {
  const sseBody = sseStream([
    'data: {"choices":[{"delta":{}}]}\n\n',  // 0 content
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(
    () => invokeApiChatStream({
      baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
      onToken: () => {},
      fetchFn: async () => mockResponse({ body: sseBody }),
    }),
    /无有效 token/,
    '应明确报错提示服务端可能不支持 stream:true'
  );
});

test('invokeApiChatStream：非 2xx 状态码报错（含 body 片段）', async () => {
  await assert.rejects(
    () => invokeApiChatStream({
      baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
      onToken: () => {},
      fetchFn: async () => mockResponse({ status: 401, body: null }),
    }),
    /模型服务返回 401/,
  );
});

test('invokeApiChatStream：缺 onToken 报错', async () => {
  await assert.rejects(
    () => invokeApiChatStream({
      baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
      fetchFn: async () => mockResponse({ body: sseStream([]) }),
    }),
    /必须提供 onToken/,
  );
});

test('invokeApiChatStream：缺 baseUrl/apiKey/model 报错', async () => {
  await assert.rejects(() => invokeApiChatStream({ apiKey: KEY, model: MODEL, prompt: PROMPT, onToken: () => {} }), /缺少 baseUrl/);
  await assert.rejects(() => invokeApiChatStream({ baseUrl: BASE, model: MODEL, prompt: PROMPT, onToken: () => {} }), /缺少 apiKey/);
  await assert.rejects(() => invokeApiChatStream({ baseUrl: BASE, apiKey: KEY, prompt: PROMPT, onToken: () => {} }), /缺少 model/);
});

test('invokeApiChatStream：non-streaming response.body 时报错（不支持流式）', async () => {
  // 模拟一个 ok 200 但 body 不带 getReader 的 Response
  const resp = { ok: true, status: 200, body: null };
  await assert.rejects(
    () => invokeApiChatStream({
      baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
      onToken: () => {},
      fetchFn: async () => resp,
    }),
    /不支持流式响应/,
  );
});

test('invokeApiChatStream：网络超时（fetch 抛 AbortError）报超时错误', async () => {
  await assert.rejects(
    () => invokeApiChatStream({
      baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT, timeout: 100,
      onToken: () => {},
      fetchFn: async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; },
    }),
    /超时/,
  );
});

test('invokeApiChat（非流式）保持原行为不变（不破坏 0.32.0 既有契约）', async () => {
  // 走非流式路径，验证 Response.ok 200 + JSON 解析 + 返回 message.content
  const resp = {
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => '{"choices":[{"message":{"content":"hello"}}]}',
    json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
  };
  const text = await invokeApiChat({
    baseUrl: BASE, apiKey: KEY, model: MODEL, prompt: PROMPT,
    fetchFn: async () => resp,
  });
  assert.equal(text, 'hello');
});
