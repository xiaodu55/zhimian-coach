/**
 * 真题构建（自包含脚本，不依赖 BFF 源码，避免后端重构把跑批带崩）
 * 用法：
 *   node scripts/build-bank/questions.mjs [--limit 15] [--domain ai-agent] [--reset] [--dry] [--require '正则']
 *
 * 配额现实（实测）：question_discovery 共享 100/天，推荐与回答摘要都从这里扣。
 * 一个题 = 1 次推荐 + 1 次回答 → 每天最多约 30–50 题，用完就停（429 直接退出）。
 *
 * 白名单为什么要按主题拆：
 *   以前是全局白名单（面试/答辩/简历/offer…），它只对软素质题有效。
 *   技术主题一旦走同一个白名单，「RAG 有什么好的优化方案？」这类题会被全部过滤掉，
 *   所以技术主题必须命中**自己主题的**关键词才算命中。
 *   每个 topic 自带 include（白名单）与 domain/kind（题库契约字段）。
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
const DOMAIN = argOf('domain', ''); // 例：--domain rag  只跑该方向的主题
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

/**
 * 主题表：每个主题自带 domain（题库方向）/ kind（技术题 or 软素质题）/ include（该主题白名单）。
 * include 命中任意一个即视为该主题命中；黑名单全局生效。
 */
