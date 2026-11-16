/**
 * 把「真实知乎跑批题库」转换成 v0.2 前端/后端约定的 schema
 * 用法：node scripts/build-bank/to-v02.mjs [--in data-raw-bank.json] [--out apps/web/data/question-bank.json]
 *
 * 输入（我方跑批产物）：{ version, items:[{id,title,questionUrl,track,heat,sources[],viewAngleCards[],benchmark,pitfalls[]}] }
 * 输出（v0.2 契约）：{ version, generatedAt, questions:[{id,track,difficulty,title,context,keywords,
 *                      expectedLength,skeleton,viewpointCards[]}], demoSampleTranscript:{questionId,rawText} }
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const IN = path.resolve(ROOT, argOf('in', 'data-raw-bank.json'));
const OUT = path.resolve(ROOT, argOf('out', 'apps/web/data/question-bank.json'));

const TRACK_LABEL = { interview: '面试通用', defense: '论文/答辩' };
const DIFFICULTY = { 1: '基础', 2: '进阶', 3: '高阶' };

/** 从标题里抽二元组关键词（无分词器的稳妥做法），并补上观点立场词 */
function keywordsOf(item) {
  const out = new Set();
  for (const w of item.tags || []) if (w && w.length >= 2) out.add(w);
  for (const v of item.viewAngleCards || []) if (v.stance) out.add(v.stance);
  const title = String(item.title || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');
  for (let i = 0; i < title.length - 1 && out.size < 12; i += 1) {
    const bi = title.slice(i, i + 2);
    if (!/^(什么|怎么|如何|为什|是否|哪些|可以|我们|你们)/.test(bi)) out.add(bi);
  }
  return [...out].slice(0, 10);
}

function skeletonOf(item) {
  const base = [
    '开口先复述问题，确认你听到的是同一件事',
    '给一个可核对数字（影响面 / 耗时 / 覆盖率）并说明口径与基线',
    item.track === 'defense' ? '说明方法与边界：什么条件下成立、什么条件下会翻车' : '说明你的判断与取舍：为什么这么做、还有什么选项',
    '收尾落到结果：变化了多少，谁验收过',
  ];
  for (const p of (item.pitfalls || []).slice(0, 2)) base.push(`注意避开：${p}`);
  return base;
}

function contextOf(item) {
  if (item.benchmark) return item.benchmark;
  const pits = (item.pitfalls || []).slice(0, 3).join(' / ');
  return pits ? `这道题真正在考：${pits}` : '考察能否在有分歧的问题上给出有依据、经得起追问的判断。';
}

function toCard(v, i, item) {
  return {
    id: `${item.id}-vp-${i + 1}`,
    stance: v.stance || '观点',
    summary: v.summary || '',
    evidenceQuote: v.evidence || '',
    sourceUrl: v.sourceUrl || '',
    author: v.sourceAuthor || '',
    upvotes: Number(v.sourceVotes) || 0,
    popularity: v.popularity === 'minority' ? '少数派' : '主流',
  };
}

/** 一键体验用的合成转写稿：故意含缺陷，保证规则层能命中 */
function demoTranscriptFor(item) {
  const rough = [
    '面试官：先简单介绍一下你在这道题上的真实经历吧。',
    '我：嗯，那个，我们团队之前做过类似的，我主要负责其中一块，就是做了一些优化，感觉效果还可以，后来也一直在迭代。',
    '面试官：具体说一下你做了什么判断，结果是多少？',
    '我：当时就是看别人这么做，我们也跟着做了，具体数字我不太记得了，反正比原来好一些。',
    '面试官：如果重做一次，你会怎么改？',
    '我：我会先把口径定清楚，比如把失败率从千分之十压到千分之三以内，然后写脚本复现问题，再决定方案。',
  ];
  return { questionId: item.id, rawText: rough.join('\n') };
}

function main() {
  if (!fs.existsSync(IN)) {
    console.error(`✗ 找不到输入：${IN}`);
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const items = Array.isArray(raw) ? raw : (raw.items ?? []);

  const questions = items
    .filter((it) => it.title)
    .map((it) => {
      const cards = (it.viewAngleCards || []).map((v, i) => toCard(v, i, it));
      return {
        id: it.id,
        track: TRACK_LABEL[it.track] || TRACK_LABEL.interview,
        difficulty: DIFFICULTY[it.difficulty] || '进阶',
        title: it.title,
        context: contextOf(it),
        keywords: keywordsOf(it),
        expectedLength: [150, 400],
        skeleton: skeletonOf(it),
        viewpointCards: cards,
        // 保真：原知乎问题链接与来源（前端不渲染也没关系，留作溯源）
        questionUrl: it.questionUrl || '',
        sources: (it.sources || []).map((s) => ({ url: s.url, author: s.author, votes: s.votes })),
      };
    })
    // 带观点卡的题排前面：首页一键体验与首屏都依赖观点卡
    .sort((a, b) => b.viewpointCards.length - a.viewpointCards.length);

  const demoQuestion = questions.find((q) => q.viewpointCards.length >= 2) || questions[0];
  const out = {
    version: '0.2.0-real',
    generatedAt: new Date().toISOString(),
    note: '真题来自知乎开放平台（question_recommendations + question_answers），观点卡由直答生成并逐字校验 evidence',
    questions,
    demoSampleTranscript: demoQuestion ? demoTranscriptFor(demoQuestion) : null,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const withCards = questions.filter((q) => q.viewpointCards.length).length;
  const verified = questions.reduce(
    (s, q) => s + q.viewpointCards.filter((c) => c.evidenceQuote).length,
    0
  );
  console.log(`[to-v02] 写入 ${OUT}`);
  console.log(`[to-v02] 题 ${questions.length}｜带观点卡 ${withCards}｜卡片 ${verified}｜体积 ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
  console.log(`[to-v02] 一键体验题目：${demoQuestion?.id} ${String(demoQuestion?.title || '').slice(0, 40)}`);
}

main();
