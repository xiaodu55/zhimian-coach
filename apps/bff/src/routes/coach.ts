import { Hono } from 'hono';
import { getQuestionById } from '../lib/knowledge/questionBank.js';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { validateStructuredClaims, ClaimItem } from '../lib/citations.js';
import { COACH_PARSE_SYSTEM_PROMPT, INTERVIEWER_STYLES, FOLLOWUP_DEPTH_RULES, POLISH_ANSWER_PROMPT, COACH_DIMENSIONS, inferQuestionKind } from '../lib/prompts.js';

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

interface ParseOutcome {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

/**
 * 复盘核心：规则层 + 模型层。非流式与流式共用同一份逻辑，
 * 保证「流式失败回落到非流式」时结果完全一致。
 */
async function runParse(
  body: Record<string, unknown>,
  onStage?: (stage: string, text: string) => void
): Promise<ParseOutcome> {
  const answer = String(body?.answer || '').trim();
  const questionId = String(body?.questionId || '');
  if (!answer) {
    return { ok: false, status: 400, payload: { error: { code: 'VALIDATION_ERROR', message: '回答内容不能为空' } } };
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
    return { ok: false, status: 400, payload: { error: { code: 'VALIDATION_ERROR', message: '缺少题目（questionId 或 question）' } } };
  }
  if (!cards.length) {
    return {
      ok: false,
      status: 400,
      payload: { error: { code: 'VALIDATION_ERROR', message: '本题没有可核对的来源（需要真题观点卡或面经来源），无法做观点层评分' } },
    };
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

    // 评分维度按题目类型分流：技术题 vs 软素质题
    const kind = body?.questionKind === 'soft' ? 'soft' : body?.questionKind === 'tech' ? 'tech' : inferQuestionKind(title);
    const dimensions = COACH_DIMENSIONS[kind];

    onStage?.('treating', '正在提炼 3 个核心考察点…');
    const rawLlm = await callStructuredLlm<{
      llmScores?: ClaimItem[];
      improvements?: ClaimItem[];
      followups?: string[];
    }>(
      COACH_PARSE_SYSTEM_PROMPT.replace('__DIMENSIONS__', dimensions),
      `题目：${title}\n\n可用知乎来源集合：\n${sourceContext || '无外部来源'}\n\n候选人回答：\n${answer}\n\n【本轮追问要求】\n${style.rule}\n${followupRule}`
    );

    onStage?.('diagnosing', '正在对照你的原话逐句诊断…');
    const scoreCheck = validateStructuredClaims(rawLlm.llmScores || [], validSourceIds);
    const impCheck = validateStructuredClaims(rawLlm.improvements || [], validSourceIds);

    return {
      ok: true,
      status: 200,
      payload: {
        degraded: false,
        sourcesUsed: cards.length,
        llmScores: scoreCheck.accepted,
        improvements: impCheck.accepted,
        followups: (rawLlm.followups || []).slice(0, 2),
        droppedByValidator: scoreCheck.droppedByValidator + impCheck.droppedByValidator,
      },
    };
  } catch (err) {
    const reason = err instanceof LlmServiceError ? err.message : '模型服务不可用，已切换规则模式';
    return {
      ok: true,
      status: 200,
      payload: {
        degraded: true,
        degradedReason: reason,
        llmScores: [],
        improvements: [],
        followups: cards[1] ? [`针对知乎分歧观点「${cards[1].summary}」，你的工程取舍是什么？`] : [],
        droppedByValidator: 0,
      },
    };
  }
}

/** 非流式复盘（保持原有契约不变） */
coachRoutes.post('/parse', async (c) => {
  const body = await c.req.json();
  const out = await runParse(body as Record<string, unknown>);
  return c.json(out.payload, out.status as 400);
});

/**
 * 流式复盘：阶段事件先到，结果最后到。
 * 事件协议：stage / delta / result / error（前端 lib/sse.js 按此消费）
 */
coachRoutes.post('/parse/stream', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      try {
        send('stage', { stage: 'retrieving', text: '正在检索知乎真实回答结构…' });
        const out = await runParse(body, (stage, text) => send('stage', { stage, text }));
        const errMsg = (out.payload?.error as { message?: string } | undefined)?.message;
        if (!out.ok) send('error', { message: errMsg || '生成失败' });
        else send('result', out.payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '生成失败';
        send('error', { message: msg });
      } finally {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });
  return c.body(stream, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
});

/**
 * 一键生成满分润色版：把用户原话改写成可直接背诵的高分版（保留事实与数字，不编造）。
 * 契约：{question, answer, findings[]} → {polished, notes[], degraded}
 */
coachRoutes.post('/polish', async (c) => {
  const body = await c.req.json();
  const question = String(body?.question || '').trim();
  const answer = String(body?.answer || '').trim();
  const rawFindings: unknown[] = Array.isArray(body?.findings) ? body.findings : [];
  const findings = rawFindings.map((f) => String(f).slice(0, 80));

  if (!question || !answer) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少题目或回答' } }, 400);
  }

  try {
    const raw = await callStructuredLlm<{ polished?: string; notes?: string[] }>(
      POLISH_ANSWER_PROMPT,
      `题目：${question}\n\n候选人原话：\n${answer.slice(0, 3000)}\n\n诊断意见：\n${findings.join('；') || '（无）'}`,
      40_000
    );
    const polished = String(raw.polished || '').trim();
    if (polished) {
      const notes: string[] = (raw.notes || []).slice(0, 3).map((n) => String(n).slice(0, 40));
      return c.json({ polished, notes });
    }
  } catch {
    // 落到下面的降级
  }

  // 降级：不编内容，直接把原话按"结论前置"重排并标注这是基础版
  const sentences = answer.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
  const base = sentences.length > 1 ? [sentences[sentences.length - 1], ...sentences.slice(0, -1)].join('') : answer;
  return c.json({
    degraded: true,
    polished: base.slice(0, 400),
    notes: ['基础版：仅把结论提到前面，联网后可得到完整润色版'],
  });
});
