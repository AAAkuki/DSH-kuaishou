// 网络梗学习：刷视频时顺手把看到的梗记下来，回评和视频文案里再用出去。
//
// 设计取舍：
//   · 只认"像梗"的东西，不是把整段文案存下来 —— 存整段只会把文案污染成复读机。
//   · 词库文件只有一个 state/slang.json（原子写），最多留 300 条，按出现次数+最近使用排序。
//   · 用的时候是**低频**掺进去（默认 20%），否则每条回复都带梗，一眼假。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from './safety.mjs';

/** 常见中文网络梗/口头梗（命中即收录；不在表里的靠规则抽） */
export const KNOWN_MEMES = [
  '破防', '绷不住', '蚌埠住了', '栓Q', '退退退', '我裂开了', '你礼貌吗', '已读乱回',
  '显眼包', '遥遥领先', '情绪价值', '情绪稳定', '班味', '早八', '偷感', '搭子',
  'city不city', '整活', '抽象', '绝绝子', '无语子', 'i人', 'e人', '淡人',
  '命运的齿轮开始转动', '确诊为', '小丑竟是我自己', '这波啊', '有被笑到',
  '这谁顶得住', '我 TM 直接', '离谱他妈给离谱开门', '蚌埠', '上大分', '离谱',
  '格局打开', '开摆', '躺平', '内卷', '社死', '阴阳怪气', '嘴替', '互联网嘴替',
  'dddd', 'yyds', 'awsl', 'u1s1', 'emmm', '阿巴阿巴', '笑死', '笑不活了',
  '我是自愿的', '听我说谢谢你', '芭比Q', '辣眼睛', '破大防', '整不会了',
  '一眼丁真', '泰裤辣', '我真的会谢', '感觉不如', '有点东西', '你干嘛哎哟'
];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 从一段文案里抽"梗"候选（纯函数）。
 * @returns {string[]} 去重后的候选词
 */
export function extractMemes(text) {
  const t = norm(text);
  if (!t) return [];
  const out = new Set();

  // ① 命中已知梗
  for (const m of KNOWN_MEMES) if (t.includes(m)) out.add(m);

  // ② 话题标签当"梗"候选（#抽象 #整活 这类）
  for (const m of t.matchAll(/#\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10})/g)) out.add(norm(m[1]));

  // ③ 引号里的短语（「」/ "" / ''）—— 一般是上一句的"金句"
  for (const m of t.matchAll(/[「"“]([\u4e00-\u9fa5A-Za-z0-9]{2,12})[」"”]/g)) out.add(norm(m[1]));

  // ④ 网络构词：XX文学 / XX门 / XX体 / XX式
  for (const m of t.matchAll(/([\u4e00-\u9fa5]{2,4})(文学|门|体|式)/g)) out.add(norm(m[0]));

  // ⑤ 全大写/英文短梗（yyds、awsl、dddd 这种 3~6 个字母）
  for (const m of t.matchAll(/\b([A-Za-z]{3,6})\b/g)) {
    const w = m[1];
    if (/^(yyds|awsl|dddd|u1s1|emo|omg|doge)$/i.test(w)) out.add(w.toLowerCase());
  }

  // 过滤：太短/太长/纯数字/纯标点都不要
  return [...out].filter((w) => {
    if (w.length < 2 || w.length > 12) return false;
    if (/^\d+$/.test(w)) return false;
    if (/^[.,!?，。！？、;；:：]+$/.test(w)) return false;
    return true;
  });
}

/** 词库文件路径 */
export function slangFile(root) {
  return path.join(root, 'state', 'slang.json');
}

/** 读词库（坏了就当空，不抛） */
export function loadSlang(root) {
  const { value } = readJsonSafe(slangFile(root), null);
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    version: 1,
    items: items
      .filter((x) => x && typeof x.term === 'string' && x.term.length >= 2)
      .map((x) => ({ term: x.term, count: Number(x.count) || 1, firstAt: x.firstAt || '', lastAt: x.lastAt || '', used: Number(x.used) || 0 }))
  };
}

/**
 * 把抽到的候选并进词库（返回新增/更新后的词库 + 这次新增了哪些）。
 * @param {object} store  loadSlang() 的结果（会被就地更新）
 * @param {string[]} terms
 */
export function learnMemes(store, terms, { now = new Date().toISOString(), max = 300 } = {}) {
  const book = store && Array.isArray(store.items) ? store : { version: 1, items: [] };
  const fresh = [];
  for (const raw of terms || []) {
    const term = norm(raw);
    if (term.length < 2 || term.length > 12) continue;
    const hit = book.items.find((x) => x.term === term);
    if (hit) {
      hit.count += 1;
      hit.lastAt = now;
    } else {
      book.items.push({ term, count: 1, firstAt: now, lastAt: now, used: 0 });
      fresh.push(term);
    }
  }
  // 只留最近的 max 条：按 lastAt 排，次数高的优先留下
  if (book.items.length > max) {
    book.items.sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)));
    book.items = book.items.slice(0, max);
  }
  return { store: book, fresh };
}

/** 存盘（原子写，坏不了） */
export function saveSlang(root, store) {
  writeJsonAtomic(slangFile(root), { version: 1, updatedAt: new Date().toISOString(), items: store.items ?? [] });
  return slangFile(root);
}

/**
 * 挑一个梗来用。
 * 规则：优先没被用过的；同一个词用完计数，避免连着复读。
 */
export function pickSlang(store, { random = Math.random, exclude = [] } = {}) {
  const items = (store?.items ?? []).filter((x) => x.term && !exclude.includes(x.term));
  if (!items.length) return '';
  const unused = items.filter((x) => !x.used);
  const pool = unused.length ? unused : items;
  const pick = pool[Math.floor(random() * pool.length) % pool.length];
  pick.used = (Number(pick.used) || 0) + 1;
  return pick.term;
}
