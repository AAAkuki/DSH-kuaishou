// 素材库 · 表情选项
//
// 需求：模板左侧那片空白（约 44% 宽度）太素，想放点东西又不想每次都自己画。
// 方案：内置一组"表情/贴纸"候选，出片时随机（或指定）贴到空白区。
//
// 素材来源（都本地、免费）：
//   1. 从模板图自身裁出来的角色（sticker-maid.png）—— 风格最统一
//   2. 纯 ffmpeg 画的 emoji 风格图形（鲸鱼/星星/爱心/云/音符）—— 零外部依赖
//   3. 用户自己放进 state/assets/stickers/ 的图片 —— 想用啥放啥
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 内置可用的"表情"（用 ffmpeg drawtext 画 emoji 字符，跨平台稳） */
export const EMOJI_PRESETS = {
  whale:   { emoji: '🐳', label: '鲸鱼', desc: '和背景的鲸鱼主题呼应' },
  sparkle: { emoji: '✨', label: '闪光', desc: '万能点缀' },
  heart:   { emoji: '💙', label: '蓝心', desc: '配蓝色调' },
  bubble:  { emoji: '💬', label: '对话泡', desc: '强调在说话' },
  music:   { emoji: '🎵', label: '音符', desc: '有配音时合适' },
  star:    { emoji: '⭐', label: '星星', desc: '简单醒目' },
  cloud:   { emoji: '☁️', label: '云', desc: '柔和' },
  wave:    { emoji: '🌊', label: '海浪', desc: '配深海/鲸蓝' }
};

/** 列出当前可用的表情：内置 + 用户放在 state/assets/stickers 的图片 */
export function listStickers({ root }) {
  const out = Object.entries(EMOJI_PRESETS).map(([id, v]) => ({
    id, kind: 'emoji', emoji: v.emoji, label: v.label, desc: v.desc
  }));
  const dir = path.join(root, 'state', 'assets', 'stickers');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
      out.push({ id: `file:${f}`, kind: 'image', file: path.join(dir, f), label: f });
    }
  }
  // 从模板裁出来的角色
  const maid = path.join(root, 'state', 'assets', 'sticker-maid.png');
  if (fs.existsSync(maid)) out.push({ id: 'file:sticker-maid.png', kind: 'image', file: maid, label: '模板角色（女仆娘）' });
  return out;
}

/**
 * 在视频左侧空白区贴一个表情。
 * 空白区：x 0 ~ width*0.30，纵向居中偏上。
 */
export function planSticker({ width = 1080, height = 1920, slot = 'left' } = {}) {
  // 左侧空白中心点（避开说话框所在的右下）
  if (slot === 'left') return { cx: Math.round(width * 0.26), cy: Math.round(height * 0.40), size: Math.round(width * 0.22) };
  if (slot === 'top') return { cx: Math.round(width * 0.5), cy: Math.round(height * 0.12), size: Math.round(width * 0.18) };
  return { cx: Math.round(width * 0.5), cy: Math.round(height * 0.5), size: Math.round(width * 0.2) };
}

/** 生成一个"表情 png"（emoji 用 drawtext 画到透明画布） */
export function renderEmojiPng(tools, { emoji, out, size = 320, font = 'C:/Windows/Fonts/seguiemj.ttf' }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fontFile = fs.existsSync(font) ? font : 'C:/Windows/Fonts/msyh.ttc';
  const tf = path.join(path.dirname(out), `emoji-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.txt`);
  fs.writeFileSync(tf, emoji, 'utf8');
  const tfArg = tf.replace(/\\/g, '/').replace(':', '\\:');
  const ff = fontFile.replace(/\\/g, '/').replace(':', '\\:');
  // 黑底白字 → colorkey 抠黑 → 透明底
  const vf = [
    'format=rgba',
    `drawtext=fontfile='${ff}':textfile='${tfArg}':fontsize=${Math.round(size * 0.7)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
    'colorkey=black:0.25:0.10'
  ].join(',');
  const r = spawnSync(tools.ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:d=1`,
    '-vf', vf, '-frames:v', '1', '-pix_fmt', 'rgba', out
  ], { encoding: 'utf8' });
  fs.rmSync(tf, { force: true });
  if (r.status !== 0) throw new Error(`画表情失败：${(r.stderr || '').split('\n').slice(-3).join(' ').slice(-200)}`);
  return out;
}

/** 位置预设：给用户选，不用填坐标 */
export const STICKER_POSITIONS = {
  'beside-box': { label: '字幕框左边', x: 0.20, y: 0.60 },
  'left-top': { label: '左上角', x: 0.18, y: 0.16 },
  'left-bottom': { label: '左下角', x: 0.18, y: 0.80 },
  'right-top': { label: '右上角', x: 0.82, y: 0.16 },
  'right-bottom': { label: '右下角', x: 0.82, y: 0.80 },
  center: { label: '画面中间', x: 0.50, y: 0.42 }
};

/** 大小预设：小/中/大 */
export const STICKER_SIZES = {
  small: { label: '小', scale: 0.16 },
  medium: { label: '中', scale: 0.26 },
  large: { label: '大', scale: 0.36 }
};

/** 情绪关键词 → 情绪标签（决定挑哪张贴纸） */
export const EMOTION_KEYWORDS = {
  happy: ['开心', '哈哈', '笑死', '快乐', '好玩', '太好了', '好耶', '愉快', '不错'],
  sad: ['难过', '可惜', '遗憾', '心疼', '难受', '伤感', '不容易', '丢人', '尴尬'],
  surprised: ['居然', '没想到', '竟然', '震惊', '什么鬼', '天呐', '真的假的'],
  thinking: ['为什么', '怎么', '是不是', '到底', '不懂', '琢磨', '问号', '压力'],
  angry: ['气死', '生气', '烦', '离谱', '忍不了', '受不了', '吐槽', '嫌弃'],
  love: ['喜欢', '爱', '可爱', '心动', '抱抱', '亲亲', '宝']
};

