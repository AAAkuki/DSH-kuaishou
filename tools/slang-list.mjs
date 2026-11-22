// 看词库：node tools/slang-list.mjs [搜索词]
import { loadSlang, slangFile } from '../src/slang.mjs';
import { projectRoot } from '../src/config.mjs';

const q = String(process.argv[2] || '').trim();
const store = loadSlang(projectRoot());
const items = store.items
  .filter((x) => !q || x.term.includes(q))
  .sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)));

console.log(`词库：${slangFile(projectRoot())}（${store.items.length} 条${q ? `，匹配「${q}」${items.length} 条` : ''}）`);
for (const x of items.slice(0, 60)) {
  console.log(`  ${x.term.padEnd(10)} 出现 ${String(x.count).padStart(2)} 次  用过 ${x.used || 0} 次  最近 ${x.lastAt}`);
}
