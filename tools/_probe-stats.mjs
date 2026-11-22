// 只读探针：创作者后台首页/数据中心能不能读到 粉丝数 / 播放量 / 点赞 / 评论
import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({});
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

try {
  for (const url of ['https://cp.kuaishou.com/profile', 'https://cp.kuaishou.com/statistics/works']) {
    const page = await web.ensure({ url });
    await page.waitForTimeout(3500);
    const info = await page.evaluate(() => {
      const t = String(document.body.innerText || '').replace(/\s+/g, ' ');
      const grab = (re) => { const m = re.exec(t); return m ? m[1] : ''; };
      return {
        url: location.href,
        fans: grab(/粉丝[^0-9]{0,6}([\d.,]+[万w]?)/),
        fansNear: (t.match(/.{0,10}粉丝.{0,14}/g) || []).slice(0, 4),
        playsNear: (t.match(/.{0,6}播放.{0,16}/g) || []).slice(0, 4),
        likesNear: (t.match(/.{0,6}(点赞|获赞).{0,16}/g) || []).slice(0, 3),
        head: t.slice(0, 400)
      };
    });
    console.log('===', url);
    console.log(JSON.stringify(info, null, 1).slice(0, 1800));
  }
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  process.exit(0);
}
