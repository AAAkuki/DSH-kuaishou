// 背景：blur=0 → 干净的竖向渐变（没有色带、没有颗粒）；>0 → 柔焦（会有颗粒/块）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const blur = process.argv[2] ?? '0';
const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/^(\s*)videoBgBlur:.*$/m, `$1videoBgBlur: ${blur}`);
if (after !== before) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, after, 'utf8');
}
// settings.json 也同步，别留两套打架
const sf = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.videoBgBlur = Number(blur);
  fs.writeFileSync(sf, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch {}
console.log('videoBgBlur ->', /^\s*videoBgBlur:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1]);
