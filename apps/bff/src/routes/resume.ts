import { Hono } from 'hono';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { RESUME_ANALYZE_SYSTEM_PROMPT } from '../lib/prompts.js';
import { zhihuSearch } from '../lib/zhihuClient.js';
import { getCache, setCache, sha1Key } from '../lib/cache.js';

export const resumeRoutes = new Hono();

/** 模型没输出 bullets 时，从"为什么问"派生可勾选的覆盖点，保证每题都有 checklist */
function fallbackBullets(why: string): string[] {
  const parts = String(why || '')
    .split(/[；;]|，(?=.{6,})/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .slice(0, 3);
  return parts.length
    ? parts
    : ['给出一个可核对的数字与口径', '讲清你的判断与取舍（为什么不是另一种做法）', '落到结果与边界条件'];
}

/** 只对"题目相关文本"做哈希：忽略空白差异，但保留定位符（同一份简历顺序变化也算不同） */
function segmentsHash(segments: unknown): string {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((s) => {
      const seg = s as { locator?: string; text?: string };
      return `${seg.locator || ''}:${String(seg.text || '').replace(/\s+/g, '').slice(0, 200)}`;
    })
    .join('|');
}

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
  bullets?: string[];
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
  const force = Boolean(body?.force);
  // 同一份简历不重复花 40–50 秒：按内容哈希缓存（含文件名，避免同名不同内容互相覆盖）
  // v3：出题结构新增 bullets，缓存键随结构升版（v2 的旧缓存没有 bullets 字段）
  const contentHash = sha1Key('resume-v3', `${filename}::${segmentsHash(body?.segments)}`);
  if (!force) {
    const hit = getCache<Record<string, unknown>>(contentHash);
    if (hit) {
      return c.json({ ...hit, cached: true, cachedAt: new Date().toISOString() });
    }
  }
  const segments: SegmentInput[] = Array.isArray(body?.segments)
    ? body.segments
        .filter((s: SegmentInput) => s && typeof s.text === 'string' && s.text.trim())
        .slice(0, 24)
    : [];

  if (!segments.length) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少简历分段（请先解析简历）' } }, 400);
  }

  const validLocators = new Set(segments.map((s) => s.locator));
  /**
   * 宽容解析模型输出的 locator：
   * 上下文格式为 `[1] (第1段) ...`，关掉 thinking 后模型常把 locator 写成 `[1]`、`1`、`S1` 或 `[1] (第1段)`。
   * 先查精确命中 → 再按 `[i]` 序号反查 → 再按子串包含 → 单段简历兜底为首段，仅在完全无法对应任何段落时才丢弃。
   */
  function resolveLocator(rawLoc: string, qText = ''): string | null {
    const loc = String(rawLoc || '').trim();
    if (loc && validLocators.has(loc)) return loc;
    if (loc) {
      const found = segments.find((s) => s.locator && (loc.includes(s.locator) || s.locator.includes(loc)));
      if (found) return found.locator;
      const paraMatch = /¶(\d+)/.exec(loc) || /^\[?[Ss#§第pP]?(\d+)[\]段节]?$/.exec(loc) || /\[(\d+)\]/.exec(loc) || /(\d+)/.exec(loc);
      if (paraMatch) {
        const idx = Number(paraMatch[1]) - 1;
        if (idx >= 0 && idx < segments.length) return segments[idx].locator;
      }
    }
    if (segments.length === 1) return segments[0].locator;
    // 按题目文本与各分段文本的 2-gram 重合度吸附到最相关的简历段落
    const cleanQ = String(qText || '').replace(/\s+/g, '');
    if (cleanQ.length >= 4) {
      let bestLoc: string | null = null;
      let bestScore = 0;
      for (const s of segments) {
        const hay = String(s.text || '');
        let score = 0;
        for (let i = 0; i < cleanQ.length - 1; i++) {
          const bi = cleanQ.slice(i, i + 2);
          if (hay.includes(bi)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestLoc = s.locator;
        }
      }
      if (bestLoc && bestScore >= 2) return bestLoc;
    }
    return null;
  }
  // 控制上下文体积：实测 3.8k 字符约 22s，超过默认 25s 超时会误降级
  const context = segments
    .map((s, i) => `[${i + 1}] (${s.locator}) ${s.text.slice(0, 400)}`)
    .join('\n');
  let profile: ResumeProfile = { headline: '', skills: [], projects: [], gaps: [] };
  let questions: Array<{ id: string; q: string; why: string; focus: string; locator: string; difficulty: string; zhihuRef: ZhihuRef | null }> = [];
  let degraded = false;
  let degradedReason = '';
  let droppedByGrounding = 0;
  // 知乎面经检索与 LLM 出题并行发起，避免串行叠加撞上云端网关 15s 上限
  const seedQuery = `${segments[0]?.heading || filename} ${segments[0]?.text?.slice(0, 28) || ''} 面试 追问`.trim();
  const refsPromise: Promise<ZhihuRef[]> = zhihuSearch(seedQuery, 'zhihu', 4)
    .then(({ results }) => results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })))
    .catch(() => []);

  try {
    // 简历出题：给 45s 上限
    const raw = await callStructuredLlm<{ profile?: ResumeProfile; questions?: RawQuestion[] }>(
      RESUME_ANALYZE_SYSTEM_PROMPT,
      `简历文件：${filename}\n\n分段：\n${context}`,
      45_000
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
      .map((q, i) => {
        const resolvedLoc = resolveLocator(String(q?.locator || ''), String(q?.q || ''));
        return {
          id: `resume-${i + 1}`,
          q: String(q?.q || '').trim().slice(0, 160),
          why: String(q?.why || '').slice(0, 120),
          focus: String(q?.focus || '项目深挖').slice(0, 12),
          locator: resolvedLoc || '',
          difficulty: ['基础', '进阶', '难'].includes(String(q?.difficulty)) ? String(q.difficulty) : '进阶',
          bullets: (Array.isArray(q?.bullets) ? q.bullets : [])
            .map((b: unknown) => String(b).trim().slice(0, 60))
            .filter((b: string) => b.length >= 4)
            .slice(0, 4),
          zhihuRef: null as ZhihuRef | null,
        };
      })
      .filter((q) => {
        if (!q.q) return false;
        if (!q.locator) {
          droppedByGrounding += 1;
          return false;
        }
        return true;
      })
      .map((q) => ({
        ...q,
        bullets: q.bullets.length ? q.bullets : fallbackBullets(q.why),
      }))
      .slice(0, 10);
    if (!questions.length) {
      degraded = true;
      degradedReason = '模型输出的定位符未命中简历分段，已回退为分段通用追问';
    }
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
    const refs = await refsPromise;
    const unique = refs.filter((r, i) => refs.findIndex((x) => x.url === r.url) === i);
    questions = questions.map((q, i) => {
      const picked = unique.length
        ? [unique[i % unique.length], unique[(i + 1) % unique.length]].filter(
            (r, idx, arr) => r && arr.findIndex((x) => x?.url === r.url) === idx
          )
        : [];
      // viewpointCards 是给前端「观点层依据」用的：面经摘录即来源，字段与题库观点卡对齐
      const viewpointCards = picked.map((r) => ({
        stance: '面经参考',
        summary: String(r.snippet || r.title || '').slice(0, 120),
        evidenceQuote: String(r.snippet || r.title || '').slice(0, 200),
        sourceUrl: r.url,
        author: '知乎答主',
        upvotes: 0,
        popularity: '主流',
      }));
      return { ...q, viewpointCards, sources: picked, zhihuRef: picked[0] || null };
    });
  }

  const payload = {
    filename,
    degraded,
    degradedReason: degraded ? degradedReason : '',
    droppedByGrounding,
    profile,
    questions,
  };
  setCache(contentHash, payload, 7 * 24 * 3600_000);
  return c.json({ ...payload, cached: false });
});
