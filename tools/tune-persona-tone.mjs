// 人设配套：语气 lively（傲娇又甜），口头禅补上（原来空着）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
let t = fs.readFileSync(file, 'utf8');
const before = t;
t = t.replace(/^(\s*)speakTone:.*$/m, '$1speakTone: lively');
t = t.replace(/^(\s*)speakCatchphrases:.*$/m, '$1speakCatchphrases: 啧,诶嘿,懒得动,圆滚滚地滚过来了');
if (t !== before) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, t, 'utf8');
}
const sf = path.resolve('state/settings.json');
try {
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s.speakTone = 'lively';
  s.speakCatchphrases = '啧,诶嘿,懒得动,圆滚滚地滚过来了';
  fs.writeFileSync(sf, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
} catch {}
const now = fs.readFileSync(file, 'utf8');
console.log('tone ->', /^\s*speakTone:\s*(\S+)/m.exec(now)?.[1]);
console.log('口头禅 ->', /^\s*speakCatchphrases:\s*(.*)$/m.exec(now)?.[1]);
