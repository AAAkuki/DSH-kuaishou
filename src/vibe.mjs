// Vibe 知识大赏 风格：分镜驱动的知识科普视频。
//
// 这套方法是从 Winhao 的教程里拆出来的（6 步：搜集 → 编排 → 找图 → 定样式写分镜 → 检查 → 直出），
// 落到代码里就是三件事：
//   1. planScenes：把文案切成一幕一幕，每幕多少秒（优先卡在 BGM 拍子上）
//   2. renderCards：每幕画一张卡片（Pillow，三种画风）
//   3. assemble：卡片 → 视频（每幕缓慢推拉 + 硬切，底下垫 BGM）
//
// 老的模板视频（render-template.mjs / video.mjs）完全不动，用户想用旧的还有。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const VIBE_STYLES = {
  notes: { label: '课堂笔记', hint: '米色纸 + 蓝黑字 + 红线，像同桌给你讲' },
  poster: { label: '黄黑大字海报', hint: '黑底黄字，强观点、强冲击' },
  docu: { label: '纪录片', hint: '深底白字 + 细黄线，适合严肃科普' }
};

/** 找 Python（渲染卡片要用 Pillow）。优先 DSH 自带的那份，其次系统 python。 */
export function pythonPath() {
  const cands = [
    process.env.KSOPS_PYTHON || '',
    'C:/Users/wudiw/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    'python',
    'python3'
  ].filter(Boolean);
  for (const p of cands) {
    try {
      const r = spawnSync(p, ['-c', 'import PIL, numpy; print("ok")'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) return p;
    } catch {}
  }
  throw new Error('找不到带 Pillow/numpy 的 Python：设 KSOPS_PYTHON 指向 python.exe');
}

/**
 * 文案 → 分镜：一幕 1 句（长句自动拆），时长按 skill 的阅读速度算：
 * 「约 0.6 秒 + 每 6 个字 1 秒」（20 字 ≈ 3.9 秒），并且单屏不超过 20 字。
 * 这套规则来自 Win-Hao/knowledge-video 的 references/notes.md，实测不容易读不完。
 */
export const CHARS_PER_SCREEN = 20;
export function readingSeconds(text) {
  const n = String(text || '').replace(/\s+/g, '').length;
  return Number((0.6 + n / 6).toFixed(2));
}

/** 把长句拆成"一屏 ≤20 字"的小句；带上是第几句拆出来的（后面配大字要按这个对） */
export function splitScreens(lines = [], maxChars = CHARS_PER_SCREEN) {
  const out = [];
  const CONNECTIVE = /^(而|但|不过|所以|因此|然后|可是|只是|结果|于是)/;
  for (let si = 0; si < (lines || []).length; si++) {
    const s = String(lines[si] || '').trim();
    if (!s) continue;
    if (s.length <= maxChars) { out.push({ text: s, src: si }); continue; }

    // ① 先按句末标点切（这样最自然），② 单句仍超长再按逗号，③ 还超长才硬切
    const sentences = s.split(/(?<=[。！？])/).filter(Boolean);
    const local = [];
    for (const sent of sentences) {
      if (sent.length <= maxChars) { local.push(sent); continue; }
      const clauses = sent.split(/(?<=[，、；：])/).filter(Boolean);
      let buf = '';
      for (const c of clauses) {
        if ((buf + c).length <= maxChars) { buf += c; continue; }
        if (buf) local.push(buf);
        if (c.length <= maxChars) { buf = c; continue; }
        for (let i = 0; i < c.length; i += maxChars) local.push(c.slice(i, i + maxChars));
        buf = '';
      }
      if (buf) local.push(buf);
    }

    // ③ 以连接词开头的碎片并回上一屏（"而是换了个问法。"单独一屏读着很怪）
    const cleaned = [];
    for (const t of local) {
      if (cleaned.length && CONNECTIVE.test(t) && (cleaned[cleaned.length - 1].length + t.length) <= maxChars * 1.3) {
        cleaned[cleaned.length - 1] += t;
        continue;
      }
      if (cleaned.length && t.length < 6) { cleaned[cleaned.length - 1] += t; continue; }
      cleaned.push(t);
    }
    for (const t of cleaned) out.push({ text: t, src: si });
  }
  return out;
}

export function planScenes({ lines, beats = [], totalSec = 0, maxPerScene = 1, minSceneSec = 1.2 } = {}) {
  const items = splitScreens(Array.isArray(lines) ? lines : []);
  if (!items.length) throw new Error('planScenes: lines 不能为空');

  // ① 分组：默认一句一屏（skill 的结论：没有旁白时观众只能读）
  const scenes = [];
  for (let i = 0; i < items.length; i += maxPerScene) {
    const group = items.slice(i, i + maxPerScene);
    scenes.push({
      lines: group.map((g) => g.text),
      src: group[0].src,
      chars: group.reduce((a, g) => a + g.text.length, 0)
    });
  }

  // ② 时长：按"阅读速度"给，不按字数强行摊满（摊满会让人读不完）
  const readTotal = scenes.reduce((a, s) => a + readingSeconds(s.lines.join('')), 0);
  const target = Number(totalSec) > 0 ? Number(totalSec) : readTotal;
  // 若指定了总时长，按比例缩放，但每幕不小于 minSceneSec
  const scale = readTotal > 0 ? target / readTotal : 1;
  let acc = 0;
  const out = scenes.map((s, i) => {
    const raw = Math.max(minSceneSec, readingSeconds(s.lines.join('')) * scale);
    const sec = i === scenes.length - 1 ? Math.max(minSceneSec, target - acc) : raw;
    acc += sec;
    return { index: i + 1, lines: s.lines, src: s.src, seconds: Number(sec.toFixed(2)) };
  });

  // ③ 卡点：把每幕结束时间吸到最近的拍子上（最多挪动 0.35 秒，别把节奏搞乱）
  if (Array.isArray(beats) && beats.length > 2) {
    let t = 0;
    const snapped = out.map((s) => {
      t += s.seconds;
      const near = beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
      const moved = Math.abs(near - t) <= 0.35 ? near : t;
      return moved;
    });
    // 还原成每幕时长（保证单调递增、且不小于 minSceneSec）
    let prev = 0;
    out.forEach((s, i) => {
      const end = Math.max(prev + minSceneSec, snapped[i]);
      s.seconds = Number((end - prev).toFixed(2));
      prev = end;
    });
  }

  const total = out.reduce((a, b) => a + b.seconds, 0);
  return { scenes: out, totalSec: Number(total.toFixed(2)) };
}

/** 用 numpy 找拍点（坏了就退化成 120BPM 匀速） */
export function detectBeats({ ffmpeg, audio, python }) {
  const empty = { duration: 0, bpm: 0, beats: [] };
  if (!audio || !fs.existsSync(audio)) return empty;
  try {
    const r = spawnSync(python, [path.join(process.cwd(), 'tools', 'beats.py'), ffmpeg, audio], {
      encoding: 'utf8', timeout: 60000
    });
    if (r.status !== 0) return empty;
    return JSON.parse(r.stdout);
  } catch { return empty; }
}

/** 一格一秒的假拍子（没有 BGM 时也能卡点） */
export function syntheticBeats(seconds, bpm = 120) {
  const gap = 60 / bpm;
  const out = [];
  for (let t = gap; t <= seconds + 0.001; t += gap) out.push(Number(t.toFixed(3)));
  return { duration: seconds, bpm, beats: out };
}

/** 跑 Pillow 渲染每幕卡片 */
export function renderCards({ spec, python }) {
  const tmp = path.join(spec.outDir, 'storyboard.json');
  fs.mkdirSync(spec.outDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2), 'utf8');
  const r = spawnSync(python, [path.join(process.cwd(), 'tools', 'vibe-render.py'), tmp], {
    encoding: 'utf8', timeout: 180000
  });
  if (r.status !== 0) {
    throw new Error(`卡片渲染失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
  }
  let report = { overflow: false, scenes: [] };
  try { report = JSON.parse(fs.readFileSync(path.join(spec.outDir, 'report.json'), 'utf8')); } catch {}
  return report;
}

/**
 * 卡片 → 成片。
 * 每幕给一点缓慢推近（zoompan），幕间硬切；BGM 垫底、结尾淡出。
 */
export function assemble({ ffmpeg, out, outDir, scenes, bgm, fps = 30, width, height, tailFadeSec = 1.2 }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const inputs = [];
  scenes.forEach((s, i) => {
    const png = path.join(outDir, `s${String(i + 1).padStart(2, '0')}.png`);
    inputs.push({ png, seconds: Number(s.seconds) || 2 });
  });
  inputs.forEach((it) => {
    args.push('-loop', '1', '-framerate', String(fps), '-t', it.seconds.toFixed(3), '-i', it.png);
  });
  const audioIdx = inputs.length;
  const hasBgm = Boolean(bgm && fs.existsSync(bgm));
  if (hasBgm) args.push('-i', bgm);

  const parts = [];
  inputs.forEach((_, i) => {
    // 每幕：放大一点点，避免"静帧 PPT"感；zoompan 的 d=1 表示每帧都算
    parts.push(
      `[${i}:v]scale=${width * 2}:${height * 2}:flags=lanczos,` +
      `zoompan=z='min(zoom+0.0012,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},` +
      `setsar=1[v${i}]`
    );
  });
  const concatIn = inputs.map((_, i) => `[v${i}]`).join('');
  parts.push(`${concatIn}concat=n=${inputs.length}:v=1:a=0[vout]`);

  const totalSec = inputs.reduce((a, b) => a + b.seconds, 0);
  let mapAudio = null;
  if (hasBgm) {
    parts.push(
      `[${audioIdx}:a]atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${Math.max(0, totalSec - tailFadeSec).toFixed(3)}:d=${tailFadeSec}[aout]`
    );
    mapAudio = '[aout]';
  }

  args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
  if (mapAudio) args.push('-map', mapAudio);
  args.push(
    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-movflags', '+faststart', '-t', totalSec.toFixed(3), out
  );
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 15 * 60 * 1000 });
  if (r.status !== 0) {
    throw new Error(`拼接失败：${String(r.stderr || '').slice(-400)}`);
  }
  return { out, totalSec: Number(totalSec.toFixed(2)), scenes: inputs.length, bgm: hasBgm };
}

