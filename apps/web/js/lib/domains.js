/**
 * 方向（domain）与题目类型（kind）的统一口径。
 *
 * 为什么要有这一层：之前前端靠关键词正则去猜题目属于哪个方向，
 * 结果 6 个方向里 5 个命中 0 道 —— 筛选器形同虚设，用户一点就是空白页。
 * 现在题库数据里直接带 `domain` / `kind`（由构建脚本产出），
 * 这里只做「老数据没有这两个字段时的兜底推断」。
 */

export const DOMAINS = [
  { key: 'ai-agent', label: 'AI Agent / 工具调用', hint: 'Agent、工具调用、权限治理、幻觉兜底', match: /agent|智能体|工具调用|tool|workflow|多轮|prompt|提示词|幻觉|越权|护栏/i },
  { key: 'rag', label: 'RAG / 检索增强', hint: '切分召回、重排、评测、知识库治理', match: /rag|检索|召回|向量|知识库|rerank|重排|embedding|切片/i },
  { key: 'backend', label: '后端与系统设计', hint: '高并发、一致性、队列、可观测性', match: /后端|系统设计|分布式|并发|队列|缓存|存储|数据库|微服务|架构|高可用|幂等|限流|熔断|索引|慢查询/i },
  { key: 'algo-data', label: '算法与数据', hint: '推荐搜索、效果评测、数据闭环', match: /算法|推荐|搜索|模型效果|评测|实验|数据|指标|特征|a\/b/i },
  { key: 'product', label: '产品与业务', hint: '需求优先级、增长留存、商业化', match: /产品|用户|增长|运营|商业|需求|商业化|留存|转化|访谈/i },
  { key: 'general', label: '通用面试素养', hint: '自我介绍、离职原因、offer 选择、沟通协作', match: /自我介绍|离职|offer|跳槽|转行|沟通|协作|冲突|职业规划|抗压|心态|考公|求职|秋招/i },
  { key: 'defense', label: '论文与答辩', hint: '评委提问、创新点、实验设计', match: /论文|答辩|开题|毕业|评委|创新点|实验设计/i },
];

export const DOMAIN_LABEL = Object.fromEntries(DOMAINS.map((d) => [d.key, d.label]));

/** 题目属于哪个方向：优先用数据里的 domain，缺失时按关键词兜底 */
export function domainOf(q = {}) {
  if (q.domain && DOMAIN_LABEL[q.domain]) return q.domain;
  const hay = `${q.title || ''} ${q.context || ''} ${(q.keywords || []).join(' ')} ${q.track || ''}`;
  const hit = DOMAINS.find((d) => d.match.test(hay));
  if (hit) return hit.key;
  return /论文|答辩/.test(q.track || '') ? 'defense' : 'general';
}

/**
 * 题目类型：tech = 技术/工程题；soft = 通用软素质题。
 * 后端会据此切换评分维度（tech：技术深度/工程权衡/边界意识；soft：结构清晰/证据充分/表达分寸）。
 */
export function kindOf(q = {}) {
  if (q.kind === 'tech' || q.kind === 'soft') return q.kind;
  const domain = domainOf(q);
  return domain === 'general' ? 'soft' : 'tech';
}

/** 方向筛选项 → 该方向实际有多少题（用于禁用空方向，避免点了是空白页） */
export function domainCounts(bank = []) {
  const counts = {};
  for (const q of bank) {
    const d = domainOf(q);
    counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

/**
 * 空结果兜底：当前筛选没有题时，按关键词相似度给几个"相关题"，
 * 而不是让用户面对一个空列表。
 */
export function fuzzySuggestions(bank = [], filter = {}, limit = 4) {
  const { keyword = '', domain = '', difficulty = '' } = filter;
  const kw = keyword.trim().toLowerCase();
  const scored = bank
    .filter((q) => domainOf(q) !== domain || !domain)
    .filter((q) => !difficulty || q.difficulty === difficulty)
    .map((q) => {
      let score = 0;
      const hay = `${q.title || ''} ${q.context || ''} ${(q.keywords || []).join(' ')}`.toLowerCase();
      if (kw) {
        for (const ch of new Set(kw)) if (hay.includes(ch)) score += 1;
      }
      // 关键词命中越多越相关
      for (const k of q.keywords || []) if (kw && kw.includes(String(k).toLowerCase())) score += 3;
      return { q, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.q);
}
