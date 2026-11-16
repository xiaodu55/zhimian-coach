import { config, hasZhihuSecret } from '../config.js';
import { getCache, getStaleCache, setCache, sha1Key } from './cache.js';
import { consumeQuota, isCircuitOpen, recordUpstreamFailure, recordUpstreamSuccess } from './quota.js';

export class ZhihuApiError extends Error {
  constructor(
    public code: 'ZH_AUTH_FAILED' | 'ZH_QUOTA_EXHAUSTED' | 'ZH_UPSTREAM_ERROR',
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export interface ZhihuSearchItem {
  title: string;
  snippet: string;
  url: string;
  type: string;
}

function buildHeaders(): Record<string, string> {
  if (!hasZhihuSecret()) {
    throw new ZhihuApiError('ZH_AUTH_FAILED', 502, '知乎授权异常（服务端密钥未配置）');
  }
  return {
    Authorization: `Bearer ${config.zhihuAccessSecret}`,
    'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
    'Content-Type': 'application/json'
  };
}

/** 知乎开放平台返回的是 PascalCase（Data.Items / Title / ContentText / Url），
 *  旧实现只认 camelCase（data.items / title…）→ 静默返回 0 条（实测：所有查询都空）。
 *  这里统一做兼容提取，两种命名都能吃。 */
function extractItems(payload: any): any[] {
  const bodies = [payload?.Data, payload?.data, payload];
  for (const body of bodies) {
    for (const key of ['Items', 'items', 'List', 'list']) {
      if (Array.isArray(body?.[key])) return body[key];
    }
  }
  return [];
}

function pickString(item: any, keys: string[]): string {
  for (const k of keys) {
    const v = item?.[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function normalizeItem(item: any, scope: string): ZhihuSearchItem {
  return {
    title: pickString(item, ['Title', 'title', 'question_title']) || '知乎内容',
    snippet: pickString(item, ['ContentText', 'Summary', 'summary', 'snippet', 'excerpt', 'content']),
    url: pickString(item, ['Url', 'url', 'link']),
    type: pickString(item, ['ContentType', 'type']) || scope
  };
}

export async function zhihuSearch(
  query: string,
  scope: 'zhihu' | 'global' = 'zhihu',
  count = 6,
  bypassOnlineQuota = false
): Promise<{ results: ZhihuSearchItem[]; fromCache: boolean }> {
  const prefix = scope === 'global' ? 'gs' : 'zs';
  const cacheKey = sha1Key(prefix, `${query}::${count}`);
  const cached = getCache<ZhihuSearchItem[]>(cacheKey);
  if (cached) {
    return { results: cached, fromCache: true };
  }

  // 未配置密钥时立即拒绝，避免白耗每日线上配额
  if (!hasZhihuSecret()) {
    throw new ZhihuApiError('ZH_AUTH_FAILED', 502, '知乎授权异常（服务端密钥未配置）');
  }

  if (isCircuitOpen()) {
    const stale = getStaleCache<ZhihuSearchItem[]>(cacheKey);
    if (stale) return { results: stale, fromCache: true };
    throw new ZhihuApiError('ZH_UPSTREAM_ERROR', 502, '知乎接口触发 60 秒熔断保护，已切换本地兜底');
  }

  if (!bypassOnlineQuota && !consumeQuota('zhihu_search_online', 30)) {
    const stale = getStaleCache<ZhihuSearchItem[]>(cacheKey);
    if (stale) return { results: stale, fromCache: true };
    throw new ZhihuApiError('ZH_QUOTA_EXHAUSTED', 429, '今日知乎搜索线上预算已用完，已切换本地题库');
  }

  const endpoint =
    scope === 'global'
      ? 'https://developer.zhihu.com/api/v1/content/global_search'
      : 'https://developer.zhihu.com/api/v1/content/zhihu_search';

  const url = `${endpoint}?Query=${encodeURIComponent(query)}&Count=${count}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      signal: AbortSignal.timeout(12_000)
    });

    if (res.status === 401 || res.status === 403) {
      throw new ZhihuApiError('ZH_AUTH_FAILED', 502, '知乎授权异常（Access Secret 失效）');
    }
    if (!res.ok) {
      recordUpstreamFailure();
      throw new ZhihuApiError('ZH_UPSTREAM_ERROR', 502, `知乎接口返回异常状态 ${res.status}`);
    }

    const payload: any = await res.json();
    const rawItems: any[] = extractItems(payload);
    const normalized: ZhihuSearchItem[] = rawItems
      .map((item) => normalizeItem(item, scope))
      .filter((item) => item.url.length > 0);

    recordUpstreamSuccess();
    setCache(cacheKey, normalized, config.cacheTtlMs);
    return { results: normalized, fromCache: false };
  } catch (err) {
    if (err instanceof ZhihuApiError) throw err;
    recordUpstreamFailure();
    const stale = getStaleCache<ZhihuSearchItem[]>(cacheKey);
    if (stale) return { results: stale, fromCache: true };
    throw new ZhihuApiError('ZH_UPSTREAM_ERROR', 502, '知乎接口暂时不可用，已使用本地题库兜底');
  }
}

export async function zhihuHotList(limit = 10): Promise<ZhihuSearchItem[]> {
  const cacheKey = sha1Key('hot', String(limit));
  const cached = getCache<ZhihuSearchItem[]>(cacheKey);
  if (cached) return cached;

  const url = `https://developer.zhihu.com/api/v1/content/hot_list?Limit=${limit}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) {
    throw new ZhihuApiError('ZH_UPSTREAM_ERROR', 502, '知乎热榜接口暂时不可用');
  }
  const payload: any = await res.json();
  const items: ZhihuSearchItem[] = extractItems(payload)
    .map((it) => normalizeItem(it, 'hot'))
    .filter((it) => it.url.length > 0);
  setCache(cacheKey, items, 3600 * 1000);
  return items;
}

export async function zhihuQuestionAnswers(questionUrl: string): Promise<any[]> {
  const cacheKey = sha1Key('qa', questionUrl);
  const cached = getCache<any[]>(cacheKey);
  if (cached) return cached;

  const url = `https://developer.zhihu.com/api/v1/content/question_answers?QuestionUrl=${encodeURIComponent(questionUrl)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
    signal: AbortSignal.timeout(12_000)
  });
  if (!res.ok) {
    throw new ZhihuApiError('ZH_UPSTREAM_ERROR', 502, '知乎回答摘要接口暂时不可用');
  }
  const payload: any = await res.json();
  const answers = payload?.data || payload?.answers || [];
  setCache(cacheKey, answers, config.cacheTtlMs);
  return answers;
}
