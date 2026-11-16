import { Hono } from 'hono';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { RESUME_ANALYZE_SYSTEM_PROMPT } from '../lib/prompts.js';
import { zhihuSearch } from '../lib/zhihuClient.js';

export const resumeRoutes = new Hono();

interface SegmentInput {
  locator: string;
  heading?: string;
  text: string;
}

interface ResumeProfile {
  headline: string;
  skills: string[];
  projects: Array<{ name: string; role: string; tech: string[]; claims: Array<{ text: string; locator: string }>; metrics: string[] }>;
  gaps: string[];
}

interface RawQuestion {
  q?: string;
  why?: string;
  focus?: string;
  locator?: string;
  difficulty?: string;
}

interface ZhihuRef {
  title: string;
  url: string;
  snippet: string;
}

/** 简历驱动模拟面试：抽取档案 → 出题（每题挂简历定位符）→ 挂真实知乎面经 */
resumeRoutes.post('/resume/analyze', async (c) => {
  const body = await c.req.json();
  const filename = String(body?.filename || '简历').slice(0, 80);
  const segments: SegmentInput[] = Array.isArray(body?.segments)
    ? body.segments
        .filter((s: SegmentInput) => s && typeof s.text === 'string' && s.text.trim())
        .slice(0, 24)
    : [];

  if (!segments.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少简历分段（请先解析简历）' } }, 400);
  }

  const validLocators = new Set(segments.map((s) => s.locator));
  // 控制上下文体积：实测 3.8k 字符约 22s，超过默认 25s 超时会误降级
  const context = segments
    .map((s, i) => `[${i + 1}] (${s.locator}) ${s.text.slice(0, 400)}`)
    .join('\n');

  let profile: ResumeProfile = { headline: '', skills: [], projects: [], gaps: [] };
  let questions: Array<{ id: string; q: string; why: string; focus: string; locator: string; difficulty: string; zhihuRef: ZhihuRef | null }> = [];
  let degraded = false;
  let degradedReason = '';
  let droppedByGrounding = 0;

  try {
    // 简历出题属于长结构化输出：给足 90s，避免 25s 默认超时把成功请求打断
    const raw = await callStructuredLlm<{ profile?: ResumeProfile; questions?: RawQuestion[] }>(
      RESUME_ANALYZE_SYSTEM_PROMPT,
      `简历文件：${filename}\n\n分段：\n${context}`,
      90_000
    );
    profile = {
      headline: String(raw.profile?.headline || '').slice(0, 120),
      skills: (raw.profile?.skills || []).map((s) => String(s).slice(0, 24)).slice(0, 10),
      projects: (raw.profile?.projects || []).slice(0, 5).map((p) => ({
        name: String(p?.name || '').slice(0, 40),
        role: String(p?.role || '').slice(0, 30),
        tech: (p?.tech || []).map((t) => String(t).slice(0, 20)).slice(0, 8),
        claims: (p?.claims || [])
          .map((cl) => ({ text: String(cl?.text || '').slice(0, 120), locator: String(cl?.locator || '') }))
          .filter((cl) => cl.text)
          .slice(0, 5),
        metrics: (p?.metrics || []).map((m) => String(m).slice(0, 40)).slice(0, 5),
      })),
      gaps: (raw.profile?.gaps || []).map((g) => String(g).slice(0, 60)).slice(0, 6),
    };

    // 接地校验：locator 必须真实存在于简历分段，否则丢弃（防止模型凭空编经历）
    questions = (raw.questions || [])
      .map((q, i) => ({
        id: `resume-${i + 1}`,
        q: String(q?.q || '').trim().slice(0, 160),
        why: String(q?.why || '').slice(0, 120),
        focus: String(q?.focus || '项目深挖').slice(0, 12),
        locator: String(q?.locator || '').trim(),
        difficulty: ['基础', '进阶', '难'].includes(String(q?.difficulty)) ? String(q?.difficulty) : '进阶',
        zhihuRef: null as ZhihuRef | null,
      }))
      .filter((q) => {
        if (!q.q) return false;
        if (!validLocators.has(q.locator)) {
          droppedByGrounding += 1;
          return false;
        }
        return true;
      })
      .slice(0, 10);
  } catch (err) {
    degraded = true;
    degradedReason =
      err instanceof LlmServiceError ? err.message : '模型不可用，已降级为「只用简历片段 + 通用追问模板」';
  }

  if (degraded) {
    // 降级：不出模型题，但给出可核对的事实卡，让用户仍能练习
    profile = {
      headline: `${filename}（模型降级：仅展示可核对片段）`,
      skills: [],
      projects: [],
      gaps: ['模型不可用：本次未生成针对性问题'],
    };
    questions = segments.slice(0, 5).map((s, i) => ({
      id: `resume-${i + 1}`,
      q: `请就「${(s.heading || s.locator)}」这段经历，讲清：你的角色、一个具体数字、以及一次失败后的调整。`,
      why: '模型不可用时的通用追问框架（结构+量化+复盘），不是针对简历定制的题。',
      focus: '行为面',
      locator: s.locator,
      difficulty: '基础',
      zhihuRef: null,
    }));
  }

  // 真实知乎面经/质疑：最多 2 次搜索，挂到题目上（失败不影响出题）
  if (questions.length) {
    const topics = [profile.headline || filename, profile.projects[0]?.tech?.[0] || profile.skills?.[0] || '项目 追问']
      .filter(Boolean)
      .slice(0, 2);
    const refs: ZhihuRef[] = [];
    for (const topic of topics) {
      try {
        const { results } = await zhihuSearch(`${topic} 面试 追问 面经`, 'zhihu', 3);
        refs.push(...results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })));
      } catch {
        /* 配额/网络问题不影响出题 */
      }
    }
    questions = questions.map((q, i) => ({ ...q, zhihuRef: refs.length ? refs[i % refs.length] : null }));
  }

  return c.json({
    filename,
    degraded,
    degradedReason: degraded ? degradedReason : '',
    droppedByGrounding,
    profile,
    questions,
  });
});
