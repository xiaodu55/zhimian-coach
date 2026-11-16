#!/usr/bin/env python
"""扫描版 PDF 的本地 OCR 兜底：PyMuPDF 渲染每页 → RapidOCR 识别 → 按页返回文本。

用法：
  python scripts/pdf/ocr_fallback.py input.pdf --out out.json [--dpi 200] [--max-pages 30]

输出：{"pages":[{"page":1,"text":"..."}],"engine":"rapidocr"}
说明：
- 本机依赖：pymupdf + rapidocr_onnxruntime（本项目开发机已具备）
- 容器里通常没有这两个依赖 → 服务端会显式降级，不会假装 OCR 成功
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--out', required=True)
    ap.add_argument('--dpi', type=int, default=200)
    ap.add_argument('--max-pages', type=int, default=30)
    args = ap.parse_args()

    try:
        import pymupdf as fitz  # PyMuPDF 1.24+ 推荐导入名
    except ImportError:
        try:
            import fitz  # 旧版本
        except ImportError:
            print('缺少 PyMuPDF：python -m pip install pymupdf', file=sys.stderr)
            return 2
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        print('缺少 RapidOCR：python -m pip install rapidocr_onnxruntime', file=sys.stderr)
        return 2

    doc = fitz.open(args.pdf)
    engine = RapidOCR()
    pages = []

    for page_index in range(min(len(doc), args.max_pages)):
        page = doc[page_index]
        pix = page.get_pixmap(dpi=args.dpi)
        # RapidOCR 接受 numpy 数组；用 png 字节更稳，避免额外依赖 numpy
        png_bytes = pix.tobytes('png')
        result, _elapsed = engine(png_bytes)
        text = '\n'.join(item[1] for item in (result or []))
        pages.append({'page': page_index + 1, 'text': text})

    doc.close()
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump({'engine': 'rapidocr', 'pages': pages}, fh, ensure_ascii=False)
    print(json.dumps({'engine': 'rapidocr', 'pages': len(pages), 'chars': sum(len(p['text']) for p in pages)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
