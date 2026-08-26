// OpenAI 兼容模型服务客户端（ask 命令的 API 直连 / 降级备选）
// 借鉴 nicekit OpenAICompatTransport 的请求模式（纯 fetch + Bearer，无 SDK 依赖），
// 实现 ask 需要的非流式单轮 chat completion + 流式 SSE token 透传：
//   POST {baseUrl}  {model, messages, stream:true|false}  Authorization: Bearer <key>
//   非流式 → choices[0].message.content
//   流式   → 逐 chunk 解析 data: {...} 行，回调 onToken(delta.content)，遇 data: [DONE] 结束
// 兼容 DeepSeek / Qwen / Kimi / OpenRouter 等一切 OpenAI 风格端点。

const DEFAULT_TIMEOUT_MS = 120000;

// 调用 OpenAI 兼容 chat completion（非流式），返回完整回答文本
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

// 流式调用：边收边回调 onToken(delta)
// 返回完整拼接的文本（与 invokeApiChat 返回结构一致，便于调用方统一处理）
//
// 协议：OpenAI 兼容的 SSE chunk 格式
//   data: {"choices":[{"delta":{"content":"你"},...}]}\n\n
//   data: {"choices":[{"delta":{"content":"好"},...}]}\n\n
//   data: [DONE]\n\n
//
// onToken(token: string) 每次收到非空 delta.content 时被调用一次
// 返回最终拼接的完整文本
export async function invokeApiChatStream({ baseUrl, apiKey, model, prompt, timeout = DEFAULT_TIMEOUT_MS, maxTokens, temperature, onToken, fetchFn } = {}) {
  if (!baseUrl) throw new Error('缺少 baseUrl（ask config set --base-url）');
  if (!apiKey) throw new Error('缺少 apiKey（ask config set --api-key 或 NICE_AOS_API_KEY）');
  if (!model) throw new Error('缺少 model（ask config set --model）');
  if (typeof onToken !== 'function') throw new Error('流式调用必须提供 onToken 回调');

  const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  let response;
  try {
    response = await doFetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // 显式声明 SSE；部分网关会因 Accept 缺失返回 chunked 非 SSE
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
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

  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('模型服务不支持流式响应（无 ReadableStream）');
  }

  // 逐行解析 SSE：按 \n 切分；缓冲跨 chunk 的半行
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let tokenCount = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按 \n 切分；保留最后一个可能不完整的行
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          if (tokenCount === 0) {
            // 0 token 仍以抛错形式退出（与自然终止统一）
            throw new Error('模型服务流式响应无有效 token（可能服务不支持 stream:true）');
          }
          return fullText; // 正常结束
        }
        if (!payload) continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // 非 JSON 跳过（部分网关会插心跳行）
          continue;
        }
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          fullText += delta;
          tokenCount += 1;
          onToken(delta);
        }
        // finish_reason='stop' 时服务端可能不发 [DONE]，也直接结束
        if (chunk?.choices?.[0]?.finish_reason === 'stop' && !chunk.choices[0].delta.content) {
          if (tokenCount === 0) {
            throw new Error('模型服务流式响应无有效 token（可能服务不支持 stream:true）');
          }
          return fullText;
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')) {
      throw new Error(`模型服务流式超时（${timeout}ms）: ${model}`);
    }
    throw new Error(`模型服务流式读取失败: ${err.message}`);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (tokenCount === 0) {
    throw new Error('模型服务流式响应无有效 token（可能服务不支持 stream:true）');
  }
  return fullText;
}