/** 一个口子做完：文案 → 分镜 → 卡片 → 成片 */
export function renderVibeVideo({
  lines, out, outDir, ffmpeg, python, bgm = '', style = 'notes', font = '',
  width = 1080, height = 1920, fps = 30, totalSec = 0, beats = null,
  bigWords = [], sources = [], images = []
} = {}) {
  if (!out) throw new Error('renderVibeVideo: out 不能为空');
  const detected = beats || (bgm ? detectBeats({ ffmpeg, audio: bgm, python }) : syntheticBeats(totalSec || 40, 120));
  const plan = planScenes({
    lines, beats: detected.beats, totalSec: totalSec || detected.duration || 0
  });

  /**
   * 每幕的"大字"和对齐方式：
   * 以前按「第几屏」对应 bigWords，但长句会被拆成多屏 → 大字和正文错位
   * （实测出现"七十五年后"配"而是换了个问法"）。
   * 现在按**原始第几句**（s.src）对应：拆出来的后续屏不再重复大字。
   */
  const bigOf = (src, i) => bigWords[src] ?? bigWords[i] ?? '';
  const seenSrc = new Set();
  const scenes = plan.scenes.map((s, i) => {
    const firstOfSrc = !seenSrc.has(s.src);
    seenSrc.add(s.src);
    // 调用方给的大字优先；没给就把这一屏第一句当大字（那这句就不在正文里重复）
    const provided = firstOfSrc ? bigOf(s.src, i) : '';
    const big = provided || (firstOfSrc ? (s.lines[0] || '').slice(0, 18) : '');
    // 大字和正文重复时（大字就是这一屏的头几个字）把那句从正文里去掉，别念两遍
    const dedupe = (arr) => (provided ? arr.filter((l) => !String(l).startsWith(String(provided).slice(0, 5))) : arr);
    const lines = provided ? dedupe(s.lines) : (firstOfSrc ? s.lines.slice(1) : s.lines);
    return {
      index: s.index,
      seconds: s.seconds,
      src: s.src,
      big,
      lines,
      source: sources[s.src] ?? sources[i] ?? '',
      image: images[s.src] ?? images[i] ?? ''
    };
  });

  const dir = path.resolve(outDir || path.join(path.dirname(out), `vibe-${Date.now()}`));
  const report = renderCards({
    spec: { width, height, style, font: font || path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'msyh.ttc'), outDir: dir, scenes },
    python
  });
  const built = assemble({ ffmpeg, out: path.resolve(out), outDir: dir, scenes, bgm, fps, width, height });
  return { ...built, plan, beats: { bpm: detected.bpm, count: (detected.beats || []).length }, overflow: report.overflow, dir };
}
