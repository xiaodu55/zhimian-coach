/**
 * 体验与数据一致性优化模块。
 *
 * 这一层专门处理"看起来是小事、但用户一眼能看出假"的问题：
 *  1. 示例回答按题目领域匹配（通用题不能填技术数据，否则一眼穿帮）
 *  2. 闪卡提炼清洗（诊断标签不能混进"支撑论据"，模板拼接不能留下"边界是在 面试通用 场景下"）
 *  3. 有效字数统计（复盘页两个地方的数字必须同源）
 *  4. 维度分值格式化（38 分要给出"38 / 100 分 · 待深化"这种刻度感）
 */

/** 按领域准备好的示范回答：只在"试一试"里用，不代表用户真实经历 */
const SAMPLE_ANSWERS_BY_CATEGORY = {
  '通用面试素养·mean': `我认为这两者不能混为一谈。面试里的「mean」本质是在高压与信息不全的条件下考察边界感与博弈韧性，不是职场里的刻意刁难。
比如我之前推进一个跨部门项目时，需求方当面质疑方案可行性，我没有情绪化辩解，而是先拆出对方真正担心的两个点，用小范围灰度数据验证后再对齐排期。
所以面试官想筛掉的其实是玻璃心和盲目顺从，留下的是能扛事、就事论事沟通的人。`,

  'AI Agent / 工具调用': `我们在 Agent 工具调用链路里同时踩了多轮循环失控和参数幻觉两个坑。
做法是在工具执行出口加一道确定性校验闸门：高危写操作必须绑定单次消费的执行凭证，并保留 3 步状态回滚快照；参数先过 schema 校验再进模型。
上线后工具调用异常率从 14.2% 降到 1.8%，首字响应延迟控制在 850ms 以内。代价是校验规则在跨模态长上下文下维护成本偏高，这部分我还在收敛。`,

  'RAG / 检索增强': `为了解决单纯依赖模型打分导致的评分漂移，我们把评测拆成双轨。
离线轨道冻结内容哈希，用 Recall@5、nDCG@10 和 Span 精确率做回归拦截；线上轨道保留抽样人工核验作为兜底。
迭代两周后检索召回准确率从 68% 提升到 86%。目前多跳复杂问题的切分粒度还不够细，这是我下一步要改的地方。`,

  后端与系统设计: `在高并发异步任务队列里，最怕的是网络抖动导致的脑裂双写。
我们用预写日志配合批量刷盘保证崩溃可恢复，并在 Worker 侧引入单调递增的租约令牌，让过期持有者无法再写入。
压测下 P99 写入延迟稳定在 12ms 左右，单节点吞吐到 1.8 万 QPS；遇到磁盘 I/O 抖动时队列会主动背压限流保护上游。`,

  通用面试素养: `这类问题我会先把「判断标准」讲清楚，再给依据和边界。
我的判断是：面试官在意的不是一句话说得漂不漂亮，而是你有没有自己的判断依据、能不能落到可核对的事实上、以及遇到反例时守不守得住边界。
具体做法是三步：先用一句话正面回应问题，不绕弯；再给一个自己亲手负责的具体例子，带上可核对的数字和口径；最后主动说明这个结论在什么条件下不成立、我会怎么退。
如果面试官继续追问，我会先确认他真正担心的那个点，再用同期对照或抽样复核的方式给出证据，而不是临时编一个更好看的数字。`,

  论文答辩: `我这篇工作的核心问题是：在多轮工具调用下，权限判定既要可解释又不能拖慢主链路。
方法上我把判定拆成工具名、参数、子命令、工作区四层输入，用确定性规则先过一遍，模型只做兜底解释；评测用冻结的用例集做回归，避免口径漂移。
实验里误拦截率从 3% 降到 1.2%，单轮判定 P99 8ms。局限是复杂命令替换场景仍会误判，这也是我下一步要补的边界。`,

  DEFAULT: `我的核心结论是：先明确评估基准，再做分阶段权衡。
过往实践中我会先用最小可行方案验证核心假设，拿到可对照的量化指标后再决定是否全量推广；同时提前设定异常降级与边界兜底条件，保证极端场景下业务依然可控。
如果条件不成立，我会先缩回到可验证的那部分结论，而不是硬推一个漂亮的数字。`,
};

/**
 * 按题目领域挑一段贴合的示范回答。
 * @param {{title?: string, track?: string, category?: string, keywords?: string[]}} question
 */
