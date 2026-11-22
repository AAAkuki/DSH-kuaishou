// 给 hypit 3 秒测试生成一张 1080x1920 的静帧（复用 vibe-render 的画卡逻辑）
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const py = 'C:/Users/wudiw/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
const spec = {
  width: 1080, height: 1920, style: 'poster',
  outDir: 'C:/Users/wudiw/Documents/deepseek/hypit-demo/assets',
  font: 'C:/Windows/Fonts/msyhbd.ttc',
  scenes: [{
    index: 1, seconds: 3,
    big: 'Hypit 3s',
    lines: ['本地渲染链路测试'],
    source: 'hypit 0.3.1 · local runtime'
  }]
};
const specPath = path.resolve('state/hypit-plate.json');
const fs = await import('node:fs');
fs.mkdirSync('C:/Users/wudiw/Documents/deepseek/hypit-demo/assets', { recursive: true });
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
const r = spawnSync(py, ['C:/Users/wudiw/Documents/deepseek/kuaishou-ops/tools/vibe-render.py', specPath], { encoding: 'utf8' });
console.log(r.stdout?.trim(), r.stderr?.slice(0, 300));
const src = 'C:/Users/wudiw/Documents/deepseek/hypit-demo/assets/s01.png';
const dst = 'C:/Users/wudiw/Documents/deepseek/hypit-demo/assets/plate.png';
fs.copyFileSync(src, dst);
console.log('plate:', dst, fs.statSync(dst).size, 'bytes');
