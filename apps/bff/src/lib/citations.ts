/**
 * §8.3 引用协议后处理校验器（防编造核心防线）
 * 校验结构化输出中的 refIds 是否全部落在合法来源集合 validSourceIds 内；越界条目直接丢弃并计数
 */
export interface ClaimItem {
  claim: string;
  basis: '原文直述' | '外部佐证' | '推断';
  refIds: string[];
  inferenceReason?: string;
}

export function validateStructuredClaims(
  items: ClaimItem[],
  validSourceIds: Set<string>
): { accepted: ClaimItem[]; droppedByValidator: number } {
  const accepted: ClaimItem[] = [];
  let droppedByValidator = 0;

  for (const item of items || []) {
    if (!item || typeof item.claim !== 'string' || !item.claim.trim()) {
      droppedByValidator++;
      continue;
    }

    const refs = Array.isArray(item.refIds) ? item.refIds.map((r) => String(r).trim()) : [];
    const allRefsValid = refs.every((id) => validSourceIds.has(id));

    if (!allRefsValid) {
      droppedByValidator++;
      continue;
    }

    // basis 枚举强校验：模型偶尔把"理由"整段塞进 basis（实测），这里做规范化而不是放行：
    //  - 合法枚举 → 原样
    //  - 非法但带合法引用 → 视为"外部佐证"，原文转存 inferenceReason 以便审计
    //  - 非法且无引用 → 丢弃（既没依据也没标注，属于不可核对结论）
    const ALLOWED_BASIS = ['原文直述', '外部佐证', '推断'];
    let basis: ClaimItem['basis'] | '' = (item.basis || '').trim() as ClaimItem['basis'];
    let inferenceReason = item.inferenceReason;
    if (!ALLOWED_BASIS.includes(basis)) {
      const raw = basis;
      basis = refs.length ? '外部佐证' : '';
      if (!inferenceReason && raw) inferenceReason = raw;
      if (!basis) {
        droppedByValidator++;
        continue;
      }
    }

    if (basis === '推断') {
      if (!inferenceReason || !String(inferenceReason).trim()) {
        droppedByValidator++;
        continue;
      }
      accepted.push({ ...item, basis, inferenceReason, refIds: refs });
      continue;
    }

    // 非推断类必须至少锚定 1 个合法来源编号
    if (refs.length === 0) {
      droppedByValidator++;
      continue;
    }

    accepted.push({ ...item, basis, refIds: refs });
  }

  return { accepted, droppedByValidator };
}
