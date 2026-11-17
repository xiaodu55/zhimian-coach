import { Hono } from 'hono';
import { parseDocumentContent, DocSegment } from '../lib/docParser.js';
import { parsePdfSmart } from '../lib/pdf/index.js';
import { callStructuredLlm } from '../lib/llm.js';
import { validateStructuredClaims, ClaimItem } from '../lib/citations.js';
import { EXPLAIN_ASK_SYSTEM_PROMPT, EXPLAIN_SUMMARY_PROMPT } from '../lib/prompts.js';
import { zhihuSearch } from '../lib/zhihuClient.js';

export const explainRoutes = new Hono();

// §8.1 / §12 无状态上传解析：直接返回带定位符的分段 JSON，前端存 IndexedDB，服务端零落盘
explainRoutes.post('/doc/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '请上传有效的文档文件' } }, 400);
  }
  if (file.size > 20 * 1024 * 1024) {
    return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '文件超过 20MB 上限' } }, 413);
  }

  const lowerName = file.name.toLowerCase();

  try {
    if (lowerName.endsWith('.pdf')) {
      const parsed = await parsePdfSmart(file.name, Buffer.from(await file.arrayBuffer()));
      return c.json({ docId: 'doc-' + Date.now(), ...parsed });
    }
    if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerName.endsWith('.txt')) {
      const text = await file.text();
      if (!text.trim()) {
        return c.json({ error: { code: 'DOC_PARSE_FAILED', message: '文件内容为空或无有效文本层' } }, 422);
      }
      return c.json({ docId: 'doc-' + Date.now(), ...parseDocumentContent(file.name, text) });
    }
    return c.json(
      { error: { code: 'DOC_PARSE_FAILED', message: '仅支持 PDF（需有文本层）、Markdown 与 TXT' } },
      422
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '文档解析失败';
    return c.json({ error: { code: 'DOC_PARSE_FAILED', message } }, 422);
  }
});

// 无状态就地追问：前端随请求传入 Top-K 召回片段 segments[]
explainRoutes.post('/explain/ask', async (c) => {
  const body = await c.req.json();
  const question = String(body?.question || '').trim();
  const segments: DocSegment[] = Array.isArray(body?.segments) ? body.segments : [];

  if (!question) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '追问问题不能为空' } }, 400);
  }
  if (!segments.length) {
    return c.json({
      noEvidence: true,
      answer: '未检索到直接依据，以下仅为基于已有材料的推断：当前未提供匹配的文档片段，请调整检索词。',
      refs: [],
      droppedByValidator: 0
    });
  }

  const validIds = new Set(segments.map((_, i) => `S${i + 1}`));
  const contextText = segments.map((s, i) => `[S${i + 1}] (${s.locator}): ${s.text}`).join('\n');

  try {
    const res = await callStructuredLlm<{ noEvidence?: boolean; claims?: ClaimItem[] }>(
      EXPLAIN_ASK_SYSTEM_PROMPT,
      `问题：${question}\n\n文档片段：\n${contextText}`
    );
    if (res.noEvidence) {
      return c.json({ noEvidence: true, answer: '未检索到直接依据', refs: [], droppedByValidator: 0 });
    }
    const checked = validateStructuredClaims(res.claims || [], validIds);
    return c.json({
      noEvidence: checked.accepted.length === 0,
      claims: checked.accepted,
      droppedByValidator: checked.droppedByValidator
    });
  } catch {
    // 模型不可用时，直接返回片段原文摘录（零幻觉降级）
    return c.json({
      noEvidence: false,
      degraded: true,
      claims: segments.slice(0, 2).map((s, i) => ({
        claim: s.text,
        basis: '原文直述',
        refIds: [`S${i + 1}`]
      })),
      droppedByValidator: 0
    });
  }
});

