// 本地演示成片：用**真实**出片流水线（VideoStudio）跑一遍全自动的文案+配音+渲染，
// 但后端是假的（不打开快手、不点任何东西、不发布）。
//
// 为什么需要它：想验证"字数够不够、时长是不是一分钟"时，不该去动真账号。
//
// 用法：
//   node tools/render-demo.mjs                 # 12 句（≈1 分钟）
//   node tools/render-demo.mjs 16 journal      # 16 句，日志体
//   node tools/render-demo.mjs 14 scrolled
import fs from 'node:fs';
import path from 'node:path';
import { runFullAuto } from '../src/autopilot.mjs';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { VideoStudio } from '../src/video.mjs';
import { OpsState } from '../src/ops.mjs';

const lineCount = Math.max(2, Math.min(20, Number(process.argv[2]) || 12));
const contentMode = ['auto', 'scrolled', 'journal'].includes(process.argv[3]) ? process.argv[3] : 'auto';
const root = projectRoot();

const cfg = loadConfig({});
cfg.video.lineCount = lineCount;
cfg.summary = { ...(cfg.summary ?? {}), perDay: 0, refresh: true }; // 演示不占总结视频配额
cfg.quotas = { ...(cfg.quotas ?? {}), scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 0 };

// 真数据（--live-stats：去创作者后台读一次播放量/涨粉，再拿来写文案）
let liveStats = null;
if (process.argv.includes('--live-stats')) {
  try {
    const { KuaishouWeb } = await import('../src/web.mjs');
    const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
    liveStats = await web.readMyStats();
    console.log('真实数据:', JSON.stringify(liveStats));
  } catch (error) {
    console.error('读真实数据失败（继续用假数据）:', error.message);
  }
}

// 假后端：只回数据，不碰浏览器（除非带了真实数据）
const fakeBackend = async () => ({
  async feedScroll({ count }) {
    return Array.from({ length: count }, (_, i) => ({ dwellMs: 6000, durationSec: 12 + i * 7, changed: true }));
  },
  async like() { return { changed: true }; },
  async readComments() {
    return [
      { author: '小明', text: '这个是怎么做的' },
      { author: '阿花', text: '说得太对了' }
    ];
  },
  async reply() { return { replied: 'ok' }; },
  async publish() { return { published: false, message: '演示不发布' }; },
  async readMyStats() { return liveStats ?? { plays: 0, likes: 0, fansDelta: 0, completion: 0, last: null }; }
});

const state = new OpsState({ file: path.join(root, 'state', 'demo-state.json') }).load();
state.data.day = state.data.day || new Date().toISOString().slice(0, 10);
state.data.counts = { scroll: 9, reply: 3, like: 4, publish: 0 };

const studio = new VideoStudio({ cfg, log: (l) => console.error(l) });
// 抓住配音时间轴：用它和成片里的有声段做对比，就能量化"音画同不同步"
let lastTimeline = null;
let lastVoice = null;
const origTts = studio.tts.bind(studio);
studio.tts = async (o) => {
  const r = await origTts(o);
  if (Array.isArray(r?.timeline) && r.timeline.length) { lastTimeline = r.timeline; lastVoice = r.file; }
  return r;
};
const events = [];
const t0 = Date.now();
const report = await runFullAuto(
  { backend: fakeBackend, state, cfg, studio, root, trace: (e) => { events.push(e); process.stdout.write(`· [${e.phase}] ${e.message}\n`); } },
  { rounds: 1, publish: false, contentMode, lineCount }
);
const videoStep = report.steps.find((s) => s.kind === 'video');
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (!videoStep?.file) {
  console.error('没出片：', JSON.stringify(report.steps, null, 2));
  process.exit(1);
}

const out = path.isAbsolute(videoStep.file) ? videoStep.file : path.join(root, videoStep.file);
const stat = fs.statSync(out);
console.log('\n=== 成片 ===');
console.log('文件:', out);
console.log('时长:', videoStep.durationSec, '秒（目标', cfg.video.targetDurationSec, '秒；最短', cfg.video.minDurationSec, '秒）');
console.log('字幕句数:', videoStep.lines?.length);
console.log('体积:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
console.log('总耗时:', elapsed, '秒');
if (lastTimeline) {
  const timelineFile = `${out}.timeline.json`;
  fs.writeFileSync(timelineFile, `${JSON.stringify({
    at: new Date().toISOString(),
    voice: lastVoice,
    durationSec: videoStep.durationSec,
    lines: videoStep.lines,
    timeline: lastTimeline
  }, null, 2)}\n`, 'utf8');
  console.log('时间轴:', timelineFile, `（${lastTimeline.length} 段）`);
  if (lastTimeline.length !== (videoStep.lines ?? []).length) {
    console.log(`⚠️ 时间轴 ${lastTimeline.length} 段 ≠ 字幕 ${videoStep.lines?.length} 句：字幕会按字数估算，可能不同步`);
  } else {
    console.log('✅ 时间轴与字幕 1:1（逐句对齐）');
  }
}
console.log('\n字幕：');
for (const [i, l] of (videoStep.lines ?? []).entries()) console.log(`  ${String(i + 1).padStart(2)}. ${l}`);

// 带 --live-stats 时会开一个常驻浏览器：用完必须回收，否则 Node 不退出、命令一直挂着
process.exit(0);
