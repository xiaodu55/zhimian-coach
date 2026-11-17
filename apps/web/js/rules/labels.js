/**
 * 规则编号 → 人话标签。
 *
 * 为什么要有这层：界面上一旦出现「R4 · STAR 结构要素不足 3 项」这类内部编号，
 * 普通求职者第一反应是"这是什么黑话"。规则编号只保留在代码与日志里，
 * 用户看到的一律是「⚠️ 追问抗压不足」这种人话 + 一句可执行建议。
 */

/** ruleId → { icon, label } */
export const RULE_LABELS = {
  followup_unresolved: { icon: '⚠️', label: '追问抗压不足' },
  no_metric: { icon: '⚠️', label: '缺少量化结果' },
  metric_no_baseline: { icon: '💡', label: '有数字但没基线' },
  star_missing: { icon: '💡', label: '经历讲得不完整' },
  we_not_i: { icon: '💡', label: '个人贡献不清晰' },
  vague_time: { icon: '💡', label: '时间说法太模糊' },
  off_topic: { icon: '⚠️', label: '没答到点上' },
  filler_density: { icon: '💡', label: '口头禅偏多' },
  length_mismatch: { icon: '💡', label: '长短不合适' },
  no_restate: { icon: '💡', label: '开场没破题' },
};

/** 兼容旧数据：按 name 里的「R数字」反查 ruleId */
const BY_INDEX = {
  R1: 'followup_unresolved',
  R2: 'no_metric',
  R3: 'metric_no_baseline',
  R4: 'star_missing',
  R5: 'we_not_i',
  R6: 'vague_time',
  R7: 'off_topic',
  R8: 'filler_density',
  R9: 'length_mismatch',
  R10: 'no_restate',
};

/**
 * 把一条诊断（或它的 id / name）翻译成人话标签。
 * @returns {{icon: string, label: string}}
 */
export function humanizeRule(rule) {
  if (!rule) return { icon: '💡', label: '可优化' };
  const id = typeof rule === 'string' ? rule : rule.ruleId || '';
  const name = typeof rule === 'string' ? rule : rule.ruleName || rule.name || '';
  if (RULE_LABELS[id]) return RULE_LABELS[id];
  const m = String(name).match(/\bR(\d+)\b/);
  if (m && BY_INDEX[`R${m[1]}`]) return RULE_LABELS[BY_INDEX[`R${m[1]}`]];
  // 兜底：把 "R4 · xxx" 里的编号前缀剥掉，只留人类描述
  return { icon: '💡', label: String(name).replace(/^R\d+\s*[·:：-]\s*/, '').trim() || '可优化' };
}

/** 一组诊断 → 一行人类可读摘要（用于闪卡、卡片副标题） */
export function summarizeFindings(findings, limit = 3) {
  return (findings || [])
    .slice(0, limit)
    .map((f) => humanizeRule(f).label)
    .filter(Boolean);
}
