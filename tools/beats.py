#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
音乐节拍检测（给"卡点剪辑"用）。

做法：ffmpeg 把 BGM 转成 8kHz 单声道 PCM → numpy 算短时能量 → 差分得到 onset 包络 →
峰值挑选 → 得到拍点时间（秒），顺便估一个 BPM。
不追求音乐级精确，只要"卡点大致在拍子上"就够视频剪辑用。
"""
import json
import subprocess
import sys

import numpy as np

SR = 8000
HOP = 160  # 20ms


def load_pcm(ffmpeg, path):
    cmd = [ffmpeg, "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def detect(audio, sr=SR, hop=HOP):
    if audio.size < sr:
        return {"duration": round(audio.size / sr, 3), "bpm": 0, "beats": []}
    n = (audio.size - hop) // hop
    frames = np.lib.stride_tricks.as_strided(
        audio, shape=(n, hop), strides=(hop * audio.itemsize, audio.itemsize)
    )
    energy = np.sqrt((frames ** 2).mean(axis=1) + 1e-9)
    # 对数能量的一阶差分 = onset 强度
    env = np.maximum(0.0, np.diff(np.log(energy + 1e-9)))
    if env.max() > 0:
        env = env / env.max()
    # 自适应阈值 + 局部极大值
    thr = max(0.12, float(env.mean() + env.std()))
    beats = []
    min_gap = int(0.28 * sr / hop)  # 最快 ~214 BPM
    last = -10 ** 9
    for i, v in enumerate(env):
        if v < thr:
            continue
        if i - last < min_gap:
            continue
        if i > 0 and i < len(env) - 1 and v < env[i - 1] and v < env[i + 1]:
            continue
        beats.append(round(i * hop / sr, 3))
        last = i
    duration = round(audio.size / sr, 3)
    bpm = 0
    if len(beats) >= 4:
        gaps = np.diff(beats[:40])
        med = float(np.median(gaps)) if gaps.size else 0
        if med > 0:
            bpm = int(round(60 / med))
    return {"duration": duration, "bpm": bpm, "beats": beats[:400]}


def main():
    if len(sys.argv) < 3:
        print("usage: beats.py <ffmpeg> <audio>", file=sys.stderr)
        return 2
    ffmpeg, path = sys.argv[1], sys.argv[2]
    audio = load_pcm(ffmpeg, path)
    out = detect(audio)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