const TOPICS = [
  // ---- ai-agent（技术） ----
  {
    q: 'Agent 工具调用 权限 设计 面试',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['Agent', 'agent', 'AGENT', '智能体', '工具调用', '工具', '权限', 'MCP', 'mcp', '工作流', 'workflow', '插件', '代理'],
  },
  {
    q: 'AI Agent 幻觉 兜底 实践',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['幻觉', '兜底', '幻觉率', 'Agent', 'agent', '智能体', '大模型', '模型', '可靠性'],
  },
  {
    q: '多轮工具调用 编排 稳定性',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['多轮', '编排', '工具调用', '工作流', '流程', 'Agent', 'agent', '智能体', '任务', '自动化'],
  },
  {
    q: 'Prompt 工程 面试题',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['Prompt', 'prompt', '提示词', '大模型', '模型', 'Agent', 'agent', '智能体'],
  },
  {
    q: '大模型 安全 越权 防护',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['越权', '安全', '防护', '注入', '权限', '护栏', '风控', '大模型', '模型', 'Agent', 'agent'],
  },
  {
    q: 'Agent 评测 面试',
    domain: 'ai-agent',
    kind: 'tech',
    include: ['评测', '评估', 'Agent', 'agent', '智能体', '效果', '指标'],
  },

  // ---- rag（技术） ----
  {
    q: '检索增强生成 RAG 优化方案',
    domain: 'rag',
    kind: 'tech',
    include: ['RAG', 'rag', '检索增强', '检索', '召回', '切分', '切片', '向量', '知识库', 'Embedding', 'embedding', '重排', 'rerank'],
  },
  {
    q: 'RAG 评估方案 评测集',
    domain: 'rag',
    kind: 'tech',
    include: ['RAG', 'rag', '检索增强', '评测', '评估', '召回率', '准确率', '数据集', '指标'],
  },
  {
    q: '向量检索 召回 切分',
    domain: 'rag',
    kind: 'tech',
    include: ['向量', '检索', '召回', '切分', '切片', 'Embedding', 'embedding', '向量库', '相似度', 'Milvus', 'faiss', 'ES'],
  },
  {
    q: '知识库 建设 治理 面试',
    domain: 'rag',
    kind: 'tech',
    include: ['知识库', '知识', '治理', '文档', '资料', 'RAG', 'rag', '检索'],
  },
  {
    q: '重排 rerank 检索',
    domain: 'rag',
    kind: 'tech',
    include: ['重排', 'rerank', 'Rerank', '排序', '检索', '召回', '精排'],
  },

  // ---- backend（技术） ----
  {
    q: '高并发 系统设计 面试',
    domain: 'backend',
    kind: 'tech',
    include: ['系统设计', '高并发', '并发', '架构', '高可用', 'QPS', 'qps', '性能', '扩容', '微服务', '秒杀', '亿级', '千万'],
  },
  {
    q: '消息队列 削峰 幂等',
    domain: 'backend',
    kind: 'tech',
    include: ['消息队列', 'MQ', 'mq', 'Kafka', 'kafka', 'RocketMQ', 'RabbitMQ', '削峰', '幂等', '队列', '消息中间件'],
  },
  {
    q: '缓存 一致性 击穿',
    domain: 'backend',
    kind: 'tech',
    include: ['缓存', 'Cache', 'cache', '击穿', '雪崩', '穿透', '一致性', 'Redis', 'redis', '预热'],
  },
  {
    q: '分布式 事务 一致性',
    domain: 'backend',
    kind: 'tech',
    include: ['分布式', '事务', '一致性', 'CAP', 'cap', '最终一致', '分布式锁', '两阶段', 'TCC', 'Seata', '时钟'],
  },
  {
    q: '限流 熔断 降级',
    domain: 'backend',
    kind: 'tech',
    include: ['限流', '熔断', '降级', '过载', '保护', '令牌桶', '漏桶', '雪崩'],
  },
  {
    q: '数据库 索引 慢查询',
    domain: 'backend',
    kind: 'tech',
    include: ['数据库', '索引', '慢查询', 'MySQL', 'mysql', 'Redis', 'redis', 'SQL', 'sql', '查询', '分库', '分表', '主从'],
  },
  {
    q: '可观测性 监控 线上排查',
    domain: 'backend',
    kind: 'tech',
    include: ['监控', '可观测', '排查', '链路', '追踪', '告警', '定位', '线上问题', '日志', 'Prometheus', 'SkyWalking', 'trace', 'Trace', '故障'],
  },

  // ---- algo-data（技术） ----
  {
    q: '推荐系统 效果 评估',
    domain: 'algo-data',
    kind: 'tech',
    include: ['推荐系统', '推荐算法', 'CTR', 'ctr', '精排', '召回算法', '排序模型', '推荐效果'],
  },
  {
    q: '搜索 排序 效果 优化',
    domain: 'algo-data',
    kind: 'tech',
    include: ['搜索排序', '搜索效果', '排序模型', '搜索算法', '搜索召回', '搜索优化'],
  },
  {
    q: '模型效果 评测 实验 A/B',
    domain: 'algo-data',
    kind: 'tech',
    include: ['评测', '评估', '实验', 'A/B', 'AB测试', 'A、B', '模型效果', '模型评测', '效果评估', '准确率', '召回率', 'AUC', 'auc', '离线评测', '线上实验'],
  },
  {
    q: '数据闭环 指标 拆解',
    domain: 'algo-data',
    kind: 'tech',
    include: ['数据', '指标', '闭环', '拆解', '埋点', '数据驱动', '北极星', '数仓', '离线'],
  },
  {
    q: '特征工程 实践',
    domain: 'algo-data',
    kind: 'tech',
    include: ['特征', '样本', '数据处理', '数据清洗', '特征工程', '训练数据', '标注'],
  },

  // ---- product（技术/软素质都可能出现，按题目本身判） ----
  {
    q: '产品经理 面试 需求 优先级',
    domain: 'product',
    kind: 'tech',
    include: ['产品经理', '产品', '需求', '优先级', '产品设计', 'B端', 'C端', '功能规划'],
  },
  {
    q: '增长 留存 面试',
    domain: 'product',
    kind: 'tech',
    include: ['增长', '留存', '拉新', '转化', '活跃', '运营', '用户量', '复购'],
  },
  {
    q: '商业化 变现 面试',
    domain: 'product',
    kind: 'tech',
    include: ['商业化', '变现', '付费', '营收', '广告', '盈利', '定价', '收费', '收入'],
  },
  {
    q: '用户研究 访谈 方法',
    domain: 'product',
    kind: 'tech',
    include: ['用户研究', '访谈', '用户调研', '用研', '定性', '定量', '用户需求', '画像'],
  },

  // ---- general（软素质） ----
  {
    q: '面试 自我介绍 怎么答',
    domain: 'general',
    kind: 'soft',
    include: ['自我介绍', '面试', '开场', '介绍自己'],
  },
  {
    q: '面试 为什么离职',
    domain: 'general',
    kind: 'soft',
    include: ['离职', '跳槽', '离职原因', '换工作', '辞职'],
  },
  {
    q: 'offer 选择 怎么判断',
    domain: 'general',
    kind: 'soft',
    include: ['offer', 'Offer', 'OFFER', '选择', '跳槽', '去哪家', '哪个公司', '薪资'],
  },
  {
    q: '面试 沟通 协作 冲突',
    domain: 'general',
    kind: 'soft',
    include: ['沟通', '协作', '冲突', '意见不合', '同事', '团队', '跨部门', '向上管理', '汇报'],
  },
  {
    q: '职业规划 面试',
    domain: 'general',
    kind: 'soft',
    include: ['职业规划', '规划', '三年', '五年', '长期', '职业发展', '职业'],
  },
  {
    q: '面试 压力 应对',
    domain: 'general',
    kind: 'soft',
    include: ['压力', '紧张', '焦虑', '抗压', '被拒', '失败', '心态', '崩溃', '怎么办'],
  },

  // ---- defense（论文/答辩，按领域约定算技术题） ----
  {
    q: '论文答辩 评委 提问',
    domain: 'defense',
    kind: 'tech',
    include: ['答辩', '评委', '论文', '提问', '毕设', '开题'],
  },
  {
    q: '毕业答辩 准备',
    domain: 'defense',
    kind: 'tech',
    include: ['答辩', '毕业', '毕设', '准备', '论文'],
  },
  {
    q: '项目答辩 被质疑',
    domain: 'defense',
    kind: 'tech',
    include: ['答辩', '质疑', '挑战', '追问', '项目', '毕业设计'],
  },
  {
    q: '开题报告 创新点',
    domain: 'defense',
    kind: 'tech',
    include: ['开题', '创新', '创新点', '选题', '开题报告', '研究'],
  },
  {
    q: '实验设计 对照 实验',
    domain: 'defense',
    kind: 'tech',
    include: ['实验', '对照', '对照组', '消融', '显著性', '样本量', '数据集', '指标'],
  },
];

