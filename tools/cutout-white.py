# 把右下角角色图的白底去掉（原图是 JPG，白底贴上去会是个白方块）。
# 只在边缘做泛洪式去白，避免把角色身上的白色蕾丝/领子也抠掉。
import sys
from collections import deque

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
w, h = im.size
px = im.load()

THRESH = 246  # 认为"白"的阈值


def is_white(x, y):
    r, g, b, a = px[x, y]
    return r >= THRESH and g >= THRESH and b >= THRESH


def soft(x, y):
    r, g, b, a = px[x, y]
    m = min(r, g, b)
    # 246~252 之间给半透明，边缘才不会锯齿
    if m >= 252:
        return 0
    if m >= THRESH:
        return int((252 - m) / (252 - THRESH) * 255)
    return None


# 从四条边开始泛洪，只清掉连通到画布边缘的白
seen = bytearray(w * h)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if is_white(x, y) and not seen[y * w + x]:
            seen[y * w + x] = 1
            q.append((x, y))
for y in range(h):
    for x in (0, w - 1):
        if is_white(x, y) and not seen[y * w + x]:
            seen[y * w + x] = 1
            q.append((x, y))

while q:
    x, y = q.popleft()
    a = soft(x, y)
    if a is None:
        continue
    r, g, b, _ = px[x, y]
    px[x, y] = (r, g, b, a)
    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
        if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_white(nx, ny):
            seen[ny * w + nx] = 1
            q.append((nx, ny))

im.save(dst, 'PNG')
bbox = im.getbbox()
print(f'ok {dst} size={im.size} content_bbox={bbox}')
