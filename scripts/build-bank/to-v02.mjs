/**
 * 把「真实知乎跑批题库」转换成 v0.2 前端/后端约定的 schema
 * 用法：node scripts/build-bank/to-v02.mjs [--in data-raw-bank.json] [--out apps/web/data/question-bank.json]
 *
 * 输入（我方跑批产物）：{ version, items:[{id,title,questionUrl,track,topic,domain,kind,heat,sources[],viewAngleCards[],benchmark,pitfalls[]}] }
 * 输出（v0.2 契约）：{ version, generatedAt, note, questions:[{id,track,domain,kind,difficulty,title,context,keywords,
 *                      expectedLength,skeleton,viewpointCards[],sources[]}], demoSampleTranscript:{questionId,rawText} }
 *
 * 三条硬约定（前端直接按字段筛，不要再用关键词正则猜）：
 *   domain   = ai-agent | rag | backend | algo-data | product | general | defense
 *   kind     = tech（技术/工程题，后端按技术维度评分）| soft（通用软素质题）
 *   difficulty= 基础 | 进阶 | 难
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

export const TRACK_LABEL = { interview: '面试通用', defense: '论文/答辩' };

/**
 * 老题（跑批之前抓的 53 道）没有 domain 字段，按标题定点归类：
 * 软素质题一律 general，答辩题一律 defense，只有这 3 道本身是技术/业务题。
 */
const LEGACY_DOMAIN = [
  ['面试 AI Agent 岗位时', 'ai-agent'],
  ['100杯水里', 'algo-data'],
  ['纳什均衡', 'algo-data'],
];

/** 通用常识型软素质题（沟通、离职原因、自我介绍…）默认难度是「基础」 */
const BASE_SOFT = /自我介绍|离职|跳槽|offer|简历|群面|笔试|紧张|焦虑|结巴|被拒|快��|轻松|吐槽|焦虑/;
/** 需要权衡/判断的软素质题，比「基础」高一档 */
const ADVANCED_SOFT = /权衡|判断.*核心|职业规划|规划|冲突|意见不合|如何选择|怎么选|比较|取舍|复盘|为什么.*失败|怎么回|如何回答|深挖|追问|反馈|偏见|潜力|翻盘/;

/**
 * 「难」的判据：题目要求落到架构级取舍或量化评估设计。
 * （系统设计、高并发、一致性、幂等、RAG 评测、权限治理……）
 */
const HARD_TECH =
  /系统设计|架构|高并发|并发|QPS|一致性|幂等|削峰|熔断|限流|降级|事务|分布式|缓存一致|慢查询|索引|监控|可观测|排查|链路追踪|评测|评估|评测集|基准|A\/B|AB测试|实验设计|对照组|消融|显著性|指标拆解|数据闭环|指标体系|特征工程|召回|重排|切分|切块|Chunk|向量|知识库|护栏|越权|幻觉|兜底|权限|沙箱|编排|多轮|稳定性|冷启动|效果评估|数据清洗|数据标注|搜索排序|推荐系统|精排|排序模型|特征|样本|治理|埋点|商业化|定价|付费转化|留存|增长|数据驱动|业务场景|落地/;

/** 「基础」的技术题：问的是概念/定义/区别，没有量化与基线要求 */
const BASE_TECH = /是什么|什么是|有哪些|定义|含义|区别|为什么是|入门|基础概念|怎么理解|如何理解|简单介绍|科普|了解|是不是/;
/** 「为什么这么设计」型原理题也属于基础（概念理解，不是架构取舍） */
const BASE_TECH_WHY = /为什么.*(设计|原理|区别|机制)/;

export const DOMAIN_LABEL = {
  'ai-agent': 'AI Agent / 工具调用',
  rag: 'RAG / 检索增强',
  backend: '后端与系统设计',
  'algo-data': '算法与数据',
  product: '产品与业务',
  general: '通用面试素养',
  defense: '论文与答辩',
};

/**
 * 软素质题限量（题库契约）：general 只保留 8–10 道，其余全部是技术题。
 * 原始抓取数据 data-raw-bank.json 保持完整（一条都不删），策展只发生在组装这一步，
 * 所以后面想扩题库，改这张清单就能把老软题放回去。
 * 保留清单覆盖契约要求的六类：自我介绍 / 离职原因 / offer 比较 / 沟通协作 / 职业规划 / 压力应对。
 */
