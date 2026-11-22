// 把「评论要积极」落到配置里：
//   · 关键词白名单清空 → 只要不是黑名单（加微信/互粉/引流…）都算可回
//   · 每轮回评上限从"不限"改成明确批量（不限也行，但这里保持 0=不限）
// 保守起见只动白名单，其它不动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profileFile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
let y = fs.readFileSync(profileFile, 'utf8');
const before = y;
// 白名单值可能是 "?，？，怎么…" 这种逗号串，也可能写成 []；统一成空串
y = y.replace(/^(\s*)replyWhitelist:.*$/m, '$1replyWhitelist: ""');
if (y !== before) {
  fs.copyFileSync(profileFile, `${profileFile}.bak-${Date.now()}`);
  fs.writeFileSync(profileFile, y, 'utf8');
}

const settingsFile = path.resolve('state/settings.json');
const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
s.replyWhitelist = '';
fs.writeFileSync(settingsFile, `${JSON.stringify(s, null, 2)}\n`, 'utf8');

const now = fs.readFileSync(profileFile, 'utf8');
console.log('profile replyWhitelist ->', /^\s*replyWhitelist:\s*(.*)$/m.exec(now)?.[1] ?? '(没有这一行)');
console.log('settings replyWhitelist ->', JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).replyWhitelist));
