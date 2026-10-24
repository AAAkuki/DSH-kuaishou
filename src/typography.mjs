// 文字排版工具：中文按 1.0 字宽、ASCII 按 0.55 估算，用于「字号自适应 + 自动折行」。
// 目的：标题/字幕不溢出画面。ffmpeg 的 drawtext 不会自动换行，所以这里先算好。

/** 估算一行文本的像素宽度。 */
export function estimateWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text ?? '')) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) units += 1.0;      // 中日韩全角
    else if (/[A-Z]/.test(ch)) units += 0.62;
    else if (/[a-z0-9]/.test(ch)) units += 0.55;
    else units += 0.35;
  }
  return units * fontSize;
}

/**
 * 自适应字号 + 折行。
 * @returns {{fontSize:number, lines:string[]}}
 */
export function fitText(text, { width = 1080, maxFontSize = 54, minFontSize = 26, maxLines = 2, ratio = 0.88 } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return { fontSize: maxFontSize, lines: [] };
  const budget = width * ratio;
  let fontSize = maxFontSize;
  for (; fontSize >= minFontSize; fontSize -= 2) {
    if (estimateWidth(s, fontSize) <= budget) return { fontSize, lines: [s] };
  }
  fontSize = minFontSize;
  // 还是放不下：按预算折行（尽量在标点/空格处断）
  const perLine = Math.max(4, Math.floor(budget / fontSize));
  const chars = [...s];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    if ([...cur].length >= perLine) { lines.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return { fontSize, lines: lines.slice(0, maxLines) };
}
