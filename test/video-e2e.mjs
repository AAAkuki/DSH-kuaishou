// 端到端：文案 → 中文配音 → 竖屏 → 逐句字幕 → 成片 → 封面。
// 用法：node test/video-e2e.mjs [spec.json]
import fs from 'node:fs';
import path from 'node:path';
import { VideoStudio } from '../src/video.mjs';

const studio = new VideoStudio({ log: (l) => process.stderr.write(`${l}\n`) });

const arg = process.argv[2];
const spec = arg && arg !== '--demo' && fs.existsSync(arg)
  ? JSON.parse(fs.readFileSync(arg, 'utf8'))
  : {
      title: 'DeepSeek 帮我改了一行代码',
      lines: [
        '昨晚十一点，我把报错直接丢给了它',
        '它没急着写代码，先问我复现步骤',
        '三分钟后给出了真正的原因',
        '原来是我自己的判断写反了'
      ],
      bgColor: '0x0f1419'
    };

const out = path.resolve('demo/deepseek-demo.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });

const t0 = Date.now();
const result = await studio.fromText({ ...spec, out });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(JSON.stringify({
  ok: true,
  tookSec: secs,
  file: result.file,
  cover: result.cover,
  durationSec: Number(result.durationSec.toFixed(2)),
  sizeMB: Number((result.sizeBytes / 1024 / 1024).toFixed(2)),
  subtitleCount: result.subtitles.length,
  voice: { file: result.voice.file, durationSec: Number(result.voice.durationSec.toFixed(2)) },
  steps: result.steps.map((s) => s.step)
}, null, 2));

const verify = await studio.probe(result.file);
console.log('probe:', JSON.stringify({
  durationSec: Number(verify.durationSec.toFixed(2)),
  width: verify.width,
  height: verify.height,
  fps: Number(verify.fps.toFixed(2)),
  video: verify.videoCodec,
  audio: verify.audioCodec
}));
