"""给模板图"去压缩块"：JPEG 8x8 块在放大后特别明显，这里做三步处理。

1. 2x Lanczos 放大（保留线条）
2. 用中值 + 双边式保边平滑把 8x8 块的方块感压掉（只抹平平坦区，不糊线条）
3. 轻量 unsharp 把被抹掉的边缘找回来

输出：state/assets/template-talking-box@2x.png（原图不动）
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

SRC = 'state/assets/template-talking-box.jpg'
DST = 'state/assets/template-talking-box@2x.png'


def main():
    img = Image.open(SRC).convert('RGB')
    w, h = img.size
    # 1) 2x 放大
    big = img.resize((w * 2, h * 2), Image.LANCZOS)

    # 2) 去块：先中值（3x3 能把 8x8 块的阶梯抹平），再轻微高斯
    med = big.filter(ImageFilter.MedianFilter(3))
    soft = med.filter(ImageFilter.GaussianBlur(0.6))

    # 3) 找回边缘：unsharp（半径小、强度适中，避免白边）
    sharp = soft.filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2))

    # 只把"平坦区"换成平滑结果，边缘保留原放大的细节（避免整张变糊）
    a = np.asarray(big).astype(np.float32)
    b = np.asarray(sharp).astype(np.float32)
    # 局部梯度：梯度小 = 平坦区
    gx = np.abs(np.diff(a, axis=1, prepend=a[:, :1]))
    gy = np.abs(np.diff(a, axis=0, prepend=a[:1]))
    grad = (gx + gy).mean(axis=2)
    flat = np.clip(1.0 - grad / 12.0, 0.0, 1.0)[..., None]   # 平坦区权重 1，边缘 0
    out = np.clip(a * (1 - flat) + b * flat, 0, 255).astype(np.uint8)

    Image.fromarray(out, 'RGB').save(DST, optimize=True)
    print(f'{SRC} {w}x{h} → {DST} {w*2}x{h*2} ({os.path.getsize(DST)//1024} KB)')


if __name__ == '__main__':
    main()
