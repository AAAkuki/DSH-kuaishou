#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Vibe 知识大赏 风格分镜渲染器：每"幕"画一张卡片 PNG，再交给 ffmpeg 拼成视频。

为什么用 Pillow 而不是 ffmpeg drawtext：
  ffmpeg 的 drawtext 要转义冒号/单引号/中文标点，字号换行全靠手算，
  一出错就整片黑屏；Pillow 里画字、量宽、自动折行都直观，还能量出边界做"字幕不出框"检查。

三种画风（对应教程里的 A/B/C）：
  docu   纪录片：深色 + 白字 + 细黄线，适合严肃科普
  poster 黄黑大字海报：黑底黄字，适合强观点
  notes  课堂笔记：米色纸 + 蓝黑字 + 红线，适合"同桌给你讲"的语气

用法：
  python vibe-render.py storyboard.json
  storyboard.json = {
    "width":1080,"height":1920,"style":"notes","outDir":"...",
    "font":"C:/Windows/Fonts/msyh.ttc",
    "scenes":[{"index":1,"seconds":4.2,"lines":["第一句","第二句"],"big":"大字","source":"出处","image":"C:/x.jpg"}]
  }
输出：
  outDir/s01.png ... ; outDir/scenes.txt（ffmpeg concat 用）；outDir/report.json（越界检查）
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

PALETTES = {
    "docu": dict(bg=(16, 19, 26), ink=(240, 242, 245), sub=(168, 178, 190), accent=(255, 214, 0), paper=None),
    "poster": dict(bg=(8, 8, 8), ink=(255, 212, 0), sub=(235, 235, 235), accent=(255, 255, 255), paper=None),
    "notes": dict(bg=(246, 241, 227), ink=(31, 41, 55), sub=(90, 98, 112), accent=(200, 60, 60), paper=True),
}


def load_font(path, size, bold=False):
    cands = []
    if bold:
        cands += [path.replace(".ttc", "bd.ttc"), path.replace("msyh.ttc", "msyhbd.ttc"), path]
    cands.append(path)
    for p in cands:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def wrap(draw, text, font, max_w):
    """按像素宽度折行（中文没有空格，只能逐字量）。"""
    lines, cur = [], ""
    for ch in str(text):
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        t = cur + ch
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def paper_bg(w, h, pal):
    img = Image.new("RGB", (w, h), pal["bg"])
    d = ImageDraw.Draw(img)
    # 横线
    step = max(48, h // 22)
    for y in range(step, h, step):
        d.line([(0, y), (w, y)], fill=(224, 216, 198), width=2)
    # 左侧红线
    d.line([(int(w * 0.085), 0), (int(w * 0.085), h)], fill=(226, 170, 170), width=3)
    # 纸角阴影
    img = img.filter(ImageFilter.GaussianBlur(0))
    return img


def fit_image(src, box_w, box_h):
    im = Image.open(src).convert("RGB")
    im = ImageOps.exif_transpose(im)
    ratio = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, int(im.width * ratio)), max(1, int(im.height * ratio))), Image.LANCZOS)


