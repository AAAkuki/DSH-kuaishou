// 视频流水线：探测 / 竖屏归一化 / 拼片 / 字幕 / 配音（Windows SAPI 中文）/ 封面 / 一条龙成片。
//
// 为什么全用 ffmpeg 而不是拉一堆 AI 视频模型：本地、免费、可重复；
// "DeepSeek 风格"的口播视频本质就是「竖屏底 + 大标题 + 逐句字幕 + 中文配音」，
// 这四件事 ffmpeg 都能做，剩下的文案由模型写、配音由系统 TTS 念。
//
// 关键选择：
//  · 字幕用 drawtext + textfile=（一行一个字幕文件），**不做字符串转义**——转义是这类脚本最大的坑；
//  · 每一步都落中间文件，出错时能只重跑那一小段，而不是整条 20 分钟的视频；
//  · 竖屏按 1080×1920 归一化：先 scale 到铺满再 pad/crop，避免画面被拉伸变形。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { fitText } from './typography.mjs';
import { synthesize, listSapiVoices } from './tts.mjs';

const requireFromHere = createRequire(import.meta.url);

export class VideoError extends Error {
  constructor(message, { cmd, stderr } = {}) {
    super(message);
    this.name = 'VideoError';
    this.cmd = cmd;
    this.stderr = (stderr || '').slice(-1500);
  }
}

/** 找 ffmpeg/ffprobe：配置 → npm 内置二进制 → PATH。 */
export function resolveTools({ ffmpegPath = '', ffprobePath = '' } = {}) {
  const pick = (explicit, mod) => {
    if (explicit && fs.existsSync(explicit)) return explicit;
    try {
      // 两个 installer 包的导出形状不同：一个导出字符串，一个导出 { path }
      const m = requireFromHere(mod);
      const p = typeof m === 'string' ? m : (m?.path ?? m?.default ?? '');
      if (p && fs.existsSync(p)) return p;
    } catch {}
    return '';
  };
  return {
    ffmpeg: pick(ffmpegPath, '@ffmpeg-installer/ffmpeg'),
    ffprobe: pick(ffprobePath, '@ffprobe-installer/ffprobe')
  };
}

/** 真跑一个进程，收 stderr 尾部（ffmpeg 的报错都在 stderr）。 */
export function runBin(cmd, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new VideoError(`超时（${timeoutMs}ms）：${path.basename(cmd)} ${args.slice(0, 4).join(' ')}…`, { cmd: [cmd, ...args].join(' ') }));
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new VideoError(`无法启动 ${cmd}：${e.message}`, { cmd })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // 把 ffmpeg 常见失败原因翻译成可操作的话，而不是只说"退出码 1"
        let hint = '';
        if (/Permission denied|拒绝访问|being used by another process/i.test(err)) {
          hint = '：输出文件被占用或只读（可能正在播放器里打开着，或同名的旧文件被锁）。换个输出文件名，或先关掉打开它的程序';
        } else if (/No such file or directory|could not open/i.test(err) && /Output|output/i.test(err)) {
          hint = '：输出目录不存在或没有写权限';
        } else if (/Invalid data found|moov atom not found/i.test(err)) {
          hint = '：输入视频损坏或还没下载完整';
        } else if (/Unknown encoder|Encoder .* not found/i.test(err)) {
          hint = '：ffmpeg 缺少对应编码器（换内置版本或改配置）';
        }
        reject(new VideoError(`${path.basename(cmd)} 退出码 ${code}${hint}`, { cmd: [cmd, ...args].join(' '), stderr: err }));
      } else resolve({ stdout: out, stderr: err });
    });
  });
}

/** 解析 ffprobe -show_format -show_streams 的 JSON。 */
export function parseProbe(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  const duration = Number(j.format?.duration ?? v?.duration ?? 0);
  return {
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: Number(v?.width ?? 0),
    height: Number(v?.height ?? 0),
    fps: Number(String(v?.r_frame_rate ?? '0/1').split('/')[0]) / Number(String(v?.r_frame_rate ?? '1/1').split('/')[1] || 1),
    videoCodec: v?.codec_name ?? '',
    audioCodec: a?.codec_name ?? '',
    hasAudio: Boolean(a),
    hasVideo: Boolean(v),
    sizeBytes: Number(j.format?.size ?? 0)
  };
}

