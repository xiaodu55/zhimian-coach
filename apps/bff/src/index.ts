import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import { config, hasLlmKey, hasZhihuSecret } from './config.js';
import { getQuestionById, loadBankFromDisk, queryBank } from './lib/knowledge/questionBank.js';
import { zhihuRoutes } from './routes/zhihu.js';
import { coachRoutes } from './routes/coach.js';
import { explainRoutes } from './routes/explain.js';
import { authRoutes } from './routes/auth.js';
import { asrRoutes } from './routes/asr.js';
import { resumeRoutes } from './routes/resume.js';
import { reviewRoutes } from './routes/review.js';

const app = new Hono();

// 健康检查
app.get('/api/health', (c) => {
  const bank = loadBankFromDisk();
  return c.json({
    ok: true,
    zhihuConfigured: hasZhihuSecret(),
    llmConfigured: hasLlmKey(),
    bankSize: bank.length,
    // 前端据此识别"跑的是旧实例"（例如旧实例没有简历出题接口）
    capabilities: {
      resume: true,
      resumeAudio: true,
      localAsr: true,
      pdfSmart: true
    }
  });
});

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
app.route('/api/auth', authRoutes);
app.route('/api/asr', asrRoutes);
app.route('/api', resumeRoutes);
app.route('/api/review', reviewRoutes);

// 同域托管 apps/web 静态站点（彻底规避 CORS）
const relativeWebRoot = path.relative(process.cwd(), config.webRoot);
app.use('/*', serveStatic({ root: relativeWebRoot }));

console.log(`[知面陪练 BFF] 启动中 -> http://localhost:${config.port}`);
console.log(`[知面陪练 BFF] 知乎密钥: ${hasZhihuSecret() ? '已配置' : '未配置(本地兜底)'} | 模型服务: ${hasLlmKey() ? '已配置' : '未配置(规则模式)'}`);

serve({
  fetch: app.fetch,
  port: config.port
});
