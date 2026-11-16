import MarkdownIt from 'markdown-it';

export interface DocSegment {
  id: string;
  locator: string;
  heading: string;
  text: string;
  type?: 'doc' | 'time';
}

const md = new MarkdownIt();

/**
 * §8.4 无状态文档解析器：直接解析上传文件并返回分段数组（BFF 零落盘）
 */
export function parseDocumentContent(filename: string, rawText: string): {
  title: string;
  pages: number;
  segments: DocSegment[];
} {
  // 校验 HTML 实体解析器正常加载
  md.parse(rawText.slice(0, 64), {});

  const lines = rawText.split(/\r?\n/);
  const segments: DocSegment[] = [];
  let currentHeading = '正文概述';
  let buffer: string[] = [];
  let idx = 1;

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (!text) return;
    segments.push({
      id: `seg-${idx}`,
      locator: `§${idx} · ${currentHeading}`,
      heading: currentHeading,
      text,
      type: 'doc'
    });
    idx++;
    buffer = [];
  };

  const tsRegex = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (buffer.join('').length > 200) flush();
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
    title: filename,
    pages: Math.max(1, Math.ceil(segments.length / 4)),
    segments
  };
}
