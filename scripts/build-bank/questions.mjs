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
 *   每个 topic 自带 groups（该主题白名单，两组都要命中）与 domain/kind（题库契约字段）。
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
const COUNT = Number(argOf('count', '10')); // 每次推荐拉多少候选（配额按调用计，拉多更划算）
const REQUIRE = argOf('require', ''); // 例：--require '答辩|评委|论文'
const DOMAIN = argOf('domain', ''); // 例：--domain rag  只跑该方向的主题
const URLS_FILE = argOf('urls', ''); // 例：--urls tmp/urls.json  外部检索到的知乎问题（{title,url} 数组），不走推荐接口
const RESET = ARGS.includes('--reset');
const DRY = ARGS.includes('--dry');
const VERBOSE = ARGS.includes('--verbose'); // 打印候选标题与被哪一组拦下，调白名单时用

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
 * 主题表：每个主题自带 domain（题库方向）/ kind（技术题 or 软素质题）/ groups（该主题白名单）。
 *
 * 白名单为什么要「按主题 + 两组命中」：
 *   以前是全局白名单（面试/答辩/简历/offer…），它只对软素质题有效，
 *   技术主题一旦走同一个白名单，「RAG 有什么好的优化方案？」这类题会被全部过滤掉。
 *   现在每个主题带两组关键词，**两组都要命中**才算该主题命中：
 *     groups[0] = 主题本体词（保证题是这个主题的）
 *     groups[1] = 语境词（保证它是个值得练的技术/工程/职场问题，
 *                  而不是「你什么时候意识到父母无法为你兜底？」这种生活题）
 *   匹配采用「跨主题择优」：一次推荐拿回的候选，依次比对所有主题，命中哪个算哪个，
 *   这样一次推荐调用能同时给多个主题补量（配额按请求计，不按候选条数计）。
 */

/** 技术语境词：出现这些词，说明这是个值得练的技术/工程问题 */
const CTX = [
  '怎么', '如何', '什么', '哪些', '为什么', '为何', '有没有', '是否', '吗', '？', '?',
  '经验', '实践', '方案', '设计', '原理', '区别', '问题', '优化', '提升', '需要', '值得',
  '理解', '实现', '方法', '选择', '指标', '评估', '评测', '场景', '案例', '难点', '坑',
  '机制', '取舍', '对比', '分析', '诊断', '排查', '治理', '影响', '注意', '面试',
  '学习', '入门', '深入', '总结', '判断', '有哪些', '路线', '体系', '架构', '底层',
  '为什么', '真的', '是不是', '应该', '能不能', '复现', '压测', '调优', '重构', '迁移',
  '升级', '扩展', '测试', '最佳实践', '最佳方案', '优缺点', '代价', '权衡', '评估体系',
  '做法', '经验', '攻略', '指南', '套路', '细节', '关键', '核心', '基础', '原则', '标准',
];

/** 职场语境词：软素质题必须沾上求职/面试语境，避免混入纯生活问题 */
const CAREER = [
  '面试', '求职', '秋招', '春招', 'HR', 'hr', '校招', '实习', '招聘', '岗位', '简历',
  '面试官', '群面', '笔试', '终面', '一面', '二面', '应届', '毕业生', '考研', '考公',
  '考编', '裸辞', '跳槽', '离职', '谈薪', '薪资', 'offer', 'Offer', 'OFFER', '被拒',
  '没过', '内推', '投递', '转行', '转正', '晋升', '加薪', '裁员', '外包', '35岁', '国企',
  '外企', '大厂', '互联网', '事业单位', '体制内', '拿到', '面试被问', '求职信', '面试题',
];

