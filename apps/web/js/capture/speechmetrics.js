/**
 * 时长与语速基础数据
 *
 * 只做"算得准 + 说得清"两件事：给用户一个可核对的时长/语速基线，
 * 并把"这次答得怎么样"翻译成一句能立刻照做的建议。
 *
 * 计数口径（为什么这样定）：
 *   - 中文按字计：汉字一字一数（面试应答以中文为主，字数最能反映信息量）；
 *   - 英文/数字按词计：连续一段 [A-Za-z0-9] 记 1，避免英文术语把字数灌水。
 */

/** 语速阈值（字/分钟）
 *  - < 180 偏慢：中文口头应答低于这个数，面试官能明显感到"在找词"，通常意味着没有提前组织结构；
 *  - 180–320 适中：常见面试应答区间，约每分钟 180–320 字，够讲清一个完整论点；
 *  - > 320 偏快：高于这个数，评委多半跟不上，重点会被稀释。
 * 经验值，允许随样本调整，但调整必须在注释里写明理由。
 */
export const CPM_SLOW = 180;
export const CPM_FAST = 320;

/**
 * 统计字数：汉字一字一数，英文/数字连续段记 1。
 * @param {string} text
 * @returns {number}
 */
export function countChars(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

/**
 * 时长格式化：秒 → "1分40秒" / "45秒" / "2分"
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

/** verdict 用的带空格写法："1 分 40 秒" */
function formatDurationSpaced(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

/**
 * 把 expectedLength 归一成 {min, max}。
 * 支持 [min,max] 数组、数字、或 {min,max} 对象；缺失时返回 null。
 */
function normalizeExpected(expectedLength) {
  if (expectedLength === null || expectedLength === undefined) return null;
  if (Array.isArray(expectedLength)) {
    const nums = expectedLength.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return null;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return { min, max };
  }
  if (typeof expectedLength === 'object') {
    const min = Number(expectedLength.min ?? expectedLength[0]);
    const max = Number(expectedLength.max ?? expectedLength[1] ?? expectedLength.min ?? expectedLength[0]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
    return { min: Math.min(min, max), max: Math.max(min, max) };
  }
  const n = Number(expectedLength);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { min: n, max: n };
}

/**
 * 计算时长与语速，并给出一句结论 + 一句可执行建议。
 *
 * @param {object} p
 * @param {number} p.durationSec 录音/作答时长（秒）
 * @param {string} p.text          转写文本（用于算字数）
 * @param {number|number[]} p.expectedLength 期望字数区间（题库里通常是 [min,max]）
 * @returns {{durationSec:number, charCount:number, cpm:number, pace:'偏慢'|'适中'|'偏快', verdict:string, suggestion:string}}
 */
export function computeSpeechMetrics({ durationSec, text, expectedLength } = {}) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const charCount = countChars(text);
  const minutes = dur / 60;
  // 时长为 0 时没有可测的语速；按阈值规则 cpm=0 落在"偏慢"区间，结论里会带出时长异常
  const cpm = minutes > 0 ? Math.round(charCount / minutes) : 0;
  const pace = cpm < CPM_SLOW ? '偏慢' : cpm <= CPM_FAST ? '适中' : '偏快';

  const verdict = `时长 ${formatDurationSpaced(dur)} · 语速${pace}`;

  const exp = normalizeExpected(expectedLength);
  let lengthAdvice;
  if (!exp) {
    lengthAdvice = '没有可比的期望字数，先按"结论 + 一条依据 + 一个数字"的三段式自检';
  } else if (charCount < exp.min) {
    const gap = exp.min - charCount;
    lengthAdvice = `篇幅偏短（${charCount} 字，比下限少 ${gap} 字），补齐到 ${exp.min} 字以上：加一个具体数字和一条能核对的依据`;
  } else if (charCount > exp.max) {
    const over = charCount - exp.max;
    lengthAdvice = `篇幅偏长（${charCount} 字，比上限多 ${over} 字），压回 ${exp.max} 字以内：背景铺垫砍成一句，只留结论与依据`;
  } else {
    lengthAdvice = `篇幅合适（${charCount} 字，落在 ${exp.min}–${exp.max} 区间），保持这个信息密度`;
  }

  let paceAdvice;
  if (pace === '偏慢') {
    paceAdvice = `语速偏慢（${cpm} 字/分），把长停顿换成短句，先抛结论再补依据`;
  } else if (pace === '偏快') {
    paceAdvice = `语速偏快（${cpm} 字/分），放慢半拍，在关键数字和边界条件后各留一次停顿`;
  } else {
    paceAdvice = `语速适中（${cpm} 字/分），保持"结论先行、依据后置"的节奏`;
  }

  return {
    durationSec: dur,
    charCount,
    cpm,
    pace,
    verdict,
    suggestion: `${lengthAdvice}；${paceAdvice}`,
  };
}
