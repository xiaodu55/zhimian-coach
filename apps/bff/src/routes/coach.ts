import { Hono } from 'hono';
import { getQuestionById } from '../lib/knowledge/questionBank.js';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { validateStructuredClaims, ClaimItem } from '../lib/citations.js';
import { COACH_PARSE_SYSTEM_PROMPT } from '../lib/prompts.js';

export const coachRoutes = new Hono();

coachRoutes.post('/session', async (c) => {
  const body = await c.req.json();
  const q = getQuestionById(String(body?.questionId || ''));
  if (!q) {
    return c.json({ error: { code: 'NOT_FOUND', message: '未找到指定真题' } }, 404);
  }
  return c.json({
    sessionId: 'sess-' + Date.now(),
    firstQuestion: q.title,
    viewAngleCards: q.viewpointCards
  });
});

coachRoutes.post('/parse', async (c) => {
  const body = await c.req.json();
  const answer = String(body?.answer || '').trim();
  const questionId = String(body?.questionId || '');
  if (!answer) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '回答内容不能为空' } }, 400);
  }

  const question = getQuestionById(questionId);
  const cards = question?.viewpointCards || [];
  const validSourceIds = new Set(cards.map((_, idx) => `S${idx + 1}`));

  const sourceContext = cards
    .map((vc, idx) => `[S${idx + 1}] (${vc.stance} · ${vc.author}): ${vc.summary} 原文：“${vc.evidenceQuote}”`)
    .join('\n');

  try {
    const rawLlm = await callStructuredLlm<{
      llmScores?: ClaimItem[];
      improvements?: ClaimItem[];
      followups?: string[];
    }>(
      COACH_PARSE_SYSTEM_PROMPT,
      `题目：${question?.title || '技术面试题'}\n\n可用知乎来源集合：\n${sourceContext || '无外部来源'}\n\n候选人回答：\n${answer}`
    );

    const scoreCheck = validateStructuredClaims(rawLlm.llmScores || [], validSourceIds);
    const impCheck = validateStructuredClaims(rawLlm.improvements || [], validSourceIds);

    return c.json({
      degraded: false,
      llmScores: scoreCheck.accepted,
      improvements: impCheck.accepted,
      followups: (rawLlm.followups || []).slice(0, 2),
      droppedByValidator: scoreCheck.droppedByValidator + impCheck.droppedByValidator
    });
  } catch (err) {
    const reason = err instanceof LlmServiceError ? err.message : '模型服务不可用，已切换规则模式';
    return c.json({
      degraded: true,
      degradedReason: reason,
      llmScores: [],
      improvements: [],
      followups: cards[1] ? [`针对知乎分歧观点「${cards[1].summary}」，你的工程取舍是什么？`] : [],
      droppedByValidator: 0
    });
  }
});
