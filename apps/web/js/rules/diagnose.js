import { RULES_CATALOG } from './rules.js';

/**
 * 执行全部 10 条确定性诊断规则，保证每条结论都绑定原话与字符区间
 */
export function runDeterministicRules(answer, context = {}) {
  const cleanAnswer = String(answer || '').trim();
  if (!cleanAnswer) return [];

  const findings = [];
  for (const rule of RULES_CATALOG) {
    const res = rule.check(cleanAnswer, context);
    if (res && res.quote) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        quote: res.quote,
        range: res.range || [0, res.quote.length],
        suggestion: res.suggestion
      });
    }
  }
  return findings;
}
