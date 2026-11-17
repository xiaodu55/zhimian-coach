import { Hono } from 'hono';
import { callStructuredLlm, LlmServiceError } from '../lib/llm.js';
import { RESUME_AUDIO_REVIEW_PROMPT } from '../lib/prompts.js';

export const reviewRoutes = new Hono();

interface ConsistencyItem {
  claim?: string;
  said?: string;
  verdict?: string;
  risk?: string;
}

interface ResumeContext {
  headline?: string;
  skills?: string[];
  projects?: Array<{
    name?: string;
    role?: string;
    tech?: string[];
    claims?: Array<{ text?: string; locator?: string }>;
    metrics?: string[];
  }>;
  gaps?: string[];
}

/**
 * 简历 × 录音 对照复盘：
 * 把"简历里写的"和"嘴里说的"放一起看 —— 这正是真实面试里最容易被击穿的地方。
 * 只做对照与追问；逐题规则诊断由前端本地的 10 条规则引擎完成（数据不出本机）。
 */
reviewRoutes.post('/resume-audio', async (c) => {
  const body = await c.req.json();
  const transcript = String(body?.transcript || '').trim();
  const resume = (body?.resumeContext || {}) as ResumeContext;

  if (!transcript) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少转写稿' } }, 400);
  }
  if (!resume.headline && !(resume.projects || []).length) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: '缺少简历上下文（请先在「简历陪练」上传简历）' } },
      400
    );
  }

  const resumeText = JSON.stringify(
    {
      画像: resume.headline || '',
      技能: (resume.skills || []).slice(0, 12),
      项目: (resume.projects || []).map((p) => ({
        名称: p.name,
        角色: p.role,
        技术: (p.tech || []).slice(0, 8),
        主张: (p.claims || []).map((x) => `${x.text}（${x.locator || ''}）`).slice(0, 5),
        量化: (p.metrics || []).slice(0, 5),
      })),
      已知缺口: (resume.gaps || []).slice(0, 6),
    },
    null,
    1
  );

  try {
    const raw = await callStructuredLlm<{
      verdict?: string;
      consistency?: ConsistencyItem[];
      risks?: string[];
      followups?: string[];
    }>(
      RESUME_AUDIO_REVIEW_PROMPT,
      `【候选人简历要点】\n${resumeText}\n\n【本次转写稿】\n${transcript.slice(0, 6000)}`,
      90_000
    );

    const consistency = (raw.consistency || [])
      .map((item) => ({
        claim: String(item?.claim || '').slice(0, 160),
        said: String(item?.said || '').slice(0, 160),
        verdict: ['一致', '不一致', '简历未提', '口述未提'].includes(String(item?.verdict))
          ? String(item.verdict)
          : '不一致',
        risk: String(item?.risk || '').slice(0, 160),
      }))
      .filter((item) => item.claim || item.said)
      .slice(0, 8);

    return c.json({
      degraded: false,
      verdict: String(raw.verdict || '').slice(0, 200),
      consistency,
      risks: (raw.risks || []).map((r) => String(r).slice(0, 120)).slice(0, 5),
      followups: (raw.followups || []).map((f) => String(f).slice(0, 160)).slice(0, 5),
    });
  } catch (err) {
    const reason = err instanceof LlmServiceError ? err.message : '模型服务不可用';
    return c.json(
      { error: { code: 'LLM_UNAVAILABLE', message: `简历对照失败：${reason}`, hint: '规则层诊断照常可用' } },
      503
    );
  }
});