const SOFT_KEEP = [
  '大厂员工吐槽新来的校招生', // 面试在选什么样的人
  '面试的时候，如何自我介绍', // 自我介绍
  '你手上还有其它 offer 吗', // offer 比较
  '当面试官问到「跳槽原因」时', // 离职原因
  '在职业生涯中，如何判断是否应该跳槽或离职', // 职业规划 / 取舍
  '如果与上级意见不合', // 沟通协作冲突
  '秋招结束还没拿到 offer', // 压力应对
  '面试中遇到面试官提问一些刁钻的', // 刁钻问题怎么回
  '秋招简历上的项目经历写参与还是负责', // 表达分寸
  '疯狂画大饼', // 谈条件 / 追问真实待遇',
];

/** 从标题里抽二元组关键词（无分词器的稳妥做法），并补上观点立场词 */
export function keywordsOf(item) {
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

export function skeletonOf(item) {
  const base = [
    '开口先复述问题，确认你听到的是同一件事',
    '给一个可核对数字（影响面 / 耗时 / 覆盖率）并说明口径与基线',
    item.domain === 'defense' ? '说明方法与边界：什么条件下成立、什么条件下会翻车' : '说明你的判断与取舍：为什么这么做、还有什么选项',
    '收尾落到结果：变化了多少，谁验收过',
  ];
  for (const p of (item.pitfalls || []).slice(0, 2)) base.push(`注意避开：${p}`);
  return base;
}

export function contextOf(item) {
  if (item.benchmark) return item.benchmark;
  const pits = (item.pitfalls || []).slice(0, 3).join(' / ');
  if (pits) return `这道题真正在考：${pits}`;
  return '考察能否在有分歧的问题上给出有依据、经得起追问的判断。';
}

export function toCard(v, i, item) {
  return {
    id: `${item.id}-vp-${i + 1}`,
    stance: v.stance || '观点',
    summary: v.summary || '',
    evidenceQuote: v.evidence || '',
    sourceUrl: v.sourceUrl || '',
    author: v.sourceAuthor || '',
    // 知乎开发者 API 只返回 {ContentType,ContentToken,Url,Summary}，没有作者与赞同数：
    // 这里固定为 0 / 空串：前端不得把它当成真实热度展示，也不要用「热门/高票」这类文案
    upvotes: 0,
    popularity: v.popularity === 'minority' ? '少数派' : '主流',
  };
}

/** 题目方向：raw 里有 domain 就用；老题按定点表 + track 兜底 */
export function domainOf(item) {
  if (item.domain && DOMAIN_LABEL[item.domain]) return item.domain;
  for (const [frag, dom] of LEGACY_DOMAIN) if (item.title.includes(frag)) return dom;
  if (item.track === 'defense') return 'defense';
  return 'general';
}

/** 题型：raw 里有 kind 就用；否则 general=soft，其余=tech */
export function kindOf(item, domain) {
  if (item.kind === 'tech' || item.kind === 'soft') return item.kind;
  return domain === 'general' ? 'soft' : 'tech';
}

/**
 * 难度三档：
 *   基础 = 通用常识，骨架里没有量化/基线要求（沟通、离职原因、自我介绍…）
 *   难   = 要求落到架构级取舍或量化评估设计（系统设计、高并发、RAG 评测、权限治理…）
 *   进阶 = 其余
 * 实现：先按 domain/kind 给默认档，再用标题关键词微调。
 */
export function difficultyOf(item, domain, kind) {
  // 只看题目本身（标题）：benchmark/context 是给前端展示的考点说明，
  // 里面常出现「评估/评测/指标」等词，topic 是粗分类，用它们判难度会让难度跟着文案漂移。
  const hay = String(item.title || '');
  if (kind === 'soft' || domain === 'general') {
    if (ADVANCED_SOFT.test(hay)) return '进阶';
    return '基础';
  }
  if (domain === 'defense') {
    return HARD_TECH.test(hay) && !BASE_TECH.test(hay) ? '难' : '进阶';
  }
  if (HARD_TECH.test(hay)) return '难';
  if (BASE_TECH.test(hay) || BASE_TECH_WHY.test(hay)) return '基础';
  return '进阶';
}

/**
 * 来源快照：保留一段摘要原文，好让「观点卡 evidence 逐字来自来源」在成品文件里可核对。
 * 摘要会裁剪到 260 字，但裁剪后仍要盖住所有引用该来源的 evidence。
 */
export function sourcesOf(item) {
  const cards = item.viewAngleCards || [];
  return (item.sources || []).map((s) => {
    const full = String(s.snippet || '');
    let clip = full.slice(0, 260);
    for (const c of cards) {
      if (c.sourceUrl !== s.url) continue;
      const ev = String(c.evidence || '').trim();
      if (!ev) continue;
      const at = full.indexOf(ev);
      if (at >= 0 && at + ev.length > clip.length) clip = full.slice(0, at + ev.length);
    }
    return { url: s.url, author: s.author, votes: s.votes, snippet: clip };
  });
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

  // 先把每道题的方向/题型定下来，再按契约限量（软素质题只留 SOFT_KEEP 里的）
  const classified = items
    .filter((it) => it.title)
    .map((it) => {
      const domain = domainOf(it);
      const kind = kindOf(it, domain);
      return { it, domain, kind };
    });

  const droppedSoft = classified.filter(
    (c) => c.kind === 'soft' && !SOFT_KEEP.some((f) => c.it.title.includes(f))
  );
  const kept = classified.filter((c) => !droppedSoft.includes(c));
  if (droppedSoft.length) {
    console.log(`[to-v02] 软素质题限量：保留 ${classified.length - droppedSoft.length} / ${classified.length}（原始数据仍完整保留在 data-raw-bank.json）`);
  }

  const questions = kept
    .map(({ it, domain, kind }) => {
      const enriched = { ...it, domain, kind };
      const cards = (it.viewAngleCards || [])
        .filter((v) => v.evidence && v.sourceUrl)
        .map((v, i) => toCard(v, i, it));
      return {
        id: it.id,
        track: TRACK_LABEL[it.track] || TRACK_LABEL.interview,
        domain,
        kind,
        difficulty: difficultyOf(enriched, domain, kind),
        title: it.title,
        context: contextOf(it),
        keywords: keywordsOf(it),
        expectedLength: [150, 400],
        skeleton: skeletonOf(enriched),
        viewpointCards: cards,
        // 保真：原知乎问题链接与来源（前端不渲染也没关系，留作溯源）
        questionUrl: it.questionUrl || '',
        sources: sourcesOf(it),
      };
    })
    // 带观点卡的题排前面：首页一键体验与首屏都依赖观点卡
    .sort((a, b) => b.viewpointCards.length - a.viewpointCards.length);

  const demoQuestion = questions.find((q) => q.viewpointCards.length >= 2) || questions[0];
  const out = {
    version: '0.2.0-real',
    generatedAt: new Date().toISOString(),
    note: '真题来自知乎开放平台（question_recommendations + question_answers），观点卡由直答生成并逐字校验 evidence；知乎 API 不返回作者与热度数据，卡片 author 留空、upvotes 固定 0，界面不要把它当真实热度展示',
    questions,
    demoSampleTranscript: demoQuestion ? demoTranscriptFor(demoQuestion) : null,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const withCards = questions.filter((q) => q.viewpointCards.length).length;
  const verified = questions.reduce((s, q) => s + q.viewpointCards.filter((c) => c.evidenceQuote).length, 0);
  const byDomain = {};
  const byKind = {};
  const byDiff = {};
  for (const q of questions) {
    byDomain[q.domain] = (byDomain[q.domain] || 0) + 1;
    byKind[q.kind] = (byKind[q.kind] || 0) + 1;
    byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  }
  console.log(`[to-v02] 写入 ${OUT}`);
  console.log(`[to-v02] 题 ${questions.length}｜带观点卡 ${withCards}｜卡片 ${verified}｜体积 ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB`);
  console.log('[to-v02] domain', byDomain);
  console.log('[to-v02] kind  ', byKind);
  console.log('[to-v02] difficulty', byDiff);
  console.log(`[to-v02] 一键体验题目：${demoQuestion?.id} ${String(demoQuestion?.title || '').slice(0, 40)}`);
}

// 被别的脚本 import 时不自动执行（只有直接运行本文件才构建）
const invokedDirectly = process.argv[1] && path.basename(process.argv[1]).startsWith('to-v02');
if (invokedDirectly) {
  main();
}
