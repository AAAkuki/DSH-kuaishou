// 真把设置页组件渲染一遍（假 React，但组件体真的执行）。
//
// 为什么要这个：client-bundle 那个测试只验证"能加载、能注册槽位"，
// 组件体里写错一个字（useRef 没导入、h() 少个参数）它照样绿 —— 而线上是整页白屏。
// 这里把 Panel() 真调一遍，然后在返回的树里找关键元素。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const file = path.resolve('plugins/dsh-plugin-kuaishou/client/client.js');
const code = fs.readFileSync(file, 'utf8');

function boot({ values, trace = [] }) {
  let captured = null;
  // 第 n 次 useState 依次拿到这些初值（顺序和 Panel 里的声明一致）
  const presets = [values, '', '', null, false, { speak: true, common: true, media: false, advanced: false }, '', [], false, '', trace, '', trace.length > 0, 0, false];
  let i = 0;
  const fakeReact = {
    createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const v = i < presets.length ? presets[i] : init;
      i += 1;
      return [v, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v })
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    console,
    fetch: async () => ({ ok: false, status: 500, text: async () => '{}', json: async () => ({ ok: false }) }),
    setTimeout, setInterval, clearInterval
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const mod = captured.factory((n) => {
    if (n === 'react') return fakeReact;
    throw new Error(`unexpected require: ${n}`);
  });
  const slots = [];
  mod.apply({
    slots: { inject: (n, cb) => cb(), register: (opts, render) => { slots.push({ opts, render }); return () => {}; } }
  });
  // 槽位 render() 返回的是一个 vnode，真正的组件在 .type 上
  const root = slots[0].render();
  return { Panel: typeof root === 'function' ? root : root.type, trace };
}

/** 把元素树拍平成文本节点列表 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out; }
  if (node.children !== undefined) texts(node.children, out);
  if (node.props) {
    if (typeof node.props.children !== 'undefined') texts(node.props.children, out);
    for (const [k, v] of Object.entries(node.props)) {
      if (k === 'children') continue;
      if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    }
  }
  return out;
}

/** 找所有按钮的文本 */
function buttons(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const arr = Array.isArray(node) ? node : [node];
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'button') out.push(texts(n).join(''));
    if (n.children !== undefined) buttons(n.children, out);
    if (n.props?.children !== undefined) buttons(n.props.children, out);
  }
  return out;
}

const values = {
  enabled: true, assetsPort: 32801, autoRounds: 2, autoContentMode: 'auto',
  speakCallUser: '主人', speakCallSelf: '我', speakTone: 'gentle', speakMaxChars: 40
};

test('设置页能渲染出「我来刷」和「停止」两个按钮', () => {
  const { Panel } = boot({ values });
  const el = Panel();
  assert.ok(el, 'Panel 必须有返回');
  const textsAll = texts(el).join('|');
  const btns = buttons(el);
  assert.ok(btns.some((b) => b.includes('🧠')), `没有"我来刷"按钮：${btns.join(', ')}`);
  assert.ok(btns.some((b) => b.includes('⏹')), `没有停止按钮：${btns.join(', ')}`);
  assert.ok(btns.some((b) => b.includes('停止')), '停止按钮文案');
  // agent 模式替代了原来的一键全自动（脚本还在，但按钮不再是它）
  assert.match(textsAll, /我来刷/);
  assert.ok(!btns.some((b) => b.includes('🚀')), `不该再有一键全自动的 🚀 开始按钮：${btns.join(', ')}`);
  assert.match(textsAll, /一条条看|像聊天一样回评论/);
  assert.match(textsAll, /跑完接着刷/, '循环勾选框要在');
});

test('有思维链时渲染出每一步（图标 + 消息），并且标题带步数', () => {
  const trace = [
    { at: new Date().toISOString(), seq: 1, phase: 'start', message: '开始全自动' },
    { at: new Date().toISOString(), seq: 2, phase: 'think', message: '先刷 10 条看看' },
    { at: new Date().toISOString(), seq: 3, phase: 'reply', ok: false, message: '回评论全部失败：X' }
  ];
  const { Panel } = boot({ values, trace });
  const el = Panel();
  const all = texts(el).join('|');
  assert.match(all, /思维链（3 步）/);
  assert.match(all, /开始全自动/);
  assert.match(all, /先刷 10 条看看/);
  assert.match(all, /回评论全部失败/);
  assert.match(all, /💭/, 'think 要有 💭');
  assert.match(all, /⚠️/, '失败的步骤要有 ⚠️');
  assert.match(all, /已结束|运行中/, '要有状态指示');
});

test('开关关掉时按钮禁用（不给点）', () => {
  const { Panel } = boot({ values: { ...values, enabled: false } });
  const el = Panel();
  let runBtn = null;
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    const arr = Array.isArray(n) ? n : [n];
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      if (x.type === 'button' && texts(x).join('').includes('🧠')) runBtn = x;
      if (x.children !== undefined) walk(x.children);
      if (x.props?.children !== undefined) walk(x.props.children);
    }
  })(el);
  assert.ok(runBtn, '找不到开始按钮');
  assert.equal(runBtn.props.disabled, true);
});
