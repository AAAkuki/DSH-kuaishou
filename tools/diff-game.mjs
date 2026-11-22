// 对比新旧两版游戏：结构、常量、状态机、音频，看新版改了什么
import fs from 'node:fs';

const oldPath = 'C:/Users/wudiw/Documents/deepseek/kuaishou-ops/state/live/jump-jump.html';
const newPath = 'C:/Users/wudiw/Documents/xwechat_files/wxid_ncglrg3ehxhf22_57fa/msg/file/2026-11/jump-jump(2).html';

const oldRaw = fs.readFileSync(oldPath, 'utf8');
const newRaw = fs.readFileSync(newPath, 'utf8');
// 旧版是注入过 bridge 的，对比时先剥掉
const bridgeStart = oldRaw.indexOf('/* ---- 直播驱动 bridge');
const bridgeEnd = bridgeStart >= 0 ? oldRaw.indexOf('};', oldRaw.indexOf('sound: function', bridgeStart)) : -1;
const oldClean = bridgeStart >= 0 && bridgeEnd > 0
  ? oldRaw.slice(0, bridgeStart) + oldRaw.slice(oldRaw.indexOf('\n', bridgeEnd))
  : oldRaw;

console.log('旧版(去注入) %d 字节 / 新版 %d 字节 / 差 %+d', oldClean.length, newRaw.length, newRaw.length - oldClean.length);

function probe(label, text) {
  const pick = (re) => {
    const m = re.exec(text);
    return m ? m[0].replace(/\s+/g, ' ') : '(没有)';
  };
  console.log(`\n===== ${label} =====`);
  console.log('常量  ', pick(/var MIN_JUMP[\s\S]{0,120}/));
  console.log('等距  ', pick(/var ISO_X[^\n]*/));
  console.log('状态机', [...new Set((text.match(/state = '[a-z]+'/g) || []))].join(' '));
  console.log('音频  ', pick(/function ensureAudio[\s\S]{0,60}/));
  console.log('音效点', [...new Set((text.match(/var s(Jump|Land|Perfect|Fail)\s*=\s*function[^\n]*/g) || []))].join('\n        '));
  console.log('按钮  ', [...new Set((text.match(/<button[^>]*id="[a-z]+"[^>]*>[^<]*/g) || []))].join(' | '));
  console.log('overlay', [...new Set((text.match(/<div class="overlay[^"]*" id="[a-zA-Z]+"/g) || []))].join(' '));
  console.log('桥口  ', /window\.__jj/.test(text) ? '有' : '没有');
  const feats = ['连击', '完美', '金币', '道具', '皮肤', '排行', 'BGM', '背景音乐', '角色', '成就', '音效'];
  console.log('特性  ', feats.filter((f) => text.includes(f)).join(' '));
  console.log('body长度', text.length);
}

probe('旧版', oldClean);
probe('新版', newRaw);

// 逐行 diff 概览：只列新版里新增的"函数定义"和"CSS 类"
const fn = (t) => new Set((t.match(/function [A-Za-z_$][\w$]*\s*\(/g) || []).map((x) => x.trim()));
const of = fn(oldClean), nf = fn(newRaw);
const addedFn = [...nf].filter((x) => !of.has(x));
const removedFn = [...of].filter((x) => !nf.has(x));
console.log('\n新增函数:', addedFn.join(' '));
console.log('删除函数:', removedFn.join(' '));
