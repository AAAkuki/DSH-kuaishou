// 网页后端"老 bug"体检：把容易残留的状态问题做成可重复检测
// 检查项：
//   1) .web-profile 残留锁文件
//   2) 登录标记
//   3) 今日配额计数
//   4) 中间文件堆积
//   5) 发布成功判定是否严格（历史 bug：published 写死 true）
//   6) 发布按钮点击是否会自动滚动（编辑页是内部滚动容器）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const ROOT = process.cwd();
const cfg = loadConfig({});
const profile = path.resolve(ROOT, cfg.web?.profileDir ?? '.web-profile');
const findings = [];
const add = (id, ok, detail, fix) => findings.push({ id, ok, detail, fix });

const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
  .filter((f) => fs.existsSync(path.join(profile, f)));
add('profileLocks', locks.length === 0, locks.length ? `残留锁：${locks.join(', ')}` : '无残留锁', 'clearProfileLocks() 会自动清');

const loginMark = path.join(ROOT, 'state', 'web-login.json');
add('loginState', fs.existsSync(loginMark), fs.existsSync(loginMark) ? '有登录标记' : '没有登录标记（可能没登录过）', '设置页扫码一次');

let counts = null;
try {
  counts = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'ops-state.json'), 'utf8')).counts;
} catch {}
add('quotaPresent', Boolean(counts),
  counts ? `今日 刷${counts.scroll} 回${counts.reply} 赞${counts.like} 发${counts.publish}` : '没有 ops-state.json',
  '跑一次任意工具会创建');

const videoDir = path.join(ROOT, 'state', 'video');
let junk = 0;
if (fs.existsSync(videoDir)) {
  junk = fs.readdirSync(videoDir).filter((f) => /^(norm|base|join|preview|tpl)-/.test(f) || /\.tmp$/.test(f)).length;
}
add('tempFiles', junk === 0, junk ? `中间文件残留 ${junk} 个` : '无中间文件残留', 'pruneWorkDir / flushTemps');

const publishSrc = fs.readFileSync(path.join(ROOT, 'src', 'publish.mjs'), 'utf8');
add('noFakeSuccess', !/published:\s*true,\s*\n\s*confirmed,/.test(publishSrc), '发布成功必须 confirmed 才返回 true', '');
add('autoScrollClick', publishSrc.includes('scrollIntoView'), '发布按钮点击前会 scrollIntoView', '');
add('worksCountVerify', publishSrc.includes('readWorksSummary'), '用作品数 +1 验证真的发出去了', '');

const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'web.mjs'), 'utf8');
add('lockRecovery', webSrc.includes('clearProfileLocks'), '启动失败会清 profile 锁', '');
add('tidyTabs', webSrc.includes('tidyTabs'), '会清理 about:blank 残留标签', '');

console.log('=== 网页后端体检 ===');
for (const f of findings) console.log(`${f.ok ? '✅' : '❌'} ${f.id.padEnd(16)} ${f.detail}${f.fix && !f.ok ? '  → ' + f.fix : ''}`);
const bad = findings.filter((f) => !f.ok);
console.log(bad.length ? `\n发现 ${bad.length} 个问题` : '\n全部通过');
process.exit(bad.length ? 1 : 0);
