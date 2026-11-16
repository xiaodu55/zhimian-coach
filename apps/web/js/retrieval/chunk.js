/**
 * §8.4 文档与视频转写稿分段器（带页码/时间戳定位符）
 */
export function chunkDocumentText(rawText, title = '未命名资料') {
  const lines = String(rawText || '').split(/\r?\n/);
  const segments = [];
  let currentHeading = '概述';
  let buffer = [];
  let idx = 1;

  const flush = (locatorOverride = null) => {
    const text = buffer.join('\n').trim();
    if (!text) return;
    segments.push({
      id: `seg-${idx}`,
      locator: locatorOverride || `§${idx} · ${currentHeading}`,
      heading: currentHeading,
      text
    });
    idx++;
    buffer = [];
  };

  const tsRegex = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (buffer.join('').length > 180) flush();
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      flush();
      currentHeading = line.replace(/^#{1,3}\s+/, '').trim();
      continue;
    }
    const tsMatch = line.match(tsRegex);
    if (tsMatch) {
      flush();
      segments.push({
        id: `seg-${idx}`,
        locator: `⏱ ${tsMatch[1]}`,
        heading: '视频时间戳片段',
        text: tsMatch[2].trim(),
        type: 'time'
      });
      idx++;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return {
    id: 'doc-' + Date.now(),
    title,
    createdAt: new Date().toISOString(),
    segments
  };
}