const TOPICS = [
  // ---- ai-agent（技术） ----
  {
    q: 'Agent 工具调用 权限 设计 面试',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['工具调用', 'MCP', 'mcp', '插件', '工作流', 'workflow', 'Workflow', '智能体', 'Agent', 'agent', 'AGENT'],
      ['权限', '设计', '调用', '实现', '方案', '怎么', '如何', '原理', '问题', '实践', '面试', '限制', '边界', '安全', '哪些', '是什么', '怎么做', '治理', '架构'],
    ],
  },
  {
    q: 'AI Agent 幻觉 兜底 实践',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['幻觉', 'hallucination', 'Hallucination', '编造', '瞎编', '事实错误', '可靠性', '稳定性', '幻觉率'],
      ['怎么', '如何', '方案', '实践', '问题', '降低', '控制', '治理', '评测', '评估', 'Agent', 'agent', '智能体', '大模型', '模型', '生产', '上线', '率', '兜底', '处理', '缓解'],
    ],
  },
  {
    q: '多轮工具调用 编排 稳定性',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['多轮', '编排', '工作流', 'workflow', 'Workflow', '工具调用', '任务编排', '上下文', '状态机'],
      ['怎么', '如何', '设计', '实践', '方案', '问题', '原理', '实现', '稳定', '流程', '工具', 'Agent', 'agent', '智能体', '会话', '处理', '提升'],
    ],
  },
  {
    q: 'Prompt 工程 面试题',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['Prompt', 'prompt', '提示词', 'few-shot', '少样本', 'CoT', '思维链'],
      ['工程', '设计', '实践', '怎么', '如何', '问题', '优化', '技巧', '模板', '面试', '方案', '模型', '大模型', '写法', '调优', '改进', '思考'],
    ],
  },
  {
    q: '大模型 安全 越权 防护',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['越权', '注入', '护栏', '风控', '安全', '权限', '防护', '沙箱', '白名单', '攻击'],
      ['怎么', '如何', '方案', '实践', '问题', '设计', '措施', '风险', '大模型', '模型', 'Agent', 'agent', '智能体', '隔离', '审计', '有哪些', '是什么', '防护', '治理', '合规'],
    ],
  },
  {
    q: 'Agent 评测 面试',
    domain: 'ai-agent',
    kind: 'tech',
    groups: [
      ['评测', '评估', '度量', '基准', 'Benchmark', 'benchmark', '打分', '评分'],
      ['Agent', 'agent', '智能体', '模型', '怎么', '如何', '方案', '体系', '指标', '搭建', '实践', '用例', '数据集', '离线', '线上', '质量', '方法', '设计'],
    ],
  },

  // ---- rag（技术） ----
  {
    q: '检索增强生成 RAG 优化方案',
    domain: 'rag',
    kind: 'tech',
    groups: [
      ['RAG', 'rag', 'Rag', '检索增强', '知识库问答', '外挂知识库', '文档问答'],
      ['优化', '改进', '提升', '方案', '实践', '问题', '技巧', '效果', '瓶颈', '难点', '排查', '架构', '怎么', '如何', '设计', '落地', '成本', '延迟', '质量', '失败', '方案'],
    ],
  },
  {
    q: 'RAG 评估方案 评测集',
    domain: 'rag',
    kind: 'tech',
    groups: [
      ['RAG', 'rag', '检索增强', '召回率', '忠实度', '答案质量', '检索质量'],
      ['评估', '评测', '度量', '评测集', '数据集', '指标', '准确', '怎么', '如何', '方案', '设计', '方法', '回归', '测试', '成本', '标准'],
    ],
  },
  {
    q: '向量检索 召回 切分',
    domain: 'rag',
    kind: 'tech',
    groups: [
      ['向量', 'Embedding', 'embedding', '向量库', 'Milvus', 'faiss', 'FAISS', '切片', '切分', '召回'],
      ['检索', '选择', '设计', '原理', '效果', '对比', '方案', '怎么', '如何', '区别', '问题', '数据库', '存储', '相似度', '优化', '策略', '性能', '选型'],
    ],
  },
  {
    q: '知识库 建设 文档 检索 企业',
    domain: 'rag',
    kind: 'tech',
    groups: [
      ['知识库', '知识管理', '语料', '文档库', '企业知识', '私域知识'],
      ['建设', '治理', '管理', '维护', '更新', '方案', '怎么', '如何', '问题', '权限', '质量', '流程', '搭建', '体系', '规范', '构建', '实践'],
    ],
  },
  {
    q: '重排 rerank 检索',
    domain: 'rag',
    kind: 'tech',
    groups: [
      ['重排', 'rerank', 'Rerank', '精排', 'cross-encoder', 'Cross-Encoder'],
      ['原理', '效果', '方案', '实现', '怎么', '如何', '区别', '对比', '问题', '必要', '模型', '收益', '代价', '提升', '优化', '用'],
    ],
  },

  // ---- backend（技术） ----
  {
    q: '高并发 系统设计 面试',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['高并发', '系统设计', '并发', 'QPS', 'qps', '高可用', '扩容', '微服务', '秒杀', '亿级', '千万级', '架构设计', '吞吐'],
      ['设计', '实践', '原理', '问题', '方案', '如何', '怎么', '是什么', '经验', '优化', '取舍', '指标', '压测', '瓶颈', '保证', '保障', '治理', '故障'],
    ],
  },
  {
    q: '消息队列 削峰 幂等',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['消息队列', 'MQ', 'mq', 'Kafka', 'kafka', 'RocketMQ', 'RabbitMQ', '削峰', '幂等', '消息中间件'],
      ['设计', '实现', '选型', '原理', '问题', '一致', '顺序', '重复', '积压', '延迟', '怎么', '如何', '方案', '实践', '保障', '可靠', '治理', '架构', '场景'],
    ],
  },
  {
    q: '缓存 一致性 击穿',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['缓存', 'Cache', 'cache', 'Redis', 'redis', '击穿', '雪崩', '穿透', '预热', '缓存一致性'],
      ['设计', '实践', '原理', '问题', '方案', '怎么', '如何', '解决', '优化', '策略', '更新', '失效', '淘汰', '热点', '治理', '一致性', '保证'],
    ],
  },
  {
    q: '分布式 事务 一致性',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['分布式', '事务', '一致性', 'CAP', 'cap', '分布式锁', '两阶段', '2PC', 'TCC', 'Seata', '最终一致', '分布式系统'],
      ['设计', '实现', '原理', '问题', '方案', '怎么', '如何', '区别', '选型', '取舍', '保证', '冲突', '场景', '实践', '权衡', '优缺点', '代价'],
    ],
  },
  {
    q: '限流 熔断 降级',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['限流', '熔断', '服务降级', '降级方案', '降级策略', '过载保护', '令牌桶', '漏桶', '背压', '限流熔断'],
      ['设计', '原理', '方案', '问题', '怎么', '如何', '实现', '实践', '区别', '选型', '场景', '保障', '策略', '治理', '效果'],
    ],
  },
  {
    q: '数据库 索引 慢查询',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['数据库', 'MySQL', 'mysql', 'SQL', 'sql', '索引', '慢查询', '分库', '分表', '主从', 'PostgreSQL', 'Oracle', '查询优化'],
      ['设计', '优化', '原理', '问题', '区别', '实践', '排查', '选型', '治理', '怎么', '如何', '方案', '性能', '慢', '锁', '事务', '调优', '提升', '实战'],
    ],
  },
  {
    q: '可观测性 监控 线上排查',
    domain: 'backend',
    kind: 'tech',
    groups: [
      ['监控', '可观测', '链路追踪', '链路', '追踪', '告警', '日志', 'trace', 'Trace', 'Tracing', '故障', '事故', 'Prometheus', 'SkyWalking', 'Grafana', 'APM'],
      ['设计', '实践', '原理', '问题', '排查', '体系', '方案', '搭建', '怎么', '如何', '是什么', '定位', '观测', '实现', '治理', '告警'],
    ],
  },

  // ---- algo-data（技术） ----
  {
    q: '推荐系统 效果 评估',
    domain: 'algo-data',
    kind: 'tech',
    groups: [
      ['推荐系统', '推荐算法', '推荐引擎', '个性化推荐', '推荐效果', '推荐', 'CTR', 'ctr', '精排', '召回', '排序模型', '冷启动', '点击率'],
      ['模型', '算法', '效果', '评估', '排序', '召回', '指标', '精度', '数据', '样本', '平台', '引擎', '业务场景', '优化', '提升', '策略', '架构', '实践', '原理', '方案', '问题', '场景', '上线'],
    ],
  },
  {
    q: '搜索 排序 效果 优化',
    domain: 'algo-data',
    kind: 'tech',
    groups: [
      ['搜索排序', '搜索算法', '搜索召回', '搜索效果', '搜索系统', '排序模型', '相关性', '搜索', '检索', 'query', 'Query', '搜索优化'],
      ['模型', '算法', '效果', '评估', '优化', '提升', '策略', '指标', '业务', '实践', '原理', '方案', '设计', '架构', '实现', '问题', '准确', '召回', '结果', '排序', '系统', '引擎', '场景', '区别', '影响', '变化', '取代', '有用', '未来', '趋势', '前景', '企业', '公司', '取代'],
    ],
  },
  {
    q: '模型效果 评测 实验 A/B',
    domain: 'algo-data',
    kind: 'tech',
    groups: [
      ['模型效果', '模型评测', '效果评估', '离线评测', '线上实验', 'A/B', 'AB测试', 'A、B', 'AUC', 'auc', '准确率', '召回率', '评测集', '基准测试', '评测', '评估', '实验', '评价', '模型对比', '模型选型'],
      ['模型', '算法', '大模型', 'LLM', '推荐', '搜索', '数据', '样本', '指标', '效果', '准确', '召回', '业务', '上线', '线上', '离线', '评测', '评估', '方法', '方案', '体系', '对比', '提升', '优化', '标准', '误差', '监控', '成本', '场景', '结果', '原理', '业务场景'],
    ],
  },
  {
    q: '数据指标 埋点 数据分析 业务 增长',
    domain: 'algo-data',
    kind: 'tech',
    groups: [
      ['数据闭环', '指标拆解', '数据指标', '指标体系', '埋点', '数仓', '数据驱动', '北极星', '数据质量', '数据分析', '特征平台', '数据', '指标', '闭环'],
      ['业务', '模型', '算法', '数据', '指标', '口径', '实验', '效果', '评估', '体系', '平台', '埋点', '方案', '拆解', '分析', '运营', '增长', '用户', '产品', '策略', '优化', '怎么', '如何', '设计'],
    ],
  },
  {
    q: '机器学习 特征工程 样本 训练 数据',
    domain: 'algo-data',
    kind: 'tech',
    groups: [
      ['特征工程', '特征提取', '特征选择', '特征平台', '特征构建', '样本构建', '数据清洗', '数据标注', '训练数据', '训练样本', '特征', '样本'],
      ['模型', '算法', '效果', '训练', '数据', '特征', '样本', '指标', '工程', '实践', '方案', '构建', '提升', '优化', '评估', '系统', '平台', '离线', '线上', '怎么', '如何', '设计'],
    ],
  },

  // ---- product（产品与业务） ----
  {
    q: '产品经理 面试 需求 优先级',
    domain: 'product',
    kind: 'tech',
    groups: [
      ['产品经理', '产品需求', '需求优先级', '功能规划', '产品设计', 'B端', 'C端', 'MVP', '竞品', '需求池', '产品路线图', '产品', '需求', '功能'],
      ['业务', '用户', '公司', '团队', '项目', '市场', '行业', '客户', '老板', '数据', '指标', '方案', '资源', '成本', '收入', '优先级', '规划', '场景', '迭代', '研发', '运营', '怎么', '如何', '判断', '取舍', '排期', '方法'],
    ],
  },
  {
    q: '增长 留存 面试',
    domain: 'product',
    kind: 'tech',
    groups: [
      ['增长', '留存', '拉新', '转化率', '转化', '活跃度', '复购', '用户增长', '增长黑客', '运营策略', '留存率'],
      ['业务', '用户', '公司', '市场', '行业', '客户', '数据', '指标', '方案', '活跃', '留存', '拉新', '投放', '渠道', '场景', '运营', '增长', '复购', '产品', '成本', '怎么', '如何', '方法', '策略', '提升'],
    ],
  },
  {
    q: '商业化 变现 面试',
    domain: 'product',
    kind: 'tech',
    groups: [
      ['商业化', '变现', '付费', '定价', '营收', '盈利', '收费', '订阅制', '广告变现', '收入', '商业模式', '客单价', '毛利'],
      ['业务', '用户', '公司', '市场', '行业', '客户', '数据', '指标', '方案', '成本', '收入', '付费', '定价', '变现', '商业', '场景', '产品', '怎么', '如何', '模式', '设计', '选择', '合理', '判断'],
    ],
  },
  {
    q: '用户研究 访谈 方法',
    domain: 'product',
    kind: 'tech',
    groups: [
      ['用户研究', '用户调研', '用研', '用户访谈', '定性研究', '定量研究', '用户画像', '访谈', '用户需求'],
      ['方法', '样本', '流程', '设计', '方案', '问题', '场景', '业务', '产品', '用户', '调研', '分析', '实践', '注意', '技巧', '怎么', '如何', '需求', '真实', '做'],
    ],
  },

  // ---- general（软素质：必须带职场语境） ----
  {
    q: '面试 自我介绍 怎么答',
    domain: 'general',
    kind: 'soft',
    groups: [['自我介绍', '介绍自己', '开场自我介绍'], CAREER],
  },
  {
    q: '面试 为什么离职',
    domain: 'general',
    kind: 'soft',
    groups: [['离职', '跳槽', '辞职', '换工作'], CAREER],
  },
  {
    q: 'offer 选择 怎么判断',
    domain: 'general',
    kind: 'soft',
    groups: [['offer', 'Offer', 'OFFER'], CAREER],
  },
  {
    q: '面试 沟通 协作 冲突',
    domain: 'general',
    kind: 'soft',
    groups: [['沟通', '协作', '冲突', '意见不合', '同事', '跨部门', '向上管理', '汇报', '团队合作'], CAREER],
  },
  {
    q: '职业规划 面试',
    domain: 'general',
    kind: 'soft',
    groups: [['职业规划', '规划', '职业发展', '三年', '五年', '长期发展'], CAREER],
  },
  {
    q: '面试 压力 应对',
    domain: 'general',
    kind: 'soft',
    groups: [['压力', '紧张', '焦虑', '抗压', '心态', '被拒', '面试失败', '没过', '崩溃'], CAREER],
  },

  // ---- defense（论文/答辩） ----
  {
    q: '论文答辩 评委 提问',
    domain: 'defense',
    kind: 'tech',
    groups: [['论文', '答辩', '开题', '毕设', '毕业设计'], ['评委', '提问', '问题', '准备', '怎么', '如何', '应对', '答辩', '技巧', '建议']],
  },
  {
    q: '毕业答辩 准备',
    domain: 'defense',
    kind: 'tech',
    groups: [['答辩', '毕设', '毕业设计'], ['准备', '怎么', '如何', '流程', '技巧', 'PPT', '提问', '建议', '内容', '结构']],
  },
  {
    q: '项目答辩 被质疑',
    domain: 'defense',
    kind: 'tech',
    groups: [['答辩', '毕业设计', '项目答辩'], ['质疑', '挑战', '追问', '被问', '应对', '怎么', '如何', '准备', '回答']],
  },
  {
    q: '开题报告 创新点',
    domain: 'defense',
    kind: 'tech',
    groups: [['开题', '创新点', '选题', '开题报告'], ['怎么', '如何', '写', '选', '找', '问题', '建议', '标准', '要求', '创新']],
  },
  {
    q: '实验设计 对照 实验',
    domain: 'defense',
    kind: 'tech',
    groups: [['实验设计', '对照组', '消融实验', '消融', '显著性', '样本量', '数据集', '实验'], ['设计', '怎么', '如何', '对比', '控制', '方法', '方案', '评估', '做', '变量']],
  },
];

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

