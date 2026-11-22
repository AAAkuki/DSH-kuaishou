// 把新版游戏（v2：跳一跳 + 敌人/道具）复制成"可被外部驱动"的版本。
// 只注入只读/操作口，不改任何游戏逻辑。
//
// 用法：node tools/instrument-jump.mjs [源文件]
//   默认读 state/live/jump-jump-src.html，没有就退回原微信路径
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'state', 'live');
fs.mkdirSync(outDir, { recursive: true });

const candidates = [
  process.argv[2],
  path.join(outDir, 'jump-jump-src.html'),
  'C:/Users/wudiw/Documents/xwechat_files/wxid_ncglrg3ehxhf22_57fa/msg/file/2026-11/jump-jump(2).html'
].filter(Boolean);
const src = candidates.find((p) => fs.existsSync(p));
if (!src) { console.error('找不到游戏源文件'); process.exit(1); }

let html = fs.readFileSync(src, 'utf8');
if (html.includes('window.__jj')) {
  // 已经是注入过的（可能又拿旧文件覆盖了），先剥掉旧 bridge 再注
  const a = html.indexOf('/* ---- 直播驱动 bridge');
  const b = html.indexOf('window.__jj = {', a);
  const end = html.indexOf('\n};', b);
  if (a >= 0 && end > 0) html = html.slice(0, a) + html.slice(end + 3);
}

const bridge = `
/* ---- 直播驱动 bridge（外部只读局面 + 模拟操作 + 音频唤醒）---- */
window.__jj = (function(){
  function safe(fn, dflt){ try { return fn(); } catch (e) { return dflt; } }
  return {
    read: function(){
      return {
        state: state, score: score, combo: combo, power: power,
        cur: { x: cur.x, y: cur.y, half: cur.half, topZ: cur.topZ },
        nxt: nxt ? { x: nxt.x, y: nxt.y, half: nxt.half, topZ: nxt.topZ } : null,
        need: nxt ? Math.hypot(nxt.x - cur.x, nxt.y - cur.y) : 0,
        // v2 新增：敌人/道具/瞄准
        enemy: (typeof enemy !== 'undefined' && enemy) ? { x: enemy.x, y: enemy.y, z: enemy.z } : null,
        ammo: (typeof ammo !== 'undefined') ? Object.assign({}, ammo) : null,
        items: (typeof ITEM_ORDER !== 'undefined') ? ITEM_ORDER.slice() : []
      };
    },
    press: function(){ startCharge(); },
    release: function(){ release(); },
    // 用道具打敌人（v2）：选道具 → 瞄准敌人 → 投掷
    selectItem: function(type){
      if (typeof selectItem !== 'function') return false;
      safe(function(){ selectItem(type); }, false);
      return true;
    },
    aimAtEnemy: function(){
      if (typeof aim === 'undefined' || !aim || typeof enemy === 'undefined' || !enemy) return false;
      var p = playerPos();
      aim.active = true;
      aim.armed = true;
      aim.sx = SX(p.x, p.y); aim.sy = SY(p.x, p.y, p.z);
      aim.wx = enemy.x; aim.wy = enemy.y; aim.wz = enemy.z;
      if (typeof computeAimLock === 'function') computeAimLock();
      return true;
    },
    throwNow: function(){ if (typeof throwItem !== 'function') return false; safe(throwItem, null); return true; },
    // 直播时没人点页面，WebAudio 会一直 suspended —— 跳跃/落地音效就全哑
    audio: function(){
      ensureAudio();
      if (actx && actx.state === 'suspended') actx.resume();
      return actx ? actx.state : 'none';
    },
    sound: function(on){ soundOn = !!on; if (soundOn) ensureAudio(); return soundOn; },
    // 开局/重开统一入口
    start: function(){
      var el = document.getElementById('startBtn') || document.getElementById('againBtn') || document.querySelector('.btn');
      if (el) { el.click(); return true; }
      return false;
    }
  };
})();
`;

const marker = 'var power = 0, chargeStart = 0;';
const at = html.indexOf(marker);
if (at < 0) { console.error('找不到注入点 var power = 0'); process.exit(1); }
html = html.slice(0, at + marker.length) + '\n' + bridge + html.slice(at + marker.length);

fs.writeFileSync(path.join(outDir, 'jump-jump.html'), html, 'utf8');
console.log(`instrumented ${path.basename(src)} -> state/live/jump-jump.html (${html.length} bytes)`);
