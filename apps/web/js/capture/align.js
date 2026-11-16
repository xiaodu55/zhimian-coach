/**
 * 双轨对齐：把「麦克风（我）」与「系统声音（面试官）」两路转写按时间轴合并成一份带说话人的转写稿。
 * 用途：线上面试时两路物理分离，比任何语音分离算法都可靠。
 */
export function mergeTracks(micSegments = [], systemSegments = [], opts = {}) {
  const overlapMs = opts.overlapMs ?? 800; // 两路时间戳精度有限，允许小幅重叠
  const rows = [
    ...systemSegments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: 'interviewer', text: String(s.text || '').trim() })),
    ...micSegments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: 'me', text: String(s.text || '').trim() })),
  ].filter((r) => r.text);

  rows.sort((a, b) => a.start - b.start || a.end - b.end);

  // 同一时刻两路都在说（抢话）时，保留两条但不合并——真实面试里这正好是要复盘的点
  const merged = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === row.speaker && row.start <= last.end + overlapMs / 1000) {
      last.text = `${last.text}${last.text.endsWith('。') ? '' : ' '}${row.text}`;
      last.end = Math.max(last.end, row.end);
      continue;
    }
    merged.push({ ...row });
  }
  return merged;
}

const LABEL = { me: '我', interviewer: '面试官' };

/** 输出可直接喂给「解析并生成复盘」的转写稿：面试官：… / 我：… */
export function toTranscriptText(merged, opts = {}) {
  const withTime = opts.withTime !== false;
  return merged
    .map((r) => {
      const ts = withTime ? `[${fmt(r.start)}] ` : '';
      return `${ts}${LABEL[r.speaker] || '（未标注）'}：${r.text}`;
    })
    .join('\n');
}

function fmt(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
