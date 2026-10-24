import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePrompt, extractVars, renderTemplate, PromptLibrary } from '../src/prompts.mjs';

function tmpLib() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-prompts-'));
  const builtin = path.join(root, 'prompts');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'reply.md'), '# 回评论\n\n视频：{{videoTitle}}\n最多 {{maxReplies}} 条\n', 'utf8');
  fs.writeFileSync(path.join(builtin, 'script.md'), '# 脚本\n\n主题 {{topic}}\n', 'utf8');
  return { root, lib: new PromptLibrary({ cfg: { prompts: { dir: 'prompts', customDir: 'state/prompts' } }, root }) };
}

test('parsePrompt: 取标题与正文', () => {
  const p = parsePrompt('\uFEFF# 标题甲\n\n正文第一行\n正文第二行');
  assert.equal(p.title, '标题甲');
  assert.equal(p.body, '正文第一行\n正文第二行');
});

test('parsePrompt: 没有 # 标题时用空标题', () => {
  const p = parsePrompt('没有标题的正文\n第二行');
  assert.equal(p.title, '');
  assert.match(p.body, /没有标题/);
});

test('extractVars: 去重且保序', () => {
  assert.deepEqual(extractVars('{{a}} {{b}} {{a}} {{ c }}'), ['a', 'b', 'c']);
});

test('renderTemplate: 替换已知变量，未知变量保留并报 missing', () => {
  const r = renderTemplate('你好 {{name}}，主题 {{topic}}', { name: '小王' });
  assert.match(r.text, /你好 小王/);
  assert.match(r.text, /\{\{topic\}\}/, '未知变量要保留原样，不能变空');
  assert.deepEqual(r.missing, ['topic']);
});

test('renderTemplate: 空字符串视为缺失', () => {
  const r = renderTemplate('{{a}}', { a: '' });
  assert.equal(r.missing.length, 1);
});

test('PromptLibrary.list: 列内置并带标题', () => {
  const { lib } = tmpLib();
  const list = lib.list();
  assert.deepEqual(list.map((x) => x.id).sort(), ['reply', 'script']);
  assert.equal(list.find((x) => x.id === 'reply').title, '回评论');
  assert.equal(list.find((x) => x.id === 'reply').source, 'builtin');
});

test('PromptLibrary.get: 不存在时报错并列出可选项', () => {
  const { lib } = tmpLib();
  assert.throws(() => lib.get('nope'), /没有提示词「nope」；现有：reply, script/);
});

test('PromptLibrary.save: 自定义覆盖内置，reset 后回落', () => {
  const { lib } = tmpLib();
  lib.save('reply', '# 我的回评论\n\n自定义 {{videoTitle}}');
  const got = lib.get('reply');
  assert.equal(got.source, 'custom');
  assert.match(got.body, /自定义/);
  // list 里也应是 custom
  assert.equal(lib.list().find((x) => x.id === 'reply').source, 'custom');

  const reset = lib.reset('reply');
  assert.equal(reset.removed, true);
  assert.equal(lib.get('reply').source, 'builtin');
});

test('PromptLibrary.save: 内容为空报错', () => {
  const { lib } = tmpLib();
  assert.throws(() => lib.save('x', '   '), /不能为空/);
});

test('PromptLibrary: 非法 id 被拒', () => {
  const { lib } = tmpLib();
  assert.throws(() => lib.get('../etc/passwd'), /非法提示词 id/);
  assert.throws(() => lib.save('a/b', 'x'), /非法提示词 id/);
});

test('PromptLibrary.render: 返回 missing 与变量清单', () => {
  const { lib } = tmpLib();
  const r = lib.render('reply', { videoTitle: '测试视频' });
  assert.equal(r.missing.length, 1);
  assert.deepEqual(r.missing, ['maxReplies']);
  assert.deepEqual(r.vars.sort(), ['maxReplies', 'videoTitle']);
});

test('仓库内置提示词都能被解析且至少有一个变量', () => {
  const root = path.resolve('.');
  const lib = new PromptLibrary({ cfg: { prompts: { dir: 'prompts', customDir: 'state/prompts' } }, root });
  const list = lib.list();
  assert.ok(list.length >= 6, `内置提示词应 >= 6 个，实际 ${list.length}`);
  for (const item of list) {
    const p = lib.get(item.id);
    assert.ok(p.body.length > 50, `${item.id} 正文太短`);
    assert.ok(p.vars.length >= 1, `${item.id} 应该用至少一个变量`);
    assert.equal(p.title.length > 0, true, `${item.id} 应有标题`);
  }
});
