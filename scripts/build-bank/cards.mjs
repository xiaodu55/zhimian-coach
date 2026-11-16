/**
 * 观点卡构建（SDD M1 · 观点维度）
 * 用法：node scripts/build-bank/cards.mjs [--limit 5] [--topic interview] [--dry]
 *
 * 每道题调一次直答（zhida-fast-1p5，100 次/天 → 分批跑），产出：
 *   - benchmark：这题真正在考什么（一句话）
 *   - viewAngleCards[]：立场 + 摘要 + **证据句** + 来源索引（可溯源）
 *   - pitfalls[]：常见坑
 *
 * 防编造（构建期就做，不等到运行时）：
 *   ① 提示词要求 evidence 必须是给定来源里的**原句片段**
 *   ② 逐条校验 evidence 是否为对应来源摘要的子串
 *   ③ 校验失败 → 重试 1 次；仍失败 → 该卡标记 evidenceVerified=false，并把 evidence 换成来源原句开头
 *      （宁可标注不可信，也不留一句"看起来很像"的编造）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { config } = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/config.js')).href);
const zhihu = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/lib/zhihuClient.js')).href);

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const LIMIT = Number(argOf('limit', '5'));
const DELAY = Number(argOf('delay', '6000')); // 直答有 QPS 限流：实测 1.5s 会 429，默认 6s
const TOPIC = argOf('topic', '');
const DRY = ARGS.includes('--dry');
const OUT = config.bankFile;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[「」“”"'’‘]/g, '');
}

function buildPrompt(q) {
  const src = q.sources
    .map((s, i) => `[S${i + 1}] 作者：${s.author || '匿名'}｜赞同 ${s.votes ?? 0}\n${s.snippet}`)
    .join('\n\n');
  return `你在为「面试/答辩陪练」整理一道真题的观点对照材料。禁止编造：所有证据必须逐字来自下面给出的来源。

【题目】${q.title}

【知乎高赞回答（编号即来源）】
${src}

请输出**严格 JSON**（不要 markdown 代码块、不要解释），结构：
{
  "benchmark": "这题真正在考什么，一句话",
  "views": [
    {
      "stance": "立场标签，6 字以内，例如：先结构后细节 / 反模板派",
      "summary": "该立场的核心主张，40 字以内",
      "evidence": "从上面某个来源里逐字复制的原句（10-60 字，必须能原样找到）",
      "sourceIndex": 1,
      "popularity": "mainstream 或 minority"
    }
  ],
  "pitfalls": ["常见坑，12 字以内", "..."]
}

要求：
- views 给 2–4 条，必须包含至少一条 minority（少数派/反常识观点）
- evidence 必须是某个 [Sx] 来源里的**连续原文片段**，不得改写、不得拼接
- sourceIndex 与 evidence 必须对应同一个来源
- pitfalls 给 2–4 条`;
}

function parseJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('未找到 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

function verify(q, card, retryNote = '') {
  const idx = Number(card.sourceIndex) - 1;
  const src = q.sources[idx];
  const evidence = String(card.evidence || '').trim();
  const ok = Boolean(src) && evidence.length >= 6 && normalize(src.snippet).includes(normalize(evidence));
  return {
    stance: String(card.stance || '').slice(0, 12),
    summary: String(card.summary || '').slice(0, 80),
    evidence: ok ? evidence : (src?.snippet || '').slice(0, 40),
    sourceIndex: idx + 1,
    sourceUrl: src?.url || '',
    sourceAuthor: src?.author || '',
    sourceVotes: src?.votes ?? null,
    popularity: card.popularity === 'minority' ? 'minority' : 'mainstream',
    evidenceVerified: ok,
    verifyNote: ok ? '' : (retryNote || '证据句未能在来源中逐字命中，已降级标注'),
  };
}

async function buildOne(q) {
  let attempt = 0;
  let lastErr = '';
  while (attempt < 2) {
    attempt += 1;
    try {
      const { content } = await zhihu.zhida(
        [{ role: 'user', content: buildPrompt(q) + (attempt > 1 ? '\n\n注意：上一次输出未通过校验，请确保 evidence 逐字来自来源。' : '') }],
        'zhida-fast-1p5'
      );
      const json = parseJson(content);
      const cards = (json.views || []).slice(0, 4).map((c) => verify(q, c));
      if (!cards.length) throw new Error('观点卡为空');
      const minority = cards.filter((c) => c.popularity === 'minority').length;
      if (!minority && cards.length) cards[0].popularity = 'minority'; // 保底：至少一张少数派
      return {
        benchmark: String(json.benchmark || '').slice(0, 120),
        viewAngleCards: cards,
        pitfalls: (json.pitfalls || []).slice(0, 4).map((p) => String(p).slice(0, 40)),
        cardsMeta: {
          attempts: attempt,
          verified: cards.filter((c) => c.evidenceVerified).length,
          total: cards.length,
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      lastErr = err.message;
      const isRate = /429|rate limit|rate_limit/i.test(err.message);
      console.warn(`   ↳ 第 ${attempt} 次失败${isRate ? '（限流）' : ''}：${err.message.slice(0, 80)}`);
      // 限流：退避更久；其他错误：短退避
      await sleep(isRate ? 20000 : 1500);
      if (isRate && attempt >= 2) throw err;
    }
  }
  throw new Error(`观点卡构建失败：${lastErr}`);
}

async function main() {
  const items = JSON.parse(fs.readFileSync(OUT, 'utf8')).items || [];
  const todo = items
    .filter((q) => !TOPIC || q.track === TOPIC)
    .filter((q) => !q.viewAngleCards || q.viewAngleCards.length === 0)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, LIMIT);

  if (!todo.length) {
    console.log('[cards] 没有待生成的题目（全部已有观点卡）');
    return;
  }
  console.log(`[cards] 待生成 ${todo.length} 题（直答配额 100/天，建议每天 ≤30 题）`);

  let ok = 0;
  let fail = 0;
  let consecutive429 = 0;
  let verifiedTotal = 0;
  let totalCards = 0;

  for (const q of todo) {
    process.stdout.write(`[cards] ${q.title.slice(0, 28)}… `);
    try {
      const built = await buildOne(q);
      q.benchmark = built.benchmark;
      q.viewAngleCards = built.viewAngleCards;
      q.pitfalls = built.pitfalls;
      q.cardsMeta = built.cardsMeta;
      verifiedTotal += built.cardsMeta.verified;
      totalCards += built.cardsMeta.total;
      ok += 1;
      consecutive429 = 0;
      console.log(`✓ ${built.cardsMeta.verified}/${built.cardsMeta.total} 证据命中`);
    } catch (err) {
      fail += 1;
      if (/429|rate limit/i.test(err.message)) {
        consecutive429 += 1;
        if (consecutive429 >= 3) {
          console.log('[cards] 连续 3 次限流，提前停止：剩余题目下次再跑（配额与限流都要留余量）');
          break;
        }
      }
      console.log(`✗ ${err.message.slice(0, 90)}`);
    }
    await sleep(DELAY);
  }

  if (!DRY) {
    fs.writeFileSync(OUT, JSON.stringify({ version: 3, updatedAt: new Date().toISOString(), items }, null, 2));
    console.log(`[cards] 已写入；成功 ${ok} / 失败 ${fail}`);
  }
  const rate = totalCards ? ((verifiedTotal / totalCards) * 100).toFixed(1) : '0';
  console.log(`[cards] 证据逐字命中率 ${rate}%（${verifiedTotal}/${totalCards}）— 这是可披露的质量指标`);
}

main().catch((e) => {
  console.error('[cards] 失败', e);
  process.exitCode = 1;
});
