// 「萝莉 + 去 AI 味」：萝莉靠降调提音高，去 AI 味靠加停顿/喘气/口吃的节奏
//
// 分工：
//   萝莉感 → 降调（asetrate + atempo）、削低频、抬中高频（童声更亮）
//   去 AI 味 → 句子之间插随机停顿、句尾加喘气音、随机插入口吃（重复首字）
import fs from 'node:fs';

export const CUTE_PRESETS = {
  loli: {
    label: '萝莉（轻）',
    pitch: 1.18,          // 比原声高约 3 个半音；再高就开始像"花栗鼠"（用户反馈"声音诡异"）
    // 少抬 3kHz、少加音量：以前 +3dB@3.2k 再 +4dB 整体音量，听起来又尖又冲
    filters: 'highpass=f=90,lowpass=f=9000,equalizer=f=2600:t=q:w=1.2:g=1.5,equalizer=f=200:t=q:w=1:g=-3,acompressor=threshold=-22dB:ratio=2:attack=8:release=140,volume=1dB'
  },
  loli_hard: {
    label: '萝莉（明显）',
    pitch: 1.30,
    filters: 'highpass=f=110,lowpass=f=9500,equalizer=f=3200:t=q:w=1.2:g=2.5,equalizer=f=220:t=q:w=1:g=-5,acompressor=threshold=-22dB:ratio=2.5:attack=6:release=120,volume=2dB'
  },
  loli_soft: {
    label: '萝莉（奶）',
    pitch: 1.12,
    filters: 'highpass=f=80,lowpass=f=7000,equalizer=f=2400:t=q:w=1.4:g=1.5,equalizer=f=190:t=q:w=1:g=-2.5,acompressor=threshold=-24dB:ratio=2:attack=10:release=160,volume=1dB'
  },
  natural: {
    label: '自然（不升调，最不容易"诡异"）',
    pitch: 1,
    filters: 'highpass=f=70,lowpass=f=11000,equalizer=f=2400:t=q:w=1.3:g=1,equalizer=f=180:t=q:w=1:g=-1.5,acompressor=threshold=-20dB:ratio=1.8:attack=10:release=160'
  }
};

/**
 * 给一段文本加"人味"：口吃 + 语气词 + 停顿点。
 * @param {string} text
 * @param {object} opts
 */
export function humanizeText(text, { stutterRate = 0.28, addParticles = true, seed = null } = {}) {
  let rnd = seed === null ? Math.random : (() => { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; })();
  const sentences = String(text).split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    let cur = s;
    // 口吃：把开头第一个字重复一次（"我我…" / "这这"）
    if (rnd() < stutterRate) {
      const m = cur.match(/^([\u4e00-\u9fa5])/);
      if (m) cur = cur.replace(/^([\u4e00-\u9fa5])/, `${m[1]}、${m[1]}`);
    }
    // 句中插入停顿（用逗号断开一个长句）
    if (cur.length > 14 && rnd() < 0.5) {
      const pos = Math.floor(cur.length * (0.4 + rnd() * 0.2));
      cur = `${cur.slice(0, pos)}，${cur.slice(pos)}`;
    }
    out.push(cur);
  }
  return out.join('　');  // 全角空格在 espeak 里会产生明显停顿
}

/**
 * 合成"萝莉 + 有人味"的语音。
 * 分段合成 → 段间插停顿/喘气 → 拼起来，这样停顿可控。
 */
export function buildSsmlSegments(text, { seed = 42 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const sentences = String(text).split(/(?<=[。！？!?…])/).map((x) => x.trim()).filter(Boolean);
  const segs = [];
  for (const sent of sentences) {
    let cur = sent;
    if (rnd() < 0.3) {
      const m = cur.match(/^([\u4e00-\u9fa5])/);
      if (m) cur = cur.replace(/^([\u4e00-\u9fa5])/, `${m[1]}、${m[1]}`);
    }
    segs.push(cur);
    // 句子之间：多数情况短停，偶尔长停（像思考）
    segs.push({ silence: rnd() < 0.35 ? 0.75 : 0.32 });
  }
  return segs;
}

export { fs };
