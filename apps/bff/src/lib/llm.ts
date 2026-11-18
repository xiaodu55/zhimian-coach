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

/**
 * 用量统计（进程内环形缓冲，重启清零）。
 * 目的：公网演示时能一眼看到"今天烧了多少额度"，也便于发现某个接口在疯狂重试。
 */
interface CallRecord {
  at: number;
  ok: boolean;
  ms: number;
  endpoint: string;
  retry: boolean;
}

const MAX_RECORDS = 500;
const records: CallRecord[] = [];

export function usageSummary() {
  const now = Date.now();
  const window = records.filter((r) => now - r.at < 24 * 3600 * 1000);
  const llm = window.filter((r) => r.endpoint.startsWith('llm:'));
  const latencies = llm.map((r) => r.ms).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    llm: {
      calls: llm.length,
      failures: llm.filter((r) => !r.ok).length,
      retries: llm.filter((r) => r.retry).length,
      avgLatencyMs: avg,
      p95LatencyMs: p95,
    },
    total: window.length,
  };
}

/**
 * 并发闸门：同一时刻最多 N 个模型请求在飞，超出的排队等待。
 * 不加闸门的话，一次批量出题（8 道）会同时打上游，很容易被限流或拖到超时。
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.LLM_MAX_CONCURRENCY || 3));
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  waiting.push(resolve);
  await promise;
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiting.shift();
  if (next) next();
}

/** 是否值得重试：超时 / 5xx / 429 值得；4xx 业务错误不值得 */
function isRetryable(err: unknown): boolean {
  if (err instanceof LlmServiceError) {
    if (err.code === 'LLM_TIMEOUT') return true;
    if (/上游响应异常 \((5\d\d|429)\)/.test(err.message)) return true;
    // 模型这次没按 JSON 吐：重试一次通常就正常了（长提示下偶发混进推理文本）
    if (/未返回可解析的 JSON/.test(err.message)) return true;
    return false;
  }
  return true;
}

/** 从上游响应里取出模型输出文本（结构未知，逐层收窄而不是断言） */
function extractContent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const root = data as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

/**
 * 调用模型并解析结构化 JSON。
 * @param systemPrompt 系统提示
 * @param userPrompt   用户提示
 * @param timeoutMs    单次超时
 * @param endpoint     统计用的接口名（形如 llm:coach/parse）
 * @param signal       外部取消信号（客户端断开时中断上游，别继续烧额度）
 */
export async function callStructuredLlm<T>(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 25_000,
  endpoint = 'llm:unknown',
  signal?: AbortSignal
): Promise<T> {
  if (!hasLlmKey()) {
    throw new LlmServiceError('LLM_UNAVAILABLE', 503, '模型服务未配置，已切换规则模式');
  }

  await acquire();
  const startedAt = Date.now();
  let retried = false;
  try {
    let lastErr: unknown = null;
    // 最多尝试 2 次（1 次退避重试）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callOnce<T>(systemPrompt, userPrompt, timeoutMs, signal);
        records.push({ at: Date.now(), ok: true, ms: Date.now() - startedAt, endpoint, retry: retried });
        if (records.length > MAX_RECORDS) records.shift();
        return result;
      } catch (err: unknown) {
        lastErr = err;
        if (attempt === 0 && isRetryable(err) && !signal?.aborted) {
          retried = true;
          // 指数退避：先歇 800ms 再试一次
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 800);
          await promise;
          continue;
        }
        break;
      }
    }
    records.push({ at: Date.now(), ok: false, ms: Date.now() - startedAt, endpoint, retry: retried });
    if (records.length > MAX_RECORDS) records.shift();
    throw lastErr;
  } finally {
    release();
  }
}

async function callOnce<T>(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 外部取消（客户端断开）也要能中断
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

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

    const data: unknown = await res.json();
    const cleaned = extractContent(data).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // 模型没按 JSON 吐（常见于长提示下混进推理文本）：把开头带回来，方便定位
      throw new LlmServiceError(
        'LLM_UNAVAILABLE',
        503,
        `模型未返回可解析的 JSON（开头：${cleaned.slice(0, 80) || '空'}）`
      );
    }
  } catch (err: unknown) {
    if (err instanceof LlmServiceError) throw err;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      throw new LlmServiceError('LLM_TIMEOUT', 504, `模型响应超过 ${Math.round(timeoutMs / 1000)} 秒超时，已切换规则模式`);
    }
    throw new LlmServiceError('LLM_UNAVAILABLE', 503, '模型服务不可用，已切换规则模式');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
