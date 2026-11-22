// 把「回复不限额度」写进 profile 补丁（优先级最高那层）+ settings.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const want = { replyPerRun: 0 };   // 0 = 不限
const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const before = fs.readFileSync(file, 'utf8');
let after = before;
const changed = [];
for (const [k, v] of Object.entries(want)) {
  const re = new RegExp(`^(\\s*)${k}:.*$`, 'm');
  if (!re.test(after)) { console.log('补丁里没有', k); continue; }
  after = after.replace(re, `$1${k}: ${v}`);
  changed.push(`${k}=${v}`);
}
if (after !== before) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, after, 'utf8');
}
const sf = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.replyPerRun = 0;
  fs.writeFileSync(sf, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch {}
console.log('改了:', changed.join(', ') || '(无)');
console.log('回读:', /^\s*replyPerRun:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1], '| publishPerDay:', /^\s*publishPerDay:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1]);
