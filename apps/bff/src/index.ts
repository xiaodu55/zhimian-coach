import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import { config, hasLlmKey, hasZhihuSecret } from './config.js';
import { getQuestionById, loadBankFromDisk, queryBank } from './lib/knowledge/questionBank.js';
import { zhihuRoutes } from './routes/zhihu.js';
import { coachRoutes } from './routes/coach.js';
import { explainRoutes } from './routes/explain.js';
import { defenseRoutes } from './routes/defense.js';
import { authRoutes } from './routes/auth.js';
import { asrRoutes } from './routes/asr.js';
import { resumeRoutes } from './routes/resume.js';
import { reviewRoutes } from './routes/review.js';
import { resumeBulletRoutes } from './routes/resumeBullets.js';
import { usageSummary } from './lib/llm.js';

const app = new Hono();

/**
 * 分享口令（可选）：配置了 PUBLIC_SHARE_TOKEN 后，除健康检查外的 /api 都要带
 * `x-share-token` 头或 `?k=` 参数 —— 公网演示时避免陌生链接白烧额度。
 */
app.use('/api/*', async (c, next) => {
  const token = config.publicShareToken;
  if (!token) return next();
  if (c.req.path === '/api/health') return next();
  const header = c.req.header('x-share-token') || '';
  const query = c.req.query('k') || '';
  if (header === token || query === token) return next();
  return c.json({ error: { code: 'UNAUTHORIZED', message: '缺少或错误的分享口令（请用带 ?k= 的链接打开）' } }, 401);
});

// 健康检查
app.get('/api/health', (c) => {
  const bank = loadBankFromDisk();
  return c.json({
    ok: true,
    zhihuConfigured: hasZhihuSecret(),
    llmConfigured: hasLlmKey(),
    bankSize: bank.length,
    // 前端据此决定要不要弹口令输入框
    requiresToken: Boolean(config.publicShareToken),
    usage: usageSummary(),
    // 前端据此识别"跑的是旧实例"（例如旧实例没有简历出题接口）
    capabilities: {
      resume: true,
      resumeAudio: true,
      localAsr: true,
      pdfSmart: true
    }
  });
});

// 用量看板：今天烧了多少模型额度
app.get('/api/usage', (c) => c.json(usageSummary()));

// 题库查询
app.get('/api/bank', (c) => {
  const q = c.req.query('q') || '';
  const track = c.req.query('track') || '';
  const limit = Number(c.req.query('limit') || 50);
  if (Number.isNaN(limit) || limit < 1) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'limit 参数无效' } }, 400);
  }
  return c.json(queryBank(q, track, limit));
});

app.get('/api/bank/:id', (c) => {
  const item = getQuestionById(c.req.param('id'));
  if (!item) {
    return c.json({ error: { code: 'NOT_FOUND', message: '题目不存在' } }, 404);
  }
  return c.json(item);
});

// 业务路由挂载
app.route('/api/zhihu', zhihuRoutes);
app.route('/api/coach', coachRoutes);
app.route('/api', explainRoutes);
app.route('/api', defenseRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/asr', asrRoutes);
app.route('/api', resumeRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api', resumeBulletRoutes);

// 同域托管 apps/web 静态站点（彻底规避 CORS）
const relativeWebRoot = path.relative(process.cwd(), config.webRoot);
// 静态资源加缓存头：云函数上每个请求都要起一次函数实例，
// 不缓存的话评委每次打开都要重新拉 7 个模块请求，容易撞上网关并发限制。
app.use('/*', async (c, next) => {
  await next();
  const p = c.req.path;
  if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.json') || p.endsWith('.png') || p.endsWith('.svg') || p.endsWith('.webp')) {
    c.header('Cache-Control', 'public, max-age=600, must-revalidate');
  }
});
app.use('/*', serveStatic({ root: relativeWebRoot }));

console.log(`[知面陪练 BFF] 启动中 -> http://localhost:${config.port}`);
console.log(`[知面陪练 BFF] 知乎密钥: ${hasZhihuSecret() ? '已配置' : '未配置(本地兜底)'} | 模型服务: ${hasLlmKey() ? '已配置' : '未配置(规则模式)'}`);

serve({
  fetch: app.fetch,
  port: config.port
});