def render_scene(spec, cfg):
    w, h = cfg["width"], cfg["height"]
    style = cfg.get("style", "notes")
    pal = PALETTES.get(style, PALETTES["notes"])
    font_path = cfg.get("font") or "C:/Windows/Fonts/msyh.ttc"

    img = paper_bg(w, h, pal) if pal["paper"] else Image.new("RGB", (w, h), pal["bg"])
    d = ImageDraw.Draw(img)

    margin = int(w * 0.09)
    max_w = w - margin * 2

    # 顶部小标 / 幕号
    kicker = load_font(font_path, int(w * 0.030))
    d.text((margin, int(h * 0.045)), "VIBE 知识大赏", font=kicker,
           fill=pal["accent"] if style != "notes" else pal["sub"])
    num = str(spec.get("index", 1)).zfill(2)
    d.text((w - margin - d.textlength(num, font=kicker), int(h * 0.045)), num, font=kicker, fill=pal["sub"])

    header_h = int(h * 0.12)
    footer_h = int(h * 0.10)
    region_top, region_bottom = header_h, h - footer_h
    region_h = region_bottom - region_top

    # ── 先算每块内容需要多高，再整体垂直居中（之前是从上往下堆，画面下半截全空）
    big = spec.get("big") or ""
    body = spec.get("lines") or []
    image_path = spec.get("image") or ""
    has_image = bool(image_path) and os.path.exists(image_path)

    big_size = int(w * 0.115) if style != "poster" else int(w * 0.135)
    big_font = load_font(font_path, big_size, bold=True)
    while big_size > int(w * 0.055):
        big_font = load_font(font_path, big_size, bold=True)
        if not big or d.textlength(big, font=big_font) <= max_w:
            break
        big_size -= 4
    big_lines = wrap(d, big, big_font, max_w)[:3] if big else []
    big_h = int(len(big_lines) * big_size * 1.26)

    body_size = int(w * 0.056)
    body_font = load_font(font_path, body_size)
    body_lines = []
    for raw in body:
        body_lines.extend(wrap(d, raw, body_font, max_w))
    body_h = int(len(body_lines) * body_size * 1.55)

    img_h = 0
    img_w = max_w
    if has_image:
        img_w = int(max_w * 0.92)
        img_h = int(region_h * 0.36)

    gap_img = int(h * 0.035) if has_image else 0
    gap_body = int(h * 0.030) if body_lines else 0
    total = img_h + gap_img + big_h + gap_body + body_h
    y = region_top + max(0, (region_h - total) // 2)

    # 配图
    if has_image:
        try:
            im = fit_image(image_path, img_w, img_h)
            px = margin + (max_w - im.width) // 2
            if style == "notes":
                pad = 14
                card = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), (255, 255, 255))
                card.paste(im, (pad, pad))
                img.paste(card, (px - pad, y - pad))
                d.rectangle([px - pad, y - pad, px + im.width + pad, y + im.height + pad],
                            outline=(210, 202, 186), width=2)
            else:
                img.paste(im, (px, y))
                d.rectangle([px, y, px + im.width, y + im.height], outline=pal["accent"], width=3)
        except Exception:
            pass
        y += img_h + gap_img

    # 大字 + 重点下划线（下划线放在字的下沿之外，别压住笔画）
    for line in big_lines:
        d.text((margin, y), line, font=big_font, fill=pal["ink"])
        lw = d.textlength(line, font=big_font)
        uy = y + int(big_size * 1.22)
        d.rectangle([margin, uy, margin + lw, uy + max(3, int(big_size * 0.03))],
                    fill=pal["accent"] if style != "poster" else (255, 255, 255))
        y += int(big_size * 1.44)
    y += gap_body

    # 正文
    for line in body_lines:
        d.text((margin, y), line, font=body_font, fill=pal["ink"] if style != "notes" else (45, 55, 72))
        y += int(body_size * 1.55)

    # 出处
    src = spec.get("source") or ""
    if src:
        sf = load_font(font_path, int(w * 0.030))
        short = wrap(d, src, sf, max_w)[:1]
        d.text((margin, h - int(h * 0.075)), short[0] if short else "", font=sf, fill=pal["sub"])

    d.rectangle([0, h - 6, w, h], fill=pal["accent"])

    report = {
        "index": spec.get("index"),
        "textBottom": y,
        "limit": h - footer_h,
        "overflow": bool(y > h - footer_h),
    }
    return img, report


def main():
    if len(sys.argv) < 2:
        print("usage: vibe-render.py storyboard.json", file=sys.stderr)
        return 2
    spec_path = sys.argv[1]
    # utf-8-sig：PowerShell 的 Set-Content 会写 BOM，json.load 遇到 BOM 直接报错
    with open(spec_path, "r", encoding="utf-8-sig") as f:
        cfg = json.load(f)
    out_dir = cfg["outDir"]
    os.makedirs(out_dir, exist_ok=True)

    reports, concat = [], []
    for i, scene in enumerate(cfg.get("scenes") or [], start=1):
        scene = dict(scene)
        scene.setdefault("index", i)
        img, rep = render_scene(scene, cfg)
        name = f"s{i:02d}.png"
        img.save(os.path.join(out_dir, name))
        reports.append(rep)
        concat.append({"file": name, "seconds": float(scene.get("seconds") or 3.0)})

    with open(os.path.join(out_dir, "scenes.txt"), "w", encoding="utf-8") as f:
        for c in concat:
            f.write(f"file '{c['file']}'\n")
            f.write(f"duration {c['seconds']:.3f}\n")
        if concat:
            f.write(f"file '{concat[-1]['file']}'\n")

    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump({"scenes": reports, "overflow": any(r["overflow"] for r in reports)}, f, ensure_ascii=False, indent=2)

    print(json.dumps({"ok": True, "scenes": len(concat), "overflow": any(r["overflow"] for r in reports)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
