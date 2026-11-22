import fs from 'node:fs';
const s = fs.readFileSync('state/live/jump-jump.html', 'utf8');

function show(label, re) {
  const seen = new Set();
  let m;
  console.log(`--- ${label} ---`);
  while ((m = re.exec(s))) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    const line = s.slice(0, m.index).split('\n').length;
    console.log(line, JSON.stringify(m[0]));
  }
}
show('class btn', /class="btn[^"]*"/g);
show('querySelector .btn', /querySelector\([^)]*btn[^)]*\)/g);
show('id btn', /id="btn[^"]*"/g);
show('overlay html', /<div[^>]*class="overlay[^>]*>/g);

const i = s.indexOf('overlay');
const j = s.indexOf('class="overlay');
console.log('--- 第一处 overlay HTML ---');
console.log(s.slice(Math.max(0, j - 80), j + 760));
const k = s.indexOf('id="card');
if (k > 0) console.log('--- card ---\n', s.slice(k - 60, k + 500));
