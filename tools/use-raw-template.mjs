// 把模板指回"用户给的原图"（不再用我二次处理过的 @2x 版本）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = 'C:\\Users\\wudiw\\Documents\\deepseek\\kuaishou-ops\\state\\assets\\template-talking-box.jpg';
const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/^(\s*)videoBgImage:.*$/m, `$1videoBgImage: ${target}`);
if (after !== before) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, after, 'utf8');
}
const sf = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.videoBgImage = target;
  fs.writeFileSync(sf, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch {}
console.log(/^\s*videoBgImage:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[0]);
