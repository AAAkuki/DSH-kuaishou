#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
「电影感知识卡」帧生成器：照参考片（Vibe知识大赏·抗日战争）的视觉语言做。

视觉要素（对着参考片逐条抄的）：
  深底 + 放射光、右上角年份区间、左上角解说字幕（关键词金色）、
  中部手绘线条/剪影式插画、右侧竖排红条文字、底部出处、轻微暗角与静态颗粒。

用法：
  python kv-cinematic.py spec.json outdir
spec = {
  "width":1080,"height":1920,"fps":30,
  "scenes":[{"caption":["1937年7月7日，","卢沟桥事变，全面抗战爆发。"],"key":"全面抗战",
             "era":"1931 — 1945","source":"…","diagram":"network","seconds":5}]
}
输出 outdir/f00001.png …，交给 ffmpeg 编码。
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

GOLD = (214, 178, 92)
WHITE = (238, 238, 238)
RED = (168, 46, 40)
DIM = (150, 150, 150)


def font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()


def background(w, h, t):
    """深底 + 慢速旋转的放射光"""
    img = Image.new("RGB", (w, h), (10, 12, 18))
    d = ImageDraw.Draw(img)
    # 垂直渐变
    for y in range(0, h, 4):
        k = y / h
        d.rectangle([0, y, w, y + 4], fill=(int(10 + 12 * k), int(12 + 9 * k), int(18 + 10 * k)))
    # 放射光（从画面上方 38% 处发散）
    cx, cy = w // 2, int(h * 0.38)
    rays = 44
    rot = t * 0.10
    for i in range(rays):
        a = (i / rays) * math.tau + rot
        spread = 0.010 + 0.007 * math.sin(i * 1.7 + t * 0.8)
        L = h * 1.4
        p1 = (cx + math.cos(a - spread) * 20, cy + math.sin(a - spread) * 20)
        p2 = (cx + math.cos(a + spread) * 20, cy + math.sin(a + spread) * 20)
        p3 = (cx + math.cos(a) * L, cy + math.sin(a) * L)
        # 光柱亮度：整数条更亮，像参考片那种明显的斜光
        boost = 2.2 if i % 3 == 0 else 1.0
        alpha = (0.045 + 0.02 * math.sin(i * 2.3 + t * 1.3)) * boost
        col = (int(GOLD[0] * alpha), int(GOLD[1] * alpha), int(GOLD[2] * alpha))
        d.polygon([p1, p2, p3], fill=col)
    # 地平线附近的一层薄雾，画面不至于上下断成两块
    for y in range(int(h * 0.52), int(h * 0.72), 3):
        k = 1 - abs(y - h * 0.62) / (h * 0.10)
        if k <= 0:
            continue
        d.line([0, y, w, y], fill=(int(18 + 12 * k), int(17 + 10 * k), int(16 + 8 * k)))
    return img