/** 讲解室：详解总结（一句话概括 + 关键论点 + 材料自身薄弱处，全部带片段引用） */
explainRoutes.post('/explain/summary', async (c) => {
  const body = await c.req.json();
  const title = String(body?.title || '资料').trim();
  const segments: DocSegment[] = Array.isArray(body?.segments) ? body.segments : [];
  if (!segments.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少 segments（先上传或粘贴资料）' } }, 400);
  }

  const validIds = new Set(segments.map((_, i) => `S${i + 1}`));
  const contextText = segments.map((s, i) => `[S${i + 1}] (${s.locator}): ${s.text}`).join('\n');

  try {
    const raw = await callStructuredLlm<{
      summary?: string;
      keyPoints?: Array<{ text?: string; refIds?: string[] }>;
      gaps?: Array<{ text?: string; refIds?: string[] }>;
    }>(EXPLAIN_SUMMARY_PROMPT, `【资料标题】${title}\n\n【资料分段】\n${contextText}`, 30_000);

    const clean = (items: Array<{ text?: string; refIds?: string[] }> = []) =>
      items
        .map((it) => ({
          text: String(it?.text || '').trim().slice(0, 300),
          refIds: (it?.refIds || []).filter((id) => validIds.has(String(id))),
        }))
        .filter((it) => it.text.length > 0);

    return c.json({
      summary: String(raw.summary || '').slice(0, 300),
      keyPoints: clean(raw.keyPoints),
      gaps: clean(raw.gaps),
    });
  } catch {
    // 降级：不调模型，直接给分段前两条摘录
    return c.json({
      degraded: true,
      summary: `（模型不可用）这份材料共 ${segments.length} 个片段，标题：${title}`,
      keyPoints: segments.slice(0, 2).map((s, i) => ({ text: s.text.slice(0, 300), refIds: [`S${i + 1}`] })),
      gaps: [],
    });
  }
});

/** 讲解室：视频链接解析（抓标题/简介/字幕轨，尽力而为，不做视频转码） */
explainRoutes.post('/explain/link', async (c) => {
  const body = await c.req.json();
  const raw = String(body?.url || '').trim();
  if (!raw) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '请填写视频链接' } }, 400);
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '链接格式不正确' } }, 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '只支持 http / https 链接' } }, 400);
  }
  // SSRF 兜底：拒绝指向本机 / 内网的地址
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '不支持抓取本机或内网地址' } }, 400);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zhimian-explainer/1.0)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const html = (await resp.text()).slice(0, 3_000_000);

    const meta = (prop: string) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
      const m = html.match(re);
      if (m) return m[1];
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
      const m2 = html.match(re2);
      return m2 ? m2[1] : '';
    };
    const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const title = (meta('og:title') || titleTag).replace(/\s+/g, ' ').trim().slice(0, 200);
    const description = (meta('og:description') || meta('description') || '').trim().slice(0, 1000);

    // 字幕轨：尽力抓第一个 track（VTT/SRT），抓不到就明说没抓到
    let transcript = '';
    const trackMatch = html.match(/<track[^>]+src=["']([^"']+)["']/i);
    if (trackMatch) {
      try {
        const trackUrl = new URL(trackMatch[1], url).toString();
        const tctrl = new AbortController();
        const ttimer = setTimeout(() => tctrl.abort(), 8000);
        const tres = await fetch(trackUrl, { signal: tctrl.signal });
        clearTimeout(ttimer);
        const raw2 = await tres.text();
        transcript = raw2
          .replace(/^WEBVTT.*$/m, '')
          .replace(/\d\d:\d\d:\d\d[.,]\d\d\d[^\n]*\n/g, '')
          .replace(/^\d+$/gm, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\n{2,}/g, '\n')
          .trim()
          .slice(0, 60000);
      } catch {
        transcript = '';
      }
    }

    return c.json({
      url: url.toString(),
      title,
      description,
      transcript,
      hasTranscript: Boolean(transcript),
      note: transcript
        ? '已抓到字幕轨，可直接做逐段详解。'
        : '未抓到字幕轨：详解将基于页面标题与简介，或粘贴字幕/转写稿后上传。',
    });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? '抓取超时' : '抓取失败';
    return c.json({ error: { code: 'UPSTREAM_ERROR', message: `${msg}：${url.hostname} 未返回可解析内容` } }, 502);
  }
});
