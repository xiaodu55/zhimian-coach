import { Hono } from 'hono';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { RESUME_BULLET_QUESTIONS_PROMPT } from '../lib/prompts.js';

export const resumeBulletRoutes = new Hono();

interface BulletInput {
  bullet?: string;
  question?: string;
}

interface Candidate {
  id: string;
  bullet: string;
  q: string;
  why: string;
  focus: string;
  difficulty: string;
}

/**
 * 按用户勾选的"要点"生成候选面试题（两步向导的第二步）。
 * 只依据要点与简历上下文，模型失败时回落到"要点即问题"的模板题，不留空白。
 */
resumeBulletRoutes.post('/resume/questions-from-bullets', async (c) => {
  const body = await c.req.json();
  const rawBullets: BulletInput[] = Array.isArray(body?.bullets) ? body.bullets : [];
  const bullets = rawBullets
    .map((b) => (typeof b === 'string' ? { bullet: b, question: '' } : b))
    .filter((b) => b && typeof b.bullet === 'string' && b.bullet.trim().length >= 4)
    .slice(0, 12);

  if (!bullets.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '请至少勾选一个要点' } }, 400);
  }

  const context = String(body?.resumeContext || '').slice(0, 4000);
  const prompt =
    `【候选人简历上下文】\n${context || '（无）'}\n\n` +
    `【要点列表】\n${bullets.map((b, i) => `${i + 1}. ${b.bullet}`).join('\n')}`;

  let candidates: Candidate[] = [];
  let degraded = false;
  try {
    const raw = await callStructuredLlm<{ questions?: Array<Record<string, unknown>> }>(
      RESUME_BULLET_QUESTIONS_PROMPT,
      prompt,
      90_000
    );
    candidates = (raw.questions || [])
      .map((q, i) => {
        const bullet = String(q?.bullet || '').trim();
        const text = String(q?.q || '').trim().slice(0, 90);
        if (!text) return null;
        return {
          id: `rb-${i + 1}`,
          bullet: bullet || bullets[i]?.bullet || '',
          q: text,
          why: String(q?.why || '').slice(0, 120),
          focus: String(q?.focus || '项目深挖').slice(0, 12),
          difficulty: ['基础', '进阶', '难'].includes(String(q?.difficulty)) ? String(q.difficulty) : '进阶',
        } satisfies Candidate;
      })
      .filter((q): q is Candidate => Boolean(q))
      .slice(0, 12);
  } catch (err) {
    degraded = true;
    const reason = err instanceof LlmServiceError ? err.message : '模型不可用';
    console.warn('[resume/bullets] 生成失败：' + reason);
  }

  // 兜底：模型失败时，用要点本身生成可练的题目（不空白、不编造）
  if (!candidates.length) {
    candidates = bullets.map((b, i) => ({
      id: `rb-${i + 1}`,
      bullet: String(b.bullet || ''),
      q: `请具体讲讲「${String(b.bullet || '').slice(0, 40)}」：你的角色、一个可核对的数字、以及一次取舍。`,
      why: '按要点直接追问（模型降级：使用固定模板，非定制化提问）',
      focus: '项目深挖',
      difficulty: '进阶',
    }));
  }

  return c.json({ degraded, candidates });
});
