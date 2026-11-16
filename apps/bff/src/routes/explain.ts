import { Hono } from 'hono';
import { parseDocumentContent, DocSegment } from '../lib/docParser.js';
import { callStructuredLlm } from '../lib/llm.js';
import { validateStructuredClaims, ClaimItem } from '../lib/citations.js';
import { EXPLAIN_ASK_SYSTEM_PROMPT } from '../lib/prompts.js';
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
  if (!lowerName.endsWith('.md') && !lowerName.endsWith('.txt') && !lowerName.endsWith('.markdown')) {
    return c.json(
      { error: { code: 'DOC_PARSE_FAILED', message: '当前接口支持 Markdown / TXT / 时间戳转写稿；扫描版 PDF 请先转为可复制文本' } },
      422
    );
  }

  const text = await file.text();
  if (!text.trim()) {
    return c.json({ error: { code: 'DOC_PARSE_FAILED', message: '文件内容为空或无有效文本层' } }, 422);
  }

  const parsed = parseDocumentContent(file.name, text);
  return c.json({
    docId: 'doc-' + Date.now(),
    ...parsed
  });
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

// 答辩高危追问关联知乎真实质疑
explainRoutes.post('/defense/analyze', async (c) => {
  const body = await c.req.json();
  const topic = String(body?.topic || 'AI Agent 工程落地 消融实验').trim();
  try {
    const { results } = await zhihuSearch(`${topic} 质疑 缺点 局限`, 'zhihu', 5);
    return c.json({ zhihuCritiques: results });
  } catch {
    return c.json({ zhihuCritiques: [], degraded: true });
  }
});
