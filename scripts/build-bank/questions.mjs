/**
 * 真题构建（自包含脚本，不依赖 BFF 源码，避免后端重构把跑批带崩）
 * 用法：node scripts/build-bank/questions.mjs [--limit 15] [--reset] [--dry]
 *
 * 配额现实（实测）：question_discovery 共享 100/天，推荐与回答摘要都从这里扣。
 * 一个题 = 1 次推荐 + 1 次回答 → 每天最多约 30–40 题，用完就停。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data-raw-bank.json');

// ---- env ----
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
const LIMIT = Number(argOf('limit', '15'));
const REQUIRE = argOf('require', ''); // 例：--require '答辩|评委|论文'
const RESET = ARGS.includes('--reset');
const DRY = ARGS.includes('--dry');

const H = () => ({
  Authorization: `Bearer ${SECRET}`,
  'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(pathname, params = {}) {
  const url = new URL('https://developer.zhihu.com' + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: H() });
  const text = await res.text();
  if (res.status === 429) throw Object.assign(new Error('配额或频率限制'), { code: 'QUOTA' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`), { code: 'UPSTREAM' });
  return JSON.parse(text);
}

function items(payload) {
  const b = payload?.Data ?? payload?.data ?? payload;
  for (const k of ['Items', 'items', 'List', 'list']) if (Array.isArray(b?.[k])) return b[k];
  return [];
}

const TOPICS = [
  ['面试 自我介绍 怎么答', 'interview'],
  ['面试 项目经历 讲不清', 'interview'],
  ['面试 被追问 答不上来', 'interview'],
  ['面试 为什么离职', 'interview'],
  ['秋招 面试 复盘', 'interview'],
  ['offer 选择 怎么判断', 'interview'],
  ['论文答辩 评委 提问', 'defense'],
  ['毕业答辩 准备', 'defense'],
  ['项目答辩 被质疑', 'defense'],
  ['答辩 PPT 逻辑', 'defense'],
];

const WHITELIST = ['面试', '答辩', '简历', 'offer', '求职', '秋招', '实习', '岗位', 'HR', '跳槽', '转行', '论文', '评委', '毕业', '自我介绍', '追问', '复盘'];
const BLACKLIST = ['赚', '副业', '创业项目', '推荐项目', '存款', '理财', '带货', '开店', '加盟', '彩票'];

function load() {
  if (!fs.existsSync(RAW)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(RAW, 'utf8'));
    return Array.isArray(j) ? j : (j.items ?? []);
  } catch {
    return [];
  }
}
function save(list) {
  fs.writeFileSync(
    RAW,
    JSON.stringify({ version: 3, updatedAt: new Date().toISOString(), items: list }, null, 2)
  );
}

async function main() {
  const list = RESET ? [] : load();
  const seen = new Set(list.map((q) => q.questionUrl));
  let added = 0;
  let recCalls = 0;
  let ansCalls = 0;

  console.log(`[questions] 已有 ${list.length} 题，目标新增 ${LIMIT} 题`);

  outer: for (const [topic, track] of TOPICS) {
    if (added >= LIMIT) break;
    let qs = [];
    try {
      const payload = await get('/api/v1/user/question_recommendations', { Query: topic, Count: 5 });
      recCalls += 1;
      qs = items(payload).map((x) => ({ title: x.Title || '', url: String(x.Url || '').split('?')[0] }));
      console.log(`[rec] "${topic}" → ${qs.length}`);
    } catch (err) {
      console.warn(`[rec] "${topic}" 失败：${err.code} ${err.message}`);
      if (err.code === 'QUOTA') break outer;
      continue;
    }
    await sleep(1200);

    for (const q of qs) {
      if (added >= LIMIT) break outer;
      if (!q.url || seen.has(q.url)) continue;
      if (q.title.length < 8) continue;
      if (BLACKLIST.some((w) => q.title.includes(w))) continue;
      if (!WHITELIST.some((w) => q.title.includes(w))) continue;
      if (REQUIRE && !new RegExp(REQUIRE).test(q.title)) continue;

      let ans = [];
      try {
        const payload = await get('/api/v1/content/question_answers', {
          QuestionUrl: q.url,
          Offset: 0,
          Limit: 6,
        });
        ansCalls += 1;
        ans = items(payload);
      } catch (err) {
        console.warn(`[ans] 失败：${err.code} ${err.message}`);
        if (err.code === 'QUOTA') break outer;
        continue;
      }
      await sleep(1200);

      const sources = ans
        .map((a) => ({
          url: a.Url || '',
          token: a.ContentToken || '',
          author: a.AuthorName || '',
          votes: a.VoteUpCount ?? null,
          snippet: String(a.Summary || a.ContentText || '').slice(0, 500),
        }))
        .filter((a) => a.url && a.snippet.length >= 80)
        .slice(0, 5);

      if (sources.length < 2) {
        console.log(`[skip] 回答不足 2 条：${q.title.slice(0, 24)}…`);
        continue;
      }

      seen.add(q.url);
      list.push({
        id: `q_${list.length + 1}`,
        title: q.title,
        questionUrl: q.url,
        track,
        topic,
        heat: sources.length,
        sources,
        viewAngleCards: [],
        benchmark: '',
        pitfalls: [],
        createdAt: new Date().toISOString(),
      });
      added += 1;
      console.log(`[+q] ${q.title.slice(0, 32)}… (${sources.length} 条回答)`);
    }
  }

  if (!DRY) save(list);
  console.log(
    `\n[questions] 新增 ${added} 题 → 合计 ${list.length} 题；配额消耗：推荐 ${recCalls}、回答 ${ansCalls}`
  );
  if (added === 0) console.log('[questions] 提示：可能是配额用尽（question_discovery 100/天），明天再跑或调小 --limit');
}

main().catch((e) => {
  console.error('[questions] 失败', e);
  process.exit(1);
});
