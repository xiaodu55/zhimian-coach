/**
 * PDF 文本质量评估：用来判断"这次解析能不能用"，而不是解析完就当真。
 * 触发兜底（OCR / Tika / MinerU）的依据全部来自这里的可量化指标。
 */
export interface TextQuality {
  score: number; // 0–100
  issues: string[];
  stats: {
    chars: number;
    cjkChars: number;
    cjkGapRatio: number; // 汉字间空格占比（pdf.js 常见瑕疵）
    replacementRatio: number; // 乱码字符比例
    controlRatio: number; // 控制字符比例
    avgLineLength: number;
    uniqueLineRatio: number; // 重复行比例（OCR 常出现）
  };
}

const CJK = /[\u4e00-\u9fa5]/g;

/** 折叠「汉字 + 空格 + 汉字」：pdf.js 抽中文会在字间插空格 */
export function normalizeCjkSpacing(text: string): string {
  let out = text;
  const re = /([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g;
  for (let i = 0; i < 6; i += 1) {
    const next = out.replace(re, '$1');
    if (next === out) break;
    out = next;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

export function assessText(rawText: string): TextQuality {
  const text = String(rawText || '');
  const chars = text.replace(/\s/g, '').length;
  const cjkChars = (text.match(CJK) || []).length;
  // 归一化前统计，才能看出 pdf.js 的字间空格问题
  const gaps = (text.match(/[\u4e00-\u9fa5]\s+[\u4e00-\u9fa5]/g) || []).length;
  const cjkGapRatio = cjkChars ? gaps / cjkChars : 0;
  const replacementRatio = chars ? (text.match(/\uFFFD/g) || []).length / chars : 0;
  const controlRatio = chars ? (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length / chars : 0;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const avgLineLength = lines.length ? lines.reduce((s, l) => s + l.length, 0) / lines.length : 0;
  const uniqueLineRatio = lines.length ? new Set(lines).size / lines.length : 0;

  const issues: string[] = [];
  let score = 100;

  if (chars < 50) {
    issues.push('可提取文本过少（疑似扫描件/纯图片 PDF）');
    score -= 55;
  }
  if (cjkChars > 20 && cjkGapRatio > 0.25) {
    issues.push(`汉字间存在大量空格（${(cjkGapRatio * 100).toFixed(0)}%）`);
    score -= 25;
  }
  if (replacementRatio > 0.1) {
    // 三成以上是乱码基本等于没解析出来：这种文本喂给检索/模型只会污染结果
    issues.push(`乱码字符比例过高 ${(replacementRatio * 100).toFixed(1)}%`);
    score -= 45;
  } else if (replacementRatio > 0.02) {
    issues.push(`乱码字符比例 ${(replacementRatio * 100).toFixed(1)}%`);
    score -= 30;
  }
  if (controlRatio > 0.01) {
    issues.push('含异常控制字符');
    score -= 15;
  }
  if (lines.length > 5 && uniqueLineRatio < 0.5) {
    issues.push('重复行偏多（OCR 抖动常见）');
    score -= 15;
  }
  if (lines.length > 3 && avgLineLength < 8) {
    issues.push('行均长度过短，可能是竖排/表格错位');
    score -= 10;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    issues,
    stats: {
      chars,
      cjkChars,
      cjkGapRatio: Number(cjkGapRatio.toFixed(3)),
      replacementRatio: Number(replacementRatio.toFixed(4)),
      controlRatio: Number(controlRatio.toFixed(4)),
      avgLineLength: Number(avgLineLength.toFixed(1)),
      uniqueLineRatio: Number(uniqueLineRatio.toFixed(3)),
    },
  };
}

export const QUALITY_THRESHOLD = 70;
