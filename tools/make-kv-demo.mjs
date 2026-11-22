// 用 Vibe 知识大赏的方法出一条样片（不发布，只渲染）
import path from 'node:path';
import { renderVibeVideo, pythonPath } from '../src/vibe.mjs';
import { resolveTools } from '../src/video.mjs';

const tools = resolveTools({});
if (!tools.ffmpeg) throw new Error('没有 ffmpeg');

const lines = [
  '今天 AI 会「自己学」，这思路源自哪一年？',
  '1950 年，图灵写了篇论文，开头就问：机器能思考吗？',
  '他没有回答「能」还是「不能」，而是换了个问法。',
  '「机器能不能思考」根本没法测，他改成：能不能装得像在思考。',
  '这就是图灵测试。',
  '七十五年后，我们做的还是同一件事：让机器的回答骗过你。',
  '所以 AI 的起点不是算力，是一个提问方式的转弯。',
  '你今天每用一次，都在给这个问题投票。'
];

const res = renderVibeVideo({
  lines,
  out: path.resolve('state/video/kv-demo-turing.mp4'),
  outDir: path.resolve('state/video/kv-demo-turing'),
  ffmpeg: tools.ffmpeg,
  python: pythonPath(),
  style: 'notes',
  width: 1080,
  height: 1920,
  totalSec: 34,
  bigWords: [
    'AI 会「自己学」',
    '1950 年',
    '他换了个问法',
    '能不能装得像',
    '图灵测试',
    '七十五年后',
    '起点不是算力',
    '你每用一次'
  ],
  sources: [
    'Turing, 1950, Mind 59(236)',
    '《计算机器与智能》',
    'Turing, 1950',
    'Turing, 1950',
    'Turing, 1950',
    'Vibe 知识大赏',
    '',
    ''
  ]
});

console.log(JSON.stringify({ file: res.out, seconds: res.totalSec, scenes: res.scenes, bpm: res.beats?.bpm, overflow: res.overflow }, null, 1));
