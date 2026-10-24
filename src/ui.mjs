// uiautomator XML 解析 + 元素查找。
//
// 为什么不用 XML 库：uiautomator dump 的输出结构极稳定（扁平 node 列表 + 自闭合标签），
// 一个正则就够，省一个依赖。真正麻烦的是**坐标**：所有 clickable 元素的 bounds 是
// [x1,y1][x2,y2]，点它的中心点最稳。

const ATTR_RE = /([a-zA-Z:_-]+)="([^"]*)"/g;

/** bounds 字符串 → 矩形。 */
export function parseBounds(bounds) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds || '');
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

/** XML → 节点数组（保持文档顺序，索引即屏幕上的相对层级顺序）。 */
export function parseUiXml(xml) {
  const nodes = [];
  const tagRe = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = tagRe.exec(String(xml ?? ''))) !== null) {
    const attrs = {};
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const bounds = parseBounds(attrs.bounds);
    if (!bounds) continue;
    nodes.push({
      index: nodes.length,
      text: attrs.text ?? '',
      resourceId: attrs['resource-id'] ?? '',
      className: attrs.class ?? '',
      contentDesc: attrs['content-desc'] ?? '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      selected: attrs.selected === 'true',
      package: attrs.package ?? '',
      bounds,
      raw: attrs
    });
  }
  return nodes;
}

/** 匹配器：把选择器描述（text/res/desc/cls 数组）编译成判定函数。 */
export function compileMatcher(spec = {}) {
  const texts = spec.text ?? [];
  const ress = spec.res ?? [];
  const descs = spec.desc ?? [];
  const classes = spec.cls ?? [];
  const exact = spec.exact === true;
  return (node) => {
    if (ress.length && ress.some((r) => node.resourceId === r || (r.endsWith('*') && node.resourceId.startsWith(r.slice(0, -1))))) return true;
    if (descs.length && descs.some((d) => node.contentDesc === d)) return true;
    if (texts.length) {
      const t = (node.text || '').trim();
      if (t && texts.some((want) => (exact ? t === want : t.includes(want)))) return true;
    }
    if (classes.length && classes.some((c) => node.className === c)) return true;
    return false;
  };
}

/** 按选择器找元素，默认只返回可见且带尺寸的。 */
export function findNodes(nodes, spec, { clickableOnly = false, includeZeroSize = false } = {}) {
  const match = typeof spec === 'function' ? spec : compileMatcher(spec);
  return nodes.filter((n) => {
    if (!includeZeroSize && (n.bounds.width <= 0 || n.bounds.height <= 0)) return false;
    if (clickableOnly && !n.clickable) return false;
    if (!n.enabled) return false;
    return match(n);
  });
}

export function findOne(nodes, spec, opts) {
  return findNodes(nodes, spec, opts)[0] ?? null;
}

/** 文本模糊查找（给人/模型用的便捷入口）。 */
export function findByText(nodes, text, { exact = false, clickableOnly = false } = {}) {
  return findNodes(nodes, { text: [text], exact }, { clickableOnly });
}

/** 屏幕上的文本摘要，给模型「不开图也能知道现在在哪一屏」用。 */
export function summarize(nodes, { max = 40 } = {}) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const label = (n.text || n.contentDesc || '').trim();
    if (!label) continue;
    const key = `${label}|${n.bounds.cx}|${n.bounds.cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: label, cx: n.bounds.cx, cy: n.bounds.cy, clickable: n.clickable, id: n.resourceId });
    if (out.length >= max) break;
  }
  return out;
}

/** 等某个选择器出现（轮询 dump），命中返回节点，超时返回 null。 */
export async function waitForNode(adapter, spec, { timeoutMs = 10000, intervalMs = 400, clickableOnly = false, sleep } = {}) {
  const nap = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const nodes = parseUiXml(await adapter.dumpUi());
    last = findOne(nodes, spec, { clickableOnly }) ?? findOne(nodes, spec, { clickableOnly, includeZeroSize: true });
    if (last) return last;
    await nap(intervalMs);
  }
  return last;
}
