import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBounds, parseUiXml, compileMatcher, findNodes, findOne, summarize, waitForNode } from '../src/ui.mjs';
import { HOME_XML, COMMENT_XML } from './fixtures.mjs';

test('parseBounds 解析中心点与尺寸', () => {
  const b = parseBounds('[100,200][300,400]');
  assert.deepEqual({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, cx: b.cx, cy: b.cy }, { x1: 100, y1: 200, x2: 300, y2: 400, cx: 200, cy: 300 });
  assert.equal(b.width, 200);
  assert.equal(b.height, 200);
});

test('parseBounds 对坏输入返回 null', () => {
  assert.equal(parseBounds('garbage'), null);
  assert.equal(parseBounds(''), null);
  assert.equal(parseBounds(undefined), null);
});

test('parseUiXml 抽出节点属性与坐标', () => {
  const nodes = parseUiXml(HOME_XML);
  assert.equal(nodes.length, 4);
  const comment = nodes.find((n) => n.text === '评论');
  assert.ok(comment);
  assert.equal(comment.clickable, true);
  assert.equal(comment.contentDesc, '评论');
  assert.equal(comment.bounds.cx, 950);
});

test('compileMatcher: resource-id 支持前缀通配', () => {
  const nodes = parseUiXml(HOME_XML);
  const m = compileMatcher({ res: ['com.smile.gifmaker:id/*'] });
  assert.equal(nodes.filter(m).length, 2); // tab_title + comment_editor
});

test('compileMatcher: 文本 exact 与包含', () => {
  const nodes = parseUiXml(HOME_XML);
  assert.equal(findNodes(nodes, { text: ['评论'], exact: true }).length, 1);
  assert.equal(findNodes(nodes, { text: ['评'] }).length, 1);
  assert.equal(findNodes(nodes, { text: ['不存在的字'] }).length, 0);
});

test('findNodes 默认过滤零尺寸与不可用节点', () => {
  const xml = `<hierarchy><node text="A" class="android.widget.TextView" bounds="[0,0][0,0]" clickable="true" enabled="true"/><node text="B" class="android.widget.TextView" bounds="[0,0][10,10]" clickable="true" enabled="false"/><node text="C" class="android.widget.TextView" bounds="[0,0][10,10]" clickable="true" enabled="true"/></hierarchy>`;
  const nodes = parseUiXml(xml);
  const found = findNodes(nodes, { text: ['A', 'B', 'C'] });
  assert.deepEqual(found.map((n) => n.text), ['C']);
});

test('findOne 返回第一个命中', () => {
  const nodes = parseUiXml(COMMENT_XML);
  const first = findOne(nodes, { res: ['com.smile.gifmaker:id/comment_text'] });
  assert.equal(first.text, '这个怎么做的？');
});

test('summarize 去重并保留可点标记', () => {
  const nodes = parseUiXml(HOME_XML);
  const s = summarize(nodes);
  const texts = s.map((x) => x.text);
  assert.ok(texts.includes('评论'));
  assert.ok(texts.includes('说点什么'));
  assert.ok(s.find((x) => x.text === '评论').clickable);
});

test('waitForNode 第二次命中就返回', async () => {
  let n = 0;
  const adapter = {
    dumpUi: async () => {
      n++;
      return n === 1 ? '<hierarchy><node text="x" bounds="[0,0][0,0]" enabled="true"/></hierarchy>' : HOME_XML;
    }
  };
  const node = await waitForNode(adapter, { text: ['评论'] }, { timeoutMs: 2000, intervalMs: 1, sleep: async () => {} });
  assert.equal(node.text, '评论');
  assert.equal(n, 2);
});

test('waitForNode 超时返回 null', async () => {
  const adapter = { dumpUi: async () => '<hierarchy></hierarchy>' };
  const node = await waitForNode(adapter, { text: ['没有'] }, { timeoutMs: 30, intervalMs: 1, sleep: async () => {} });
  assert.equal(node, null);
});
