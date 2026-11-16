#!/usr/bin/env python
"""本机转写兜底：用 faster-whisper 把一个音轨转成带时间戳的 JSON。

用法：
  python scripts/asr/transcribe_local.py audio.wav --out out.json [--model small] [--language zh]

说明：
- 首次使用会下载模型（本机 HF 缓存里通常已有 Systran/faster-whisper-small）
- 输出 {"language","duration","segments":[{"start","end","text"}]}，供 local-transcribe.mjs 合并
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('audio')
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='zh')
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print('faster-whisper 未安装：python -m pip install -U faster-whisper', file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device='cpu', compute_type='int8')
    segments, info = model.transcribe(args.audio, language=args.language, vad_filter=False)

    rows = []
    for seg in segments:
        text = (seg.text or '').strip()
        if text:
            rows.append({'start': round(seg.start, 2), 'end': round(seg.end, 2), 'text': text})

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(
            {'language': info.language, 'duration': float(info.duration or 0), 'segments': rows},
            fh,
            ensure_ascii=False,
            indent=2,
        )
    print(json.dumps({'segments': len(rows), 'duration': round(float(info.duration or 0), 2)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
