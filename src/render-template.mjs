// 模板视频生成：横版模板图 → 竖屏成片，只往说话框里打字
//
// 竖屏适配策略（关键决策）：
//   模板原图 1176x628（横），直接 cover 到 1080x1920 会把右侧说话框裁掉一半。
//   所以采用「**图片居中 + 上下用模板主色填充**」：
//     · 背景先用模板图的主色（浅蓝）铺满 1080x1920
//     · 模板图按宽度等比缩放后垂直居中放置（1080 宽 → 高 577）
//     · 说话框位置按缩放后的实际坐标算，字体随缩放比放大
//   这样模板 100% 完整显示，说话框不裁切，字也够大。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 模板默认框（相对原图 0~1），实测自 1176x628 这张图 */
export const DEFAULT_BOX = {
  x0: 0.442, y0: 0.652, x1: 0.947, y1: 0.918,
  padX: 0.02, padY: 0.06,
  color: '0x2b4a7d',
  fontSize: 0,
  lineGap: 1.15
};

function esc(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * 生成一条"套模板"的视频。
 * @param {object} tools {ffmpeg, ffprobe}
 * @param {object} opts
 *   template   模板图路径
 *   out        输出 mp4
 *   workDir    中间文件目录
 *   width/height 画布（默认 1080x1920）
 *   bgColor    上下填充色（0xRRGGBB），留空则从模板边缘取样
 *   lines      要打的字（数组，按时间依次显示）
 *   durations  每句显示时长（秒）
 *   font       字体文件
 *   box        框坐标（相对）
 *   voiceFile  配音 wav（可选；给了就按语音总长分配时间）
 */
export function renderTemplateVideo(tools, {
  template, out, workDir, width = 1080, height = 1920,
  bgColor = '0xB8D4F0', lines = [], durations = null, font,
  box = DEFAULT_BOX, voiceFile = '', titleFontSize = 0,
  stickerText = '', stickerColor = 'white', stickerSize = 0.22, timings = null,
  // 用户自定义贴纸（图片）：位置与大小可调
  stickerFile = '', stickerX = 0.26, stickerY = 0.36, stickerScale = 0.22, stickerKey = 'auto',
  minDurationSec = 0, stickerTrim = 0.02, stickerAnchor = '', stickerPlan = null,
  /** 背景留白的填充方式：>0 = 放大后柔焦（sigma，建议 10~18）；0 = 竖向渐变 */
  bgBlur = 0,
  /** 柔焦背景压暗 0~1：让背景退到后面去，突出模板和中文字 */
  bgDim = 0,
  // 参考视频学来的四项装饰
  titleBar = '',          // 左上角栏目名，如「大肥鱼的生活日记」
  titleBarColor = 'white',
  aiBadge = '',           // 右上角合规标识，如「大肥鱼 (AI) 生成内容」
  speakerName = '',       // 对话框左上角名字标签，如「大肥鱼」
  speakerColor = '0xd97706',
  typing = false          // 打字光标闪烁
} = {}) {
  if (!fs.existsSync(template)) throw new Error(`模板不存在：${template}`);
  template = path.resolve(template);
  out = path.resolve(out);
  if (voiceFile) voiceFile = path.resolve(voiceFile);
  // 每次渲染用独立子目录：并发跑时不会互相覆盖 line-*.txt / sticker.txt
  const stamp = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  workDir = path.resolve(workDir, stamp);
  fs.mkdirSync(workDir, { recursive: true });

  // ① 读模板尺寸
  const probe = spawnSync(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', template], { encoding: 'utf8' });
  let tw = 1176, th = 628;
  try {
    const j = JSON.parse(probe.stdout);
    tw = j.streams?.[0]?.width ?? tw;
    th = j.streams?.[0]?.height ?? th;
  } catch {}

  // ② 按宽度等比缩放，垂直居中
  // 模板必须按**宽度**缩放（横图按高度放大会溢出画布宽度，框被裁到画面外）
  const imgW = width;
  const imgH = Math.round((th / tw) * imgW);
  const imgY = Math.round((height - imgH) / 2);
  const scale = imgW / tw;
  void scale;

  // ③ 说话框在画布上的像素矩形
  const bx0 = Math.round(box.x0 * imgW);
  const bx1 = Math.round(box.x1 * imgW);
  const by0 = imgY + Math.round(box.y0 * imgH);
  const by1 = imgY + Math.round(box.y1 * imgH);
  const textW = Math.round((bx1 - bx0) * (1 - box.padX * 2));
  const textH = Math.round((by1 - by0) * (1 - box.padY * 2));
  const cx = Math.round((bx0 + bx1) / 2);
  const cy = Math.round((by0 + by1) / 2);

  // ④ 逐句画字
  const audioDur = voiceFile && fs.existsSync(voiceFile)
    ? Number(JSON.parse(spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', voiceFile], { encoding: 'utf8' }).stdout || '{}').format?.duration ?? 0)
    : 0;

  // 最短时长：太短的视频在快手上会被划走（用户要求）
  let minDur = Number(minDurationSec) > 0 ? Number(minDurationSec) : 0;

  // 时间轴优先：timings=[{text,start,end}] → 直接用真实时间（否则平均分会和声音错位）
  let totalDur;
  let spans;
  if (Array.isArray(timings) && timings.length === lines.length) {
    // 条数一致：用真实时间
    totalDur = Math.max(audioDur, timings[timings.length - 1].end);
    spans = timings.map((t) => ({ start: t.start, end: t.end }));
  } else if (Array.isArray(timings) && timings.length) {
    // 条数不一致（语音句数 ≠ 字幕句数）：按字数比重铺满整段音频
    totalDur = Math.max(audioDur, timings[timings.length - 1].end);
    const weights = lines.map((l) => Math.max(2, String(l).length));
    const sum = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    spans = lines.map((_, i) => {
      const d = (weights[i] / sum) * totalDur;
      const s0 = acc;
      acc += d;
      return { start: s0, end: acc };
    });
  } else {
    totalDur = audioDur > 0 ? audioDur : Math.max(4, lines.length * 3);
    const per = durations ?? lines.map(() => totalDur / Math.max(1, lines.length));
    spans = [];
    let acc = 0;
    for (let i = 0; i < lines.length; i++) { spans.push({ start: acc, end: acc + per[i] }); acc += per[i]; }
  }


  /**
   * 采样图片四角颜色；四角接近一致时返回该颜色（说明是纯色底，可以抠掉）。
   * @returns {string|null} 0xRRGGBB 或 null
   */
  /** 图片本身是否带 alpha 通道（透明 PNG 就不用再抠） */
  function hasAlphaChannel(file) {
    try {
      const r = spawnSync(tools.ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=pix_fmt', '-of', 'json', file
      ], { encoding: 'utf8' });
      const fmt = JSON.parse(r.stdout || '{}').streams?.[0]?.pix_fmt ?? '';
      return /a/.test(fmt);   // rgba / ya8 / pal8...
    } catch { return false; }
  }

  function detectFlatBackground(file) {
    try {
      const r = spawnSync(tools.ffmpeg, [
        '-hide_banner', '-v', 'error',
        '-i', file,
        '-vf', 'crop=2:2:1:1,format=rgb24',
        '-frames:v', '1', '-f', 'rawvideo', '-'
      ], { encoding: 'buffer', maxBuffer: 1024 * 64 });
      const r2 = spawnSync(tools.ffmpeg, [
        '-hide_banner', '-v', 'error',
        '-i', file,
        '-vf', 'crop=2:2:iw-3:ih-3,format=rgb24',
        '-frames:v', '1', '-f', 'rawvideo', '-'
      ], { encoding: 'buffer', maxBuffer: 1024 * 64 });
      const px = (buf) => (buf && buf.length >= 3 ? [buf[0], buf[1], buf[2]] : null);
      const a = px(r.stdout);
      const b = px(r2.stdout);
      if (!a || !b) return null;
      const near = (x, y) => Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 40;
      if (!near(a, b)) return null;   // 两角颜色差太多 → 不是纯色底
      const hex = '0x' + a.map((v) => v.toString(16).padStart(2, '0')).join('');
      return hex;
    } catch { return null; }
  }
  // 填补句间空档：停顿期间保持上一句字幕，避免"字幕闪没"
  for (let i = 0; i < spans.length - 1; i++) {
    const gap = spans[i + 1].start - spans[i].end;
    if (gap > 0 && gap < 1.5) spans[i].end = spans[i + 1].start;
  }

  // 不够长就补时长，但**不能拉伸字幕时间轴**（那会让字幕跑在声音前面）。
  // 正确做法：前面的字幕保持与音频对齐，最后一句一直显示到新的结尾。
  if (minDur && totalDur < minDur && spans.length) {
    // 只做"轻微补齐"，最多 3 秒；否则结尾会出现一大段无声（观感很差）
    minDur = Math.min(minDur, totalDur + 3);
    const audioEnd = totalDur;               // 原音频结束时间
    const last = spans[spans.length - 1];
    // 只在"最后一句已经说完"的位置之后补时长
    last.end = Math.max(last.end, minDur);
    // 如果最后一句起点晚于音频结束，说明本来就对齐，不动
    if (last.end > audioEnd) last.end = Math.max(audioEnd, minDur);
    totalDur = minDur;
  }

  const draw = [];
  let stickerGeom = null;

  // 贴纸：优先用用户上传的图片，其次 emoji
  // 与字幕框对齐：用画布上的真实框坐标算中心，不用模板相对值
  if (stickerAnchor === 'box') {
    stickerY = Math.round((by0 + by1) / 2) / height;
    if (stickerX == null || Number.isNaN(Number(stickerX))) {
      stickerX = Math.round(bx0 / 2) / width;   // 框左侧空白中心
    }
  }
  const stickerImg = String(stickerFile ?? '').trim();
  const useImageSticker = stickerImg && fs.existsSync(path.resolve(stickerImg));
  if (useImageSticker) {
    // 位置按"中心点占画面比例"算，size 为宽度占比
    const wpx = Math.round(width * Math.min(0.9, Math.max(0.05, Number(stickerScale) || 0.22)));
    const cxPx = Math.round(width * Math.min(1, Math.max(0, Number(stickerX) || 0.26)));
    const cyPx = Math.round(height * Math.min(1, Math.max(0, Number(stickerY) || 0.36)));
    stickerGeom = { w: wpx, cx: cxPx, cy: cyPx, file: path.resolve(stickerImg) };
  } else {
    const sticker = String(stickerText ?? '').trim();
    if (sticker) {
      const sz = Math.round(width * Math.min(0.4, Math.max(0.08, stickerSize ?? 0.22)));
      const emojiFont = fs.existsSync('C:/Windows/Fonts/seguiemj.ttf') ? 'C:/Windows/Fonts/seguiemj.ttf' : font;
      const sf = path.resolve(workDir, 'sticker.txt');
      fs.writeFileSync(sf, sticker, 'utf8');
      const sfArg = sf.replace(/\\/g, '/').replace(':', '\\:');
      const fontArg = emojiFont.replace(/\\/g, '/').replace(':', '\\:');
      draw.push(
        `drawtext=fontfile='${fontArg}':textfile='${sfArg}':` +
        `fontsize=${sz}:fontcolor=${stickerColor ?? 'white'}@0.95:` +
        `x=${Math.round(width * 0.26)}-text_w/2:y=${Math.round(height * 0.36)}-text_h/2:` +
        `enable='gt(t,0.3)'`
      );
    }
  }

  // ── ① 左上角栏目名 ──
  const smallFs = Math.round(width * 0.034);
  if (titleBar) {
    const tf = path.resolve(workDir, 'title-bar.txt');
    fs.writeFileSync(tf, String(titleBar), 'utf8');
    const tfArg = tf.replace(/\\/g, '/').replace(':', '\\:');
    draw.push(
      `drawtext=fontfile='${esc(font)}':textfile='${tfArg}':` +
      `fontsize=${smallFs}:fontcolor=${titleBarColor}:` +
      `shadowcolor=black@0.75:shadowx=3:shadowy=3:` +
      `x=${Math.round(width * 0.045)}:y=${Math.round(height * 0.050)}`
    );
  }

  // ── ② 右上角「AI 生成内容」药丸标签 ──
  if (aiBadge) {
    const bFs = Math.round(width * 0.022);
    const bf = path.resolve(workDir, 'ai-badge.txt');
    fs.writeFileSync(bf, String(aiBadge), 'utf8');
    const bfArg = bf.replace(/\\/g, '/').replace(':', '\\:');
    const bw = Math.round([...String(aiBadge)].length * bFs * 1.02 + bFs * 1.2);
    const bh = Math.round(bFs * 2.0);
    const bx = width - bw - Math.round(width * 0.04);
    const by = Math.round(height * 0.046);
    draw.push(`drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=white@0.90:t=fill`);
    draw.push(
      `drawtext=fontfile='${esc(font)}':textfile='${bfArg}':` +
      `fontsize=${bFs}:fontcolor=0x1f2937:` +
      `x=${bx}+(${bw}-text_w)/2:y=${by}+(${bh}-text_h)/2`
    );
  }

  // ── ③ 对话框左上角名字标签 ──
  if (speakerName) {
    const nFs = Math.round(width * 0.024);
    const nf = path.resolve(workDir, 'speaker.txt');
    fs.writeFileSync(nf, String(speakerName), 'utf8');
    const nfArg = nf.replace(/\\/g, '/').replace(':', '\\:');
    const nw = Math.round([...String(speakerName)].length * nFs * 1.05 + nFs * 1.0);
    const nh = Math.round(nFs * 1.9);
    const nx = bx0;
    const ny = Math.max(0, by0 - nh - Math.round(height * 0.004));
    draw.push(`drawbox=x=${nx}:y=${ny}:w=${nw}:h=${nh}:color=${speakerColor}:t=fill`);
    draw.push(
      `drawtext=fontfile='${esc(font)}':textfile='${nfArg}':` +
      `fontsize=${nFs}:fontcolor=white:` +
      `x=${nx}+(${nw}-text_w)/2:y=${ny}+(${nh}-text_h)/2`
    );
  }

  lines.forEach((line, i) => {
    const start = spans[i]?.start ?? 0;
    const end = spans[i]?.end ?? start + 1;
    // textfile 必须给绝对路径：纯文件名在 ffmpeg 里找不到（cwd 不生效）。
    // 用正斜杠形式（Windows 上 drawtext 认，反斜杠会被当转义）。
    const tfName = `tmpl-line-${i}.txt`;
    const tfPath = path.resolve(workDir, tfName);                 // 写文件用真实路径
    const tfArg = tfPath.replace(/\\/g, '/').replace(':', '\\:'); // 塞进 drawtext 才转义
    fs.writeFileSync(tfPath, line, 'utf8');
    // 字号：单行能放下，最多两行
    // 中文字宽 ≈ 1.0 * fontsize，数字/字母 ≈ 0.55
    const wide = [...line].filter((ch) => /[\u4e00-\u9fa5]/.test(ch)).length;
    const narrow = line.length - wide;
    const emWidth = wide * 1.0 + narrow * 0.55;
    // 0.8 而不是 0.92：参考视频里字幕两侧留白更明显，贴边会显得挤
    const maxByWidth = emWidth > 0 ? Math.floor((textW * 0.80) / emWidth) : textW;
    const fs2 = Math.max(20, Math.min(titleFontSize || 72, maxByWidth, Math.floor(textH / 1.15)));
    // ── ④ 打字光标（闪烁）──
    // 开启打字效果时只画"交替的那两段"，否则会和基线文字叠成重影（实测踩到）
    if (!typing) {
      draw.push(
        `drawtext=fontfile='${esc(font)}':textfile='${tfArg}':` +
        `fontsize=${fs2}:fontcolor=${box.color}:` +
        `x=${cx}-(text_w/2):y=${cy}-(text_h/2):` +
        `line_spacing=${Math.round((box.lineGap - 1) * fs2)}:` +
        `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`
      );
    }
    // 交替两段：有光标 / 无光标
    if (typing) {
      const tfBlink = path.resolve(workDir, `tmpl-line-${i}-caret.txt`);
      fs.writeFileSync(tfBlink, line + '|', 'utf8');
      const blinkArg = tfBlink.replace(/\\/g, '/').replace(':', '\\:');
      // 有光标的那半拍
      draw.push(
        `drawtext=fontfile='${esc(font)}':textfile='${blinkArg}':` +
        `fontsize=${fs2}:fontcolor=${box.color}:` +
        `x=${cx}-(text_w/2):y=${cy}-(text_h/2):` +
        `line_spacing=${Math.round((box.lineGap - 1) * fs2)}:` +
        `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})*gte(mod(t,0.7),0.35)'`
      );
      // 无光标的那半拍：把上面那段"字"盖住（用同一位置再画一次不带光标的原文）
      // ——其实更简单：不带光标的那段用 0.35 周期显示，两段互斥即可
      draw.push(
        `drawtext=fontfile='${esc(font)}':textfile='${tfArg}':` +
        `fontsize=${fs2}:fontcolor=${box.color}:` +
        `x=${cx}-(text_w/2):y=${cy}-(text_h/2):` +
        `line_spacing=${Math.round((box.lineGap - 1) * fs2)}:` +
        `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})*lt(mod(t,0.7),0.35)'`
      );
    }
  });

  // ⑤ 合成：背景不再用"放大 + 强模糊"，那会把 16:9 的模板放大 3 倍糊成一片。
  //    改成：把模板缩成 1x2 像素再放大 —— 得到"上色→下色"的柔和竖向渐变，
  //    观感和模板边缘颜色接得上，又完全没有模糊和重影。
  // 输入顺序：0=模板，随后若干贴纸（可中途换），最后语音
  const inputArgs = ['-loop', '1', '-t', totalDur.toFixed(2), '-i', template];
  const stickerInputs = [];        // [{idx, file, start, end, scale}]
  let voiceInputIdx = -1;

  const planItems = Array.isArray(stickerPlan)
    ? stickerPlan.filter((it) => it && it.file && fs.existsSync(it.file))
    : [];

  if (planItems.length) {
    let idx = 1;
    for (const it of planItems) {
      inputArgs.push('-i', it.file);
      stickerInputs.push({
        idx, file: it.file,
        start: Number(it.start) || 0,
        end: Number(it.end) || totalDur,
        scale: it.scale
      });
      idx++;
    }
    voiceInputIdx = idx;
  } else if (stickerGeom) {
    inputArgs.push('-i', stickerGeom.file);
    stickerInputs.push({ idx: 1, file: stickerGeom.file, start: 0, end: totalDur, scale: stickerGeom.w });
    voiceInputIdx = 2;
  }

  const hasVoice = Boolean(voiceFile && fs.existsSync(voiceFile));
  if (hasVoice) {
    // 语音永远是最后一个输入
    voiceInputIdx = 1 + stickerInputs.length;
    inputArgs.push('-i', voiceFile);
  } else {
    voiceInputIdx = -1;   // 没有语音就别 map
  }

  // 背景小图的高度：先压到很小（area 平均）把压缩块平均掉，再放大回来
  const bgSmallH = Math.max(40, Math.round(height / 30));
  const bgBright = (0.06 + 0.5 * Math.min(1, Math.max(0, bgDim))).toFixed(3);

  const chains = [
    // 背景：压小 → 柔焦 → 放大铺满，或者退化成竖向渐变
    // setsar=1 不能省：scale 会按原图 DAR 反推 SAR，不归一会让整条视频被播放器拉变形
    bgBlur > 0
      // 注意：模糊背景必然带颗粒/色带（源图小 + 8bit），所以只保留极轻的静态抖动。
      // 时间噪声（allf=t）会让每帧都不同，码率直接飙到 33Mbps / 230MB，别用。
      ? `[0:v]scale=-2:${bgSmallH}:flags=area,gblur=sigma=${Math.max(1, bgBlur / 2).toFixed(1)},scale=${width}:${height}:flags=bicubic,setsar=1,eq=brightness=-${bgBright}:saturation=0.85,noise=alls=2:allf=u[bg]`
      : `[0:v]scale=1:2,setsar=1,scale=${width}:${height}:flags=bilinear,setsar=1[bg]`,
    `[0:v]scale=${imgW}:${imgH},setsar=1[tpl]`,
    `[bg][tpl]overlay=0:${imgY}:format=auto,setsar=1[base]`
  ];

  let lastLabel = 'base';
  let rgbaBase = false;   // 主画面是否已经是 rgba（只在第一张贴纸时转一次）
  // 逐张贴纸叠加；有多个时按时间段显示（中途换表情）
  stickerInputs.forEach((st, n) => {
    const sw = st.scale || Math.round(width * Math.min(0.9, Math.max(0.05, Number(stickerScale) || 0.22)));
    // JPG 之类没有透明通道：检测到纯色底就抠掉；透明 PNG 跳过
    const alreadyTransparent = hasAlphaChannel(st.file);
    const flat = alreadyTransparent ? null : detectFlatBackground(st.file);
    const stkFilters = [`scale=${sw}:-1`];
    if (flat && stickerKey !== 'off') {
      stkFilters.push('format=rgba', `colorkey=${flat}:0.14:0.20`);
      const trim = Math.max(0, Math.min(0.1, Number(stickerTrim) || 0.02));
      if (trim > 0) {
        stkFilters.push(`crop=iw*${(1 - trim * 2).toFixed(3)}:ih*${(1 - trim * 2).toFixed(3)}`);
      }
    }
    const tag = `stk${n}`;
    chains.push(`[${st.idx}:v]${stkFilters.join(',')}[${tag}]`);
    // 主画面转一次 rgba 就一直用 rgba 叠到底，最后统一转 yuv420p。
    // 以前每贴一张就 rgba → yuv420p → rgba 来回折腾，15 张就是 15 次色度重采样：
    // 画面会被"压"出一块块的色斑（用户说"像被压缩好多遍"就是这个）。
    if (!rgbaBase) {
      chains.push(`[${lastLabel}]format=rgba[pre${tag}]`);
      rgbaBase = true;
    } else {
      chains.push(`[${lastLabel}]null[pre${tag}]`);
    }
    const cx = stickerGeom ? stickerGeom.cx : Math.round(width * Math.min(1, Math.max(0, Number(stickerX) || 0.2)));
    const cy = stickerGeom ? stickerGeom.cy : Math.round(height * Math.min(1, Math.max(0, Number(stickerY) || 0.6)));
    chains.push(
      `[pre${tag}][${tag}]overlay=x=${cx}-w/2:y=${cy}-h/2:format=auto:enable='between(t,${st.start.toFixed(2)},${st.end.toFixed(2)})'[with${tag}]`
    );
    lastLabel = `with${tag}`;
  });

  // 收尾统一归一到 yuv420p + SAR 1:1：少这一步，播放器会把 9:16 的片子按 16:9 拉变形
  if (draw.length) chains.push(`[${lastLabel}]${draw.join(',')},format=yuv420p,setsar=1[v]`);
  else chains.push(`[${lastLabel}]format=yuv420p,setsar=1[v]`);

  const vf = chains.join(';');
  if (process.env.KSOPS_DEBUG_RENDER === '1') {
    process.stderr.write(`[render] template=${template}\n[render] filters=${vf}\n`);
  }

  const args = ['-hide_banner', '-y', ...inputArgs];
  args.push('-filter_complex', vf, '-map', '[v]');
  if (voiceInputIdx >= 0) {
    // apad 把配音补到画面长度，避免"画面还在放、声音已经没了"
    args.push('-map', `${voiceInputIdx}:a`, '-af', 'apad', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  }
  // crf 20 + medium：以前 crf23/veryfast 在渐变背景上会压出明显的块（用户反馈"像被压缩好多遍"）
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);

  if (process.env.DEBUG_TMPL) fs.writeFileSync(path.join(workDir, 'cmd.txt'), JSON.stringify({ cwd: workDir, args }, null, 1), 'utf8');
  const r = spawnSync(tools.ffmpeg, args, { encoding: 'utf8', cwd: workDir });
  for (let i = 0; i < lines.length; i++) fs.rmSync(path.resolve(workDir, `tmpl-line-${i}.txt`), { force: true });
  if (r.status !== 0) {
    const stderr = r.stderr || '';
    const errLines = stderr.split('\n').filter((l) => /rror|nvalid|Cannot|No such|failed|Permission|denied|只读/.test(l));
    // 留一份现场，便于事后排查（不阻塞主流程）
    try {
      fs.writeFileSync(path.resolve(workDir, 'failed-filter.txt'), vf, 'utf8');
      fs.writeFileSync(path.resolve(workDir, 'failed-args.json'), JSON.stringify({ cwd: workDir, cmd: tools.ffmpeg, args, stderr }, null, 1), 'utf8');
    } catch {}

    let hint = '';
    if (/Permission denied|拒绝访问|being used by another process/i.test(stderr)) {
      hint = '：输出文件被占用或只读（可能正在播放器里打开着，或同名旧文件被锁）。换个输出名，或先关掉打开它的程序';
    } else if (/No such file or directory/i.test(stderr) && /output|Output/i.test(stderr)) {
      hint = '：输出目录不存在或没有写权限';
    }
    const detail = errLines.slice(0, 3).join(' | ').slice(0, 240);
    throw new Error(`模板合成失败${hint}${detail ? '：' + detail : ''}`);
  }

  return {
    file: out,
    durationSec: totalDur,
    template: { file: template, w: tw, h: th, scaledW: imgW, scaledH: imgH, y: imgY },
    box: { x0: bx0, y0: by0, x1: bx1, y1: by1, cx, cy, textW, textH },
    lines,
    spans: spans.map((x) => ({ start: Number(x.start.toFixed(2)), end: Number(x.end.toFixed(2)) })),
    plan: stickerInputs.map((st) => ({ file: st.file, start: st.start, end: st.end })),
    sticker: stickerGeom ? { file: stickerGeom.file, w: stickerGeom.w, cx: stickerGeom.cx, cy: stickerGeom.cy, keyed: Boolean(stickerGeom.keyed) } : null,
    decorations: { titleBar, aiBadge, speakerName, typing }
  };
}
