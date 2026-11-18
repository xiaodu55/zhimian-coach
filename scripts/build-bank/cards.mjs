/**
 * 观点卡构建（自包含脚本）
 * 用法：node scripts/build-bank/cards.mjs [--limit 20] [--delay 7000] [--dry]
 *
 * 实测约束：
 *  - 直答（zhida-fast-1p5）有 QPS 限流：间隔 < 3s 会 429 → 默认 7s + 429 退避 20s + 连续 3 次熔断
 *  - 每张卡的 evidence 必须逐字来自来源摘要，否则重试一次后标 evidenceVerified=false
 *  - 知乎开发者 API 只返回 {ContentType,ContentToken,Url,Summary}：没有作者、没有赞同数。
 *    所以不要写「高赞回答」，也不要在文案里暗示热度；author 留空、votes 为 null。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data-raw-bank.json');

function loadEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ENV = loadEnv();
const SECRET = ENV.ZHIHU_ACCESS_SECRET;
if (!SECRET) {
  console.error('✗ .env 缺少 ZHIHU_ACCESS_SECRET');
  process.exit(1);
}

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const LIMIT = Number(argOf('limit', '20'));
const DELAY = Number(argOf('delay', '7000'));
const DRY = ARGS.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function zhida(prompt, model = 'zhida-fast-1p5') {
  const res = await fetch('https://developer.zhihu.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  if (res.status === 429) throw Object.assign(new Error('rate limit'), { code: 'RATE' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`), { code: 'UPSTREAM' });
  const j = JSON.parse(text);
  return j?.choices?.[0]?.message?.content || '';
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[「」“”"'’‘]/g, '');

function buildPrompt(q) {
  const src = (q.sources || [])
    .map((s, i) => `[S${i + 1}] 作者：${s.author || '匿名'}\n${s.snippet}`)
    .join('\n\n');
  return `你在为「面试/答辩陪练」整理一道真题的观点对照材料。禁止编造：所有证据必须逐字来自下面给出的来源。

【题目】${q.title}

【知乎来源回答（编号即来源）】
${src}

输出**严格 JSON**（不要 markdown 代码块、不要解释）：
{
  "benchmark": "这题真正在考什么，一句话",
  "views": [
    {"stance":"立场标签，6 字以内","summary":"该立场核心主张，40 字以内",
     "evidence":"从某个来源逐字复制的原句（10-60 字）","sourceIndex":1,
     "popularity":"mainstream 或 minority"}
  ],
  "pitfalls": ["常见坑，12 字以内"]
}

要求：views 2–4 条，至少一条 minority；evidence 必须是 [Sx] 来源里的连续原文片段，不得改写。`;
}

function parseJson(text) {
  const raw = String(text || '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('未找到 JSON');
  return JSON.parse(raw.slice(s, e + 1));
}

function verifyCard(q, c) {
  const idx = Number(c.sourceIndex) - 1;
  const src = (q.sources || [])[idx];
  const evidence = String(c.evidence || '').trim();
  const ok = Boolean(src) && evidence.length >= 6 && norm(src.snippet).includes(norm(evidence));
  return {
    stance: String(c.stance || '').slice(0, 12),
    summary: String(c.summary || '').slice(0, 80),
    evidence: ok ? evidence : String(src?.snippet || '').slice(0, 40),
    sourceIndex: idx + 1,
    sourceUrl: src?.url || '',
    sourceAuthor: src?.author || '',
    sourceVotes: src?.votes ?? null, // API 没有该字段时就是 null，不编造
    popularity: c.popularity === 'minority' ? 'minority' : 'mainstream',
    evidenceVerified: ok,
  };
}

async function buildOne(q) {
  let attempt = 0;
  let lastErr = '';
  while (attempt < 2) {
    attempt += 1;
    try {
      const content = await zhida(buildPrompt(q) + (attempt > 1 ? '\n注意：上次未通过校验，evidence 必须逐字取自来源。' : ''));
      const json = parseJson(content);
      const cards = (json.views || []).slice(0, 4).map((c) => verifyCard(q, c));
      if (!cards.length) throw new Error('观点卡为空');
      if (!cards.some((c) => c.popularity === 'minority')) cards[cards.length - 1].popularity = 'minority';
      return {
        benchmark: String(json.benchmark || '').slice(0, 120),
        viewAngleCards: cards,
        pitfalls: (json.pitfalls || []).slice(0, 4).map((p) => String(p).slice(0, 40)),
        cardsMeta: { attempts: attempt, verified: cards.filter((c) => c.evidenceVerified).length, total: cards.length },
      };
    } catch (err) {
      lastErr = err.message;
      const rate = /429|rate limit/i.test(err.message);
      console.warn(`   ↳ 第 ${attempt} 次失败${rate ? '（限流）' : ''}：${err.message.slice(0, 60)}`);
      await sleep(rate ? 20000 : 1500);
      if (rate && attempt >= 2) throw err;
    }
  }
  throw new Error(lastErr);
}

async function main() {
  const list = JSON.parse(fs.readFileSync(RAW, 'utf8')).items || [];
  const todo = list
    .filter((q) => !(q.viewAngleCards || []).length)
    .sort((a, b) => (b.sources?.length || 0) - (a.sources?.length || 0))
    .slice(0, LIMIT);

  if (!todo.length) {
    console.log('[cards] 没有待生成的题目');
    return;
  }
  console.log(`[cards] 待生成 ${todo.length} 题，间隔 ${DELAY}ms（直答有 QPS 限流）`);

  let ok = 0;
  let fail = 0;
  let verified = 0;
  let total = 0;
  let consecutiveRate = 0;

  for (const q of todo) {
    process.stdout.write(`[cards] ${q.title.slice(0, 26)}… `);
    try {
      const built = await buildOne(q);
      q.benchmark = built.benchmark;
      q.viewAngleCards = built.viewAngleCards;
      q.pitfalls = built.pitfalls;
      q.cardsMeta = built.cardsMeta;
      verified += built.cardsMeta.verified;
      total += built.cardsMeta.total;
      ok += 1;
      consecutiveRate = 0;
      console.log(`✓ ${built.cardsMeta.verified}/${built.cardsMeta.total}`);
    } catch (err) {
      fail += 1;
      if (/429|rate limit/i.test(err.message)) {
        consecutiveRate += 1;
        if (consecutiveRate >= 3) {
          console.log('[cards] 连续限流 3 次，提前停止（明天再跑剩余）');
          break;
        }
      }
      console.log(`✗ ${err.message.slice(0, 70)}`);
    }
    await sleep(DELAY);
  }

  if (!DRY) fs.writeFileSync(RAW, JSON.stringify({ version: 3, updatedAt: new Date().toISOString(), items: list }, null, 2));
  const rate = total ? ((verified / total) * 100).toFixed(1) : '0';
  console.log(`\n[cards] 成功 ${ok} / 失败 ${fail}；证据逐字命中率 ${rate}%（${verified}/${total}）`);
}

main().catch((e) => {
  console.error('[cards] 失败', e);
  process.exit(1);
});
