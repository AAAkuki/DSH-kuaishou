// 背景三连测：渐变预设 / 图片+模糊 / 视频背景
import path from 'node:path';
import fs from 'node:fs';
import { VideoStudio, backgroundKind } from '../src/video.mjs';

const studio = new VideoStudio({ log: (l) => process.stderr.write(`${l}\n`) });
const lines = ['这一句是字幕', '背景可以换成渐变', '也可以换成图片或视频'];
const voiceText = '这一句是字幕。背景可以换成渐变，也可以换成图片或视频。';

const cases = [
  { name: 'bg-gradient', opts: { bgPreset: 'whale-blue', bgGradientAxis: 'vertical', fontColor: '0xFFE066' } },
  { name: 'bg-image-blur', opts: { bgImage: path.resolve('demo/bg-test.png'), bgBlur: 18, bgDim: 0.3, subtitleY: 0.82 } },
  { name: 'bg-video', opts: { bgVideo: path.resolve('demo/bg-video.mp4'), bgDim: 0.5, fontColor: 'white' } }
];

const results = [];
for (const c of cases) {
  const out = path.resolve(`demo/${c.name}.mp4`);
  const r = await studio.fromText({
    title: c.name,
    lines,
    voiceText,
    out,
    ...c.opts
  });
  const kind = backgroundKind(r.style.background.type === 'video'
    ? { video: r.style.background.video }
    : r.style.background.type === 'image'
      ? { image: r.style.background.image }
      : r.style.background.type === 'gradient'
        ? { gradientFrom: r.style.background.from, gradientTo: r.style.background.to }
        : { color: r.style.background.color });
  results.push({
    case: c.name,
    kind,
    file: r.file,
    durationSec: Number(r.durationSec.toFixed(2)),
    sizeMB: Number((r.sizeBytes / 1024 / 1024).toFixed(2)),
    background: r.style.background
  });
}

console.log(JSON.stringify(results, null, 2));
