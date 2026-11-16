import { config, hasLlmKey } from '../config.js';

export class LlmServiceError extends Error {
  constructor(
    public code: 'LLM_TIMEOUT' | 'LLM_UNAVAILABLE',
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function callStructuredLlm<T>(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 25_000
): Promise<T> {
  if (!hasLlmKey()) {
    throw new LlmServiceError('LLM_UNAVAILABLE', 503, '模型服务未配置，已切换规则模式');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.llmApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      throw new LlmServiceError('LLM_UNAVAILABLE', 503, `模型上游响应异常 (${res.status})`);
    }

    const data: any = await res.json();
    const rawContent: string = data?.choices?.[0]?.message?.content || '';
    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned) as T;
  } catch (err: any) {
    if (err instanceof LlmServiceError) throw err;
    if (err?.name === 'AbortError') {
      throw new LlmServiceError('LLM_TIMEOUT', 504, '模型响应超过 25 秒超时，已切换规则模式');
    }
    throw new LlmServiceError('LLM_UNAVAILABLE', 503, '模型服务不可用，已切换规则模式');
  } finally {
    clearTimeout(timer);
  }
}
