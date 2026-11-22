// 合成"萝莉 + 去 AI 味"语音：分段合成 + 插停顿 + 喘气 + 升调
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CUTE_PRESETS } from './cute-voice.mjs';

function run(cmd, args, { input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`超时：${path.basename(cmd)}`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(t); reject(new Error(`启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`${path.basename(cmd)} 退出码 ${code}: ${err.slice(-300)}`));
      else resolve({ out, err });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

/** 生成一小段"喘气/吸气"音：白噪声 + 高通，短促。 */
async function makeBreath(ffmpeg, outFile) {
  await run(ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=0.32:amplitude=0.10',
    '-af', 'highpass=f=600,lowpass=f=3000,afade=t=in:st=0:d=0.08,afade=t=out:st=0.22:d=0.10,volume=1.6',
    '-ar', '22050', '-ac', '1', outFile
  ]);
  return outFile;
}

/**
 * 剪掉一段人声首尾的静音。
 *
 * 为什么必须剪：piper 每段前面有 ~0.5-0.7 秒静音、后面还有尾巴。
 * 这些静音会被算进"这一段有多长"，于是字幕时间轴整体比人声**早**半个多秒，
 * 念到后面越差越多（用户说的"音画不同步"）。剪掉之后时间轴就是真实的说话时间。
 */
async function trimSilence(tools, file) {
  const tmp = `${file}.trim.wav`;
  const head = 'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-40dB:detection=peak';
  const tail = 'areverse,silenceremove=start_periods=1:start_silence=0.08:start_threshold=-40dB:detection=peak,areverse';
  try {
    await run(tools.ffmpeg, [
      '-hide_banner', '-y', '-i', file,
      // 首尾都剪，但各留 40/80 毫秒，避免切掉辅音开头和收尾的气口
      '-af', `${head},${tail}`,
      '-ar', '22050', '-ac', '1', tmp
    ]);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;   // 剪失败就用原段（宁可有点偏移，也别没声音）
  }
}

/** 生成静音段 */
async function makeSilence(ffmpeg, outFile, sec) {
  // 注意：这个 ffmpeg 的 anullsrc 不认 d=，用 -t 控制时长
  await run(ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono',
    '-t', String(sec),
    '-ar', '22050', '-ac', '1', outFile
  ]);
  return outFile;
}

/**
 * 主入口：把一段文本合成成"有人味"的萝莉语音
 * @param {object} tools {ffmpeg, ffprobe}
 * @param {object} opts
 *   text      要念的文本
 *   out       输出 wav
 *   workDir   中间文件目录
 *   piperExe / piperModel
 *   preset    CUTE_PRESETS 的键（loli / loli_hard / loli_soft）
 *   stutter   是否加口吃（默认 true）
 *   breath    是否加喘气（默认 true）
 *   pause     是否加句中停顿（默认 true）
 *   lengthScale  piper 语速（>1 更慢，萝莉感更足）
 */
export async function synthCute(tools, {
  text, lines, out, workDir, piperExe, piperModel,
  preset = 'loli', stutter = false, breath = false, pause = true, lengthScale = 1.12, seed = 42,
  /** 目标总时长（秒）：句间停顿会均摊补足，避免结尾一大段静音 */
  targetSec = 0
} = {}) {
  if (!piperExe || !fs.existsSync(piperExe)) throw new Error(`piper 不存在：${piperExe || '(未配置)'}`);
  if (!piperModel || !fs.existsSync(piperModel)) throw new Error(`语音模型不存在：${piperModel || '(未配置)'}`);
  // 独立子目录，避免并发/多次调用互相覆盖 part-*.wav
  workDir = path.join(String(workDir), `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(workDir, { recursive: true });

  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;

  /**
   * ① 切句：**优先用调用方给的 lines**。
   *
   * 这里以前只按 [。！？!?…] 切，而 video.mjs 传进来的是 lines.join('，') ——
   * 中文逗号不在切分集合里，于是整段变成"一句"，timeline 只有 1 段，
   * 字幕只能按字数比例估算，念到后面就越来越不对（用户说的"音画不同步"）。
   * 现在一句一行，timeline 天然和字幕 1:1。
   */
  const segments = Array.isArray(lines) && lines.length
    ? lines.map((x) => String(x ?? '').trim()).filter(Boolean)
    : String(text ?? '').split(/(?<=[。！？!?…，,；;])/).map((x) => x.trim()).filter(Boolean);
  if (!segments.length) throw new Error('没有可念的文本');

  // ① 先把每句合成出来（只合成 speak 段），拿到真实时长再决定停顿多长
  const speaks = [];
  for (const sent of segments) {
    let cur = sent;
    // 口吃：重复开头第一个字（默认关：实测听起来像卡顿，不像人）
    if (stutter && rnd() < 0.3) {
      const m = cur.match(/^([\u4e00-\u9fa5])/);
      if (m) cur = cur.replace(/^([\u4e00-\u9fa5])/, `${m[1]}、${m[1]}`);
    }
    const f = path.join(workDir, `speak-${speaks.length}.wav`);
    const txtFile = `${f}.txt`;
    fs.writeFileSync(txtFile, cur, 'utf8');
    await run(piperExe, [
      '--model', piperModel,
      '--output_file', f,
      '--length_scale', String(lengthScale),
      '--noise_scale', '0.75',
      '--noise_w', '0.95',
      '--sentence_silence', '0.12'
    ], { input: fs.readFileSync(txtFile) });
    fs.rmSync(txtFile, { force: true });
    // 剪掉 piper 自带的头尾静音：不剪的话字幕会比人声早半秒左右
    await trimSilence(tools, f);
    speaks.push({ text: cur, file: f });
  }

  const probeDur = (f) => {
    try {
      const pr = spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f], { encoding: 'utf8' });
      return Number(JSON.parse(pr.stdout || '{}').format?.duration ?? 0) || 0;
    } catch { return 0; }
  };

  /**
   * ② 决定句间停顿。
   *
   * 以前固定 0.26/0.55 秒、而且最后一句后面也塞一个，结果整段只有 51 秒，
   * 剩下 7 秒全是结尾静音 —— 观众看到的是"画面还在动、声音没了"。
   * 现在：有 targetSec 就把"差的那几秒"均摊到句间（每处最多 0.9 秒），
   * 既凑够一分钟，又不会在结尾堆一大段空白。
   */
  const speakDurs = speaks.map((sp) => probeDur(sp.file));
  const speakTotal = speakDurs.reduce((a, b) => a + b, 0);
  const gapCount = Math.max(0, speaks.length - 1);
  let gaps = Array.from({ length: gapCount }, () => (pause ? (rnd() < 0.35 ? 0.55 : 0.26) : 0));
  if (pause && targetSec && gapCount > 0) {
    const need = Number(targetSec) - speakTotal;
    const base = gaps.reduce((a, b) => a + b, 0);
    if (need > base) {
      const extra = (need - base) / gapCount;
      // 每处最多加 1.15 秒：再多就变成"每句之间都停顿一大口气"，反而不像人
      gaps = gaps.map((g) => Math.min(1.15, g + extra));
    }
  }

  // ③ 按顺序拼：说话 → 停顿 → 说话 …（最后一句后面不再补静音）
  const parts = [];
  const durations = [];
  const timeline = [];
  let t = 0;
  for (let i = 0; i < speaks.length; i++) {
    parts.push(speaks[i].file);
    durations.push(speakDurs[i]);
    timeline.push({ text: speaks[i].text, start: Number(t.toFixed(2)), end: Number((t + speakDurs[i]).toFixed(2)), index: i });
    t += speakDurs[i];
    if (i < speaks.length - 1) {
      if (gaps[i] > 0) {
        const sf = path.join(workDir, `gap-${i}.wav`);
        await makeSilence(tools.ffmpeg, sf, gaps[i]);
        parts.push(sf);
        durations.push(gaps[i]);
        t += gaps[i];
      }
      if (breath && rnd() < 0.34) {
        const bf = path.join(workDir, `breath-${i}.wav`);
        await makeBreath(tools.ffmpeg, bf);
        const bd = probeDur(bf);
        parts.push(bf);
        durations.push(bd);
        t += bd;
      }
    }
  }

  // ③ 拼起来（用 concat 滤镜，不用 -c copy：
  //    WAV 片段用 concat demuxer + copy 会因 data chunk 长度不一致而出现重叠/杂音）
  const joined = path.join(workDir, 'joined.wav');
  const inputs = [];
  for (const f of parts) inputs.push('-i', f);
  const filter = parts.map((_, i) => `[${i}:a]aresample=22050,aformat=sample_fmts=s16:channel_layouts=mono[a${i}]`).join(';')
    + ';' + parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1[out]`;
  await run(tools.ffmpeg, [
    '-hide_banner', '-y', ...inputs,
    '-filter_complex', filter, '-map', '[out]',
    '-ar', '22050', '-ac', '1', joined
  ]);

  // ④ 升调成萝莉音 + 音色塑形 + 响度归一
  const p = CUTE_PRESETS[preset] ?? CUTE_PRESETS.loli;
  const semis = p.pitch;
  const chain = [];
  if (semis !== 1) {
    chain.push(`asetrate=22050*${semis}`);
    chain.push(`atempo=${(1 / semis).toFixed(4)}`);
    chain.push('aresample=22050');
  }
  chain.push(p.filters);
  // 响度归一：短视频平台按 -14~-16 LUFS 听感最舒服；不加这个，成片声音偏小（实测 -23 LUFS）
  chain.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  await run(tools.ffmpeg, [
    '-hide_banner', '-y', '-i', joined,
    '-af', chain.join(','),
    '-ar', '22050', '-ac', '1', out
  ]);

  // ⑤ 清理中间文件
  for (const f of parts) fs.rmSync(f, { force: true });
  fs.rmSync(joined, { force: true });

  return {
    out, preset, pitch: semis,
    segments: segments.length, parts: parts.length,
    timeline,
    durationSec: timeline.length ? timeline[timeline.length - 1].end : 0
  };
}