export function getMatchedSampleAnswer(question = {}) {
  const q = question || {};
  const track = String(q.track || '');
  const scope = `${q.category || ''} ${track} ${(q.keywords || []).join(' ')}`;

  // ① 类别名精确命中
  for (const key of Object.keys(SAMPLE_ANSWERS_BY_CATEGORY)) {
    if (key !== 'DEFAULT' && scope.includes(key)) return SAMPLE_ANSWERS_BY_CATEGORY[key];
  }
  // ② 按题库 track 归类（面试通用 / 论文答辩 这两档必须分对）
  if (/论文|答辩/.test(track)) return SAMPLE_ANSWERS_BY_CATEGORY['论文答辩'];
  if (/面试|通用/.test(track)) {
    // 面试通用里也有技术题：先看标题有没有明显技术领域，没有才用通用示范
    const tech = `${q.title || ''} ${q.context || ''} ${scope}`;
    if (/Agent|工具调用|智能体|MCP/i.test(tech)) return SAMPLE_ANSWERS_BY_CATEGORY['AI Agent / 工具调用'];
    if (/RAG|检索|召回|向量|知识库/i.test(tech)) return SAMPLE_ANSWERS_BY_CATEGORY['RAG / 检索增强'];
    if (/后端|系统设计|并发|队列|缓存|存储|架构/i.test(tech)) return SAMPLE_ANSWERS_BY_CATEGORY['后端与系统设计'];
    if (/mean|刻薄|校招|吐槽/i.test(tech)) return SAMPLE_ANSWERS_BY_CATEGORY['通用面试素养·mean'];
    return SAMPLE_ANSWERS_BY_CATEGORY['通用面试素养'];
  }
  // ③ 只看标题/上下文的关键词兜底
  const hay = `${q.title || ''} ${q.context || ''} ${scope}`;
  if (/Agent|工具调用|智能体|MCP/i.test(hay)) return SAMPLE_ANSWERS_BY_CATEGORY['AI Agent / 工具调用'];
  if (/RAG|检索|召回|向量|知识库/i.test(hay)) return SAMPLE_ANSWERS_BY_CATEGORY['RAG / 检索增强'];
  if (/后端|系统设计|并发|队列|缓存|存储|架构|微服务/i.test(hay)) return SAMPLE_ANSWERS_BY_CATEGORY['后端与系统设计'];
  return SAMPLE_ANSWERS_BY_CATEGORY.DEFAULT;
}

/** 诊断标签 / 规则编号：这些不是"论据"，绝不能混进闪卡 */
const DIRTY_SUPPORT = /^(⚠️|💡|命中规则|规则\s*R?\d|R\d+\s*[·:：]|追问抗压不足|开场没破题|缺少量化结果|经历讲得不完整|个人贡献不清晰|时间说法太模糊|没答到点上|口头禅偏多|长短不合适)/;

/** 模板拼接痕迹：读起来像程序填空 */
const TEMPLATE_SMELL = /边界是在\s*\S+\s*这个场景下|这一点我的数据我暂时只能给出/;

/**
 * 清洗一张闪卡：过滤诊断标签类"论据"，并把生硬的模板兜底话术换成自然语言。
 * 只改展示/新建的数据，不动既有库里的字段语义。
 * @param {object} card 闪卡（coreConclusion / supports / fallback …）
 * @param {object} [question]
 * @param {string} [userAnswer] 用户原话（论据被过滤光时用它兜底）
 */
export function sanitizeFlashcardData(card = {}, question = {}, userAnswer = '') {
  const supports = (card.supports || [])
    .map((x) => String(x || '').trim())
    .filter((x) => x.length > 0 && !DIRTY_SUPPORT.test(x))
    .slice(0, 3);

  // 论据被清空时，从用户原话里取前两句实质陈述（至少 12 字），而不是留空
  if (!supports.length && userAnswer) {
    const sentences = String(userAnswer)
      .split(/[。！？\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12)
      .slice(0, 2);
    supports.push(...sentences);
  }

  const track = question?.track || '';
  const isGeneric = /面试通用|通用面试|通用素养/.test(track);
  let fallback = String(card.fallback || '').trim();
  if (!fallback || TEMPLATE_SMELL.test(fallback)) {
    fallback = isGeneric
      ? '以上判断主要基于我过往的项目与团队协作经验；如果换到不同业务阶段或组织文化，我会先看清团队的决策权重，再调整沟通策略。'
      : '这组结论是在当前业务规模与限定前提下验证的；如果并发量级翻倍或数据分布发生漂移，我会先灰度降级并盯住监控告警守住底线，再做针对性调优。';
  }

  return {
    ...card,
    coreConclusion: String(card.coreConclusion || '').trim(),
    supports,
    fallback,
  };
}

/**
 * 有效字数：去掉空白与标点后计数（中英混排都算）。
 * 复盘页两处字数必须用同一个函数，否则用户会怀疑统计不准。
 */
export function countEffectiveChars(text = '') {
  return String(text || '')
    .replace(/[\s\p{P}]/gu, '')
    .length;
}

/**
 * 维度分值格式化：给裸分补上刻度与等级，避免"38"这种没有参照的裸数字。
 * @param {number} score
 */
export function formatDimensionScore(score) {
  const num = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  let badge = '待深化';
  let className = 'score-warn';
  if (num >= 75) {
    badge = '表现扎实';
    className = 'score-good';
  } else if (num >= 50) {
    badge = '基本达标';
    className = 'score-mid';
  }
  return { display: `${num} / 100 分`, badge, className, score: num };
}
