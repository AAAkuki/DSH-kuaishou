// 演练：定位回复框、填字、然后取消（不真的发出去）—— 验证"回自己作品评论"的交互链路
import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({});
cfg.dryRun = true;                 // 关键：演练模式
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
try {
  const comments = await web.listOwnComments({ limit: 5 });
  if (!comments.length) { console.log('没有可回的评论'); process.exit(0); }
  const target = comments[0];
  console.log('目标评论:', `[${target.when}] ${target.author}：${target.text}`);
  const r = await web.replyOwnComment({ match: target.text.slice(0, 10), content: '测试一下，这条不会发出去' });
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  process.exit(0);
}
