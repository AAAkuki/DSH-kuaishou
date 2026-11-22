// 探路 2：点创作者平台的「去直播」，看它到底把用户导到哪（网页开播？下载伴侣？扫码？）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright-core');
const profile = path.join(root, '.web-profile');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const out = path.join(root, 'state', 'live', 'probe');
fs.mkdirSync(out, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: edge, headless: false, viewport: { width: 1440, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://cp.kuaishou.com/profile', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);

const before = page.url();
const hit = page.getByText('去直播', { exact: false }).first();
let clicked = false;
if (await hit.count()) {
  await hit.click({ timeout: 5000 }).catch(() => {});
  clicked = true;
  await page.waitForTimeout(3500);
}
const after = page.url();
const pages = ctx.pages().map((p) => p.url());

// 顺便把「开播」相关按钮/链接都列出来
const cand = await page.evaluate(() => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const el of document.querySelectorAll('a,button,div[role="button"]')) {
    const t = norm(el.innerText);
    if (!t || t.length > 24) continue;
    if (!/直播|开播|伴侣|推流/.test(t)) continue;
    out.push({ tag: el.tagName, text: t, href: el.getAttribute('href') || '', cls: String(el.className).slice(0, 60) });
  }
  return out.slice(0, 20);
});

await page.screenshot({ path: path.join(out, 'after-click.png') });
console.log(JSON.stringify({ clicked, before, after, pages, cand }, null, 2));
await ctx.close();
