import { parseTranscriptToQA } from '../capture/transcript.js';
import { runDeterministicRules } from '../rules/diagnose.js';

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
export async function runReview({ question, raw, sources = null, followupFocus = '' }) {
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
  let degraded = false;
  let degradedReason = '';

  // 简历题 / 要点题 / 答辩预演题：都没有题库 id，一律走「问题 + 来源」模式
  const isResumeLike =
    question.source === 'resume' || question.source === 'resume-bullet' || question.source === 'defense';
  if (isResumeLike && !src.length) {
    degraded = true;
    degradedReason = '本题没有可核对的面经来源：只跑规则层';
  } else {
    try {
      const ctrl = new AbortController();
      // 实测：DeepSeek 结构化输出 10–16s，8s 超时会把成功请求 abort 掉（曾导致误降级）
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch('/api/coach/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isResumeLike
            ? { question: question.title, sources: src, answer: targetAnswer, transcript: raw }
            : { questionId: question.id, answer: targetAnswer, transcript: raw }
        ),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        degraded = !!j.degraded;
        llmScores = j.llmScores || null;
        improvements = j.improvements || null;
      } else {
        degraded = true;
      }
    } catch (_) {
      degraded = true;
    }
  }

  return { qaPairs, answer: targetAnswer, ruleFindings, llmScores, improvements, degraded, degradedReason };
}
