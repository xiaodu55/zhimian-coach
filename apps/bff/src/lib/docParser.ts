import MarkdownIt from 'markdown-it';
// pdf-parse 的 index.js 会执行调试代码，直接引 lib 入口（官方 README 同款做法）
// @ts-expect-error 无类型声明
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export interface DocSegment {
  id: string;
  locator: string;
  heading: string;
  text: string;
  type?: 'doc' | 'time';
}

const md = new MarkdownIt();

/**
 * 中文 PDF 抽文本时 pdf.js 会在每个汉字之间插空格（实测：'AI 应 用 工 程 师'），
 * 不归一化会让检索、引用、错题匹配全部失真。这里反复折叠「汉字 + 空格 + 汉字」。
 */
function normalizeCjkSpacing(text: string): string {
  let out = text;
  const cjkSpace = /([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g;
  for (let i = 0; i < 6; i += 1) {
    const next = out.replace(cjkSpace, '$1');
    if (next === out) break;
    out = next;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

/** 逐页解析 PDF：定位符 p{页码}¶{段号}；无文本层（扫描件）明确报错 */
export async function parsePdfBuffer(
  filename: string,
  buffer: Buffer
): Promise<{ title: string; pages: number; segments: DocSegment[] }> {
  const pageTexts: string[] = [];
  const data = await pdfParse(buffer, {
    pagerender: async (pageData: any) => {
      const content = await pageData.getTextContent();
      const str = content.items.map((it: any) => it.str || '').join(' ');
      pageTexts.push(str);
      return str;
    },
  });

  const total = pageTexts.join('').replace(/\s/g, '');
  if (total.length < 50) {
    throw new Error('该 PDF 没有可提取的文本层（疑似扫描件/图片版），请上传可复制文本的 PDF 或 Markdown 版本');
  }

  const segments: DocSegment[] = [];
  let idx = 1;
  pageTexts.forEach((raw, pageIdx) => {
    const text = normalizeCjkSpacing(raw).trim();
    if (!text) return;
    const paras = text
      .split(/\n{1,}|(?<=[。！？；])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20);
    paras.forEach((para, paraIdx) => {
      segments.push({
        id: `seg-${idx++}`,
        locator: `p${pageIdx + 1}¶${paraIdx + 1}`,
        heading: `第 ${pageIdx + 1} 页`,
        text: para,
        type: 'doc',
      });
    });
  });

  return { title: filename, pages: data.numpages || pageTexts.length, segments };
}

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
