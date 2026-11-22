// 去 AI 味的**确定性**清洗：不调用模型，只做能保证"事实不变、只改说法"的机械替换。
//
// 为什么还需要这层：prompts/de-ai.md 是给模型看的改写要求，但真正出片/发布的地方
// 未必经过模型（比如自动生成的文案、用户手填的文案）。这里补一层"兜底清洗"：
// 八股连接词、客服腔、大词、形容词堆料、emoji 堆砌 —— 都在这里当场去掉。

/** 连接词八股：出现在句首时直接删（连标点一起） */
export const CRUTCH_CONNECTIVES = [
  '首先', '其次', '再者', '最后', '接下来', '总的来说', '综上所述', '总而言之',
  '值得注意的是', '由此可见', '不仅如此', '与此同时', '换言之', '换句话说',
  '值得一提的是', '需要指出的是', '毋庸置疑', '毫无疑问'
];

/** 大词空话 → 人话（只换取词，不碰事实） */
export const JARGON_MAP = [
  ['赋能', '帮上忙'],
  ['抓手', '办法'],
  ['闭环', '一整条流程'],
  ['沉淀', '攒下来'],
  ['颗粒度', '细节'],
  ['对齐', '对一下'],
  ['拉通', '串起来'],
  ['在当今社会', ''],
  ['众所周知', ''],
  ['不可否认', ''],
  ['随着时代的发展', ''],
  ['随着科技的发展', ''],
  ['综上所述', '']
];

/** 客服腔：整句删掉（删了不影响事实） */
export const SERVICE_CLICHES = [
  '感谢您的观看',
  '感谢观看',
  '希望对您有所帮助',
  '希望对你有所帮助',
  '欢迎大家留言讨论',
  '欢迎在评论区留言',
  '让我们一起',
  '如果觉得有帮助',
  '记得点赞关注'
];

/** 形容词堆料：合并重复的程度副词 */
const PUFFERY = ['非常', '十分', '极其', '超级', '特别', '相当'];

const norm = (s) => String(s ?? '');

/**
 * 去 AI 味（机械版）。
 * @returns {{text:string, changes:string[]}}
 */
export function deaiClean(input, { maxEmoji = 1 } = {}) {
  let s = norm(input);
  const changes = [];
  if (!s.trim()) return { text: s, changes };

  // ① 句首八股连接词（连标点一起删）
  for (const w of CRUTCH_CONNECTIVES) {
    const re = new RegExp(`(^|[。！？!?；;\\n])\\s*${w}\\s*[，,：:]\\s*`, 'g');
    if (re.test(s)) {
      s = s.replace(re, '$1');
      changes.push(`删掉句首连接词「${w}」`);
    }
  }

  // ② 客服腔整句删
  for (const w of SERVICE_CLICHES) {
    if (!s.includes(w)) continue;
    const re = new RegExp(`[^。！？!?\\n]*${w}[^。！？!?\\n]*[。！？!?]?`, 'g');
    s = s.replace(re, '');
    changes.push(`删掉客服腔「${w}」`);
  }

  // ③ 大词换人话
  // 先把"动词+宾语"整体改顺（直接替换成"帮上忙了X"会读着别扭）
  const VERB_REWRITES = [
    [/赋能了?([^。；，！？\s]{1,8})/g, '让$1更顺', '赋能X'],
    [/沉淀了?([^。；，！？\s]{1,8})/g, '把$1攒起来', '沉淀X'],
    [/拉通了?([^。；，！？\s]{1,8})/g, '把$1串起来', '拉通X'],
    [/对齐了?([^。；，！？\s]{1,8})/g, '跟$1对一下', '对齐X']
  ];
  for (const [re, to, label] of VERB_REWRITES) {
    if (!re.test(s)) continue;
    s = s.replace(re, to);
    changes.push(`「${label}」改成"${to.replace(/\$\d/g, '…')}"`);
  }

  for (const [from, to] of JARGON_MAP) {
    if (!s.includes(from)) continue;
    s = s.split(from).join(to);
    changes.push(`「${from}」→「${to || '删掉'}」`);
  }

  // ④ 形容词堆料："非常非常" / "十分非常" → 只留一个
  for (const a of PUFFERY) {
    const re = new RegExp(`(${a})\\s*(${PUFFERY.join('|')})`, 'g');
    if (re.test(s)) { s = s.replace(re, '$1'); changes.push(`合并堆叠副词「${a}」`); }
  }

  // ⑤ emoji 堆砌：只留前 maxEmoji 个
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const emojis = s.match(emojiRe) || [];
  if (emojis.length > maxEmoji) {
    let seen = 0;
    s = s.replace(emojiRe, (m) => { seen += 1; return seen <= maxEmoji ? m : ''; });
    changes.push(`emoji 从 ${emojis.length} 个减到 ${maxEmoji} 个`);
  }

  // ⑥ 收拾残留：空标点、重复标点、多余空格
  s = s
    .replace(/[，,]\s*[。！？!?]/g, (m) => m.slice(-1))
    .replace(/([。！？!?])\1+/g, '$1')
    .replace(/^[\s，,。.!！?？、;；]+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([。！？!?，,])/g, '$1')
    .trim();

  // ⑦ 全删空了就退回原文（宁可留 AI 味，也不能发空文案）
  if (!s.trim()) return { text: norm(input).trim(), changes: [] };
  return { text: s, changes: [...new Set(changes)] };
}

/** 只取文本（调用方不关心细节时用） */
export function deaiText(input) {
  return deaiClean(input).text;
}

/** 事实/数字不变的自检：原文里的数字必须都还在 */
export function numbersPreserved(before, after) {
  const nums = (t) => (String(t).match(/\d+(?:\.\d+)?/g) || []).sort();
  return JSON.stringify(nums(before)) === JSON.stringify(nums(after));
}
