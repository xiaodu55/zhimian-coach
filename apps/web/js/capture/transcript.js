/**
 * M4 转写解析模块：说话人标签解析 + Q&A 切分
 */
export function parseTranscriptToQA(rawText, fallbackQuestion = '') {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const interviewerRe = /^(面试官|评委|老师|提问|Q|Interviewer)\s*[:：]\s*(.+)$/i;
  const candidateRe = /^(我|候选人|答辩人|回答|A|Candidate)\s*[:：]\s*(.+)$/i;

  const pairs = [];
  let currentQ = '';
  let currentA = [];
  let hasExplicitSpeaker = false;

  for (const line of lines) {
    const mQ = line.match(interviewerRe);
    const mA = line.match(candidateRe);
    if (mQ) {
      hasExplicitSpeaker = true;
      if (currentQ || currentA.length) {
        pairs.push({ question: currentQ || fallbackQuestion, answer: currentA.join('\n') });
        currentA = [];
      }
      currentQ = mQ[2].trim();
    } else if (mA) {
      hasExplicitSpeaker = true;
      currentA.push(mA[2].trim());
    } else {
      currentA.push(line);
    }
  }

  if (currentQ || currentA.length) {
    pairs.push({ question: currentQ || fallbackQuestion, answer: currentA.join('\n') });
  }

  // 无显式说话人标签时的启发式切分：以问号结尾的短句视为提问
  if (!hasExplicitSpeaker && pairs.length === 1) {
    const sentences = rawText.split(/(?<=[？?。！!])\s*/).filter(Boolean);
    const heuristicPairs = [];
    let qBuf = fallbackQuestion;
    let aBuf = [];
    for (const s of sentences) {
      if (/[？?]$/.test(s) && s.length <= 80 && aBuf.length > 0) {
        heuristicPairs.push({ question: qBuf, answer: aBuf.join('') });
        qBuf = s;
        aBuf = [];
      } else if (/[？?]$/.test(s) && s.length <= 80 && heuristicPairs.length === 0 && aBuf.length === 0) {
        qBuf = s;
      } else {
        aBuf.push(s);
      }
    }
    if (aBuf.length) {
      heuristicPairs.push({ question: qBuf, answer: aBuf.join('') });
    }
    return heuristicPairs.length ? heuristicPairs : pairs;
  }

  return pairs.filter((p) => p.answer.trim().length > 0);
}
