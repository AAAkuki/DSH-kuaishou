// 往直播画面窗口的弹幕队列里塞一条（窗口脚本会读走并回一句）
//   node tools/push-danmaku.mjs "昵称" "说的话"
// 或者读直播间真弹幕：ks_live_danmaku 拿到 items 后，把每条写进来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'state', 'live', 'danmaku.jsonl');

const [who = '观众', text = ''] = process.argv.slice(2);
if (!text) {
  console.error('用法: node tools/push-danmaku.mjs "昵称" "说的话"');
  process.exit(2);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.appendFileSync(file, JSON.stringify({ who, text, at: Date.now() }) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, who, text, file }));
