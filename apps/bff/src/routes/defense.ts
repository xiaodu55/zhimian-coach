import { Hono } from 'hono';
import { callStructuredLlm } from '../lib/llm.js';
import { zhihuSearch } from '../lib/zhihuClient.js';
import { DEFENSE_QUESTIONS_PROMPT, DEFENSE_FOLLOWUP_PROMPT } from '../lib/prompts.js';

export const defenseRoutes = new Hono();

/** 答辩材料的主题词：取首段标题或文件名 */
function topicOf(title: string, segments: Array<{ heading?: string }>): string {
  const raw = segments[0]?.heading || String(title || '技术方案').replace(/\\.[^.]+$/, '');
  return String(raw).slice(0, 30).trim();
}

/**
 * 知乎相关讨论：答辩材料主题 → 几条"别人怎么质疑/踩坑"的真实讨论。
 * 这些会作为可点击链接返回给用户（前端直接渲染成链接）。
 */
async function searchReferences(topic: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const queries = [`${topic} 质疑 局限`, `${topic} 优缺点 对比`, `${topic} 踩坑 经验`];
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  for (const q of queries) {
    try {
      const { results } = await zhihuSearch(q, 'zhihu', 5);
      for (const r of results) {
        if (!r?.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push({ title: r.title || '', url: r.url, snippet: r.snippet || '' });
        if (out.length >= 8) return out;
      }
    } catch {
      // 单条查询失败不阻塞：继续试下一条
    }
  }
  return out;
}

/** 独立接口：只取知乎相关讨论（前端「知乎相关内容」区块） */
defenseRoutes.post('/defense/references', async (c) => {
  const body = await c.req.json();
  const title = String(body?.title || '').trim();
  const segments = Array.isArray(body?.segments) ? body.segments : [];
  const topic = topicOf(title, segments);
  if (!topic) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少材料标题或分段' } }, 400);
  }
  const items = await searchReferences(topic);
  return c.json({ items, topic, degraded: items.length === 0 });
});

interface DefenseQuestion {
  q: string;
  why: string;
  locator: string;
  severity: string;
  zhihuRef: { title: string; url: string; snippet: string } | null;
}

/**
 * 答辩预测：基于材料生成评委高危追问，并挂上知乎上真实的质疑讨论。
 * 契约：{title, segments} → {degraded, topRisks, predictedQuestions, references}
 */
defenseRoutes.post('/defense/analyze', async (c) => {
  const body = await c.req.json();
  const title = String(body?.title || '技术方案').trim();
  const segments = Array.isArray(body?.segments) ? body.segments : [];

  if (!segments.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '请先上传并解析答辩材料（缺少 segments）' } }, 400);
  }

  const topic = topicOf(title, segments);
  const references = await searchReferences(topic);

  // 材料薄弱点（纯结构化推断，不编造内容）
  const segs = segments as Array<{ locator?: string; heading?: string; text?: string }>;
  const topRisks = segs.slice(0, 3).map((seg, i) => ({
    riskId: `risk-${i + 1}`,
    locator: seg.locator,
    title: `薄弱点 #${i + 1}：${seg.heading}`,
    reason: `材料在 ${seg.locator} 提出了关键论断，但缺少对照基线、消融实验或极端边界数据。`,
  }));

  const contextText = segs.map((s, i) => `[S${i + 1}] (${s.locator}) ${s.heading}：${s.text}`).join('\n');

  let questions: DefenseQuestion[] = [];
  let degraded = false;
  try {
    const raw = await callStructuredLlm<{ questions?: Array<Record<string, unknown>> }>(
      DEFENSE_QUESTIONS_PROMPT,
      `【答辩材料标题】${title}\n【主题】${topic}\n\n【材料分段】\n${contextText}`,
      45_000
    );
    const mapped: Array<DefenseQuestion | null> = (raw.questions || [])
      .map((q) => {
        const text = String(q?.q || '').trim().slice(0, 120);
        if (!text) return null;
        const severity = ['高', '中', '低'].includes(String(q?.severity)) ? String(q.severity) : '中';
        return {
          q: text,
          why: String(q?.why || '').slice(0, 140),
              locator: String(q?.locator || '').slice(0, 40),
          severity,
          zhihuRef: null,
        } satisfies DefenseQuestion;
      });
    questions = mapped.filter((q): q is DefenseQuestion => q !== null).slice(0, 8);
  } catch {
    degraded = true;
  }

  // 模型不可用：按材料结构给出模板追问（不空白、不编造内容）
  if (!questions.length) {
    degraded = true;
    questions = segs.slice(0, 8).map((seg, idx) => ({
      q: `针对 ${seg.locator}「${seg.heading}」，如果去掉这个机制、或遇到长尾异常输入，你的指标会掉多少？依据是什么？`,
      why: '该段是核心技术主张，评委通常用"消融实验 + 边界压力"验证它是不是真的必要。',
      locator: String(seg.locator || ''),
      severity: idx < 3 ? '高' : '中',
      zhihuRef: null,
    }));
  }

  // 每条追问挂一条真实知乎讨论（用户可点进去看）
  const predictedQuestions = questions.map((q, i) => ({
    ...q,
    zhihuRef: references.length ? references[i % references.length] : null,
  }));

  return c.json({ degraded, topRisks, predictedQuestions, references });
});

/**
 * 答辩连续追问：评委针对候选人的回答继续追（最多 3 轮，由前端控制）。
 * 契约：{question, answer, segments[]} → {exhausted, followup: {q, why, severity}}
 */
defenseRoutes.post('/defense/followup', async (c) => {
  const body = await c.req.json();
  const question = String(body?.question || '').trim();
  const answer = String(body?.answer || '').trim();
  const segments = Array.isArray(body?.segments) ? body.segments : [];

  if (!question || !answer) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少 question 或 answer' } }, 400);
  }

  const segs = segments as Array<{ locator?: string; heading?: string; text?: string }>;
  const contextText = segs
    .slice(0, 12)
    .map((s, i) => `[S${i + 1}] (${s.locator}) ${s.heading}：${s.text}`)
    .join('\n');

  try {
    const raw = await callStructuredLlm<{ questions?: Array<Record<string, unknown>> }>(
      DEFENSE_FOLLOWUP_PROMPT,
      `【评委的问题】\n${question}\n\n【答辩人的回答】\n${answer}\n\n【答辩材料（评委手里的底稿）】\n${contextText || '（无）'}`,
      40_000
    );
    const items = (raw.questions || [])
      .map((q) => {
        const text = String(q?.q || '').trim().slice(0, 120);
        if (!text) return null;
        const severity = ['高', '中', '低'].includes(String(q?.severity)) ? String(q.severity) : '中';
        return { q: text, why: String(q?.why || '').slice(0, 140), severity };
      })
      .filter((q): q is { q: string; why: string; severity: string } => q !== null)
      .slice(0, 1);
    const followup = items[0] || null;
    return c.json({ exhausted: !followup, followup });
  } catch {
    // 模型不可用：给一条固定但有指向性的追问（不空白、不编造材料内容）
    return c.json({
      degraded: true,
      exhausted: false,
      followup: {
        q: '你刚才这个结论有没有对照实验或线上数据支撑？具体是在什么条件下测的？',
        why: '追回答里是否只有结论、缺少可核对的证据（模型降级：使用固定追问模板）',
        severity: '中',
      },
    });
  }
});
