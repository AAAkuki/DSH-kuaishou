// 样式 e2e：图片背景 + 压暗 + 自定义字号/颜色/位置 + 语速 + BGM
import path from 'node:path';
import fs from 'node:fs';
import { VideoStudio } from '../src/video.mjs';

const studio = new VideoStudio({ log: (l) => process.stderr.write(`${l}\n`) });

const out = path.resolve('demo/styled-demo.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });

const result = await studio.fromText({
  title: '鲸鱼女仆娘的视频模板',
  lines: ['背景是图片，不是纯色', '字号颜色位置都能改', '配音语速和 BGM 也行', '这条就是模板参数跑出来的'],
  voiceText: '背景是图片，不是纯色。字号颜色位置都能改，配音语速和 BGM 也行，这条就是模板参数跑出来的。',
  // 背景
  bgImage: path.resolve('demo/bg-test.png'),
  bgFit: 'cover',
  bgDim: 0.45,
  // 字体
  fontSize: 46,
  titleFontSize: 64,
  fontColor: '0xFFE066',
  titleColor: 'white',
  boxAlpha: 0.3,
  subtitleY: 0.8,
  // 声音
  rate: 2,
  bgmFile: path.resolve('demo/bgm-test.mp3'),
  bgmGainDb: -20,
  out
});

console.log(JSON.stringify({
  file: result.file,
  durationSec: Number(result.durationSec.toFixed(2)),
  sizeMB: Number((result.sizeBytes / 1024 / 1024).toFixed(2)),
  style: result.style,
  steps: result.steps
}, null, 2));