/**
 * 方向锚点：标题除了命中主题白名单，还必须命中该方向的技术锚点，
 * 否则「你什么时候意识到父母无法为你兜底？」这种生活题会被「兜底」捞进来。
 */
const ANCHOR = {
  'ai-agent': ['Agent', 'agent', 'AGENT', '智能体', '大模型', 'LLM', 'llm', 'GPT', 'gpt', 'MCP', 'mcp', 'Prompt', 'prompt', '提示词', '工具调用', '工作流', 'workflow', 'Workflow', 'AIGC', 'LangChain', 'Dify', 'dify', 'Coze', '扣子', 'Manus', 'Claude', 'Qwen', '通义', '豆包', '文心', 'OpenAI', 'Embedding', 'RAG', 'rag', '多模态', '智能体框架'],
  rag: ['RAG', 'rag', '检索增强', '向量检索', '向量库', 'Embedding', 'embedding', '召回', '重排', 'rerank', 'Rerank', '语料', 'Milvus', 'faiss', 'FAISS', '大模型', 'LLM', 'llm', '知识库', '文档问答', '外挂知识库'],
  backend: ['后端', '服务端', 'Java', 'Go', 'Golang', 'Python', 'Redis', 'redis', 'MySQL', 'mysql', '数据库', '缓存', '消息队列', '系统设计', '架构', '分布式', '并发', 'QPS', 'qps', '中间件', '微服务', '容器', 'Docker', 'K8s', 'k8s', '服务器', 'API', '接口', '高可用', '事务', '索引', '慢查询', '监控', '日志', 'Kafka', 'kafka', 'Nginx', '存储', 'Linux', '线程', '锁', '延迟', '机房'],
  'algo-data': ['算法', '推荐系统', '搜索', '排序', '模型', '特征', '实验', '评测', '机器学习', '深度学习', 'NLP', 'nlp', '训练', '样本', '指标', '统计', '数据分析', '数据挖掘', '召回', 'CTR', 'ctr', '聚类', '分类', '预测', 'LLM', '大模型', 'AIGC'],
  product: ['产品', '需求', '用户', '增长', '运营', '商业', '市场', 'B端', 'C端', '付费', '变现', '留存', '拉新', '品牌', '策划', '活动', '调研', '访谈', '平台', '创业', '商业模式', '定价', '推广', '渠道', '转化'],
  general: ['面试', '求职', '秋招', '春招', 'offer', 'Offer', 'OFFER', '离职', '跳槽', '简历', 'HR', 'hr', '校招', '实习', '招聘', '岗位', '考公', '考编', '考研', '公司', '同事', '领导', '上级', '职场', '工作', '薪资', '待遇', '群面', '笔试', '终面', '一面', '二面', '转行', '裸辞', '裁员', '内推', '应届', '毕业生', '投递', '谈薪', '加班', '996', '面试官'],
  defense: ['论文', '答辩', '开题', '毕设', '毕业设计', '评委', '毕业', '学位', '导师', '查重', '盲审', '评审', '答辩委员会', '创新点', '实验'],
};

