// 把用户上传但没接线的背景图写进设置（走 DSH 的 settings/update），再用它生成一条样片
import { discoverDshSessionCookie } from 'file:///C:/Users/wudiw/Documents/deepseek/qq-bridge/src/dsh-client.js';
import path from 'node:path';
import { VideoStudio } from '../src/video.mjs';
import { loadConfig } from '../src/config.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:51501';
const asset = path.resolve('state/assets/微信图片_20261007162334_56_36.jpg');

const cookie = discoverDshSessionCookie(BASE);
async function rpc(method, args) {
  const rpcId = `ks-${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok || body?.error) throw new Error(`${method} 失败 ${res.status} ${text.slice(0, 200)}`);
  return body?.result?.value ?? body?.result;
}

console.log('写入设置 videoBgImage =', asset);
const updated = await rpc('settings/update', { ns: 'kuaishou', patch: { videoBgImage: asset, videoBgBlur: 8, videoBgDim: 0.35 } });
console.log('settings/update ok, user =', JSON.stringify(updated?.user ?? {}).slice(0, 300));

// 用当前代码（会读到刚写入的 patch）生成一条样片
// 必须传 cfg，否则 VideoStudio 用空配置（我第一次就漏了，导致误判"设置没生效"）
const studio = new VideoStudio({ cfg: loadConfig({}), log: (l) => process.stderr.write(`${l}\n`) });
const cfgOut = await studio.fromText({
  title: '背景图生效测试',
  lines: ['这次用的是你自己上传的图', '在设置里选中它并保存', '以后每条视频都会带这张背景'],
  voiceText: '背景图生效测试。这次用的是你自己上传的图，在设置里选中它并保存，以后每条视频都会带这张背景。',
  out: path.resolve('demo/bgimage-proof.mp4')
});
console.log(JSON.stringify({
  file: cfgOut.file,
  durationSec: Number(cfgOut.durationSec.toFixed(2)),
  background: cfgOut.style.background
}, null, 2));
