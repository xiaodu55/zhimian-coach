#!/usr/bin/env node
/**
 * 生成「演示保底包」：预跑几道题的真实复盘报告，存成静态 JSON。
 *
 * 为什么需要：公网演示时模型可能超时、知乎额度可能用尽、网络可能断。
 * 有了这个包，「免费开始 3 分钟实战演练」在完全离线的机器上也能走完
 * 复盘 → 闪卡 → 弹药库 的完整闭环。
 *
 * 用法：node scripts/build-bank/demo-reports.mjs [--count 3] [--base http://127.0.0.1:8787]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const COUNT = Number(argOf('count', '3'));
const BASE = argOf('base', 'http://127.0.0.1:8787');
const OUT = path.resolve(ROOT, 'apps/web/data/demo-reports.json');

/** 每道题配一段"有瑕疵但像真人"的作答：诊断才有东西可讲 */
const SCRIPTS = [
  {
    pick: (q) => /权限|工具调用|Agent|系统设计|高并发/i.test(q.title + (q.keywords || []).join('')),
    answer:
      '我们做了一套权限控制，主要是分了三档，高危操作会转人工。' +
      '上线之后效果不错，拦截了很多问题，团队反馈也比较好。' +
      '中间也遇到过误拦截的情况，我们后来加了一些规则来兜住。' +
      '后续可能还要在多模态场景下再看看。',
  },
  {
    pick: (q) => /RAG|检索|评测|效果/i.test(q.title + (q.keywords || []).join('')),
    answer:
      '检索这块我们主要是做了切分和召回的优化，也加了一些重排。' +
      '效果上比之前好一些，但具体的数字我记不太清了，大概有提升。' +
      '评测的话我们用的是内部人工标注的一批评测集。' +
      '未来希望能自动化一点。',
  },
  {
    pick: () => true,
    answer:
      '这个问题我的看法是要先明确标准，再分阶段推进。' +
      '我们当时是这么做的，效果还不错，后来也在其他项目里复用了。' +
      '具体的数据我需要回去查一下才能给你准确数字。' +
      '边界条件那块可能还需要再想想。',
  },
];

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/data/question-bank.json'), 'utf8'));
const questions = bank.questions || [];

const picked = [];
for (const script of SCRIPTS) {
  if (picked.length >= COUNT) break;
  const hit = questions.find((q) => !picked.includes(q) && script.pick(q));
  if (hit) picked.push({ q: hit, answer: script.answer });
}

console.log(`[demo] 选中 ${picked.length} 道题：${picked.map((p) => p.q.title.slice(0, 18)).join(' | ')}`);

const out = [];
for (const { q, answer } of picked) {
  try {
    const res = await fetch(`${BASE}/api/coach/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q.title,
        questionKind: q.kind || 'tech',
        sources: (q.viewpointCards || []).slice(0, 3).map((c) => ({
          summary: c.summary,
          snippet: c.evidenceQuote,
          evidenceQuote: c.evidenceQuote,
          sourceUrl: c.sourceUrl,
          author: c.author || '',
        })),
        answer,
        transcript: `面试官：${q.title}\n我：${answer}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    out.push({
      questionId: q.id,
      question: q,
      answer,
      report: {
        id: 'demo-' + q.id,
        question: q,
        answer,
        qaPairs: [{ question: q.title, answer }],
        ruleFindings: [],
        llmScores: data.llmScores || [],
        improvements: data.improvements || [],
        followups: data.followups || [],
        degraded: !!data.degraded,
        createdAt: new Date().toISOString(),
        isDemo: true,
      },
    });
    console.log(`[demo] ✓ ${q.title.slice(0, 26)} → ${(data.llmScores || []).length} 条评分 / ${(data.improvements || []).length} 条改进`);
  } catch (err) {
    console.warn(`[demo] ✗ ${q.title.slice(0, 26)}：${err.message}`);
  }
}

// 规则层诊断在前端跑（确定性、零成本），这里只存模型层结果
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      note: '离线演示保底包：预跑的真实复盘结果，断网/模型不可用时使用',
      reports: out,
    },
    null,
    2
  ),
  'utf8'
);
console.log(`[demo] 写出 ${OUT}（${out.length} 条）`);
