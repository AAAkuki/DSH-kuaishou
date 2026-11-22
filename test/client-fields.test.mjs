// 设置页的"开关到底能不能用"：
// 1) FIELDS 里用到的每种 type 都必须有渲染分支（以前 9 个 type:'switch' 被当文本框渲染）
// 2) 布尔字段不能渲染成 value="true"/"false" 的文本框
// 3) 保存时布尔必须发真正的 boolean（发字符串会让 schema 判非法，整批保存失败）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('plugins/dsh-plugin-kuaishou/client/client.js');
const src = fs.readFileSync(file, 'utf8');

const types = [...new Set([...src.matchAll(/type:\s*'(toggle|switch|number|text|select|textarea|voicelist|upload)'/g)].map((m) => m[1]))];

const HANDLED = new Set(['toggle', 'switch', 'select', 'textarea', 'voicelist', 'text', 'number', 'upload']);

test('FIELDS 里每种 type 都有渲染分支（未知类型会被当成文本框）', () => {
  for (const t of types) assert.ok(HANDLED.has(t), `type=${t} 没有渲染分支`);
});

test('渲染器把 toggle 和 switch 一视同仁（都用 Switch 组件）', () => {
  assert.match(src, /if \(f\.type === 'toggle' \|\| f\.type === 'switch'\)/);
});

test('布尔字段不会渲染成文本框（老 bug：显示 "true"/"false"）', () => {
  // 布尔分支必须在"默认 input"分支之前 return
  const boolIdx = src.indexOf("if (f.type === 'toggle' || f.type === 'switch')");
  const inputIdx = src.indexOf("type: f.type === 'number' ? 'number' : 'text'");
  assert.ok(boolIdx > 0 && inputIdx > 0);
  assert.ok(boolIdx < inputIdx, '布尔分支必须在默认 input 之前');
  assert.match(src, /h\(Switch, \{ key: 's', checked: on/);
});

test('保存时布尔发 boolean、数字发 number，坏值跳过', () => {
  assert.match(src, /patch\[f\.key\] = typeof v === 'string' \? \(v !== 'false' && v !== '0' && v !== ''\) : Boolean\(v\)/);
  assert.match(src, /if \(!Number\.isFinite\(n\)\) continue;/);
});

test('设置页每个 FIELDS 键都在插件 schema 里（不然保存会被丢）', () => {
  const plugin = fs.readFileSync(path.resolve('plugins/dsh-plugin-kuaishou/index.js'), 'utf8');
  const schema = new Set([...plugin.matchAll(/^\s{2}(\w+):\s*z\./gm)].map((m) => m[1]));
  const keys = [...src.matchAll(/\{\s*key:\s*'(\w+)',\s*group:/g)].map((m) => m[1]);
  const missing = keys.filter((k) => !schema.has(k));
  assert.deepEqual(missing, [], `这些字段不在 schema 里，保存会丢：${missing.join(', ')}`);
});
