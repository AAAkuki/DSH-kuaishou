// 删掉那条说"真人剪的"的回复（公开内容，必须纠正），并换成不走脑子的诚实版本。
// 步骤都打印出来，出错就停在那一步，不会乱点。
import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const WRONG = '真人剪的';
const HONEST = 'AI做的：素材是脚本刷的，口播也是AI合成的';
const DRY = process.argv.includes('--dry');

const cfg = loadConfig({});
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
const log = (...a) => console.log(...a);

try {
  const page = await web.ensureCommentManager();
  await page.waitForTimeout(1500);

  // 1) 展开回复（默认是折叠的，折叠时 innerText 里没有回复内容）
  const expand = page.locator('text=展开回复').first();
  if (await expand.count().catch(() => 0)) {
    await expand.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    log('已展开回复');
  }

  const rowText = await page.evaluate(() => [...document.querySelectorAll('.comment-item')].map((el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()));
  log('当前行文本:', rowText.map((t) => t.slice(0, 200)));

  if (!rowText.some((t) => t.includes(WRONG))) {
    log('⚠️ 页面上找不到那条「真人剪的」回复（可能已折叠/已删）');
    process.exit(0);
  }

  // 2) 找到那条回复所在的块（含"回复 鱿鱼的江苏入"和 WRONG 文本的最小容器）
  const replyBlock = page.locator('.comment-item').filter({ hasText: WRONG }).locator('..').locator('..').first();
  log('定位到回复块:', (await replyBlock.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));

  // 3) 该块里的「删除」
  const del = replyBlock.locator('text=删除').first();
  if (!(await del.count().catch(() => 0))) {
    log('⚠️ 回复块里没有删除按钮，放弃（不动任何东西）');
    process.exit(0);
  }
  if (DRY) {
    log('（dry）会点这个删除按钮；不做任何修改');
    process.exit(0);
  }

  page.on('dialog', async (d) => { log('确认框:', d.message()); await d.accept().catch(() => {}); });
  await del.click({ timeout: 5000 });
  await page.waitForTimeout(1500);

  // 「删除」有时先弹一个二次确认按钮
  const confirm = page.locator('text=确定, text=确认').first();
  if (await confirm.count().catch(() => 0)) {
    await confirm.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const gone = !after.includes(WRONG);
  log(gone ? '✅ 那条回复已经不在了' : '❌ 还在（可能需要手动删）');

  // 4) 发一条诚实的
  if (gone) {
    const r = await web.replyOwnComment({ match: '这个视频到底是真人做的还是由AI做的', content: HONEST });
    log('新回复:', JSON.stringify({ sent: r.sent, verified: r.verified, note: r.note }));
  }
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  process.exit(0);
}
