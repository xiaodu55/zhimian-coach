import test from 'node:test';
import assert from 'node:assert/strict';

import { runDeterministicRules } from '../../web/js/rules/diagnose.js';
import { parseTranscriptToQA } from '../../web/js/capture/transcript.js';
import { mergeTracks, toTranscriptText } from '../../web/js/capture/align.js';
import { validateStructuredClaims } from '../src/lib/citations.ts';
import { assessText, normalizeCjkSpacing, QUALITY_THRESHOLD } from '../src/lib/pdf/quality.ts';

const ctx = { keywords: ['架构', '高并发', '系统'], expectedLength: [10, 400] };

test('R• 缺量化：无数字时命中 no_metric，且给出原话区间', () => {
  const findings = runDeterministicRules('我认为这套架构非常稳定，能够应对高并发场景。', ctx);
  const hit = findings.find((f) => f.ruleId === 'no_metric');
  assert.ok(hit, '应命中 no_metric');
  assert.equal(hit.range[0], 0);
  assert.ok(hit.range[1] > 0);
});

test('R• 我们多于我：命中 we_not_i', () => {
  const findings = runDeterministicRules('我们团队做了这个系统，后来我们又优化了一次。', ctx);
  assert.ok(findings.some((f) => f.ruleId === 'we_not_i'));
});

test('R• 有数字有基线时不报 no_metric / metric_no_baseline', () => {
  const answer = '上线后错误率从千分之十降到千分之三，相比灰度前下降了 70%。';
  const ids = runDeterministicRules(answer, ctx).map((f) => f.ruleId);
  assert.ok(!ids.includes('no_metric'));
  assert.ok(!ids.includes('metric_no_baseline'));
});

test('转写解析：带说话人标签切出 Q&A', () => {
  const pairs = parseTranscriptToQA('面试官：为什么用 WAL？\n我：为了保证崩溃恢复时不丢数据。');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, '为什么用 WAL？');
  assert.equal(pairs[0].answer, '为了保证崩溃恢复时不丢数据。');
});

test('转写解析：容忍行首时间戳（本地 whisper 输出格式）', () => {
  const pairs = parseTranscriptToQA('[00:02] 面试官：请先做个自我介绍\n[00:05] 我：我做过一个校园二手平台');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, '请先做个自我介绍');
  assert.equal(pairs[0].answer, '我做过一个校园二手平台');
});

test('双轨对齐：按时间排序并合并同人相邻句', () => {
  const mic = [
    { start: 5, end: 7, text: '我负责后端' },
    { start: 7.2, end: 9, text: '主要解决并发下单问题' },
  ];
  const sys = [{ start: 1, end: 3, text: '先做个自我介绍' }];
  const merged = mergeTracks(mic, sys);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].speaker, 'interviewer');
  assert.equal(merged[1].speaker, 'me');
  assert.ok(merged[1].text.includes('我负责后端') && merged[1].text.includes('并发下单'));
  // 默认带时间戳；关掉时间戳时可直接被解析器吃（面试官：/我：）
  assert.match(toTranscriptText(merged), /^\[00:01\] 面试官：/);
  assert.match(toTranscriptText(merged, { withTime: false }), /^面试官：/);
});

test('引用校验：越界/缺引用/推断无理由一律丢弃并计数', () => {
  const valid = new Set(['S1', 'S2']);
  const { accepted, droppedByValidator } = validateStructuredClaims(
    [
      { claim: '有依据', basis: '外部佐证', refIds: ['S1'] },
      { claim: '越界引用', basis: '外部佐证', refIds: ['S9'] },
      { claim: '没有引用', basis: '外部佐证', refIds: [] },
      { claim: '推断但没理由', basis: '推断', refIds: [] },
      { claim: '推断有理由', basis: '推断', refIds: [], inferenceReason: '由 S1/S2 推得' },
    ],
    valid
  );
  assert.equal(accepted.length, 2);
  assert.equal(droppedByValidator, 3);
});

test('PDF 文本质量：汉字间空格会被归一化（pdf.js 常见瑕疵）', () => {
  const raw = 'AI 应 用 工 程 师 ， 熟 悉 A g e n t 治 理';
  const fixed = normalizeCjkSpacing(raw);
  assert.ok(!/[\u4e00-\u9fa5] [\u4e00-\u9fa5]/.test(fixed), `仍有汉字间空格: ${fixed}`);
  assert.match(fixed, /AI 应用工程师/);
});

test('PDF 文本质量：纯图片 PDF（几乎无文本）判为不达标', () => {
  const q = assessText('');
  assert.ok(q.score < QUALITY_THRESHOLD);
  assert.ok(q.issues.some((i) => i.includes('扫描件')));
});

test('PDF 文本质量：正常中文文本判为达标且无 issue', () => {
  const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：候选人负责后端服务，把失败率从千分之十降到千分之三。`).join('\n');
  const q = assessText(text);
  assert.ok(q.score >= QUALITY_THRESHOLD, `score=${q.score} issues=${q.issues.join(',')}`);
  assert.equal(q.issues.length, 0);
});

test('PDF 文本质量：大量乱码字符会拉低分数', () => {
  const q = assessText('正常内容'.repeat(20) + '\uFFFD'.repeat(40));
  assert.ok(q.score < QUALITY_THRESHOLD);
  assert.ok(q.issues.some((i) => i.includes('乱码')));
});
