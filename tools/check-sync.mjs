// 检查成片的「音画同步 + 音频是否干净」。
//
// 做法：把音轨里的静音段找出来（ffmpeg silencedetect），
// 每一段有声音的地方应该对应一句字幕；句间静音应该是 0.2~0.6 秒的小停顿。
//
// 用法：node tools/check-sync.mjs <视频文件> [字幕句数]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const file = process.argv[2];
const expectLines = Number(process.argv[3] || 0);
if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/check-sync.mjs <视频文件> [字幕句数]');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const ffmpeg = path.join(root, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');

// 静音阈值 -32dB、持续 0.12 秒以上算停顿
const r = spawnSync(ffmpeg, [
  '-hide_banner', '-nostats', '-i', file,
  '-af', 'silencedetect=noise=-32dB:d=0.12', '-f', 'null', '-'
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const err = String(r.stderr || '');
const durMatch = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
const total = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0;

const silences = [];
for (const m of err.matchAll(/silence_start:\s*(-?[\d.]+)/g)) silences.push({ start: Number(m[1]), end: null });
for (const m of err.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)) {
  // 配最先出现的那个「还没配对的 silence_start」（按时间顺序），否则区间会乱序
  const s = silences.find((x) => x.end === null);
  if (s) { s.end = Number(m[1]); s.len = Number(m[2]); }
}

// 有声音的区间 = 静音区间的补集
const speech = [];
let cursor = 0;
for (const s of silences) {
  if (s.start > cursor + 0.05) speech.push({ start: cursor, end: s.start, len: s.start - cursor });
  cursor = s.end ?? s.start;
}
if (total > cursor + 0.05) speech.push({ start: cursor, end: total, len: total - cursor });

const fmt = (x) => x.toFixed(2).padStart(6);
console.log(`文件：${path.basename(file)}`);
console.log(`时长：${total.toFixed(2)} 秒`);
console.log(`有声段：${speech.length}${expectLines ? `（字幕 ${expectLines} 句）` : ''}`);
console.log(`静音段：${silences.length}`);
const gaps = silences.filter((s) => s.len != null);
if (gaps.length) {
  const avg = gaps.reduce((a, b) => a + b.len, 0) / gaps.length;
  console.log(`句间停顿：平均 ${avg.toFixed(2)} 秒，最长 ${Math.max(...gaps.map((g) => g.len)).toFixed(2)} 秒`);
  const weird = gaps.filter((g) => g.len > 1.0);
  if (weird.length) console.log(`⚠️ 有 ${weird.length} 处停顿超过 1 秒（可能漏句或空转）：${weird.map((g) => g.start.toFixed(1)).join(', ')}`);
}

console.log('\n有声段一览：');
speech.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${fmt(s.start)} → ${fmt(s.end)}  (${s.len.toFixed(2)}s)`));

/**
 * 如果同目录有 <视频>.timeline.json（render-demo 会写），就做**真同步检查**：
 * 拿每句字幕的预期开始时间，去有声段里找最近的一个起点，误差应该 < 0.4 秒。
 * 没有这个文件就只能做结构检查（有声段数 vs 句数）。
 */
function readTimeline(file) {
  const t = `${file}.timeline.json`;
  if (!fs.existsSync(t)) return null;
  try { return JSON.parse(fs.readFileSync(t, 'utf8')); } catch { return null; }
}

const timeline = readTimeline(file);
let bad = 0;
// 有句级时间轴时，「有声段数 vs 句数」不作为判据：
// piper 会在句内逗号处自己停顿，检测出来就成了两段，属于正常现象。
if (!timeline?.timeline?.length && expectLines && Math.abs(speech.length - expectLines) > 1) {
  console.log(`\n⚠️ 有声段 ${speech.length} 和字幕 ${expectLines} 对不上（差超过 1）：可能有一句没念或两句连在一起`);
  bad += 1;
}
if (timeline?.timeline?.length) {
  const starts = speech.map((s) => s.start);
  const offsets = [];
  let missing = 0;
  for (const seg of timeline.timeline) {
    const near = starts.reduce((best, s) => (Math.abs(s - seg.start) < Math.abs(best - seg.start) ? s : best), starts[0] ?? 0);
    const d = Math.abs(near - seg.start);
    if (d > 1.2) missing += 1;
    offsets.push({ text: seg.text, want: seg.start, got: near, d });
  }
  const max = Math.max(...offsets.map((o) => o.d));
  const avg = offsets.reduce((a, o) => a + o.d, 0) / offsets.length;
  console.log(`\n=== 句级同步（对比 ${timeline.timeline.length} 段配音时间轴）===`);
  console.log(`平均误差 ${avg.toFixed(2)} 秒 / 最大 ${max.toFixed(2)} 秒`);
  const worst = offsets.filter((o) => o.d > 0.4).sort((a, b) => b.d - a.d).slice(0, 5);
  if (worst.length) {
    console.log('偏差较大的句子：');
    for (const o of worst) console.log(`  ${o.d.toFixed(2)}s  「${String(o.text).slice(0, 16)}」 预期 ${o.want.toFixed(2)} / 实测 ${o.got.toFixed(2)}`);
    bad += 1;
  }
  if (missing) { console.log(`⚠️ ${missing} 句找不到对应的有声段（可能没念出来）`); bad += 1; }
  if (bad === 0) console.log('✅ 逐句对得上（误差 < 0.4 秒）');
}
const shortLine = speech.filter((s) => s.len < 0.35);
if (shortLine.length) {
  console.log(`\n⚠️ ${shortLine.length} 段有声 < 0.35 秒：像"哼/啊"这种碎音（多半是尾音，不一定是问题）`);
}
console.log(bad === 0 ? '\n✅ 同步结构看起来正常' : '\n有上面的疑点，先看这几段');
process.exitCode = bad === 0 ? 0 : 1;
