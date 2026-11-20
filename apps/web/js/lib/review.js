import { parseTranscriptToQA } from '../capture/transcript.js';
import { runDeterministicRules } from '../rules/diagnose.js';
import { postSSE } from './sse.js';

/**
 * 跑一次复盘：规则层（原话级诊断）+ 模型层（观点/知识契合度评分）。
 * 只算不存、不跳转 —— 主练习区与"练习小窗"共用同一套逻辑。
 *
 * @param {object} p
 * @param {object} p.question 当前题目
 * @param {string} p.raw      作答原文（可带「面试官：/ 我：」标签）
 * @param {Array|null} p.sources  可核对的来源（面经/检索结果）；null 时取 question.viewpointCards
 * @param {string} p.followupFocus 当前追问焦点
 */
export async function runReview({
  question,
  raw,
  sources = null,
  followupFocus = '',
  interviewerStyle = 'tough',
  followupDepth = 2,
  /** 题目类型：tech（技术题）/ soft（软素质题）—— 决定后端用哪套评分维度 */
  questionKind = 'tech',
  /** 阶段文案回调（流式时前端用它播报"现在在做什么"） */
  onStage = null,
}) {
  const qaPairs = parseTranscriptToQA(raw, question.title);
  const targetAnswer = qaPairs.map((p) => p.answer).join('\n\n');
  const ruleFindings = runDeterministicRules(targetAnswer, { ...question, followupFocus });

  const src =
    sources ??
    (question.viewpointCards || []).map((c) => ({
      summary: c.summary,
      snippet: c.evidenceQuote,
      evidenceQuote: c.evidenceQuote,
      sourceUrl: c.sourceUrl,
      author: c.author,
    }));

  let llmScores = null;
  let improvements = null;
  let followups = null;
  let degraded = false;
  let degradedReason = '';

  // 简历题 / 要点题 / 答辩预演题：都没有题库 id，一律走「问题 + 来源」模式
  const isResumeLike =
    question.source === 'resume' || question.source === 'resume-bullet' || question.source === 'defense';
  if (isResumeLike && !src.length) {
    degraded = true;
    degradedReason = '本题没有可核对的面经来源：只跑规则层';
  } else {
    const payload = isResumeLike
      ? {
          question: question.title,
          sources: src,
          answer: targetAnswer,
          transcript: raw,
          interviewerStyle,
          followupDepth,
          questionKind,
        }
      : {
          questionId: question.id,
          answer: targetAnswer,
          transcript: raw,
          interviewerStyle,
          followupDepth,
          questionKind,
        };
    try {
      // 优先走流式：阶段文案能立刻告诉用户"在做什么"，首字等待更短
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      const j = await postSSE('/api/coach/parse/stream', payload, {
        onStage: (d) => onStage?.(d?.text || d?.stage || ''),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      degraded = !!j.degraded;
      llmScores = j.llmScores || null;
      improvements = j.improvements || null;
      followups = j.followups || null;
    } catch (err) {
      // 流式不可用（老服务端 / 网络 / 网关掐断）→ 回落非流式接口，并带退避重试。
      // 云函数冷启动 + 网关约 15 秒上限：第一次请求可能整条失败（554/网络中断）。
      // 实例预热后第二次通常几秒就成功，所以这里重试几次，
      // 否则评委第一次点"结束作答"就会看到降级成规则模式（没有追问、没有维度分）。
      const maxAttempts = err?.name === 'AbortError' ? 2 : 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 25000);
          const res = await fetch('/api/coach/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (res.ok) {
            const j = await res.json();
            degraded = !!j.degraded;
            llmScores = j.llmScores || null;
            improvements = j.improvements || null;
            followups = j.followups || null;
            lastErr = null;
            break;
          }
          lastErr = new Error('HTTP ' + res.status);
        } catch (e) {
          lastErr = e;
        }
        if (attempt < maxAttempts) {
          onStage?.('retrying', attempt === 1 ? '网络不太顺，正在重试…' : '仍在重试，请稍候…');
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      if (lastErr) degraded = true;
    }
  }

  return { qaPairs, answer: targetAnswer, ruleFindings, llmScores, improvements, followups, degraded, degradedReason };
}
