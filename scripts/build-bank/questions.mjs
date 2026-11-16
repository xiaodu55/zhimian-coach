/**
 * 真题库构建（SDD M1 · 问题维度）
 * 用法：node scripts/build-bank/questions.mjs [--limit 20] [--reset] [--dry]
 *
 * 语义修正（关键）：练习单元必须是**知乎问题**，不是文章标题。
 *   ① question_recommendations → 拿到真人问题（Title + Url）
 *   ② question_answers        → 拿到该问题下的高赞回答摘要（可溯源）
 * 配额：问题推荐 100/天、回答摘要 100/天 → 每天最多稳定构建约 30–40 题，分两三天跑满。
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
const LIMIT = Number(argOf('limit', '20'));
const RESET = ARGS.includes('--reset');
const DRY = ARGS.includes('--dry');
const OUT = config.bankFile;

const WHITELIST = ['面试','答辩','简历','offer','求职','秋招','实习','岗位','技术面','HR','背调','跳槽','转行','论文','评委','课题','毕业','自我介绍','追问','复盘'];
const BLACKLIST = ['赚','副业','创业项目','推荐项目','存款','理财','带货','开店','加盟','P图','彩票'];

const TOPICS = [
  ['面试 自我介绍', 'interview'],
  ['面试 项目经历 讲不清', 'interview'],
  ['面试 被追问 答不上来', 'interview'],
  ['面试 为什么离职 跳槽', 'interview'],
  ['秋招 面试 复盘', 'interview'],
  ['论文答辩 评委提问', 'defense'],
  ['毕业答辩 准备 注意事项', 'defense'],
  ['项目答辩 被质疑', 'defense'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
};
const save = (items) =>
  fs.writeFileSync(OUT, JSON.stringify({ version: 3, updatedAt: new Date().toISOString(), items }, null, 2));

async function main() {
  if (!config.zhihuSecret) {
    console.error('✗ 未配置 ZHIHU_ACCESS_SECRET');
    process.exitCode = 1;
    return;
  }
  const items = RESET ? [] : load();
  const seenQ = new Set(items.map((q) => q.questionUrl));
  let added = 0;
  let recCalls = 0;
  let ansCalls = 0;

  for (const [topic, track] of TOPICS) {
    if (added >= LIMIT) break;
    let questions = [];
    try {
      questions = await zhihu.questionRecommendations(topic, 5);
      recCalls += 1;
      console.log(`[rec] "${topic}" → ${questions.length} 问`);
    } catch (err) {
      console.warn(`[rec] "${topic}" 失败：${err.code || ''} ${err.message}`);
      continue;
    }
    await sleep(600);

    for (const q of questions) {
      if (added >= LIMIT) break;
      if (!q.url || seenQ.has(q.url)) continue;
      const title = q.title || '';
      if (title.length < 8) { console.log(`[skip] 标题过短：${title}`); continue; }
      if (BLACKLIST.some((w) => title.includes(w))) { console.log(`[skip] 命中黑名单：${title.slice(0, 24)}…`); continue; }
      if (!WHITELIST.some((w) => title.includes(w))) { console.log(`[skip] 非面试/答辩题：${title.slice(0, 24)}…`); continue; }

      let answers;
      try {
        answers = await zhihu.questionAnswers(q.url, 6);
        ansCalls += 1;
      } catch (err) {
        console.warn(`[ans] ${q.title.slice(0, 20)}… 失败：${err.code || ''} ${err.message}`);
        if (err.code === 'ZH_QUOTA_EXHAUSTED') break;
        continue;
      }
      await sleep(600);

      const sources = (answers.items || [])
        .filter((a) => (a.summary || '').trim().length >= 80)
        .slice(0, 5)
        .map((a) => ({
          url: a.url,
          token: a.token,
          author: a.author,
          votes: a.votes,
          snippet: a.summary.slice(0, 500),
        }));
      if (sources.length < 2) {
        console.log(`[skip] 回答不足 2 条：${q.title.slice(0, 24)}…`);
        continue;
      }

      seenQ.add(q.url);
      items.push({
        id: `q_${items.length + 1}`,
        title: q.title,
        questionUrl: q.url,
        track,
        topic,
        // 注意：question_answers 接口不返回赞同数/作者名，热度用来源条数近似（不虚报点赞）
        heat: sources.length,
        sources,
        viewAngleCards: [],
        benchmark: '',
        pitfalls: [],
        createdAt: new Date().toISOString(),
      });
      added += 1;
      console.log(`[+q] ${q.title.slice(0, 30)}… (${sources.length} 条回答)`);
    }
  }

  if (!DRY) save(items);
  console.log(
    `\n[questions] 新增 ${added} 题，合计 ${items.length} 题；配额消耗：推荐 ${recCalls} 次、回答 ${ansCalls} 次`
  );
  console.log('[questions] 下一步：node scripts/build-bank/cards.mjs --limit 5 生成观点卡');
}

main().catch((e) => {
  console.error('[questions] 失败', e);
  process.exitCode = 1;
});
