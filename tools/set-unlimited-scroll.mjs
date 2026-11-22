// 把「每轮刷视频条数」在两层都设为 0（=不限）。
// 注意：profile 补丁是最高优先级，只改 state/settings.json 是没用的（这个坑踩过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
let y = fs.readFileSync(file, 'utf8');
const before = y;
y = y.replace(/^(\s*)scrollPerRun:\s*\S+.*$/m, '$1scrollPerRun: 0');
if (y !== before) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, y, 'utf8');
}
const settingsFile = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  s.scrollPerRun = 0;
  fs.writeFileSync(settingsFile, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch (e) {
  console.error('settings.json 改失败:', e.message);
}
const now = fs.readFileSync(file, 'utf8');
console.log('profile scrollPerRun ->', /^\s*scrollPerRun:\s*(\S+)/m.exec(now)?.[1]);
console.log('settings scrollPerRun ->', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).scrollPerRun);
