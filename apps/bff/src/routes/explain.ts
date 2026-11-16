import { Hono } from 'hono';
import { parseDocumentContent, parsePdfBuffer, DocSegment } from '../lib/docParser.js';
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

  try {
    if (lowerName.endsWith('.pdf')) {
      const parsed = await parsePdfBuffer(file.name, Buffer.from(await file.arrayBuffer()));
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

// 答辩预测：8 条高危追问 + 3 个薄弱点 + 真实知乎质疑（契约：{title, segments} → {predictedQuestions, topRisks, degraded}）
explainRoutes.post('/defense/analyze', async (c) => {
  const body = await c.req.json();
  const title = String(body?.title || '技术方案').trim();
  const segments: DocSegment[] = Array.isArray(body?.segments) ? body.segments : [];

  if (!segments.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '请先上传并解析文档（缺少 segments）' } }, 400);
  }

  const topic = (segments[0]?.heading || title.replace(/\.[^.]+$/, '')).slice(0, 30);
  let critiques: Array<{ title: string; url: string; snippet: string }> = [];
  let degraded = false;
  try {
    const { results } = await zhihuSearch(`${topic} 质疑 缺点 局限`, 'zhihu', 5);
    critiques = results;
    degraded = results.length === 0;
  } catch {
    degraded = true;
  }

  const topRisks = segments.slice(0, 3).map((seg, i) => ({
    riskId: `risk-${i + 1}`,
    locator: seg.locator,
    title: `薄弱点 #${i + 1}：${seg.heading}`,
    reason: `材料在 ${seg.locator} 提出了关键论断，但缺少对照基线、消融实验或极端边界数据。`,
  }));

  const predictedQuestions = segments.slice(0, 8).map((seg, idx) => {
    const ref = critiques[idx % Math.max(1, critiques.length)];
    return {
      q: `针对 ${seg.locator}「${seg.heading}」，如果去掉这个机制、或遇到长尾异常输入，你的指标会掉多少？依据是什么？`,
      why: '该段是核心技术主张，评委通常用"消融实验 + 边界压力"验证它是不是真的必要。',
      zhihuRef: ref ? { title: ref.title, url: ref.url, snippet: ref.snippet } : null,
    };
  });

  return c.json({ degraded, topRisks, predictedQuestions });
});
