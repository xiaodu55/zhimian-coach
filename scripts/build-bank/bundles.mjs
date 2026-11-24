/**
 * 生成「题单」（bundles）：把 92 道真题组织成评委/用户 30 秒能定位的场景化精选题单。
 *
 * 为什么不靠拉新题：加题要调直答生成观点卡（40~70s/题、有配额与失败风险），
 * 卡生成失败的题会以「观点卡待补」暴露给评委；题量对评分的边际贡献很低，
 * 而「每题都有正反观点卡 + 逐字可核证据」才是密度优势。
 *
 * 题单的两个来源：
 *   1) 主库 92 题：按 domain + 难度梯度组合（基础 → 进阶 → 难），每单 9~12 题
 *   2) 软素质专项：data-raw-bank.json 里被「软素质题限量」策展掉的题，
 *      其中 31 道**已经有逐字校验过的观点卡**，直接复用（零 API 消耗、不稀释主库）
 *
 * 用法：node scripts/build-bank/bundles.mjs
 * 输出：apps/web/data/bundles.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  TRACK_LABEL,
  DOMAIN_LABEL,
  toCard,
  domainOf,
  kindOf,
  difficultyOf,
  skeletonOf,
  contextOf,
  keywordsOf,
  sourcesOf,
} from './to-v02.mjs';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data-raw-bank.json');
const BANK = path.join(ROOT, 'apps/web/data/question-bank.json');
const OUT = path.join(ROOT, 'apps/web/data/bundles.json');

/** 难度梯度：题单先给基础题，再进阶，最后难题，保证有学习路径 */
const DIFFICULTY_ORDER = ['基础', '进阶', '难'];

/** 每个题单从哪个 domain 取题、取几道、一句话说明 */
const CURATED = [
  {
    id: 'agent',
    title: 'AI Agent / 工具调用 精选',
    domain: 'ai-agent',
    size: 10,
    desc: '权限治理、工具调用、评测与失败处理：Agent 岗最常被追着问的一类题',
  },
  {
    id: 'rag',
    title: 'RAG / 检索增强 精选',
    domain: 'rag',
    size: 10,
    desc: '切分、召回、重排、评测：检索链路上的分歧最多，也最能看出你的取舍',
  },
  {
    id: 'backend',
    title: '后端与系统设计 精选',
    domain: 'backend',
    size: 10,
    desc: '一致性、幂等、限流、可观测：系统设计题的通用底座',
  },
  {
    id: 'algo',
    title: '算法与数据 精选',
    domain: 'algo-data',
    size: 10,
    desc: '从系统设计到数据闭环：偏硬核的一组，适合想展示深度时挑',
  },
  {
    id: 'product',
    title: '产品与业务 精选',
    domain: 'product',
    size: 9,
    desc: '需求判断、指标与商业化：转产品岗或需要谈业务影响时用这组',
  },
  {
    id: 'defense',
    title: '论文与答辩 精选',
    domain: 'defense',
    size: 10,
    desc: '创新点、方法边界、对照实验：毕设与开题答辩最容易被击穿的地方',
  },
];

function pickByDifficulty(pool, size) {
  // 难度梯度排序：基础 → 进阶 → 难，同难度按原顺序
  const sorted = [...pool].sort((a, b) => {
    const d = DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty);
    return d !== 0 ? d : 0;
  });
  return sorted.slice(0, size);
}

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const bank = JSON.parse(fs.readFileSync(BANK, 'utf8'));
  const questions = bank.questions || [];
  const keptIds = new Set(questions.map((q) => q.id));

  // ---- 软素质专项：复用被策展掉但已有逐字校验观点卡的题 ----
  const softPool = (raw.items || []).filter((it) => !keptIds.has(it.id) && (it.viewAngleCards || []).length);
  const extraQuestions = softPool.map((it) => {
    const domain = domainOf(it);
    const kind = kindOf(it, domain);
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
      context: contextOf(enriched),
      keywords: keywordsOf(it),
      expectedLength: [150, 400],
      skeleton: skeletonOf(enriched),
      viewpointCards: cards,
      questionUrl: it.questionUrl || '',
      sources: sourcesOf(it),
    };
  });
  // 软素质专项题单：按"沟通协作 / 离职与选择 / 压力与情绪 / 岗位与角色"分组覆盖，各取几道
  const softGroups = [
    { key: /沟通|协作|意见不合|冲突|群面|团队/, size: 4, label: '沟通协作' },
    { key: /离职|跳槽|offer|转行|选择|要不要/, size: 4, label: '离职与选择' },
    { key: /紧张|焦虑|压力|害怕|拒绝|被拒|拖延|考公/, size: 2, label: '压力与情绪' },
  ];
  const softPicked = [];
  const usedSoft = new Set();
  for (const g of softGroups) {
    const hits = extraQuestions.filter((q) => g.key.test(q.title) && !usedSoft.has(q.id)).slice(0, g.size);
    for (const h of hits) {
      usedSoft.add(h.id);
      softPicked.push(h);
    }
  }
  // 补齐到 12 道（不足则从剩余里按顺序取）
  for (const q of extraQuestions) {
    if (softPicked.length >= 12) break;
    if (usedSoft.has(q.id)) continue;
    usedSoft.add(q.id);
    softPicked.push(q);
  }

  const bundles = CURATED.map((c) => {
    const pool = questions.filter((q) => q.domain === c.domain);
    const picked = pickByDifficulty(pool, c.size);
    return {
      id: c.id,
      title: c.title,
      desc: c.desc,
      domain: c.domain,
      domainLabel: DOMAIN_LABEL[c.domain] || c.domain,
      questionIds: picked.map((q) => q.id),
      difficultyMix: DIFFICULTY_ORDER.map((d) => `${d} ${picked.filter((q) => q.difficulty === d).length} 道`).join(' · '),
    };
  });

  bundles.unshift({
    id: 'soft',
    title: '通用软素质专项',
    desc: '沟通协作、离职与选择、压力应对：这组题不考技术，但最容易在最后十分钟被问崩',
    domain: 'general',
    domainLabel: '通用面试素养',
    questionIds: softPicked.map((q) => q.id),
    difficultyMix: DIFFICULTY_ORDER.map((d) => `${d} ${softPicked.filter((q) => q.difficulty === d).length} 道`).join(' · '),
  });

  const out = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    note: '题单把 92 道主库真题按方向与难度梯度组织成场景化精选；「通用软素质专项」复用已被逐字校验过、但因软素质题限量未进主库的 31 道题，不新增任何知乎 API 消耗。',
    bundles,
    extraQuestions: softPicked,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[bundles] 写入 ${OUT}`);
  for (const b of bundles) {
    console.log(`  · ${b.title}: ${b.questionIds.length} 道（${b.difficultyMix}）`);
  }
  console.log(`[bundles] 附带的软素质题对象：${softPicked.length} 道`);
}

main();
