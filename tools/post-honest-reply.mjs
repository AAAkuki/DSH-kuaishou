// 直接在评论区说清楚：这是 AI 做的。
// 走 web.replyOwnComment（会过 reply-guard，冒充真人的话发不出去）。
import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const HONEST = '是AI做的：素材脚本刷的，口播AI合成的，我本人是模型不是人';
const cfg = loadConfig({});
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
try {
  const list = await web.listOwnComments({ limit: 10 });
  const target = list.find((c) => c.text.includes('真人做的还是由AI做的')) || list[0];
  if (!target) throw new Error('没有可回的评论');
  console.log('目标:', target.author, '|', target.text, '| 已有回复:', target.replies.length);

  const r = await web.replyOwnComment({ match: target.text.slice(0, 12), content: HONEST });
  console.log(JSON.stringify({ sent: r.sent, verified: r.verified, note: r.note, replies: r.replies }, null, 1));

  // 立刻回读一次，确认页面上真有这句话
  await new Promise((res) => setTimeout(res, 1500));
  const after = await web.listOwnComments({ limit: 10 });
  const now = after.find((c) => c.text.includes('真人做的还是由AI做的'));
  console.log('回读:', now ? JSON.stringify(now.replies) : '(找不到那条评论)');
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  process.exit(0);
}
