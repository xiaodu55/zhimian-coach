#!/usr/bin/env python
"""
给演示视频配旁白。

两个引擎：
  --engine edge   微软 Edge 在线 Neural TTS（音色自然，需要走代理；本机代理在注册表里）
  --engine piper  本地 Piper onnx（离线，纯 CPU，音色偏机械，作为断网兜底）

人味处理（不是调参玄学，是四件具体的事）：
  1) 逐段按画面时长反推语速：先按基准语速合成一次量出自然时长，再算出这一段该多快/多慢。
     全片统一语速是最像机器人的做法；按画面段落分别定速，才像人在跟着画面讲。
  2) 每段末尾留静音，段与段之间再留白，听感上像人在换气。
  3) 混合后统一响度（loudnorm），避免每段音量忽大忽小。
  4) 数字与英文缩写按中文习惯念（14.2% → 百分之十四点二，P99 → P 九十九），
     这是中文 TTS 最容易糊弄过去、评委最容易听出来的地方。

用法：
  python scripts/demo/make-voiceover.py --engine edge
  python scripts/demo/make-voiceover.py --engine piper
"""
import argparse
import asyncio
import json
import os
import re
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
    ("——", "，"),
    ("「", ""),
    ("」", ""),
]


def normalize(text: str) -> str:
    for a, b in PRONOUNCE:
        text = text.replace(a, b)
    return text.replace("  ", " ").strip()


def win_proxy():
    """从注册表读系统代理（edge-tts 只认环境变量，不会读 Windows 的系统代理）"""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        val, _ = winreg.QueryValueEx(key, "ProxyServer")
        if val:
            return "http://" + val
    except Exception:
        pass
    return os.environ.get("HTTPS_PROXY", "")


def probe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


# ---------------------------------------------------------------- edge 引擎
async def edge_synth_async(text, voice, rate, out_path, tries=12):
    import edge_tts

    last = None
    for i in range(tries):
        try:
            comm = edge_tts.Communicate(text, voice, rate=rate)
            await comm.save(out_path)
            return True
        except Exception as e:  # 代理链路不稳，重试（退避最长 8s）
            last = e
            await asyncio.sleep(min(1.2 * (i + 1), 8))
    print(f"    edge-tts 失败（已试 {tries} 次）：{type(last).__name__} {str(last)[:120]}")
    return False


def edge_synth(text, voice, rate, out_path, tries=12):
    ok = asyncio.run(edge_synth_async(text, voice, rate, out_path, tries))
    if not ok:
        raise RuntimeError("edge-tts 合成失败")
    return probe_duration(out_path)


