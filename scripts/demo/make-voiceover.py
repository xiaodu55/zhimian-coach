#!/usr/bin/env python
"""
给演示视频配 AI 旁白（本地 Piper TTS，纯 CPU、不联网上传）。

为什么这么做：视频是自动录屏出来的，没有人声，提交时要自己配。
本地能用的方案只有这几个：
  - edge-tts（微软在线）：音色好，但合成端点 speech.platform.bing.com 在本机网络下不通；
  - Windows SAPI Huihui：离线，但音色是 Vista 时代的机械音；
  - Piper（本地 onnx）：zh_CN-huayan-medium，22kHz，合成比实时快 20 倍，质量明显好于 SAPI。

人味处理（不靠调参玄学，靠三件具体的事）：
  1) 逐段按画面时长反推语速：length_scale = 自然时长 / 可用时长，夹在 0.85~1.15，
     太长就加速、太空就放慢，而不是全片统一语速（统一语速最像机器人）；
  2) 每段末尾留 0.25s 静音，段间再留 0.35s，听感上像人在换气；
  3) 数字与英文缩写逐个读得清楚（14.2% 读「百分之十四点二」，P99 读「P 九十九」），
     这是中文 TTS 最容易糊弄过去、但评委最容易听出来的地方。

用法：python scripts/demo/make-voiceover.py [--video out/xxx.mp4] [--out out/xxx-vo.mp4]
"""
import argparse
import json
import math
import os
import subprocess
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FFMPEG = r"D:/college/ffmpeg/bin/ffmpeg.exe"
FFPROBE = r"D:/college/ffmpeg/bin/ffprobe.exe"

# TTS 前处理：把"念不顺"的写法换成能被读好的写法
PRONOUNCE = [
    ("14.2%", "百分之十四点二"),
    ("1.8%", "百分之一点八"),
    ("P99", "P 九十九"),
    ("AI", "A I"),
    ("知乎", "知乎"),
    ("——", "，"),
    ("「", ""),
    ("」", ""),
]


def normalize(text: str) -> str:
    for a, b in PRONOUNCE:
        text = text.replace(a, b)
    return text.replace("  ", " ").strip()


def synth(voice, text, out_path, length_scale=None):
    """合成一段，返回 (时长秒, 采样率)"""
    from piper import PiperVoice, SynthesisConfig

    cfg = None
    if length_scale is not None:
        cfg = SynthesisConfig(length_scale=length_scale)
    with wave.open(out_path, "wb") as w:
        voice.synthesize_wav(text, w, syn_config=cfg)
    with wave.open(out_path) as w:
        return w.getnframes() / w.getframerate(), w.getframerate()


def probe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "scripts", "demo", "voiceover.json"))
    ap.add_argument("--video", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--keep", action="store_true", help="保留分段音频")
    args = ap.parse_args()

    cfg = json.load(open(args.config, encoding="utf-8"))
    video = args.video or os.path.join(ROOT, cfg["video"])
    out = args.out or video.replace(".mp4", "-voiced.mp4")
    work = os.path.join(ROOT, ".tunnel", "tts")
    os.makedirs(work, exist_ok=True)

    video_len = probe_duration(video)
    segs = cfg["segments"]
    print(f"视频：{os.path.basename(video)}  时长 {video_len:.1f}s")
    print(f"配音段：{len(segs)} 段\n")

    from piper import PiperVoice
    voice = PiperVoice.load(
        os.path.join(ROOT, cfg["voice"]), config_path=os.path.join(ROOT, cfg["voiceConfig"])
    )

    # 每段的可用时长 = 到下一段开始（末段到视频结束）
    prepared = []
    for i, seg in enumerate(segs):
        nxt = segs[i + 1]["start"] if i + 1 < len(segs) else video_len
        budget = nxt - seg["start"] - 0.25  # 末尾留 0.25s 静音
        text = normalize(seg["text"])
        natural, sr = synth(voice, text, os.path.join(work, f"seg{i:02d}_nat.wav"))
        scale = natural / budget if budget > 0 else 1.0
        scale = max(0.82, min(1.15, scale))
        final, _ = synth(voice, text, os.path.join(work, f"seg{i:02d}.wav"), length_scale=scale)
        flag = ""
        if final > budget + 0.35:
            flag = "  ⚠ 放不下（建议改短这句）"
        print(
            f"  段{i+1}: 起 {seg['start']:5.1f}s | 槽位 {budget:4.1f}s | "
            f"自然 {natural:5.1f}s → 语速 x{scale:.2f} → 实得 {final:5.1f}s"
            f" | {len(text)} 字{flag}"
        )
        prepared.append({"i": i, "start": seg["start"], "path": os.path.join(work, f"seg{i:02d}.wav")})

    # 拼成一条音轨：每段延迟到自己的起始点，再混合
    filt_parts = []
    for idx, p in enumerate(prepared):
        filt_parts.append(f"[{idx}:a]adelay={int(round(p['start']*1000))}|{int(round(p['start']*1000))}[d{idx}]")
    labels = "".join(f"[d{i}]" for i in range(len(prepared)))
    # 混合 → 统一响度 → 末尾补静音到视频长度
    filt_parts.append(
        f"{labels}amix=inputs={len(prepared)}:normalize=0,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur={video_len:.3f}[out]"
    )
    filt = ";".join(filt_parts)

    voice_track = os.path.join(work, "voice.wav")
    cmd = [FFMPEG, "-y", "-loglevel", "error"]
    for p in prepared:
        cmd += ["-i", p["path"]]
    cmd = [FFMPEG, "-y", "-loglevel", "error"]
    for p in prepared:
        cmd += ["-i", p["path"]]
    cmd += ["-filter_complex", filt, "-map", "[out]", "-ar", "44100", "-ac", "1", voice_track]
    subprocess.run(cmd, check=True)

    # 混进视频
    cmd2 = [
        FFMPEG, "-y", "-loglevel", "error",
        "-i", video, "-i", voice_track,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        out,
    ]
    subprocess.run(cmd2, check=True)

    dur = probe_duration(out)
    print(f"\n输出：{out}")
    print(f"时长 {dur:.1f}s | 音轨 aac 128k | 视频流直接 copy（无二次编码）")
    if not args.keep:
        for i in range(len(prepared)):
            for suffix in ("", "_nat"):
                f = os.path.join(work, f"seg{i:02d}{suffix}.wav")
                if os.path.exists(f):
                    os.remove(f)


if __name__ == "__main__":
    main()
