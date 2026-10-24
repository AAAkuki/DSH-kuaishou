// 「怎么说话 / 怎么打字」的结构化设置 → 一段可注入提示词的人设说明。
//
// 为什么要结构化：让人在设置页点选、填空，而不是自己写一段 markdown。
// 生成结果会追加到人设提示词后面（persona 的说话方式/打字习惯/禁区三节）。
// 全部字段都有默认值；默认值下生成的内容接近"什么都不改"，不会把内置人设顶掉。

/** 默认值（与 config.DEFAULTS.style 保持一致）。 */
export const STYLE_DEFAULTS = {
  callUser: '主人',       // 怎么称呼对方
  callSelf: '我',         // 怎么自称
  tone: 'gentle',         // gentle | calm | sharp | lively | pro
  catchphrases: '',       // 口头禅，逗号分隔
  maxChars: 40,           // 一次回复最多多少字
  useEmoji: true,         // 用不用 emoji/表情
  useTilde: true,         // 用不用「～」
  usePeriod: false,       // 句末用不用「。」
  useParticles: true,     // 语气词（呀/啦/诶）
  forbid: '不承诺收益，不导流，不刷量，不人身攻击'  // 禁区，逗号分隔
};

const TONE_TEXT = {
  gentle: '语气软，先接住对方情绪再给建议；不用「加油」「会好的」这类空话',
  calm: '冷静、句子短、信息密度高；不寒暄，不解释废话',
  sharp: '先怼一句再给真话；只怼事情不怼人，吐槽后必须给一条有用信息',
  lively: '活泼、节奏快，多用短句和感叹；但不刷屏、不喊口号',
  pro: '专业、条理清楚；先给结论再解释，术语第一次出现时顺带一句白话'
};

export function parseList(text) {
  return String(text ?? '')
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 生成「说话与打字」指南。
 * @param {object} style 见 STYLE_DEFAULTS
 * @returns {string} markdown 片段（无内容时返回空串）
 */
export function composeSpeakingGuide(style = {}) {
  const s = { ...STYLE_DEFAULTS, ...(style ?? {}) };
  const lines = [];

  // 称呼与自称
  const callUser = String(s.callUser ?? '').trim();
  const callSelf = String(s.callSelf ?? '').trim();
  if (callUser || callSelf) {
    const parts = [];
    if (callUser) parts.push(`称呼对方「${callUser}」`);
    if (callSelf) parts.push(`自称「${callSelf}」`);
    lines.push(`- ${parts.join('，')}`);
  }

  // 语气
  const toneText = TONE_TEXT[s.tone];
  if (toneText) lines.push(`- ${toneText}`);

  // 长度
  const maxChars = Number(s.maxChars);
  if (Number.isFinite(maxChars) && maxChars > 0) lines.push(`- 一次回复不超过 ${maxChars} 字`);

  // 口头禅
  const phrases = parseList(s.catchphrases);
  if (phrases.length) lines.push(`- 口头禅（挑着用，不要每句都来）：${phrases.map((p) => `\`${p}\``).join(' ')}`);

  // 打字习惯
  const typing = [];
  typing.push(s.useEmoji ? '可以用 emoji，但一条消息最多一个' : '不用 emoji / 表情符号');
  typing.push(s.useTilde ? '可以用「～」收尾，但别每条都拖长音' : '不用「～」');
  typing.push(s.usePeriod ? '句末正常用「。」' : '句末不用「。」，更像随手打字');
  typing.push(s.useParticles ? '可以带语气词（呀 / 啦 / 诶）' : '不带语气词，直接说事');
  lines.push(`- 打字习惯：${typing.join('；')}`);

  // 禁区
  const forbid = parseList(s.forbid);
  if (forbid.length) lines.push(`- 不做：${forbid.join('、')}`);

  if (lines.length === 0) return '';
  return ['## 说话与打字（用户自定义）', '', ...lines, ''].join('\n');
}

/** 把指南接到人设正文后面；指南为空则原样返回。 */
export function applySpeakingGuide(personaText, style) {
  const guide = composeSpeakingGuide(style);
  if (!guide) return String(personaText ?? '');
  return `${String(personaText ?? '').trimEnd()}\n\n${guide}`;
}
