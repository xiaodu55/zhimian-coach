import { Hono } from 'hono';
import { getQuestionById } from '../lib/knowledge/questionBank.js';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { validateStructuredClaims, ClaimItem } from '../lib/citations.js';
import { COACH_PARSE_SYSTEM_PROMPT, INTERVIEWER_STYLES, FOLLOWUP_DEPTH_RULES } from '../lib/prompts.js';

interface InlineSource {
  stance?: string;
  summary?: string;
  snippet?: string;
  evidenceQuote?: string;
  sourceUrl?: string;
  url?: string;
  author?: string;
}

interface SourceCard {
  stance: string;
  summary: string;
  evidenceQuote: string;
  sourceUrl: string;
  author: string;
  upvotes: number;
  popularity: string;
}

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

  const bankQuestion = questionId ? getQuestionById(questionId) : null;
  const inlineSources: InlineSource[] = Array.isArray(body?.sources) ? (body.sources as InlineSource[]) : [];

  // 来源优先级：题库观点卡 → 前端传来的「面经来源」（简历题走这条）
  const cards: SourceCard[] = (bankQuestion?.viewpointCards || []).length
    ? bankQuestion!.viewpointCards.map((c) => ({
        stance: c.stance,
        summary: c.summary,
        evidenceQuote: c.evidenceQuote,
        sourceUrl: c.sourceUrl,
        author: c.author,
        upvotes: c.upvotes ?? 0,
        popularity: c.popularity,
      }))
    : inlineSources
        .slice(0, 4)
        .map((s) => ({
          stance: String(s.stance || '面经参考').slice(0, 16),
          summary: String(s.summary || s.snippet || '').slice(0, 120),
          evidenceQuote: String(s.evidenceQuote || s.snippet || s.summary || '').slice(0, 200),
          sourceUrl: String(s.sourceUrl || s.url || ''),
          author: String(s.author || '知乎答主').slice(0, 20),
          upvotes: 0,
          popularity: '主流',
        }))
        .filter((c) => Boolean(c.summary || c.evidenceQuote));

  const title = bankQuestion?.title || String(body?.question || '').trim();
  if (!title) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少题目（questionId 或 question）' } }, 400);
  }
  if (!cards.length) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: '本题没有可核对的来源（需要真题观点卡或面经来源），无法做观点层评分' } },
      400
    );
  }

  const validSourceIds = new Set<string>(cards.map((_, idx) => `S${idx + 1}`));

  const sourceContext = cards
    .map((vc, idx) => `[S${idx + 1}] (${vc.stance} · ${vc.author}): ${vc.summary} 原文：“${vc.evidenceQuote}”`)
    .join('\n');

  try {
    // 面试官人设 + 追问深度：写进 prompt，控制 followups 的语气与钻取层数
    const styleKey = String(body?.interviewerStyle || 'tough') === 'gentle' ? 'gentle' : 'tough';
    const style = INTERVIEWER_STYLES[styleKey];
    const depth = Math.min(3, Math.max(1, Number(body?.followupDepth) || 2));
    const followupRule = FOLLOWUP_DEPTH_RULES[depth - 1];

    const rawLlm = await callStructuredLlm<{
      llmScores?: ClaimItem[];
      improvements?: ClaimItem[];
      followups?: string[];
    }>(
      COACH_PARSE_SYSTEM_PROMPT,
      `题目：${title}\n\n可用知乎来源集合：\n${sourceContext || '无外部来源'}\n\n候选人回答：\n${answer}\n\n【本轮追问要求】\n${style.rule}\n${followupRule}`
    );

    const scoreCheck = validateStructuredClaims(rawLlm.llmScores || [], validSourceIds);
    const impCheck = validateStructuredClaims(rawLlm.improvements || [], validSourceIds);

    return c.json({
      degraded: false,
      sourcesUsed: cards.length,
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
