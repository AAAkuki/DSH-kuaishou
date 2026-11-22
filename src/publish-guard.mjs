// 发布去重：同一个视频 + 同一段文案，短时间内不许重复发。
//
// 为什么需要：10-27 那天同一个片子被发了 **4 次**（19:11 / 19:13 / 19:15 / 19:17），
// 每次重试或重复点「发布」都会新开一次上传 —— 在粉丝眼里就是刷屏。
// 现在发之前先查指纹，发成功再记账。
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;

/** 指纹：文件大小 + 文案（文件名/mtime 会变，不用） */
export function publishKey({ file, caption } = {}) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const cap = String(caption || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${size}|${cap}`;
}

/**
 * 查这个指纹最近发过没。
 * @returns {{duplicate:boolean, lastAt?:number, agoMin?:number}}
 */
export function checkDuplicate(state, key, { withinHours = 12, now = Date.now() } = {}) {
  const list = Array.isArray(state?.data?.publishedKeys) ? state.data.publishedKeys : [];
  const hit = [...list].reverse().find((x) => x && x.key === key);
  if (!hit) return { duplicate: false };
  const age = now - Number(hit.at || 0);
  if (age > withinHours * HOUR) return { duplicate: false };
  return { duplicate: true, lastAt: Number(hit.at), agoMin: Math.round(age / 60000) };
}

/** 记账（保留最近 60 条） */
export function markPublished(state, key, { now = Date.now() } = {}) {
  if (!state?.data) return;
  if (!Array.isArray(state.data.publishedKeys)) state.data.publishedKeys = [];
  state.data.publishedKeys.push({ key, at: now });
  if (state.data.publishedKeys.length > 60) state.data.publishedKeys = state.data.publishedKeys.slice(-60);
}
