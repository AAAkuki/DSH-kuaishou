// 探路：快手网页端能不能开播、开播页里能不能拿到 rtmp 推流地址 + 串流密钥。
// 只读：打开页面、截图、把可见文本和链接打出来，不点任何"开播"按钮。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');

const profile = path.join(root, '.web-profile');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const outDir = path.join(root, 'state', 'live', 'probe');
fs.mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: edge,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = ctx.pages()[0] || (await ctx.newPage());

const targets = [
  ['cp-live', 'https://cp.kuaishou.com/producer/live/home'],
  ['cp-home', 'https://cp.kuaishou.com/'],
  ['live-center', 'https://live.kuaishou.com/live-center'],
  ['live-index', 'https://live.kuaishou.com/']
];

const report = [];
for (const [name, url] of targets) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const info = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const text = norm(document.body.innerText).slice(0, 1500);
      const links = [...document.querySelectorAll('a[href]')]
        .map((a) => ({ t: norm(a.innerText).slice(0, 24), h: a.href }))
        .filter((x) => x.t)
        .slice(0, 40);
      const rtmp = [];
      const html = document.documentElement.outerHTML;
      const re = /rtmp:\/\/[^\s"'<>]+/g;
      let m;
      while ((m = re.exec(html))) rtmp.push(m[0]);
      return { url: location.href, title: document.title, text, links, rtmp: [...new Set(rtmp)].slice(0, 10) };
    });
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
    report.push({ name, ...info });
    console.log(`\n=== ${name} -> ${info.url}\n${info.title}\n${info.text.slice(0, 700)}`);
    if (info.rtmp.length) console.log('RTMP:', info.rtmp);
  } catch (error) {
    console.log(`\n=== ${name} FAILED: ${String(error.message).slice(0, 160)}`);
    report.push({ name, error: String(error.message).slice(0, 200) });
  }
}
fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 2), 'utf8');
await ctx.close();
console.log('\nsaved ->', path.join(outDir, 'probe.json'));
