"""重新抠底：只处理"几乎不透明"的贴纸（有 alpha 但透明区 <12% 的，等于白底没抠掉）。

比 cutout-stickers.py 更稳的一招：不按"和某一个底色的距离"判背景，
而是按"亮且不鲜艳"（近白）判，再从四条边做连通填充 —— 这样即便底色是
白到灰的渐变也能一次刷干净，而角色身上的白色围裙/荷叶边不会被误吃
（除非它贴着边）。

用法：
  python tools/rematte-stickers.py [--dry] [--dir state/assets/stickers]
"""
import glob
import os
import shutil
import sys

import numpy as np
from PIL import Image

TOL_BRIGHT = 205      # 每通道都 >= 这个值才算"近白"
TOL_CHROMA = 20       # max-min <= 这个值才算"不鲜艳"


def dilate(mask):
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[1:, 1:] |= mask[:-1, :-1]
    out[:-1, :-1] |= mask[1:, 1:]
    out[1:, :-1] |= mask[:-1, 1:]
    out[:-1, 1:] |= mask[1:, :-1]
    return out


def rematte(src, dst):
    img = Image.open(src).convert('RGB')
    a = np.asarray(img).astype(np.float32)
    h, w, _ = a.shape
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    near_white = (mn >= TOL_BRIGHT) & ((mx - mn) <= TOL_CHROMA)

    seed = np.zeros((h, w), bool)
    seed[0, :] = seed[-1, :] = True
    seed[:, 0] = seed[:, -1] = True
    seed &= near_white

    prev = None
    for _ in range(600):
        nxt = dilate(seed) & near_white
        if prev is not None and np.array_equal(nxt, prev):
            break
        prev = seed
        seed = nxt

    bg_mask = seed
    # 连成一片的白底去掉之后，剩下的近白像素（角色内部）保留
    alpha = np.where(bg_mask, 0.0, 1.0)

    # 边缘 2px 做羽化，避免锯齿
    edge = dilate(bg_mask) & ~bg_mask
    alpha = np.where(edge, 0.55, alpha)
    edge2 = dilate(dilate(bg_mask)) & ~edge & ~bg_mask
    alpha = np.where(edge2, 0.85, alpha)

    # 白边反预乘：靠边的像素把混进来的白减掉
    safe = np.clip(alpha, 1e-3, 1.0)[..., None]
    rgb = np.clip((a - (1.0 - safe) * 255.0) / safe, 0, 255)

    out = np.dstack([rgb, alpha * 255.0]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(dst, optimize=True)
    return 1.0 - float(alpha.mean())


def transparent_ratio(path):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im.getchannel('A'))
    return float((a < 128).mean())


def main():
    args = sys.argv[1:]
    dry = '--dry' in args
    d = 'state/assets/stickers'
    if '--dir' in args:
        d = args[args.index('--dir') + 1]
    files = sorted(glob.glob(os.path.join(d, '*.png')))
    changed = 0
    for p in files:
        ratio = transparent_ratio(p)
        if ratio >= 0.12:
            print(f'skip  {os.path.basename(p)}  透明区 {ratio:.1%}（已经抠过）')
            continue
        orig = os.path.join(d, '_orig', os.path.splitext(os.path.basename(p))[0] + '.jpg')
        src = orig if os.path.exists(orig) else p
        tmp = p + '.new.png'
        new_ratio = rematte(src, tmp)
        if new_ratio < 0.05:
            os.remove(tmp)
            print(f'FAIL  {os.path.basename(p)}  重抠后透明区只有 {new_ratio:.1%}，保留原图')
            continue
        print(f'{"would fix" if dry else "fixed"}  {os.path.basename(p)}  {ratio:.1%} → {new_ratio:.1%}')
        if not dry:
            shutil.move(p, p + '.bak')
            shutil.move(tmp, p)
            changed += 1
        else:
            os.remove(tmp)

    # 落一份透明区清单：JS 侧据此跳过"基本没透明区"的贴纸（否则会是个白方块）
    if not dry:
        import json
        manifest = {}
        for p in files:
            if p.endswith('.bak') or p.endswith('.new.png'):
                continue
            manifest[os.path.basename(p)] = round(transparent_ratio(p), 4)
        with open(os.path.join(d, 'matte.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        weak = [k for k, v in manifest.items() if v < 0.10]
        print(f'matte.json 写好：{len(manifest)} 个贴纸，其中 {len(weak)} 个透明区不足 10%（渲染时会跳过）')
        for k in weak:
            print('  跳过:', k, manifest[k])

    print(f'\n{"(dry) 会改" if dry else "已改"} {changed} 个')


if __name__ == '__main__':
    main()
