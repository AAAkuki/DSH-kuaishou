"""把贴纸 JPG 批量抠成透明 PNG。

思路（纯 numpy/Pillow，不装额外依赖）：
1. 取样边框像素估计背景色
2. 形态学重建（膨胀 & 掩膜）做**从边界开始的连通填充**，只抠和边框连通的背景，
   这样角色内部的白围裙不会被啃掉（这是之前 colorkey 的主要问题）
3. 边缘用"到背景色的距离"做软 alpha，并按 alpha 反预乘去掉白色毛边
"""
import sys
import os
import numpy as np
from PIL import Image


def estimate_bg(img):
    a = np.asarray(img.convert('RGB')).astype(np.float32)
    h, w, _ = a.shape
    band = 3
    border = np.concatenate([
        a[:band].reshape(-1, 3),
        a[-band:].reshape(-1, 3),
        a[:, :band].reshape(-1, 3),
        a[:, -band:].reshape(-1, 3),
    ])
    # 用中位数代表底色（比均值抗噪）
    return np.median(border, axis=0)


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


def cutout(path, out_path, tol=30, feather=2.2):
    img = Image.open(path).convert('RGB')
    a = np.asarray(img).astype(np.float32)
    h, w, _ = a.shape

    bg = estimate_bg(img)
    dist = np.sqrt(((a - bg) ** 2).sum(axis=2))          # 到背景色的距离

    near_bg = dist < tol                                  # 可能是背景的像素
    seed = np.zeros((h, w), bool)
    seed[0, :] = True
    seed[-1, :] = True
    seed[:, 0] = True
    seed[:, -1] = True
    seed &= near_bg

    # 形态学重建：从边框往里长，只吃"和边框连通"的背景
    prev = None
    for _ in range(400):
        nxt = dilate(seed) & near_bg
        if prev is not None and np.array_equal(nxt, prev):
            break
        prev = seed
        seed = nxt

    bg_mask = seed                                          # True = 背景（要抠）

    # 软 alpha：背景 0，主体 255，边界按距离过渡
    alpha = np.where(bg_mask, 0.0, 1.0)
    if feather > 0:
        # 边界附近的像素按距离给 0~1，减少锯齿和白边
        edge_zone = dilate(bg_mask) & ~bg_mask
        ramp = np.clip((dist - tol * 0.5) / (tol * 1.6), 0.0, 1.0)
        alpha = np.where(edge_zone, ramp, alpha)
        # 轻微模糊让过渡自然
        k = np.array([1, 2, 3, 2, 1], dtype=np.float32)
        k /= k.sum()
        alpha = np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 0, alpha)
        alpha = np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 1, alpha)
        alpha = np.clip(alpha, 0.0, 1.0)

    # 反预乘去白边：边缘像素减去混进来的背景色
    safe = np.clip(alpha, 1e-3, 1.0)[..., None]
    rgb = (a - (1.0 - safe) * bg) / safe
    rgb = np.clip(rgb, 0, 255)

    out = np.dstack([rgb, alpha * 255.0]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(out_path, optimize=True)
    return float((alpha < 0.5).mean())


def main(src_dir):
    files = [f for f in sorted(os.listdir(src_dir)) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    ok = 0
    for f in files:
        src = os.path.join(src_dir, f)
        base = os.path.splitext(f)[0]
        dst = os.path.join(src_dir, base + '-cut.png')
        try:
            ratio = cutout(src, dst)
            print(f'OK  {f}  →  {os.path.basename(dst)}  透明占比 {ratio:.1%}')
            ok += 1
        except Exception as e:
            print(f'FAIL {f}: {e}')
    print(f'完成 {ok}/{len(files)}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'state/assets/stickers')
