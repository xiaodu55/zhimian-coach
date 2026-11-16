import { Hono } from 'hono';
import { config } from '../config.js';

export const asrRoutes = new Hono();

const HINT_LOCAL =
  '未配置云端 ASR。可用两条本地路线：① 页面「导出两条音轨」→ 运行 `node scripts/asr/local-transcribe.mjs mic.webm system.webm` ' +
  '（本机 faster-whisper，wasm/CPU 均可）→ 把生成的转写稿粘回复盘；② 导入飞书妙记/腾讯会议 AI 笔记导出的转写稿。';

const asrReady = config.asrProvider !== 'none' && Boolean(config.asrBaseUrl && config.asrApiKey);

asrRoutes.get('/status', (c) =>
  c.json({
    available: asrReady,
    provider: config.asrProvider,
    model: config.asrModel || null,
    hint: asrReady ? null : HINT_LOCAL,
  })
);

/**
 * 双轨转写：一次一个音轨（track=mic|system），前端分别调两次再按时间轴合并。
 * 只支持 OpenAI 兼容的 /audio/transcriptions（whisper-1 等）。
 * 未配置 → 501 + 可执行的替代路径，绝不假装能转。
 */
asrRoutes.post('/transcribe', async (c) => {
  if (!asrReady) {
    return c.json({ error: { code: 'NOT_IMPLEMENTED', message: '服务端 ASR 未配置', hint: HINT_LOCAL } }, 501);
  }
  const form = await c.req.formData();
  const file = form.get('file');
  const track = String(form.get('track') || 'mic');
  if (!file || !(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少音频文件' } }, 400);
  }
  if (file.size > 25 * 1024 * 1024) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '音频超过 25MB，请分段录音' } }, 413);
  }

  const upstream = new FormData();
  upstream.append('file', file, file.name || `${track}.webm`);
  upstream.append('model', config.asrModel || 'whisper-1');
  upstream.append('language', 'zh');
  upstream.append('response_format', 'verbose_json');

  try {
    const res = await fetch(`${config.asrBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.asrApiKey}` },
      body: upstream,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return c.json({ error: { code: 'ASR_UPSTREAM_ERROR', message: `ASR 服务返回 ${res.status}`, hint: HINT_LOCAL } }, 502);
    }
    const payload = JSON.parse(text) as { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
    const segments = (payload.segments || []).map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || '').trim(),
    }));
    return c.json({
      track,
      segments,
      text: payload.text || segments.map((s: { text: string }) => s.text).join(''),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json({ error: { code: 'ASR_UPSTREAM_ERROR', message: `ASR 请求失败：${reason}`, hint: HINT_LOCAL } }, 502);
  }
});
