/**
 * PDF 解析编排：先 pdf-parse，质量不达标再按可用性依次尝试 OCR / Tika / MinerU。
 * 原则：**先测质量再决定升级**，并把"用了哪个引擎、哪里有问题"如实回给前端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error 无类型声明
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { config } from '../../config.js';
import { DocSegment } from '../docParser.js';
import { assessText, normalizeCjkSpacing, QUALITY_THRESHOLD, TextQuality } from './quality.js';

export type PdfEngine = 'pdf-parse' | 'local-ocr' | 'tika' | 'mineru';

export interface PdfParseResult {
  title: string;
  pages: number;
  segments: DocSegment[];
  engine: PdfEngine;
  quality: TextQuality;
  attempts: Array<{ engine: PdfEngine; score: number; issues: string[]; error?: string }>;
}

interface PageText {
  page: number;
  text: string;
}

function pagesToSegments(pages: PageText[]): DocSegment[] {
  const segments: DocSegment[] = [];
  let idx = 1;
  for (const { page, text } of pages) {
    const clean = normalizeCjkSpacing(String(text || '')).trim();
    if (!clean) continue;
    const paras = clean
      .split(/\n{1,}|(?<=[。！？；])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 15);
    paras.forEach((para, i) => {
      segments.push({
        id: `seg-${idx++}`,
        locator: `p${page}¶${i + 1}`,
        heading: `第 ${page} 页`,
        text: para,
        type: 'doc',
      });
    });
  }
  return segments;
}

/** pdf-parse 传给 pagerender 的最小形状（只用到 getTextContent） */
interface PdfPageData {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}

async function withPdfParse(buffer: Buffer): Promise<PageText[]> {
  const pages: PageText[] = [];
  const data = await pdfParse(buffer, {
    pagerender: async (pageData: PdfPageData) => {
      const content = await pageData.getTextContent();
      const text = content.items.map((it) => it.str ?? '').join(' ');
      pages.push({ page: pages.length + 1, text });
      return text;
    },
  });
  return pages.length ? pages : [{ page: 1, text: data.text || '' }];
}

/** 本地 OCR：PyMuPDF 渲染 + RapidOCR（容器里通常不可用 → 会明确失败，不假装） */
function withLocalOcr(buffer: Buffer, filename: string): PageText[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-pdf-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const outPath = path.join(tmpDir, 'ocr.json');
  fs.writeFileSync(pdfPath, buffer);
  const script = path.join(config.repoRoot, 'scripts/pdf/ocr_fallback.py');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const res = spawnSync(py, [script, pdfPath, '--out', outPath], { encoding: 'utf8', timeout: 180_000 });
  if (res.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(String(res.stderr || '').split('\n').slice(-2).join(' ').slice(0, 200) || '本地 OCR 失败');
  }
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8')) as { pages: PageText[] };
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return parsed.pages || [];
}

/** Apache Tika：自建 tika-server（docker run -p 9998:9998 apache/tika），走 /tika 纯文本输出 */
async function withTika(buffer: Buffer, filename: string): Promise<PageText[]> {
  if (!config.tikaUrl) throw new Error('未配置 TIKA_URL');
  const res = await fetch(`${config.tikaUrl.replace(/\/+$/, '')}/tika`, {
    method: 'PUT',
    headers: {
      Accept: 'text/plain',
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Tika 返回 ${res.status}`);
  const text = await res.text();
  // Tika 纯文本用 \f 分页
  return text.split('\f').map((t, i) => ({ page: i + 1, text: t }));
}

/**
 * MinerU（自建服务）：契约按最常见的自托管形态实现 —— POST multipart(file) → { md_content | content | text }
 * 若你的 MinerU 版本返回结构不同，只需在此适配一处。
 */
async function withMineru(buffer: Buffer, filename: string): Promise<PageText[]> {
  if (!config.mineruUrl) throw new Error('未配置 MINERU_URL');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), filename);
  form.append('return_content', 'true');
  const res = await fetch(`${config.mineruUrl.replace(/\/+$/, '')}/file_parse`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`MinerU 返回 ${res.status}`);
  const data = (await res.json()) as unknown;
  const pick = (key: string): string => {
    if (data && typeof data === 'object' && key in data) {
      const v = (data as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : '';
    }
    return '';
  };
  const md = pick('md_content') || pick('content') || pick('text');
  if (!md.trim()) throw new Error('MinerU 返回空内容');
  // Markdown 用标题切页无意义 → 按标题分块，页码统一记 1（定位符仍可用 §n）
  return md.split(/\n(?=#{1,3}\s)/).map((t: string, i: number) => ({ page: i + 1, text: t }));
}

export async function parsePdfSmart(filename: string, buffer: Buffer): Promise<PdfParseResult> {
  const attempts: PdfParseResult['attempts'] = [];
  let best: { engine: PdfEngine; pages: PageText[]; quality: TextQuality } | null = null;

  const tryEngine = async (engine: PdfEngine, run: () => Promise<PageText[]>) => {
    try {
      const pages = await run();
      const joined = pages.map((p) => p.text).join('\n');
      const quality = assessText(joined);
      attempts.push({ engine, score: quality.score, issues: quality.issues });
      if (!best || quality.score > best.quality.score) best = { engine, pages, quality };
      return quality.score >= QUALITY_THRESHOLD;
    } catch (err) {
      attempts.push({
        engine,
        score: 0,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  if (await tryEngine('pdf-parse', () => withPdfParse(buffer))) {
    // 质量已达标：不再花时间做 OCR
  } else {
    if (config.pdfOcrEnabled) await tryEngine('local-ocr', async () => withLocalOcr(buffer, filename));
    if (config.tikaUrl) await tryEngine('tika', () => withTika(buffer, filename));
    if (config.mineruUrl) await tryEngine('mineru', () => withMineru(buffer, filename));
  }

  if (!best) {
    throw new Error(
      `PDF 解析失败：${attempts.map((a) => `${a.engine}(${a.error || '质量 ' + a.score})`).join('；')}`
    );
  }

  const chosen = best as { engine: PdfEngine; pages: PageText[]; quality: TextQuality };
  const segments = pagesToSegments(chosen.pages);
  if (!segments.length) {
    throw new Error('该 PDF 未能提取出可用文本（疑似扫描件且 OCR 不可用），可改用 MinerU / Tika 或上传 Markdown');
  }

  return {
    title: filename,
    pages: chosen.pages.length,
    segments,
    engine: chosen.engine,
    quality: chosen.quality,
    attempts,
  };
}