/** 外部检索（web 搜索）拿到的知乎问题：{title,url} 数组或 TSV */
function loadUrls(file) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`✗ 找不到 urls 文件：${abs}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  let list = [];
  if (raw.trim().startsWith('[')) {
    list = JSON.parse(raw);
  } else {
    list = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [title, url] = l.split('\t');
        return { title: title || '', url: url || '' };
      });
  }
  return list
    .map((x) => ({
      title: String(x.title || '').trim(),
      // 归一到问题页：去掉 /answer/xxx 与查询串
      url: String(x.url || '').split('?')[0].replace(/\/answer\/.*$/, '').replace(/\/$/, ''),
    }))
    .filter((x) => x.title && x.url.includes('/question/'));
}

let ansCalls = 0;
let quotaHit = false;

/** 抓答案 → 组 sources → 落库。返回是否入库成功 */
async function addQuestion(q, hit, list) {
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
    if (err.code === 'QUOTA') quotaHit = true;
    return false;
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
    return false;
  }

  list.push({
    id: `q_${list.length + 1}`,
    title: q.title,
    questionUrl: q.url,
    track: hit.domain === 'defense' ? 'defense' : 'interview',
    topic: hit.q,
    domain: hit.domain,
    kind: hit.kind,
    heat: sources.length,
    sources,
    viewAngleCards: [],
    benchmark: '',
    pitfalls: [],
    createdAt: new Date().toISOString(),
  });
  console.log(`[+q][${hit.domain}] ${q.title.slice(0, 32)}… (${sources.length} 条回答)`);
  return true;
}

async function main() {
  const list = RESET ? [] : load();
  const seen = new Set(list.map((q) => q.questionUrl));
  let added = 0;
  let recCalls = 0;

  const topics = DOMAIN ? TOPICS.filter((t) => t.domain === DOMAIN) : TOPICS;
  if (!topics.length) {
    console.error(`✗ 未知方向：${DOMAIN}`);
    process.exit(1);
  }

  console.log(
    `[questions] 已有 ${list.length} 题，目标新增 ${LIMIT} 题，主题 ${topics.length} 个${DOMAIN ? `（限定 ${DOMAIN}）` : ''}`
  );

  // ---- 模式 A：外部检索得到的候选（不走推荐接口，推荐配额用尽时用） ----
  if (URLS_FILE) {
    const cands = loadUrls(URLS_FILE);
    console.log(`[questions] urls 模式：候选 ${cands.length} 题，目标新增 ${LIMIT} 题`);
    for (const q of cands) {
      if (added >= LIMIT) break;
      if (seen.has(q.url)) continue;
      if (q.title.length < 8) continue;
      if (BLACKLIST.some((w) => q.title.includes(w))) continue;
      if (!QUESTIONISH.test(q.title)) continue;
      const hit = topics.find((t) => t.groups.every((g) => g.some((w) => q.title.includes(w))));
      if (!hit) {
        console.log(`[skip] 没有主题命中：${q.title.slice(0, 28)}…`);
        continue;
      }
      const ok = await addQuestion(q, hit, list);
      if (ok) { added += 1; seen.add(q.url); }
    }
    if (!DRY) save(list);
    console.log(`\n[questions] 新增 ${added} 题 → 合计 ${list.length} 题；配额消耗：推荐 0、回答 ${ansCalls}`);
    return;
  }

  outer: for (const topic of topics) {
    if (added >= LIMIT) break;
    let qs = [];
    try {
      const payload = await get('/api/v1/user/question_recommendations', { Query: topic.q, Count: COUNT });
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
      if (!QUESTIONISH.test(q.title)) continue;
      if (REQUIRE && !new RegExp(REQUIRE).test(q.title)) continue;

      // 跨主题择优：本次推荐的候选也允许落到别的主题上（一次推荐给多个主题补量）
      const hit = topics.find((t) => t.groups.every((g) => g.some((w) => q.title.includes(w))));
      if (!hit) {
        if (VERBOSE) console.log(`   × ${q.title.slice(0, 46)}`);
        continue;
      }
      if (VERBOSE) console.log(`   ✓ [${hit.domain}] ${q.title.slice(0, 46)}`);

      const ok = await addQuestion(q, hit, list);
      if (ok) { added += 1; seen.add(q.url); }
      if (!ok && quotaHit) break outer;
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
