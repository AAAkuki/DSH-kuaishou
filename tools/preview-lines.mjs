// 快速看文案（不渲染视频）：用真实数据生成，打印字幕
import { runFullAuto } from '../src/autopilot.mjs';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { OpsState, todayKey } from '../src/ops.mjs';
import { KuaishouWeb } from '../src/web.mjs';
import path from 'node:path';

const cfg = loadConfig({});
cfg.summary = { perDay: 0 };
cfg.quotas = { ...cfg.quotas, publishPerDay: 0 };

let stats = null;
try {
  const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
  stats = await web.readMyStats();
  console.log('真实数据:', JSON.stringify(stats));
  await web.closeForReal().catch(() => {});
} catch (e) {
  console.error('读数据失败:', e.message);
}

const st = new OpsState({ file: path.join(projectRoot(), 'state', 'demo-state.json') }).load();
st.data.day = todayKey();
st.data.counts = { scroll: 12, reply: 4, like: 5, publish: 0 };

const backend = async () => ({
  // 带几段"像视频文案"的描述：用来演示学梗
  async feedScroll({ count = 3 } = {}) {
    const descs = [
      '#抽象 这波直接破防了 #整活',
      '「情绪价值拉满」#搭子日常',
      '一眼丁真，鉴定为 #显眼包'
    ];
    return descs.slice(0, Math.max(1, Math.min(count, descs.length))).map((desc, i) => ({
      index: i + 1, dwellMs: 6000, durationSec: 12 + i, desc, changed: true
    }));
  },
  async like() { return { changed: false }; },
  async readComments() { return [{ author: '小明', text: '这个怎么做的' }]; },
  async reply() { return { verified: true }; },
  async publish() { return { published: false }; },
  async readMyStats() { return stats; }
});
// studio 打桩：不渲染，只拿到文案
const studio = { async fromText({ title, lines }) { return { file: 'x.mp4', cover: '', durationSec: 58, title, lines }; } };

const report = await runFullAuto(
  { backend, state: st, cfg, studio, root: projectRoot(), trace: () => {} },
  { rounds: 1, publish: false, contentMode: 'journal', lineCount: 16 }
);
const v = report.steps.find((s) => s.kind === 'video');
console.log(`\n主题：${v.topic}\n字幕 ${v.lines.length} 句：`);
v.lines.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}. ${l}`));
process.exit(0);