def vignette(img):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([-w * 0.25, -h * 0.2, w * 1.25, h * 1.2], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w // 12))
    dark = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(img, dark, mask)


_grain = None
def grain(img):
    global _grain
    w, h = img.size
    if _grain is None or _grain.size != (w, h):
        rnd = random.Random(7)
        n = Image.new("L", (w // 2, h // 2))
        n.putdata([rnd.randint(110, 145) for _ in range(n.width * n.height)])
        _grain = n.resize((w, h)).convert("RGB")
    return Image.blend(img, Image.blend(img, _grain, 0.16), 0.5)


def draw_diagram(d, kind, t, w, h, scale=1.0):
    """手绘感插画：线条按时间逐步画出"""
    cx, cy = w // 2, int(h * 0.47)
    ink = (226, 226, 226)
    gold = GOLD
    p = min(1.0, t / 1.2)  # 线条生长进度

    if kind == "network":
        rnd = random.Random(11)
        pts = [(cx + rnd.randint(-230, 230) * scale, cy + rnd.randint(-260, 200) * scale) for _ in range(14)]
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                if (i * 7 + j) % 5:
                    continue
                if (i + j) / 26 > p:
                    continue
                d.line([pts[i], pts[j]], fill=(120, 118, 110), width=2)
        for i, (x, y) in enumerate(pts):
            if i / len(pts) > p:
                continue
            r = 6 if i % 4 else 9
            d.ellipse([x - r, y - r, x + r, y + r], fill=gold if i % 4 == 0 else ink, outline=None)
    elif kind == "boxes":
        for k, (label, dx) in enumerate([("人", -0.22), ("机器", 0.22)]):
            x0 = cx + dx * w - 150 * scale
            y0 = cy - 130 * scale
            x1 = x0 + 300 * scale
            y1 = y0 + 260 * scale
            if k / 2 > p:
                continue
            d.rounded_rectangle([x0, y0, x1, y1], radius=18, outline=ink, width=3)
            f = font(FONT_HAN, int(54 * scale))
            tw = d.textlength(label, font=f)
            d.text((x0 + (x1 - x0 - tw) / 2, y0 + 90 * scale), label, font=f, fill=gold)
        if p > 0.5:
            d.line([cx - 60 * scale, cy, cx + 60 * scale, cy], fill=gold, width=4)
            d.polygon([(cx + 60 * scale, cy), (cx + 30 * scale, cy - 16), (cx + 30 * scale, cy + 16)], fill=gold)
    elif kind == "timeline":
        x0, x1 = int(w * 0.16), int(w * 0.84)
        y = cy
        seg = int((x1 - x0) * p)
        d.line([x0, y, x0 + seg, y], fill=ink, width=3)
        for i, frac in enumerate((0.12, 0.38, 0.64, 0.9)):
            if frac > p:
                continue
            x = x0 + (x1 - x0) * frac
            d.ellipse([x - 10, y - 10, x + 10, y + 10], fill=gold)
            f = font(FONT_HAN, int(34 * scale))
            label = str(1950 if i == 0 else 1970 + i * 10)
            d.text((x - d.textlength(label, font=f) / 2, y + 26), label, font=f, fill=DIM)
    elif kind == "bars":
        for i in range(5):
            bh = int((60 + i * 46) * p * scale)
            x = int(cx - 220 * scale + i * 110 * scale)
            d.rectangle([x, cy + 160 * scale - bh, x + 62 * scale, cy + 160 * scale],
                        fill=gold if i == 4 else (140, 136, 126))
        d.line([cx - 240 * scale, cy + 160 * scale, cx + 300 * scale, cy + 160 * scale], fill=ink, width=2)
    elif kind == "question":
        f = font(FONT_SERIF, int(360 * scale))
        tw = d.textlength("?", font=f)
        # 粒子拼出的问号：先画本体，再逐步显示
        layer = Image.new("L", (w, h), 0)
        ld = ImageDraw.Draw(layer)
        ld.text((cx - tw / 2, cy - 220 * scale), "?", font=f, fill=255)
        bbox = layer.getbbox()
        if bbox:
            for _ in range(int(900 * p)):
                x = random.randint(bbox[0], bbox[2])
                y = random.randint(bbox[1], bbox[3])
                if layer.getpixel((x, y)) > 60:
                    d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=gold)
    elif kind == "title":
        pass


FONT_HAN = "C:/Windows/Fonts/simhei.ttf"
FONT_SERIF = "C:/Windows/Fonts/simsun.ttc"


def frame(spec, scene, t, index):
    w, h = spec["width"], spec["height"]
    img = background(w, h, index / spec["fps"])
    d = ImageDraw.Draw(img)
    s = 1.0

    # 右侧竖排红条（参考片右侧那条"书脊"）
    bar_x = int(w * 0.935)
    d.rectangle([bar_x, int(h * 0.10), bar_x + 46, int(h * 0.62)], fill=(120, 28, 24))
    vf = font(FONT_HAN, 30)
    text = scene.get("spine", "知识")
    yy = int(h * 0.11)
    for ch in text:
        d.text((bar_x + 10, yy), ch, font=vf, fill=(236, 226, 210))
        yy += 38

    # 中部插画
    draw_diagram(d, scene.get("diagram", "network"), t, w, h, s)

    # 右上角年份区间
    if scene.get("era"):
        ef = font(FONT_SERIF, 34)
        et = scene["era"]
        tw = d.textlength(et, font=ef)
        x = int(w * 0.90) - tw
        y = int(h * 0.055)
        d.text((x, y), et, font=ef, fill=GOLD)
        d.line([int(w * 0.90) - 150, y + 44, int(w * 0.90), y + 44], fill=(120, 100, 60), width=2)

    # 左上角字幕：两行，关键词金色（关键词下面加一条红划线，参考片同款）
    fade = min(1.0, t / 0.5) if t < 0.5 else 1.0
    if fade < 1.0:
        pass
    y = int(h * 0.075)
    cf = font(FONT_HAN, 40)
    key = scene.get("key", "")
    for line in scene.get("caption", []):
        x = int(w * 0.055)
        if key and key in line:
            pre, post = line.split(key, 1)
            d.text((x, y), pre, font=cf, fill=WHITE)
            kx = x + d.textlength(pre, font=cf)
            d.text((kx, y), key, font=cf, fill=GOLD)
            kw = d.textlength(key, font=cf)
            d.line([kx, y + 52, kx + kw, y + 52], fill=RED, width=3)
            x = kx + kw
            d.text((x, y), post, font=cf, fill=WHITE)
        else:
            d.text((x, y), line, font=cf, fill=WHITE)
        y += 54

    # 左上角幕号（参考片那种 01 / 04 的小标）
    if scene.get("index"):
        nf = font(FONT_SERIF, 30)
        d.text((int(w * 0.055), int(h * 0.045)), scene["index"], font=nf, fill=(150, 130, 90))

    # 底部出处
    if scene.get("source"):
        sf = font(FONT_HAN, 24)
        st = scene["source"]
        tw = d.textlength(st, font=sf)
        d.text(((w - tw) / 2, int(h * 0.925)), st, font=sf, fill=(140, 138, 130))

    img = vignette(img)
    img = grain(img)
    return img


def main():
    if len(sys.argv) < 3:
        print("usage: kv-cinematic.py spec.json outdir", file=sys.stderr)
        return 2
    spec_path, outdir = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8-sig") as f:
        spec = json.load(f)
    os.makedirs(outdir, exist_ok=True)
    fps = int(spec.get("fps", 30))
    idx = 0
    for scene in spec["scenes"]:
        n = int(round(float(scene.get("seconds", 4)) * fps))
        for i in range(n):
            t = i / fps
            img = frame(spec, scene, t, idx)
            img.save(os.path.join(outdir, f"f{idx:05d}.png"))
            idx += 1
    print(json.dumps({"ok": True, "frames": idx, "fps": fps}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
