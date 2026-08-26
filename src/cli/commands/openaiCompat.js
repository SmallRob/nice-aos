// OpenAI 兼容模型服务客户端（ask 命令的 API 直连 / 降级备选）
// 借鉴 nicekit OpenAICompatTransport 的请求模式（纯 fetch + Bearer，无 SDK 依赖），
// 仅实现 ask 需要的非流式单轮 chat completion：
//   POST {baseUrl}  {model, messages, stream:false}  Authorization: Bearer <key>
//   → choices[0].message.content
// 兼容 DeepSeek / Qwen / Kimi / OpenRouter 等一切 OpenAI 风格端点。

const DEFAULT_TIMEOUT_MS = 120000;

// 调用 OpenAI 兼容 chat completion，返回完整回答文本
// baseUrl 应指向最终端点（含 /chat/completions）
export async function invokeApiChat({ baseUrl, apiKey, model, prompt, timeout = DEFAULT_TIMEOUT_MS, maxTokens, temperature, fetchFn } = {}) {
  if (!baseUrl) throw new Error('缺少 baseUrl（ask config set --base-url）');
  if (!apiKey) throw new Error('缺少 apiKey（ask config set --api-key 或 NICE_AOS_API_KEY）');
  if (!model) throw new Error('缺少 model（ask config set --model）');

  const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  let response;
  try {
    response = await doFetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(maxTokens !== undefined && { max_tokens: maxTokens }),
        ...(temperature !== undefined && { temperature }),
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')) {
      throw new Error(`模型服务调用超时（${timeout}ms）: ${model}`);
    }
    throw new Error(`模型服务请求失败: ${err.message}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.text();
      detail = body.slice(0, 300);
    } catch { /* ignore */ }
    throw new Error(`模型服务返回 ${response.status}: ${detail || response.statusText}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('模型服务响应不是合法 JSON（检查 baseUrl 是否指向 /chat/completions 端点）');
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error(`模型服务响应缺少 choices[0].message.content: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text;
}
