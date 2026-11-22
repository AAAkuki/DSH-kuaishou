// 出口把关：凡是发到快手上的文字，都不能冒充真人。
//
// 为什么要有这个：我犯过一次 —— 有人问"这视频是真人做的还是AI做的"，
// 我回了"真人剪的"。那是假话，而且是在公开评论区。这个模块把它变成机制：
// 任何"真人/本人/我是人"这类表述，发送前统一改写成不回避的 AI 口径。

/** 命中这些就是在冒充真人（"人工智能""AI"不算） */
export const HUMAN_CLAIM_RE = /真人|本人|亲(?:自|手)|我是个?人|我是人(?!工)|普通人做的|实拍/;

/** 把"真人"类表述改成不回避的说法 */
export function sanitizeReply(text) {
  let s = String(text ?? '');
  if (!HUMAN_CLAIM_RE.test(s)) return { text: s, changed: false, reason: '' };
  const before = s;
  s = s
    .replace(/我本人/g, '我（AI）')
    .replace(/真人剪的|真人做的|真人拍的|本人亲自|本人做的|我自己做的|实拍的/g, 'AI做的')
    .replace(/真人/g, 'AI')
    .replace(/本人/g, 'AI')
    .replace(/亲(?:自|手)/g, 'AI');
  return {
    text: s,
    changed: s !== before,
    reason: s !== before ? '把"真人"类表述改成了 AI 口径（不冒充真人）' : ''
  };
}

/** 被明确问"是不是AI"时，必须如实回答（给调用方做二次校验用） */
export function asksIfAI(text) {
  return /(真人|ai|AI|人工智能|机器|脚本|自动|合成).{0,6}(做|剪|生成|搞)|是不是(ai|AI|机器人)|是ai吗|是AI吗/.test(String(text ?? ''));
}