/** 从文案猜情绪；没命中就 calm */
export function detectEmotion(text) {
  const t = String(text ?? '');
  const score = {};
  for (const [emo, words] of Object.entries(EMOTION_KEYWORDS)) {
    score[emo] = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'calm';
}

/**
 * 每种情绪对应的 emoji（网页版发不了图片表情时，退化成往文案里塞这个）。
 * calm 给 🐳：鲸鱼女孩人设的签名表情。
 */
export const EMOTION_EMOJI = {
  happy: '😄',
  sad: '😭',
  surprised: '😮',
  thinking: '🤔',
  angry: '😤',
  love: '🥰',
  calm: '🐳'
};

/**
 * 给一条评论挑回复用的表情包。
 *
 * 挑选顺序：emotions.json 显式映射 > 文件名情绪线索（开心.png / 哭.jpg 这类）> 全库随机。
 * 同一情绪里**随机**挑一张 —— 每条都回同一张图比不回还假。
 *
 * @param {object} opts { root, commentText, random }
 * @returns {{file:string, emotion:string, matched:boolean, poolSize:number, reason:string}}
 */
export function pickReplySticker({ root, commentText = '', random = Math.random } = {}) {
  const files = scanStickerFiles(root);
  if (!files.length) {
    return { file: '', emotion: 'calm', matched: false, poolSize: 0, reason: '贴纸目录是空的（state/assets/stickers）' };
  }
  const emotion = detectEmotion(commentText);
  const mapping = loadStickerEmotions(root);
  const byMap = files.filter((f) => mapping[path.basename(f)] === emotion);
  const hints = FILE_HINTS[emotion] || [];
  const byName = files.filter((f) => {
    const name = path.basename(f).toLowerCase();
    return hints.some((h) => name.includes(String(h).toLowerCase()));
  });
  const pool = byMap.length ? byMap : byName.length ? byName : files;
  const file = pool[Math.floor(random() * pool.length) % pool.length];
  return {
    file,
    emotion,
    matched: pool !== files,
    poolSize: pool.length,
    reason: pool === files ? `没有「${emotion}」情绪的贴纸，从全部 ${files.length} 张里随机挑的` : ''
  };
}

/** 读情绪映射文件（stickers/emotions.json）：{ "xxx.jpg": "happy" } */
export function loadStickerEmotions(root) {
  const f = path.join(root, 'state', 'assets', 'stickers', 'emotions.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; }
}

/** 文件名里的情绪线索（用户自己命名成 开心.png / 哭.jpg 之类就能对上） */
const FILE_HINTS = {
  happy: ['开心', '笑', 'happy', 'smile', 'joy', '乐'],
  sad: ['难过', '哭', 'sad', 'cry', '泪'],
  surprised: ['惊', 'surprise', 'shock', '哇'],
  thinking: ['思考', '疑惑', 'think', 'what', '问号', '?'],
  angry: ['怒', '气', 'angry', 'mad'],
  love: ['爱', '心', 'love', 'heart', '亲']
};

/**
 * 按情绪挑一张贴纸。
 * @param {object} opts { emotion, files, fallback }
 * @returns {{file:string, emotion:string, matched:boolean}}
 */
export function pickSticker({ emotion = 'calm', files = [], fallback = '', mapping = {} } = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return { file: fallback || '', emotion, matched: false };

  // ① 映射文件优先（用户传的图通常没有情绪文件名）
  const mapped = list.find((f) => mapping[path.basename(f)] === emotion);
  if (mapped) return { file: mapped, emotion, matched: true };


  const hints = FILE_HINTS[emotion] || [];
  const hit = list.find((f) => {
    const name = String(f).toLowerCase();
    return hints.some((h) => name.includes(String(h).toLowerCase()));
  });
  if (hit) return { file: hit, emotion, matched: true };

  // 没有对应情绪的贴纸：用第一张（或 fallback）
  return { file: fallback || list[0], emotion, matched: false };
}

/**
 * 扫贴纸目录（用户导入的多张贴纸都在这里）。
 *
 * 有一类贴纸得跳过：**透明区太小的**（白底没抠干净）。
 * 用它会得到一个白方块/白边，比不用更难看 —— 用户反馈过"表情包不透明"。
 * 透明区清单由 tools/rematte-stickers.py 生成（matte.json），没有清单就不过滤。
 */
export function scanStickerFiles(root, { minTransparent = 0.10 } = {}) {
  const dir = path.join(root, 'state', 'assets', 'stickers');
  if (!fs.existsSync(dir)) return [];
  let matte = null;
  try { matte = JSON.parse(fs.readFileSync(path.join(dir, 'matte.json'), 'utf8')); } catch {}
  const all = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  // 同名时优先用 PNG：PNG 是已经抠好底的版本，同名的 JPG 是原图（白底，得现场再抠一遍，容易抠不干净）
  const pngBase = new Set(all.filter((f) => /\.png$/i.test(f)).map((f) => path.basename(f, path.extname(f))));
  return all
    .filter((f) => !(/\.jpe?g$/i.test(f) && pngBase.has(path.basename(f, path.extname(f)))))
    .filter((f) => {
      if (!matte || matte[f] === undefined) return true;      // 没测过 → 放行
      return Number(matte[f]) >= minTransparent;               // 白底没抠干净 → 跳过
    })
    .map((f) => path.join(dir, f));
}
