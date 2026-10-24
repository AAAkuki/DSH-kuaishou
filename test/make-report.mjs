// 用当前代码（不是旧 MCP 进程）重新生成总结视频：渐变背景 + 黄色字幕
import path from 'node:path';
import { VideoStudio } from '../src/video.mjs';

const studio = new VideoStudio({ log: (l) => process.stderr.write(`${l}\n`) });
const out = path.resolve('demo/test-report.mp4');

const r = await studio.fromText({
  title: '快手插件首测总结',
  lines: [
    '刷了 3 条视频，最长一条 5 分钟',
    '读了 6 条评论，真回出去 1 条',
    '点赞点了，但赞数被取整看不出变化',
    '这轮修了 9 个 bug',
    '还加了自检脚本，以后不会偷偷坏'
  ],
  voiceText: '快手插件首测总结。刷了 3 条视频，最长一条 5 分钟；读了 6 条评论，真回出去 1 条；点赞点了，但赞数被取整看不出变化；这轮修了 9 个 bug，还加了自检脚本，以后不会偷偷坏。',
  bgPreset: 'whale-blue',
  fontColor: '0xFFE066',
  fontSize: 48,
  subtitleY: 0.8,
  out
});

console.log(JSON.stringify({
  file: r.file,
  durationSec: Number(r.durationSec.toFixed(2)),
  sizeMB: Number((r.sizeBytes / 1024 / 1024).toFixed(2)),
  background: r.style.background,
  subtitles: r.subtitles.length
}, null, 2));