/** 把一句字幕排进时间轴：按字数分配时长，返回 [{text,start,end}]。 */
export function planSubtitles(lines, totalSec, { minSec = 1.2, gapSec = 0.1 } = {}) {
  const items = (lines ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (items.length === 0 || !(totalSec > 0)) return [];
  const weights = items.map((s) => Math.max(2, [...s].length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const usable = Math.max(0.1, totalSec - gapSec * (items.length - 1));
  // 总时长不够「每句都占 minSec」时，按比例把下限压下来 —— 否则后面的句子会被挤成 0 秒
  const floor = Math.min(minSec, usable / items.length);
  let cursor = 0;
  const out = [];
  items.forEach((text, i) => {
    const share = Math.max(floor, (usable * weights[i]) / sum);
    const start = cursor;
    const end = Math.min(totalSec, start + share);
    out.push({ text, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) });
    cursor = end + gapSec;
  });
  return out;
}

/** 生成 SRT 文本（给人看/给别的工具用；烧录用 drawtext 不依赖它）。 */
export function toSrt(items) {
  const fmt = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const rest = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${rest}`;
  };
  return items.map((it, i) => `${i + 1}\n${fmt(it.start)} --> ${fmt(it.end)}\n${it.text}\n`).join('\n');
}

/** 背景渐变预设（设置页 videoBgPreset 直接选名字）。 */
export const BACKGROUND_PRESETS = {
  'deep-sea': { from: '0x0b1020', to: '0x1b3a5c' },
  'night-purple': { from: '0x141226', to: '0x3b2a5a' },
  'whale-blue': { from: '0x0a1a33', to: '0x1f5f8b' },
  'sakura': { from: '0x2a1420', to: '0x6b2a4a' },
  'paper': { from: '0xE8E2D0', to: '0xC9BFA8' },
  'mint': { from: '0x06231f', to: '0x1c6b5a' }
};

/** '0xRRGGBB' / '#RRGGBB' / 'RRGGBB' → {r,g,b}；解析不了返回 null。 */
export function parseColor(input) {
  const s = String(input ?? '').trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

/** 判定背景类型：视频 > 图片 > 渐变 > 纯色。 */
export function backgroundKind(bg = {}) {
  if (bg.video) return 'video';
  if (bg.image) return 'image';
  if (bg.gradientFrom && bg.gradientTo) return 'gradient';
  return 'color';
}

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/arial.ttf'
];

export function pickFont(explicit = '') {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f;
  return '';
}

/** 转义 ffmpeg 里作为「值」出现的路径（冒号、反斜杠、单引号）。只用于路径，不用于文案。 */
export function escapeFontPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export class VideoStudio {
  /**
   * @param {object} opts
   * @param {object} opts.cfg 全局配置（读 cfg.video）
   * @param {(line:string)=>void} [opts.log]
   */
  constructor({ cfg = {}, log = () => {} } = {}) {
    this.cfg = cfg;
    this.videoCfg = cfg.video ?? {};
    this.log = log;
    const tools = resolveTools({ ffmpegPath: this.videoCfg.ffmpegPath, ffprobePath: this.videoCfg.ffprobePath });
    this.ffmpeg = tools.ffmpeg;
    this.ffprobe = tools.ffprobe;
    /** 临时文件（标题/字幕的 textfile），一次成片结束时统一清掉 */
    this._tmpFiles = [];
    this._swept = false;
  }

  get available() { return Boolean(this.ffmpeg && this.ffprobe); }

  assertAvailable() {
    if (!this.available) {
      throw new VideoError('找不到 ffmpeg/ffprobe：装 @ffmpeg-installer/ffmpeg 与 @ffprobe-installer/ffprobe，或写 config.json 的 video.ffmpegPath / video.ffprobePath');
    }
  }

  workDir() {
    const dir = path.resolve(projectRoot(), this.videoCfg.workDir ?? 'state/video');
    fs.mkdirSync(dir, { recursive: true });
    // 一次性清扫：老版本不删 line-*.txt / title-*.txt，会一直堆在 state/video 里
    if (!this._swept) {
      this._swept = true;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^(line|title)-\d+-[\w-]+\.txt$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
        }
      } catch {}
    }
    return dir;
  }

  /** 清掉本轮留下的临时 textfile（标题/字幕），避免 state/video 越来越大。 */
  flushTemps() {
    for (const f of this._tmpFiles) { try { fs.rmSync(f, { force: true }); } catch {} }
    this._tmpFiles = [];
  }

  /**
   * 清理过期的生成中间件（voice-*.wav / cover-*.jpg 保留最近 N 份）。
   * 之前每次生成都留一个 wav 和一张封面，实测 21 个 wav 占了 ~15MB。
   */
  pruneWorkDir({ keepWav = 3, keepCover = 5 } = {}) {
    try {
      const dir = this.workDir();
      const pick = (re) => fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const f of pick(/^voice-\d+\.wav$/).slice(keepWav)) fs.rmSync(f, { force: true });
      // 试听也会生成 preview-*.wav，同样要清理（否则点几次试听就堆一堆）
      for (const f of pick(/^preview-\d+\.wav$/).slice(keepWav)) fs.rmSync(f, { force: true });
      for (const f of pick(/^cover-\d+\.jpg$/).slice(keepCover)) fs.rmSync(f, { force: true });
      return true;
    } catch { return false; }
  }

  async version() {
    this.assertAvailable();
    const r = await runBin(this.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 20000 });
    return String(r.stdout).split('\n')[0].trim();
  }

  async probe(file) {
    this.assertAvailable();
    if (!fs.existsSync(file)) throw new VideoError(`文件不存在：${file}`);
    const r = await runBin(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
    return { file, ...parseProbe(r.stdout) };
  }

  /**
   * 语音合成 → WAV。引擎由 config.video.audio.engine 决定：
   *   sapi  = Windows 自带语音（**不需要任何文件**，只填语音名）
   *   piper = 本地 .onnx 语音模型（自定义音色，需要 exe + 模型文件）
   */
  async tts({ text, lines, out, voice, rate, engine, lengthScaleOverride } = {}) {
    const au = { ...(this.videoCfg?.audio ?? {}) };
    if (Number.isFinite(Number(lengthScaleOverride))) au.lengthScale = Number(lengthScaleOverride);

    // 「萝莉 + 有人味」模式：分段合成 + 停顿/喘气/口吃 + 升调。
    // 它需要 piper 模型，不消耗 SAPI 合成。
    // 只有"没有显式指定 sapi"时才走萝莉合成器，否则尊重调用方选择的引擎
    const wantCute = au.cute && au.piperExe && au.piperModel && engine !== 'sapi' && !voice;
    if (wantCute) {
      const { synthCute } = await import('./synth-cute.mjs');
      const target = out || path.join(this.workDir(), `cute-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
      const r = await synthCute(
        { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe },
        {
          text,
          // 一句一行传进去：每句单独合成，时间轴才能和字幕严格 1:1（否则必然越来越不同步）
          lines: Array.isArray(lines) ? lines : undefined,
          out: target,
          workDir: path.join(this.workDir(), 'cute-work'),
          piperExe: au.piperExe,
          piperModel: au.piperModel,
          preset: au.cute,
          // 口吃/喘气改成"显式打开才用"：默认关，因为它俩是"声音诡异"的主要来源
          stutter: au.stutter === true,
          breath: au.breath === true,
          pause: au.pause !== false,
          lengthScale: au.lengthScale ?? 1.12,
          // 目标时长交给合成器：句间停顿均摊补足，别在结尾堆静音
          targetSec: Number(this.videoCfg?.targetDurationSec) || 0
        }
      );
      const info = await this.probe(r.out);
      return {
        file: r.out, engine: 'cute', cutePreset: r.preset, pitch: r.pitch,
        bytes: info.sizeBytes, durationSec: info.durationSec,
        timeline: r.timeline ?? null   // 每句真实起止，供字幕对齐
      };
    }
    const result = await synthesize({
      engine: engine || au.engine || 'sapi',
      text,
      out: out || path.join(this.workDir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`),
      voice: voice ?? au.voice,
      rate: rate ?? au.rate ?? 0,
      exe: au.piperExe,
      model: au.piperModel
    });
    // 柔化：用 ffmpeg 滤镜降调 + 削齿音 + 加厚度（配置 video.audio.soften）
    const preset = this.videoCfg?.audio?.soften;
    let softened = null;
    if (preset && preset !== 'none' && this.available) {
      try {
        const { softenAudio } = await import('./voice-soften.mjs');
        const out2 = result.file.replace(/\.wav$/, `-soft${preset}.wav`);
        const r = softenAudio(
          { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe },
          { input: result.file, out: out2, preset }
        );
        softened = { preset, file: r.out };
        this._tmpFiles.push(out2);
        result.file = out2;
      } catch (error) {
        this.log?.(`[voice-soften] 跳过：${error.message}`);
      }
    }

    const info = await this.probe(result.file);
    return { ...result, ...info, softenPreset: softened?.preset ?? 'none' };
  }

  /** 列出可用语音（给 ks_voice_list 用）。 */
  async voices() {
    const au = this.videoCfg?.audio ?? {};
    return {
      engine: au.engine || 'sapi',
      sapi: await listSapiVoices(),
      piper: {
        exe: au.piperExe || '',
        model: au.piperModel || '',
        ready: Boolean(au.piperExe && fs.existsSync(au.piperExe) && au.piperModel && fs.existsSync(au.piperModel))
      }
    };
  }

  /** 任意输入（图片/视频）→ 1080x1920 30fps 的标准片，缺音轨补静音。 */
  async normalize({ input, out, durSec = 0, width = 1080, height = 1920, fps = 30, fit = 'cover' } = {}) {
    this.assertAvailable();
    if (!fs.existsSync(input)) throw new VideoError(`输入不存在：${input}`);
    const target = out ? path.resolve(out) : path.join(this.workDir(), `norm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    // gif 单独处理：它既能当图片又能当动图，而且这个 ffmpeg 的 image2 不认 -loop
    const isGif = /\.gif$/i.test(input);
    const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(input);
    const vf = fit === 'contain'
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`;
    const args = ['-hide_banner', '-y'];
    if (isGif) {
      // 动图当输入：-loop 1 在这个 ffmpeg 的 image2 上会报 "Option loop not found"，改用 -stream_loop
      args.push('-stream_loop', '-1', '-t', String(Math.max(1, durSec || 3)), '-i', input);
    } else if (isImage) {
      args.push('-loop', '1', '-t', String(Math.max(1, durSec || 3)), '-i', input);
    } else {
      args.push('-i', input);
    }
    args.push(
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      target
    );
    await runBin(this.ffmpeg, args);
    return { file: target, ...(await this.probe(target)) };
  }

  /** 多段顺序拼接（同规格）。 */
  async concat({ files, out } = {}) {
    this.assertAvailable();
    const list = (files ?? []).filter((f) => fs.existsSync(f));
    if (list.length === 0) throw new VideoError('concat 需要至少一个已存在的文件');
    const target = out ? path.resolve(out) : path.join(this.workDir(), `concat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    const listFile = `${target}.txt`;
    fs.writeFileSync(listFile, list.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    await runBin(this.ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', target]);
    fs.rmSync(listFile, { force: true });
    return { file: target, ...(await this.probe(target)) };
  }

  /**
   * 烧字幕：每行一个 textfile（不做转义），drawtext 按时间窗 enable。
   * @param {Array<{text,start,end}>} items planSubtitles 的输出
   */
  async burnSubtitles({ input, out, items, fontSize = 54, fontColor = 'white', bottomRatio = 0.76, boxAlpha = 0.45, width = 1080, maxLines = 2, fontPath = '', borderWidth = 3 } = {}) {
    this.assertAvailable();
    if (!fs.existsSync(input)) throw new VideoError(`输入不存在：${input}`);
    const font = pickFont(fontPath || this.videoCfg?.typography?.fontPath || this.videoCfg?.fontPath);
    if (!font) throw new VideoError('找不到中文字体：写 config.json 的 video.fontPath（例如 C:/Windows/Fonts/msyh.ttc）');
    const dir = this.workDir();
    const target = out ? path.resolve(out) : path.join(dir, `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    const temps = [];   // 每个字幕一个 textfile，渲染完必须删，否则越攒越多
    const chain = [];
    (items ?? []).forEach((it, i) => {
      const tf = path.join(dir, `line-${Date.now()}-${i}.txt`);
      // 自适应：字大就缩字号，还放不下就折行（最多 maxLines 行）
      const fitted = fitText(it.text, { width, maxFontSize: fontSize, maxLines });
      fs.writeFileSync(tf, fitted.lines.join('\n'), 'utf8');
      temps.push(tf);
      chain.push(
        `drawtext=fontfile='${escapeFontPath(font)}':textfile='${escapeFontPath(tf)}':` +
        `fontsize=${fitted.fontSize}:fontcolor=${fontColor}:borderw=${borderWidth}:bordercolor=black@0.85:` +
        `box=1:boxcolor=black@${boxAlpha}:boxborderw=18:` +
        `x=(w-text_w)/2:y=h*${bottomRatio}-text_h:` +
        `enable='between(t,${it.start},${it.end})'`
      );
    });
    if (chain.length === 0) throw new VideoError('burnSubtitles 需要至少一条字幕');
    try {
      await runBin(this.ffmpeg, [
        '-hide_banner', '-y', '-i', input,
        '-vf', chain.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        target
      ]);
    } finally {
      for (const f of temps) fs.rmSync(f, { force: true });
    }
    return { file: target, ...(await this.probe(target)) };
  }

  /** 加一条配音轨（替换原音轨）+ 可选 BGM 低音量混入。 */
  async muxAudio({ input, out, voiceFile = '', bgmFile = '', bgmGainDb = -22, voiceGainDb = 0 } = {}) {
    this.assertAvailable();
    if (!voiceFile && !bgmFile) return { file: input, ...(await this.probe(input)) };
    const target = out ? path.resolve(out) : path.join(this.workDir(), `audio-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    const args = ['-hide_banner', '-y', '-i', input];
    if (voiceFile) args.push('-i', voiceFile);
    if (bgmFile) args.push('-stream_loop', '-1', '-i', bgmFile);

    const filters = [];
    const maps = ['-map', '0:v:0'];
    if (voiceFile && bgmFile) {
      filters.push(`[1:a]volume=${voiceGainDb}dB[v]`, `[2:a]volume=${bgmGainDb}dB[b]`, '[v][b]amix=inputs=2:duration=first:dropout_transition=0[aout]');
      maps.push('-map', '[aout]');
    } else if (voiceFile) {
      if (Number(voiceGainDb) !== 0) {
        filters.push(`[1:a]volume=${voiceGainDb}dB[aout]`);
        maps.push('-map', '[aout]');
      } else {
        maps.push('-map', '1:a:0');
      }
    } else {
      filters.push(`[1:a]volume=${bgmGainDb}dB[aout]`);
      maps.push('-map', '[aout]');
    }
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push(...maps, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', target);
    await runBin(this.ffmpeg, args);
    return { file: target, ...(await this.probe(target)) };
  }

  /** 从视频抽一帧当封面。 */
  async cover({ input, out, atSec = 1 } = {}) {
    this.assertAvailable();
    const target = out ? path.resolve(out) : path.join(this.workDir(), `cover-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    await runBin(this.ffmpeg, ['-hide_banner', '-y', '-ss', String(Math.max(0, atSec)), '-i', input, '-frames:v', '1', '-q:v', '2', target]);
    return { file: target, ...(await this.probe(target)) };
  }

  /**
   * 合并「配置里的样式」与「本次调用的覆盖」，得到一份可直接用的样式对象。
   * 所有项都可被设置页（config.video.*）或工具参数覆盖 —— 背景、字体、声音全由用户决定。
   */
  resolveStyle(overrides = {}) {
    const v = this.cfg.video ?? {};
    const bg = { ...(v.background ?? {}), ...(overrides.background ?? {}) };
    const ty = { ...(v.typography ?? {}), ...(overrides.typography ?? {}) };
    const au = { ...(v.audio ?? {}), ...(overrides.audio ?? {}) };

    // 兼容旧的顶层快捷参数
    const quick = {
      bgColor: ['color', bg],
      bgImage: ['image', bg],
      bgVideo: ['video', bg],
      bgFit: ['fit', bg],
      bgDim: ['dim', bg],
      bgBlur: ['blur', bg],
      bgGradientFrom: ['gradientFrom', bg],
      bgGradientTo: ['gradientTo', bg],
      bgGradientAxis: ['gradientAxis', bg],
      bgPreset: ['preset', bg],
      fontPath: ['fontPath', ty],
      fontSize: ['fontSize', ty],
      titleFontSize: ['titleFontSize', ty],
      fontColor: ['fontColor', ty],
      titleColor: ['titleColor', ty],
      boxAlpha: ['boxAlpha', ty],
      subtitleY: ['subtitleY', ty],
      voice: ['voice', au],
      rate: ['rate', au],
      bgmFile: ['bgmFile', au],
      bgmGainDb: ['bgmGainDb', au]
    };
    for (const [key, [target, box]] of Object.entries(quick)) {
      const val = overrides[key];
      if (val === undefined || val === null || val === '') continue;
      box[target] = val;
    }

    // 预设展开：只有「本次显式给了颜色/图片/视频」以外的情况才用预设，
    // 否则用户选了 preset 又指明 bgColor 时，颜色会被预设的渐变偷偷盖掉（曾经的 bug）。
    const explicitBackground = Boolean(
      overrides.background || overrides.bgColor || overrides.bgImage || overrides.bgVideo
      || overrides.bgGradientFrom || overrides.bgGradientTo
    );
    if (!explicitBackground && bg.preset && BACKGROUND_PRESETS[bg.preset]) {
      const p = BACKGROUND_PRESETS[bg.preset];
      if (!bg.gradientFrom) bg.gradientFrom = p.from;
      if (!bg.gradientTo) bg.gradientTo = p.to;
    }

    return {
      width: overrides.width ?? v.width ?? 1080,
      height: overrides.height ?? v.height ?? 1920,
      fps: overrides.fps ?? v.fps ?? 30,
      bg,
      ty,
      au
    };
  }

  /**
   * 竖屏底片：背景 + 标题。
   *
   * 背景四种类型，优先级 **视频 > 图片 > 渐变 > 纯色**：
   *   color     纯色
   *   gradient  双色渐变（geq 生成，可竖向/横向）
   *   image     图片（cover/contain + 可选模糊 + 压暗）
   *   video     视频循环（静音，铺满/留边 + 可选模糊 + 压暗）
   * 字幕和标题都画在这一层之上。
   */
  async buildBase({ style, title, durSec, out }) {
    const { width, height, fps, bg, ty } = style;
    const font = pickFont(ty.fontPath);
    const draw = [];
    if (font && title) {
      const tf = path.join(this.workDir(), `title-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
      const fitted = fitText(title, { width, maxFontSize: ty.titleFontSize, maxLines: 2 });
      fs.writeFileSync(tf, fitted.lines.join('\n'), 'utf8');
      this._tmpFiles.push(tf);
      const hold = Number(ty.titleHoldSec) > 0 ? `:enable='lt(t,${Number(ty.titleHoldSec)})'` : '';
      draw.push(
        `drawtext=fontfile='${escapeFontPath(font)}':textfile='${escapeFontPath(tf)}':` +
        `fontsize=${fitted.fontSize}:fontcolor=${ty.titleColor ?? 'white'}:` +
        `x=(w-text_w)/2:y=h*0.16:borderw=4:bordercolor=black@0.85${hold}`
      );
    }

    const kind = backgroundKind(bg);
    const vf = [];
    let inputs;

    if (kind === 'video') {
      if (!fs.existsSync(bg.video)) throw new VideoError(`背景视频不存在：${bg.video}`);
      inputs = ['-stream_loop', '-1', '-t', durSec.toFixed(2), '-i', path.resolve(bg.video), '-an'];
    } else if (kind === 'image') {
      if (!fs.existsSync(bg.image)) throw new VideoError(`背景图不存在：${bg.image}`);
      inputs = ['-loop', '1', '-t', durSec.toFixed(2), '-i', path.resolve(bg.image)];
    } else {
      inputs = ['-f', 'lavfi', '-i', `color=c=${kind === 'gradient' ? 'black' : (bg.color ?? '0x0f1419')}:s=${width}x${height}:d=${durSec.toFixed(2)}:r=${fps}`];
    }

    if (kind === 'gradient') {
      const from = parseColor(bg.gradientFrom) ?? { r: 11, g: 16, b: 32 };
      const to = parseColor(bg.gradientTo) ?? { r: 27, g: 58, b: 92 };
      const axis = bg.gradientAxis === 'horizontal' ? 'X/W' : 'Y/H';
      vf.push(
        `geq=r='${from.r}+${to.r - from.r}*(${axis})'` +
        `:g='${from.g}${(to.g - from.g) >= 0 ? '+' : ''}${to.g - from.g}*(${axis})'` +
        `:b='${from.b}+${to.b - from.b}*(${axis})'`
      );
    }

    if (kind === 'video' || kind === 'image') {
      if (bg.fit === 'contain') {
        vf.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
      } else {
        vf.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`);
      }
      vf.push('setsar=1');
      if (Number(bg.blur) > 0) vf.push(`gblur=sigma=${Number(bg.blur)}`);
      if (Number(bg.dim) > 0) vf.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@${Number(bg.dim)}:t=fill`);
    }
    vf.push(`fps=${fps}`);
    vf.push(...draw);

    await runBin(this.ffmpeg, [
      '-hide_banner', '-y',
      ...inputs,
      '-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-t', durSec.toFixed(2),
      out
    ]);
    return { file: out, ...(await this.probe(out)) };
  }

  /**
   * 一条龙：文案 → 中文配音 → 竖屏底（背景可换）→ 逐句字幕 → 成片 → 封面。
   *
   * 背景 / 字体 / 声音全部可自定义：优先取参数，其次取 config.json 的 video.*，
   * 最后才是内置默认值。设置页里的同名项会写进 config.json 那一层。
   *
   * @returns {{file, cover, durationSec, subtitles, voice, style, steps}}
   */
  async fromText({
    title = '',
    lines = [],
    voiceText = '',
    out = '',
    // ── 背景 ──
    bgColor,
    bgImage,
    bgVideo,
    bgFit,
    bgDim,
    bgBlur,
    bgGradientFrom,
    bgGradientTo,
    bgGradientAxis,
    bgPreset,
    background,
    // ── 字体 ──
    fontPath,
    fontSize,
    titleFontSize,
    fontColor,
    titleColor,
    boxAlpha,
    subtitleY,
    typography,
    // ── 声音 ──
    voice,
    rate,
    bgmFile,
    bgmGainDb,
    audio,
    // ── 画幅 ──
    width,
    height,
    fps,
    // ── 模板 / 表情 ──
    template,
    templateBox,
    sticker,
    stickerSize
  } = {}) {
    this.assertAvailable();

    // ── 模板模式 ──
    // 设置里指了一张横版模板图（带说话框）时，用 renderTemplateVideo：
    // 背景=模板自身模糊放大、只往框里打字、左侧可贴表情。
    {
      const { renderTemplateVideo } = await import('./render-template.mjs');
      const au = this.videoCfg?.audio ?? {};
      const bgCfg = this.videoCfg?.background ?? {};
      const tplFile = template || bgCfg.template || (
        bgCfg.image && /\.(jpg|jpeg|png|webp)$/i.test(bgCfg.image) &&
        (this.videoCfg?.templateMode === true || bgCfg.fit === 'contain' && (this.videoCfg?.templateBox || bgCfg.templateBox))
          ? bgCfg.image : ''
      );
      const box = templateBox || bgCfg.templateBox || this.videoCfg?.templateBox;
      if (tplFile && box) {
        // 先合成配音
        let voiceTimeline = null;
        let voiceFile = '';
        if (voiceText) {
          const targetSec = Number(this.videoCfg?.targetDurationSec) || 0;
          const voiceOut = () => path.join(this.workDir(), `tpl-voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
          let vres = await this.tts({ text: voiceText, lines, out: voiceOut() });
          // 配音比目标短很多 → 放慢语速重合成（比在结尾补 20 秒静音自然得多）
          if (targetSec && vres.durationSec && vres.durationSec < targetSec * 0.9 && au.cute) {
            let scale = Number(this.videoCfg?.audio?.lengthScale ?? 1.12);
            for (let i = 0; i < 3; i++) {
              const need = targetSec / vres.durationSec;
              scale = Math.min(2.2, Math.max(1.0, scale * Math.min(1.5, need)));
              const retry = await this.tts({ text: voiceText, lines, out: voiceOut(), lengthScaleOverride: scale }).catch(() => null);
              if (!retry) break;
              vres = retry;
              if (vres.durationSec >= targetSec * 0.9) break;
            }
          }
          voiceFile = vres.file;
          voiceTimeline = vres.timeline ?? null;
        }
        const target = out ? path.resolve(out) : path.join(this.workDir(), `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
        // 贴纸：位置/大小用预设，多张时按文案情绪自动挑
        const { STICKER_POSITIONS, STICKER_SIZES, detectEmotion, pickSticker, scanStickerFiles, loadStickerEmotions } = await import('./sticker.mjs');
        const posKey = au.stickerPos ?? 'beside-box';
        const posPreset = { ...(STICKER_POSITIONS[posKey] ?? STICKER_POSITIONS['beside-box']) };
        // "字幕框左边"交给渲染器算（它才知道画布上的真实框坐标）
        const stickerAnchor = posKey === 'beside-box' ? 'box' : '';
        const sizePreset = STICKER_SIZES[au.stickerSizeName] ?? STICKER_SIZES.medium;
        const emotion = detectEmotion([...(lines || []), voiceText || ''].join(' '));
        let resolvedSticker = { file: '', x: posPreset.x, y: posPreset.y, scale: sizePreset.scale, emotion };
        // 先算每句字幕的起止（配音真实时间轴；条数不一致按字数铺满）
        const preSpans = await (async () => {
          let audioDur = 0;
          try {
            const pv = await this.probe(voiceFile);
            audioDur = Number(pv?.durationSec ?? 0) || 0;
          } catch {}
          const minD = Number(this.videoCfg?.targetDurationSec ?? this.videoCfg?.minDurationSec) || 0;
          const total = Math.max(audioDur, minD, 1);
          if (voiceTimeline && voiceTimeline.length === lines.length) {
            const sp = voiceTimeline.map((t) => ({ start: t.start, end: t.end }));
            if (sp.length) sp[sp.length - 1].end = Math.max(sp[sp.length - 1].end, total);
            return sp;
          }
          const weights = lines.map((l) => Math.max(2, String(l).length));
          const sum = weights.reduce((a, b) => a + b, 0);
          let acc = 0;
          return lines.map((_, i) => {
            const d = (weights[i] / sum) * total;
            const s0 = acc;
            acc += d;
            return { start: Number(s0.toFixed(2)), end: Number(acc.toFixed(2)) };
          });
        })();

        // 中途换表情：每一句按自己的情绪挑一张（连续相同只保留一个时间段）
        let stickerPlan = null;
        if (process.env.KSOPS_NO_STICKER === '1') {   // 调试用：临时不贴表情
          stickerPlan = null;
        } else {
        {
          const allFiles = scanStickerFiles(projectRoot());
          const emoMap = loadStickerEmotions(projectRoot());
          const perLine = au.stickerPerLine !== false;
          if (perLine && !au.stickerFile && allFiles.length && lines && lines.length) {
            const plan = [];
            // 平淡句没有情绪可配 → 轮换，保证表情会变
            const calmFiles = allFiles.filter((f) => (emoMap[path.basename(f)] ?? '') === 'calm');
            const rotatePool = calmFiles.length >= 2 ? calmFiles : allFiles;
            let rot = 0;
            let prevFile = '';

            lines.forEach((line, i) => {
              const emo = detectEmotion(String(line));
              let pickedFile = '';
              if (emo === 'calm') {
                // 轮换，跳过和上一句相同的那张
                for (let k = 0; k < rotatePool.length; k++) {
                  const cand = rotatePool[(rot + k) % rotatePool.length];
                  if (cand !== prevFile) { pickedFile = cand; rot = (rot + k + 1) % rotatePool.length; break; }
                }
                if (!pickedFile) pickedFile = rotatePool[0];
              } else {
                pickedFile = pickSticker({ emotion: emo, files: allFiles, mapping: emoMap }).file;
              }
              const picked = { file: pickedFile };
              if (!picked.file) return;
              const span = preSpans[i] || null;
              const last = plan[plan.length - 1];
              if (last && last.file === picked.file) {
                // 同一张：延长上一段
                if (span) last.end = Math.max(last.end, span.end);
                return;
              }
              prevFile = picked.file;
              plan.push({
                file: path.resolve(projectRoot(), picked.file),
                emotion: emo,
                start: span ? span.start : 0,
                end: span ? span.end : 0
              });
            });
            if (plan.length) {
              // 让每段覆盖到下一段开始（避免中间空档）
              for (let i = 0; i < plan.length; i++) {
                const next = plan[i + 1];
                plan[i].end = Math.max(plan[i].end, next ? next.start : 0);
              }
              stickerPlan = plan;
            }
          }
        }
        }
        {
          const all = scanStickerFiles(projectRoot());
          resolvedSticker.candidates = all.length;
          if (au.stickerFile) {
            // 显式指定优先
            resolvedSticker.file = au.stickerFile;
          } else if (au.stickerAutoEmotion !== false && all.length) {
            resolvedSticker.file = pickSticker({ emotion, files: all, mapping: loadStickerEmotions(projectRoot()) }).file;
          }
          // 坐标微调支持两种字段名（stickerX / stickerX2 都认）
          const px = Number.isFinite(Number(au.stickerX2)) ? Number(au.stickerX2) : Number(au.stickerX);
          const py = Number.isFinite(Number(au.stickerY2)) ? Number(au.stickerY2) : Number(au.stickerY);
          if (Number.isFinite(px)) { resolvedSticker.x = px; resolvedSticker.explicitX = true; }
          if (Number.isFinite(py)) { resolvedSticker.y = py; resolvedSticker.explicitY = true; }
          if (Number.isFinite(Number(au.stickerScale))) resolvedSticker.scale = Number(au.stickerScale);
          // 相对路径补成绝对
          if (resolvedSticker.file && !resolvedSticker.file.match(/^[a-zA-Z]:|^\//)) {
            resolvedSticker.file = path.resolve(projectRoot(), resolvedSticker.file);
          }
        }

        // 打印实际用的模板与贴纸：排"为什么画面跟素材不一样"时全靠这一行
        try {
          const st = fs.statSync(tplFile);
          this.log?.(`[template] ${tplFile} (${st.size}B, ${st.mtime.toISOString()})`);
          this.log?.(`[sticker] plan=${Array.isArray(stickerPlan) ? stickerPlan.length : 0} file=${resolvedSticker.file || '(none)'}`);
          if (Array.isArray(stickerPlan) && stickerPlan[0]) {
            const p0 = stickerPlan[0];
            this.log?.(`[sticker:0] ${JSON.stringify({ file: path.basename(p0.file || ''), start: p0.start, end: p0.end, scale: p0.scale })}`);
          }
        } catch {}

        const r = renderTemplateVideo(
          { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe },
          {
            template: tplFile,
            out: target,
            workDir: path.join(this.workDir(), 'tmpl-work'),
            width: width ?? 1080,
            height: height ?? 1920,
            font: pickFont(fontPath || this.videoCfg?.typography?.fontPath),
            lines,
            voiceFile,
            timings: preSpans,
            box,
            stickerText: sticker ?? au.sticker ?? '',
            stickerSize: stickerSize ?? au.stickerSize ?? 0.22,
            stickerFile: resolvedSticker.file,
            stickerX: resolvedSticker.explicitX ? resolvedSticker.x : null,
            stickerY: resolvedSticker.explicitY ? resolvedSticker.y : null,
            stickerAnchor,
            stickerScale: resolvedSticker.scale,
            stickerEmotion: resolvedSticker.emotion,
            stickerPlan,
            stickerKey: au.stickerKey ?? 'auto',
            minDurationSec: Number(this.videoCfg?.targetDurationSec ?? this.videoCfg?.minDurationSec) || 0,
            stickerTrim: Number(au.stickerTrim ?? 0.02),
            // 背景留白怎么填：>0 = 同一张图放大后模糊（sigma 就是这个值）+ 压暗；0 = 纯渐变
            bgBlur: Math.max(0, Number(bgCfg.blur ?? bgBlur ?? 0) || 0),
            bgDim: Math.min(1, Math.max(0, Number(bgCfg.dim ?? bgDim ?? 0) || 0)),
            // 参考视频学来的装饰（栏目名 / AI 标识 / 名字标签 / 打字光标）
            titleBar: this.videoCfg?.titleBar ?? '',
            aiBadge: this.videoCfg?.aiBadge ?? '',
            speakerName: this.videoCfg?.speakerName ?? '',
            typing: this.videoCfg?.typing !== false
          }
        );
        const info = await this.probe(r.file);
        const cover = await this.cover({ input: r.file, out: path.join(this.workDir(), `cover-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`) }).catch(() => ({ file: '' }));
        // 配音时长也要带上（MCP 层会读它），字幕给一个按总时长均分的结构
        let voiceInfo = null;
        if (voiceFile) {
          const vp = await this.probe(voiceFile).catch(() => null);
          voiceInfo = { file: voiceFile, durationSec: vp?.durationSec ?? 0 };
        }
        const total = Number(info.durationSec ?? 0);
        // 有语音时间轴就按真实时间对齐（否则字幕会和声音错位）
        let subtitles;
        if (voiceTimeline && voiceTimeline.length === lines.length) {
          // 条数一致：直接用真实时间
          subtitles = voiceTimeline.map((t) => ({ text: t.text, start: t.start, end: t.end }));
        } else if (voiceTimeline && voiceTimeline.length) {
          // 条数不一致：按每个 line 的字符数比重，把整段语音时长切开
          const weights = lines.map((l) => Math.max(2, String(l).length));
          const sum = weights.reduce((a, b) => a + b, 0);
          let acc = 0;
          subtitles = lines.map((text, i) => {
            const d = (weights[i] / sum) * total;
            const s0 = acc;
            acc += d;
            return { text, start: Number(s0.toFixed(2)), end: Number(acc.toFixed(2)) };
          });
        } else {
          const per = lines.length ? total / lines.length : total;
          subtitles = lines.map((text, i) => ({
            text,
            start: Number((i * per).toFixed(2)),
            end: Number(((i + 1) * per).toFixed(2))
          }));
        }
        return {
          file: r.file, cover: cover.file, durationSec: total,
          sizeBytes: info.sizeBytes, width: info.width, height: info.height,
          mode: 'template', template: r.template, box: r.box, lines, subtitles,
          sticker: r.sticker ? { ...r.sticker, emotion: resolvedSticker.emotion, keptPosition: resolvedSticker } : { emotion: resolvedSticker.emotion, file: '' },
          stickerPlanReport: r.plan ?? [],
          voice: voiceInfo
        };
      }
    }

    const style = this.resolveStyle({
      bgColor, bgImage, bgVideo, bgFit, bgDim, bgBlur,
      bgGradientFrom, bgGradientTo, bgGradientAxis, bgPreset, background,
      fontPath, fontSize, titleFontSize, fontColor, titleColor, boxAlpha, subtitleY, typography,
      voice, rate, bgmFile, bgmGainDb, audio,
      width, height, fps
    });

    const steps = [];
    const dir = this.workDir();
    const stamp = Date.now();
    const spoken = String(voiceText || [title, ...lines].filter(Boolean).join('，')).trim();
    if (!spoken) throw new VideoError('fromText 需要 title / lines / voiceText 至少一个');

    // 1) 配音（同时决定整片时长）
    const voiceOut = await this.tts({
      text: spoken,
      out: path.join(dir, `voice-${stamp}.wav`),
      voice: style.au.voice,
      rate: style.au.rate
    });
    steps.push({ step: 'tts', file: voiceOut.file, durationSec: Number(voiceOut.durationSec.toFixed(2)), voice: style.au.voice, rate: style.au.rate });
    const total = Math.max(2, voiceOut.durationSec + 0.6);

    // 2) 字幕时间轴
    const items = planSubtitles(lines, total - 0.6);
    steps.push({ step: 'subtitles', count: items.length });

    // 3) 底片：背景（纯色/图片）+ 标题
    const baseFile = path.join(dir, `base-${stamp}.mp4`);
    await this.buildBase({ style, title, durSec: total, out: baseFile });
    steps.push({
      step: 'base',
      file: baseFile,
      background: style.bg.image ? `image:${path.basename(style.bg.image)}` : `color:${style.bg.color}`,
      dim: Number(style.bg.dim)
    });

    // 4) 烧字幕（字号/颜色/位置/底色都来自样式）
    const subbed = items.length
      ? await this.burnSubtitles({
          input: baseFile,
          out: path.join(dir, `subbed-${stamp}.mp4`),
          items,
          fontSize: style.ty.fontSize,
          fontColor: style.ty.fontColor,
          bottomRatio: style.ty.subtitleY,
          boxAlpha: style.ty.boxAlpha,
          fontPath: style.ty.fontPath,
          borderWidth: style.ty.borderWidth,
          width: style.width
        })
      : { file: baseFile };
    steps.push({ step: 'burn', file: subbed.file, fontSize: style.ty.fontSize, fontColor: style.ty.fontColor });

    // 5) 合音（配音音量 + 可选 BGM）
    const finalOut = out ? path.resolve(out) : path.join(dir, `ks-${stamp}.mp4`);
    const muxed = await this.muxAudio({
      input: subbed.file,
      out: finalOut,
      voiceFile: voiceOut.file,
      bgmFile: style.au.bgmFile,
      bgmGainDb: style.au.bgmGainDb,
      voiceGainDb: style.au.voiceGainDb
    });
    steps.push({ step: 'mux', file: muxed.file, durationSec: Number(muxed.durationSec.toFixed(2)), bgm: style.au.bgmFile ? path.basename(style.au.bgmFile) : null });

    // 6) 封面
    const coverFile = path.join(dir, `cover-${stamp}.jpg`);
    const cover = await this.cover({ input: muxed.file, out: coverFile, atSec: Math.min(1, total / 2) });
    steps.push({ step: 'cover', file: cover.file });

    // 中间产物清掉，只留成片/封面/配音
    for (const f of [baseFile, subbed.file]) if (f && f !== finalOut) fs.rmSync(f, { force: true });

    this.flushTemps();
    this.pruneWorkDir();

    return {
      file: muxed.file,
      cover: cover.file,
      durationSec: muxed.durationSec,
      sizeBytes: muxed.sizeBytes,
      subtitles: items,
      voice: { file: voiceOut.file, durationSec: voiceOut.durationSec, text: spoken, name: style.au.voice },
      style: {
        background: (() => {
          const kind = backgroundKind(style.bg);
          if (kind === 'video') return { type: 'video', video: style.bg.video, fit: style.bg.fit, dim: style.bg.dim, blur: style.bg.blur };
          if (kind === 'image') return { type: 'image', image: style.bg.image, fit: style.bg.fit, dim: style.bg.dim, blur: style.bg.blur };
          if (kind === 'gradient') return { type: 'gradient', from: style.bg.gradientFrom, to: style.bg.gradientTo, axis: style.bg.gradientAxis };
          return { type: 'color', color: style.bg.color };
        })(),
        typography: { fontPath: style.ty.fontPath, fontSize: style.ty.fontSize, titleFontSize: style.ty.titleFontSize, fontColor: style.ty.fontColor, titleColor: style.ty.titleColor, boxAlpha: style.ty.boxAlpha, subtitleY: style.ty.subtitleY },
        audio: { voice: style.au.voice, rate: style.au.rate, bgmFile: style.au.bgmFile, bgmGainDb: style.au.bgmGainDb }
      },
      steps
    };
  }
}
