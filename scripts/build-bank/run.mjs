/**
 * 离线题库跑批 v0.2（SDD M1）
 * 用法：node scripts/build-bank/run.mjs [--query "关键词"] [--count 10] [--dry] [--reset]
 *
 * 关键设计（v0.2 修正）：
 *  - **按"问题"聚合，不按"回答"平铺**：同题的热门回答/文章收进 sources[]，一条题 = 一个可练的问题
 *  - 去重键优先 contentId，其次规范化标题（去掉 " - 知乎" 后缀）
 *  - 过滤低质：正文 < 80 字丢弃；votes=0 且 authority<3 的丢弃
 *  - 断点续跑：默认合并已有题库；--reset 先清空
 *  - 严格限速：串行 + 1000ms 间隔（配额保护，SDD §8.2）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const { config } = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/config.js')).href);
const zhihu = await import(
  pathToFileURL(path.join(ROOT, 'apps/bff/src/lib/zhihuClient.js')).href
);

const ARGS = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};
const DRY = ARGS.includes('--dry');
const RESET = ARGS.includes('--reset');
const OUT_FILE = config.bankFile;

const SEED_QUERIES = [
  ['面试 自我介绍 没准备', 'interview'],
  ['大厂 面试 追问 答不上来', 'interview'],
  ['面试 项目 没有亮点 怎么讲', 'interview'],
  ['面试 挂了 复盘 原因', 'interview'],
  ['面试 反问 面试官 问题', 'interview'],
  ['毕业答辩 评委 提问 怎么回答', 'defense'],
  ['论文答辩 会问什么问题 准备', 'defense'],
  ['项目 答辩 被问住 怎么办', 'defense'],
  ['答辩 PPT 讲不清 逻辑', 'defense'],
  ['竞赛 答辩 评委 质疑', 'defense'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 规范标题：去掉知乎后缀与多余空白，作为聚合同题的主键 */
function normTitle(t) {
  return String(t || '')
    .replace(/\s*-\s*知乎\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadBank() {
  try {
    const raw = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
}

function saveBank(items) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), items }, null, 2)
  );
}

function sourceKey(r) {
  return r.contentId || r.url;
}

async function main() {
  const extra = argOf('query', null);
  const queries = (extra ? [[extra, 'interview']] : []).concat(SEED_QUERIES);
  const count = Number(argOf('count', '10'));

  if (!config.zhihuSecret) {
    console.error('✗ 未配置 ZHIHU_ACCESS_SECRET：请先在 .env 填写（不要贴到对话里）');
    process.exitCode = 1;
    return;
  }

  const questions = RESET ? [] : loadBank();
  /** @type {Map<string, any>} */
  const byTitle = new Map(questions.map((q) => [q.normTitle || q.title, q]));
  const seenSources = new Set();
  for (const q of questions) for (const s of q.sources || []) seenSources.add(s.contentId || s.url);

  console.log(
    `[bank] ${queries.length} 组关键词 × ${count} 条 | 已有 ${questions.length} 题 | ${DRY ? 'dry-run' : '写入'}${RESET ? ' | 已重置' : ''}`
  );

  let apiCalls = 0;
  let addedSources = 0;

  for (const [q, track] of queries) {
    let results = [];
    try {
      results = await zhihu.search('zhihu', q, count);
      apiCalls += 1;
      console.log(`[search] "${q}" → ${results.length} 条 (${track})`);
    } catch (err) {
      console.warn(`[search] "${q}" 失败：${err.code || ''} ${err.message}`);
      if (err.code === 'ZH_QUOTA_EXHAUSTED') break;
      continue;
    }
    await sleep(1000);

    for (const r of results) {
      const text = (r.text || '').trim();
      if (text.length < 80) continue; // 过短：不是可用的解释性内容
      const votes = Number(r.votes) || 0;
      const authority = Number(r.authority) || 0;
      if (votes === 0 && authority < 3) continue; // 低质过滤

      const key = sourceKey(r);
      if (seenSources.has(key)) continue;
      seenSources.add(key);

      const title = normTitle(r.title);
      if (!title) continue;

      let q1 = byTitle.get(title);
      if (!q1) {
        q1 = {
          id: `q_${questions.length + 1}`,
          title,
          normTitle: title,
          track,
          tags: q.split(/\s+/).filter(Boolean),
          difficulty: 2,
          heat: 0,
          seedQueries: [q],
          sources: [],
          viewAngleCards: [], // 下一步用直答生成（100 次/天，分批）
          benchmarkAnswer: '',
          createdAt: new Date().toISOString(),
        };
        byTitle.set(title, q1);
        questions.push(q1);
      }
      q1.sources.push({
        url: r.url,
        author: r.author,
        votes,
        comments: r.comments ?? 0,
        authority,
        contentType: r.contentType || '',
        contentId: r.contentId || '',
        snippet: text.slice(0, 400),
      });
      q1.heat += votes + authority * 5;
      if (!q1.seedQueries.includes(q)) q1.seedQueries.push(q);
      addedSources += 1;
    }
  }

  // 每题来源按赞数排序，保留前 5 条最有说服力的
  for (const q of questions) {
    q.sources.sort((a, b) => b.votes - a.votes || b.authority - a.authority);
    q.sources = q.sources.slice(0, 5);
  }
  // 只保留有来源的题，按热度降序重编号
  const kept = questions
    .filter((q) => (q.sources || []).length > 0)
    .sort((a, b) => b.heat - a.heat)
    .map((q, i) => ({ ...q, id: `q_${i + 1}` }));

  const withCards = kept.filter((q) => (q.viewAngleCards || []).length > 0).length;
  console.log(
    `[bank] 新增来源 ${addedSources} 条 → 合计 ${kept.length} 题（其中已生成观点卡 ${withCards} 题），消耗检索配额约 ${apiCalls} 次`
  );
  console.log(
    `[bank] 题型分布：${JSON.stringify(
      kept.reduce((acc, q) => ((acc[q.track] = (acc[q.track] || 0) + 1), acc), {})
    )}`
  );

  if (DRY) {
    console.log('[bank] dry-run：不写文件');
    return;
  }
  saveBank(kept);
  console.log(`[bank] 已写入 ${OUT_FILE}`);
  console.log('[bank] 下一步：node scripts/build-bank/cards.mjs 生成观点卡（直答 100 次/天，分批跑）');
}

main().catch((err) => {
  console.error('[bank] 失败：', err);
  process.exitCode = 1;
});
