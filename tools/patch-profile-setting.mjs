// 改 DSH profile 补丁里 kuaishou 的几项（这是**优先级最高**的一层：
// state/settings.json 会被它覆盖，所以只改 settings.json 会出现"改了不生效"）。
// 先备份，再逐行替换，不重排 YAML。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const want = {
  videoBgBlur: 14,      // 背景柔焦强度（用户要求"背景模糊"）
  cute_stutter: false,  // 口吃：听着像卡带
  cute_breath: false,   // 喘气：粉噪听着像杂音
  cute_pause: true
};

if (!fs.existsSync(file)) {
  console.error('找不到 profile 补丁：', file);
  process.exit(1);
}

const before = fs.readFileSync(file, 'utf8');
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(file, backup);

let text = before;
const changed = [];
for (const [key, val] of Object.entries(want)) {
  const re = new RegExp(`^(\\s*)${key}:(.*)$`, 'm');
  if (!re.test(text)) { console.error(`补丁里没有 ${key}，跳过`); continue; }
  text = text.replace(re, `$1${key}: ${val}`);
  changed.push(`${key}=${val}`);
}

if (text === before) {
  console.log('没有任何改动（值本来就对）');
} else {
  fs.writeFileSync(file, text, 'utf8');
  console.log('已改：', changed.join(', '));
  console.log('备份：', backup);
}

// 回读确认
for (const key of Object.keys(want)) {
  const m = new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm').exec(fs.readFileSync(file, 'utf8'));
  console.log(`  ${key} -> ${m ? m[1] : '(缺失)'}`);
}
