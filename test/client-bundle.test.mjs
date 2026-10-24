// 离线验证 client bundle：模拟 DSH 的 __ModuleLoader__，确认能加载、导出 apply/inject，
// 且渲染函数在注入假 React 后不炸（不连真浏览器）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const file = path.resolve('plugins/dsh-plugin-kuaishou/client/client.js');
const code = fs.readFileSync(file, 'utf8');

let captured = null;
const fakeReact = {
  createElement: (type, props, children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn
};
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
  console,
  fetch: async () => ({ ok: true, text: async () => '{}' }),
  setTimeout,
  Math
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

if (!captured) throw new Error('__ModuleLoader__.load 没被调用');
if (captured.id !== 'dsh-plugin-kuaishou') throw new Error(`id 不对：${captured.id}`);

const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require: ${name}`);
});

const report = {
  exports: Object.keys(mod).sort(),
  name: mod.name,
  inject: mod.inject,
  hasApply: typeof mod.apply === 'function'
};
console.log(JSON.stringify(report, null, 2));

const registered = [];
// 真实 api 形状：slots.inject(name, cb) 先等槽位被宿主声明，再在回调里 register
const ctx = {
  slots: {
    inject: (name, cb) => { registered.length; cb(); },
    register: (opts, render) => { registered.push({ opts, render }); return () => {}; }
  }
};
mod.apply(ctx);
console.log('注册的槽位:', JSON.stringify(registered.map((r) => r.opts)));

const el = registered[0].render();
console.log('渲染返回节点类型:', el?.type, '| children:', el?.children?.length);
console.log('✅ client bundle 可用');
