import { Hono } from 'hono';
import { zhihuHotList, zhihuSearch, ZhihuApiError } from '../lib/zhihuClient.js';

export const zhihuRoutes = new Hono();

zhihuRoutes.post('/search', async (c) => {
  try {
    const body = await c.req.json();
    const query = String(body?.query || '').trim();
    if (!query) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '检索词 query 不能为空' } }, 400);
    }
    const scope = body?.scope === 'global' ? 'global' : 'zhihu';
    const count = Math.min(10, Math.max(1, Number(body?.count || 6)));
    const data = await zhihuSearch(query, scope, count);
    return c.json(data);
  } catch (err) {
    if (err instanceof ZhihuApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    }
    return c.json({ error: { code: 'ZH_UPSTREAM_ERROR', message: '知乎检索服务异常' } }, 502);
  }
});

zhihuRoutes.get('/hot', async (c) => {
  try {
    const items = await zhihuHotList(10);
    return c.json({ items });
  } catch (err) {
    if (err instanceof ZhihuApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    }
    return c.json({ error: { code: 'ZH_UPSTREAM_ERROR', message: '知乎热榜获取失败' } }, 502);
  }
});
