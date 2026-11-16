/**
 * §10 规则层（10 条确定性诊断规则，纯前端可跑，输出必须附带原话字符区间 [start, end]）
 */
export const RULES_CATALOG = [
  {
    id: 'followup_unresolved',
    name: 'R1 · 连续追问焦点未覆盖',
    severity: 'red',
    check(answer, ctx) {
      if (!ctx.followupFocus) return null;
      const hit = ctx.followupFocus.split(/\s+/).some((kw) => kw && answer.includes(kw));
      if (hit) return null;
      return {
        quote: answer.slice(0, Math.min(40, answer.length)),
        range: [0, Math.min(40, answer.length)],
        suggestion: `追问焦点集中在「${ctx.followupFocus}」，建议首句直接正面回应核心指标或边界条件。`
      };
    }
  },
  {
    id: 'no_metric',
    name: 'R2 · 缺乏量化数字/指标支撑',
    severity: 'red',
    check(answer) {
      const numMatch = answer.match(/\d+(\.\d+)?(%|倍|ms|s|秒|分钟|万|千|百|个|条|次|GB|MB)?/);
      if (numMatch) return null;
      const end = Math.min(answer.length, 48);
      return {
        quote: answer.slice(0, end),
        range: [0, end],
        suggestion: '整段回答未出现任何量化数字。建议补充延迟（如 P99 < 120ms）、准确率提升幅度或数据规模。'
      };
    }
  },
  {
    id: 'metric_no_baseline',
    name: 'R3 · 给出数字但缺失对比基线/口径',
    severity: 'amber',
    check(answer) {
      const numMatch = answer.match(/[^\n。！？]*\d+(\.\d+)?%[^\n。！？]*/);
      if (!numMatch) return null;
      const sentence = numMatch[0];
      const hasBaseline = /(相比|对比|基线|baseline|原来|之前|提升|下降|从.+到)/i.test(sentence);
      if (hasBaseline) return null;
      const start = numMatch.index ?? 0;
      return {
        quote: sentence.trim(),
        range: [start, start + sentence.length],
        suggestion: '出现了百分比指标，但未说明评测集规模或优化前基线（例如：在 220 条测试集上从 62% 提升至 93%）。'
      };
    }
  },
  {
    id: 'star_missing',
    name: 'R4 · STAR 结构要素不足 3 项',
    severity: 'amber',
    check(answer) {
      const hasS = /(背景|场景|当时|项目|业务|遇到)/.test(answer);
      const hasT = /(目标|需要|解决|负责|要求|挑战)/.test(answer);
      const hasA = /(通过|采用|设计|实现|拆分|引入|重构)/.test(answer);
      const hasR = /(最终|结果|提升|降低|落地|上线|收益)/.test(answer);
      const count = [hasS, hasT, hasA, hasR].filter(Boolean).length;
      if (count >= 3) return null;
      const end = Math.min(answer.length, 45);
      return {
        quote: answer.slice(0, end),
        range: [0, end],
        suggestion: `当前仅命中 ${count}/4 个 STAR 要素，建议补齐「背景痛点 → 核心动作 → 量化结果」闭环。`
      };
    }
  },
  {
    id: 'we_not_i',
    name: 'R5 · 「我们」多于「我」（个人贡献模糊）',
    severity: 'amber',
    check(answer) {
      const weMatches = [...answer.matchAll(/我们/g)];
      const allIMatches = [...answer.matchAll(/我/g)];
      // 扣除“我们”中包含的“我”，避免重复计数
      const pureICount = Math.max(0, allIMatches.length - weMatches.length);
      if (weMatches.length <= pureICount) return null;
      const firstWe = weMatches[0];
      const start = firstWe.index ?? 0;
      const snippet = answer.slice(Math.max(0, start - 8), Math.min(answer.length, start + 24));
      return {
        quote: snippet,
        range: [start, start + 2],
        suggestion: `全篇出现 ${weMatches.length} 次「我们」，仅 ${pureICount} 次「我」。建议明确区分团队分工与你个人主导的设计决策。`
      };
    }
  },
  {
    id: 'vague_time',
    name: 'R6 · 使用无锚点模糊时间词',
    severity: 'amber',
    check(answer) {
      const m = answer.match(/(之前|一段时间|后来|之后|某次)/);
      if (!m) return null;
      const start = m.index ?? 0;
      const snippet = answer.slice(Math.max(0, start - 6), Math.min(answer.length, start + 18));
      return {
        quote: snippet,
        range: [start, start + m[0].length],
        suggestion: `检测到模糊时间词「${m[0]}」，建议替换为具体周期或迭代阶段（如“压测第 2 周”或“V1 上线前”）。`
      };
    }
  },
  {
    id: 'off_topic',
    name: 'R7 · 题目核心关键词覆盖率偏低',
    severity: 'red',
    check(answer, ctx) {
      const keywords = ctx.keywords || [];
      if (!keywords.length) return null;
      const lower = answer.toLowerCase();
      const hits = keywords.filter((kw) => lower.includes(String(kw).toLowerCase()));
      const ratio = hits.length / keywords.length;
      if (ratio >= 0.25) return null;
      const end = Math.min(answer.length, 40);
      return {
        quote: answer.slice(0, end),
        range: [0, end],
        suggestion: `仅命中 ${hits.length}/${keywords.length} 个核心考点词（建议覆盖：${keywords.slice(0, 4).join('、')}）。`
      };
    }
  },
  {
    id: 'filler_density',
    name: 'R8 · 口头禅/填充词密度过高',
    severity: 'amber',
    check(answer) {
      const matches = [...answer.matchAll(/(嗯|啊|那个|就是|然后)/g)];
      const density = (matches.length / Math.max(1, answer.length)) * 100;
      if (matches.length < 3 || density < 2.2) return null;
      const first = matches[0];
      const start = first.index ?? 0;
      return {
        quote: answer.slice(Math.max(0, start - 4), Math.min(answer.length, start + 22)),
        range: [start, start + first[0].length],
        suggestion: `检测到 ${matches.length} 处口头填充词（密度 ${density.toFixed(1)}/百字），停顿思考时可用短暂静音替代“嗯/那个”。`
      };
    }
  },
  {
    id: 'length_mismatch',
    name: 'R9 · 回答篇幅与题型预期不匹配',
    severity: 'amber',
    check(answer, ctx) {
      const [minLen, maxLen] = ctx.expectedLength || [120, 500];
      if (answer.length >= minLen && answer.length <= maxLen) return null;
      const isShort = answer.length < minLen;
      return {
        quote: answer.slice(0, Math.min(36, answer.length)),
        range: [0, Math.min(36, answer.length)],
        suggestion: isShort
          ? `当前仅 ${answer.length} 字（建议 ${minLen}–${maxLen} 字），论据展开不足，建议补充架构权衡与边界案例。`
          : `当前已达 ${answer.length} 字（建议 ${minLen}–${maxLen} 字），信息密度偏散，建议采用“结论先行 + 三点支撑”压缩表达。`
      };
    }
  },
  {
    id: 'no_restate',
    name: 'R10 · 开场前 20 字未破题/确认焦点',
    severity: 'amber',
    check(answer, ctx) {
      const head = answer.slice(0, 24);
      const keywords = ctx.keywords || [];
      const hitHead = keywords.some((kw) => head.toLowerCase().includes(String(kw).toLowerCase()));
      const hasStructHead = /(核心|本质|首先|第一|简单来说|结论)/.test(head);
      if (hitHead || hasStructHead) return null;
      return {
        quote: head,
        range: [0, head.length],
        suggestion: '开场前 20 字仍在铺垫寒暄，建议第一句话直接点明核心结论或复述问题边界。'
      };
    }
  }
];
