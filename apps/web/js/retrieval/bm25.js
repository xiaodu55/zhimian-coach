/**
 * 纯前端轻量级 BM25 / 词项覆盖检索器（F3 讲解追问第一跳：文档内精准召回）
 */
function tokenize(text) {
  const clean = String(text || '').toLowerCase();
  const enWords = clean.match(/[a-z0-9_]+/g) || [];
  const zhChars = clean.replace(/[^一-龥]/g, '').split('');
  const bigrams = [];
  for (let i = 0; i < zhChars.length - 1; i++) {
    bigrams.push(zhChars[i] + zhChars[i + 1]);
  }
  return [...enWords, ...zhChars, ...bigrams];
}

export function searchSegmentsBM25(segments, query, topK = 3) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !segments.length) return [];

  const docs = segments.map((seg) => {
    const tokens = tokenize(seg.text + ' ' + seg.heading);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { seg, tokens, tf, len: tokens.length };
  });

  const avgdl = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  const N = docs.length;
  const k1 = 1.5;
  const b = 0.75;

  const scored = docs.map((doc) => {
    let score = 0;
    for (const qt of qTokens) {
      const f = doc.tf.get(qt) || 0;
      if (!f) continue;
      const df = docs.filter((d) => d.tf.has(qt)).length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.len / Math.max(1, avgdl)))));
    }
    return { segment: doc.seg, score };
  });

  return scored
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