# --------------------------------------------------------------- piper 引擎
def piper_synth(voice_obj, text, out_path, length_scale=None):
    from piper import SynthesisConfig

    cfg = SynthesisConfig(length_scale=length_scale) if length_scale else None
    with wave.open(out_path, "wb") as w:
        voice_obj.synthesize_wav(text, w, syn_config=cfg)
    with wave.open(out_path) as w:
        return w.getnframes() / w.getframerate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "scripts", "demo", "voiceover.json"))
    ap.add_argument("--video", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--engine", default="edge", choices=["edge", "piper"])
    ap.add_argument("--voice", default=None, help="edge 音色名，覆盖配置")
    ap.add_argument("--rate", default=None, help="edge 基准语速，如 +6%")
    args = ap.parse_args()

    cfg = json.load(open(args.config, encoding="utf-8"))
    video = args.video or os.path.join(ROOT, cfg["video"])
    work = os.path.join(ROOT, ".tunnel", "tts")
    os.makedirs(work, exist_ok=True)

    voice_name = args.voice or cfg.get("edgeVoice") or "zh-CN-YunxiNeural"
    base_rate = args.rate or cfg.get("edgeRate") or "+6%"

    out = args.out or video.replace(".mp4", f"-voiced-{args.engine}.mp4")
    video_len = probe_duration(video)
    segs = cfg["segments"]
    print(f"引擎 {args.engine} | 音色 {voice_name} | 基准语速 {base_rate}")
    print(f"视频 {os.path.basename(video)} 时长 {video_len:.1f}s | {len(segs)} 段\n")

    if args.engine == "edge":
        proxy = win_proxy()
        if proxy:
            os.environ["HTTPS_PROXY"] = proxy
            os.environ["HTTP_PROXY"] = proxy
            print(f"走系统代理：{proxy}\n")
    else:
        piper_voice = None

    prepared = []
    for i, seg in enumerate(segs):
        nxt = segs[i + 1]["start"] if i + 1 < len(segs) else video_len
        budget = nxt - seg["start"] - 0.25  # 末尾留 0.25s 静音
        text = normalize(seg["text"])

        if args.engine == "edge":
            nat_path = os.path.join(work, f"seg{i:02d}_nat.mp3")
            try:
                edge_synth(text, voice_name, base_rate, nat_path)
                natural = probe_duration(nat_path)
                # 时长与 (1+rate) 近似成反比，据此反推这一段需要的语速
                need = base_rate
                if natural > 0:
                    delta = (natural / budget - 1) * 100
                    need = f"{max(-30, min(45, int(base_rate.strip('%+').replace('+','').replace('-','') and int(base_rate.strip('%+')) + delta))):+d}%"
                final_path = os.path.join(work, f"seg{i:02d}.mp3")
                edge_synth(text, voice_name, need, final_path)
                final = probe_duration(final_path)
                scale = need
            except RuntimeError:
                # 代理链路彻底断了也别让整条配音作废：这一段退回本地 Piper
                print("    ↳ 本段改用本地 Piper 兜底")
                if piper_voice is None:
                    from piper import PiperVoice
                    piper_voice = PiperVoice.load(
                        os.path.join(ROOT, cfg["voice"]), config_path=os.path.join(ROOT, cfg["voiceConfig"])
                    )
                nat_wav = os.path.join(work, f"seg{i:02d}_nat.wav")
                natural = piper_synth(piper_voice, text, nat_wav)
                scale = max(0.82, min(1.15, natural / budget if budget > 0 else 1.0))
                final_path = os.path.join(work, f"seg{i:02d}.wav")
                final = piper_synth(piper_voice, text, final_path, length_scale=scale)
                scale = f"x{scale:.2f}(piper)"
        else:
            nat_path = os.path.join(work, f"seg{i:02d}_nat.wav")
            natural = piper_synth(piper_voice, text, nat_path)
            scale = max(0.82, min(1.15, natural / budget if budget > 0 else 1.0))
            final_path = os.path.join(work, f"seg{i:02d}.wav")
            final = piper_synth(piper_voice, text, final_path, length_scale=scale)
            scale = f"x{scale:.2f}"

        flag = ""
        if final > budget + 0.35:
            flag = "  ⚠ 放不下（建议改短这句）"
        print(
            f"  段{i+1}: 起 {seg['start']:5.1f}s | 槽位 {budget:4.1f}s | "
            f"自然 {natural:5.1f}s → 语速 {scale:>6s} → 实得 {final:5.1f}s | {len(text)} 字{flag}"
        )
        prepared.append({"i": i, "start": seg["start"], "path": final_path})

    # 拼音轨：每段延迟到自己的起点 → 混合 → 统一响度 → 补静音到视频长度
    filt_parts = []
    for idx, p in enumerate(prepared):
        ms = int(round(p["start"] * 1000))
        filt_parts.append(f"[{idx}:a]adelay={ms}|{ms}[d{idx}]")
    labels = "".join(f"[d{i}]" for i in range(len(prepared)))
    filt_parts.append(
        f"{labels}amix=inputs={len(prepared)}:normalize=0,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur={video_len:.3f}[out]"
    )
    filt = ";".join(filt_parts)

    voice_track = os.path.join(work, f"voice-{args.engine}.wav")
    cmd = [FFMPEG, "-y", "-loglevel", "error"]
    for p in prepared:
        cmd += ["-i", p["path"]]
    cmd += ["-filter_complex", filt, "-map", "[out]", "-ar", "44100", "-ac", "1", voice_track]
    subprocess.run(cmd, check=True)

    cmd2 = [
        FFMPEG, "-y", "-loglevel", "error",
        "-i", video, "-i", voice_track,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        out,
    ]
    subprocess.run(cmd2, check=True)

    print(f"\n输出：{out}")
    print(f"时长 {probe_duration(out):.1f}s | 音轨 aac 128k | 视频流直接 copy")


if __name__ == "__main__":
    main()
