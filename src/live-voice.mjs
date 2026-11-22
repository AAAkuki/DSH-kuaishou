// 直播里"说话"用的嗓子：**和发视频完全同一套**（piper 华颜 + cute loli 预设 + soft 柔化）。
// 合成结果按文本缓存，直播时同一句话只合成一次。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import nodeChild from 'node:child_process';
import { projectRoot } from './config.mjs';

// ESM 里没有 require：ffprobe 解析要用 createRequire
const nodeRequire = createRequire(import.meta.url);

const cacheDir = () => path.join(projectRoot(), 'state', 'live', 'voice');

// 同一句话并发合成会同时写同一个 wav（写出半截文件），用 in-flight 表挡一下
const inFlight = new Map();

function key(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

/** 读 wav 时长（秒）；读不到返回 0，不抛。混音/排队都要用它算间隔。 */
export function wavDuration(file, ffprobe = '') {
  try {
    const { spawnSync } = nodeChild;
    const bin = ffprobe || (() => {
      try { return nodeRequire('./video.mjs').resolveTools({}).ffprobe || ''; } catch { return ''; }
    })();
    if (!bin) return 0;
    const r = spawnSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const d = Number(String(r.stdout || '').trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
}

/** 真正的合成（内部用，外面统一走 speakLine） */
async function synthOnce(t, { cfg, tools = {}, log = () => {} }) {
  const au = cfg?.video?.audio || {};
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${key(t)}.wav`);
  const softOut = path.join(dir, `${key(t)}-soft.wav`);
  // 先用柔化版（视频出厂就是柔化过的），没有再退回干声
  if (fs.existsSync(softOut) && fs.statSync(softOut).size > 1000) {
    return { ok: true, file: softOut, cached: true, softened: true };
  }
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    return { ok: true, file: out, cached: true };
  }

  const piperReady = au.piperExe && fs.existsSync(au.piperExe) && au.piperModel && fs.existsSync(au.piperModel);
  try {
    if (piperReady) {
      const { synthCute } = await import('./synth-cute.mjs');
      // synthCute 需要 ffmpeg/ffprobe 做变调/拼接，这里用和视频同一套解析
      const { resolveTools } = await import('./video.mjs');
      const vt = resolveTools({ ffmpegPath: cfg?.video?.ffmpegPath, ffprobePath: cfg?.video?.ffprobePath });
      const r = await synthCute(
        { ffmpeg: tools.ffmpeg || vt.ffmpeg, ffprobe: tools.ffprobe || vt.ffprobe, piperExe: au.piperExe, piperModel: au.piperModel },
        {
          text: t,
          lines: [t],
          out,
          workDir: path.join(dir, 'work'),
          piperExe: au.piperExe,
          piperModel: au.piperModel,
          preset: au.cute || 'loli',
          stutter: false,
          breath: false,
          pause: true,
          lengthScale: au.lengthScale ?? 1.12
        }
      );
      const file = r?.out || out;
      // 柔化（和视频一样，带一点厚度）
      if (au.soften && au.soften !== 'none') {
        try {
          const { softenAudio } = await import('./voice-soften.mjs');
          const soft = softOut;
          softenAudio({ ffmpeg: tools.ffmpeg || vt.ffmpeg, ffprobe: tools.ffprobe || vt.ffprobe }, { input: file, out: soft, preset: au.soften });
          if (fs.existsSync(soft) && fs.statSync(soft).size > 1000) {
            return { ok: true, file: soft, cached: false, softened: true };
          }
        } catch (error) { log(`[live-voice] 柔化跳过：${error.message}`); }
      }
      return { ok: true, file, cached: false };
    }

    // 没装 piper 就退回系统 SAPI（还是设置里那个声音）
    const { synthesize } = await import('./tts.mjs');
    const r = await synthesize({ engine: au.engine === 'piper' ? 'sapi' : (au.engine || 'sapi'), text: t, out, voice: au.voice, rate: au.rate ?? 0 });
    return { ok: true, file: r.file || r.out || out, cached: false, fallback: 'sapi' };
  } catch (error) {
    return { ok: false, reason: String(error.message || error).slice(0, 160) };
  }
}

/**
 * 把一句话合成为 wav（返回文件路径）。失败返回 { ok:false, reason }，不抛。
 * 用的模型/参数与视频出片一致：piper 华颜、cute 预设、soft 柔化。
 * 同一句话并发调用会共用同一次合成（不会把 wav 写花）。
 */
export async function speakLine(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: '空句子' };
  const k = key(t);
  if (inFlight.has(k)) return inFlight.get(k);
  const task = synthOnce(t, opts).finally(() => { inFlight.delete(k); });
  inFlight.set(k, task);
  return task;
}

/** 给页面用的 file:// URL */
export function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}
