// 只读验证：自己作品下的评论 + 嵌套回复（不发任何东西）
import { KuaishouWeb } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({});
console.log('web.persist =', cfg.web.persist, '| replyPerRun =', cfg.quotas.replyPerRun, '(0=不限)');
const web = new KuaishouWeb({ cfg, log: (l) => console.error(l) });
const t0 = Date.now();
try {
  const list = await web.listOwnComments({ limit: 20 });
  console.log(`读到 ${list.length} 条（耗时 ${Math.round((Date.now() - t0) / 1000)}s）：`);
  for (const c of list) {
    console.log(`  - [${c.when}] ${c.author}：${c.text}（赞 ${c.likes}，回复 ${c.replies.length} 条）`);
    for (const r of c.replies) console.log(`       ↳ ${r.author} 回 ${r.to}「${r.text}」`);
  }
  const hit = list.some((c) => c.replies.some((r) => r.text.includes('脚本刷的')));
  console.log(hit ? '✅ 能读到我们刚发的那条回复（嵌套解析已修好）' : '❌ 还是读不到回复');
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  const alive = await web.ensureAlive().catch(() => false);
  console.log('浏览器还活着？', alive, '（常驻）');
  process.exit(0);
}
