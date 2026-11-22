import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({});
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
try {
  for (const url of ['https://cp.kuaishou.com/statistics/fans', 'https://cp.kuaishou.com/profile']) {
    const page = await web.ensure({ url });
    await page.waitForTimeout(3000);
    const info = await page.evaluate(() => {
      const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        url: location.href,
        totalFans: (t.match(/(?:粉丝总数|总粉丝|粉丝数|粉丝总量)[^0-9]{0,8}([\d.,]+[万w]?)/) || [])[1] || '',
        near: (t.match(/.{0,18}(粉丝|关注).{0,18}/g) || []).slice(0, 6),
        nums: (t.match(/\d[\d,.]*[万亿w]?/g) || []).slice(0, 25)
      };
    });
    console.log('===', url, JSON.stringify(info, null, 1).slice(0, 1200));
  }
} catch (e) { console.error('FAILED:', e.message); } finally { process.exit(0); }
