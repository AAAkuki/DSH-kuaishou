// 把正式生效层（profile 补丁）的人设切成「鲸鱼女孩 CETACEA_LOLI」
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/^(\s*)personaId:.*$/m, '$1personaId: persona-cetacea');
if (after === before) {
  console.log('（personaId 行没变：可能已经不是旧值）');
} else {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, after, 'utf8');
}
const sf = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.personaId = 'persona-cetacea';
  fs.writeFileSync(sf, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch {}
console.log('personaId ->', /^\s*personaId:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1]);