const BLACKLIST = ['赚', '副业', '创业项目', '推荐项目', '存款', '理财', '带货', '开店', '加盟', '彩票', '小说', '追剧'];

/** 标题得像一个「问」而不是一篇文章/招聘贴 */
const QUESTIONISH = /[？?]|怎么|如何|为什么|为何|是什么|有哪些|该不该|要不要|值不值|怎样|咋|多少|哪些|如何才|有啥/;

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

  const topics = DOMAIN ? TOPICS.filter((t) => t.domain === DOMAIN) : TOPICS;
  if (!topics.length) {
    console.error(`✗ 未知方向：${DOMAIN}`);
    process.exit(1);
  }

  console.log(
    `[questions] 已有 ${list.length} 题，目标新增 ${LIMIT} 题，主题 ${topics.length} 个${DOMAIN ? `（限定 ${DOMAIN}）` : ''}`
  );

  outer: for (const topic of topics) {
    if (added >= LIMIT) break;
    let qs = [];
    try {
      const payload = await get('/api/v1/user/question_recommendations', { Query: topic.q, Count: 5 });
      recCalls += 1;
      qs = items(payload).map((x) => ({ title: x.Title || '', url: String(x.Url || '').split('?')[0] }));
      console.log(`[rec] "${topic.q}" → ${qs.length}`);
    } catch (err) {
      console.warn(`[rec] "${topic.q}" 失败：${err.code} ${err.message}`);
      if (err.code === 'QUOTA') break outer;
      continue;
    }
    await sleep(1200);

    for (const q of qs) {
      if (added >= LIMIT) break outer;
      if (!q.url || seen.has(q.url)) continue;
      if (q.title.length < 8) continue;
      if (BLACKLIST.some((w) => q.title.includes(w))) continue;
      // 命中**该主题自己的**白名单才算命中（原来全局白名单会把技术题全过滤掉）
      if (!topic.include.some((w) => q.title.includes(w))) continue;
      // 再加一层方向锚点：避免生活题/无关题被单个宽泛词捞进来
      const anchor = ANCHOR[topic.domain] || [];
      if (anchor.length && !anchor.some((w) => q.title.includes(w))) continue;
      if (!QUESTIONISH.test(q.title)) continue;
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
        track: topic.domain === 'defense' ? 'defense' : 'interview',
        topic: topic.q,
        domain: topic.domain,
        kind: topic.kind,
        heat: sources.length,
        sources,
        viewAngleCards: [],
        benchmark: '',
        pitfalls: [],
        createdAt: new Date().toISOString(),
      });
      added += 1;
      console.log(`[+q][${topic.domain}] ${q.title.slice(0, 32)}… (${sources.length} 条回答)`);
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
