import test from 'node:test';
import assert from 'node:assert/strict';
import { WebBackend } from '../src/driver.mjs';
import { KuaishouWeb } from '../src/web.mjs';
import { freshConfig } from './helpers.mjs';

test('WebBackend 必须暴露 tidy（收拾空白标签）', () => {
  const b = new WebBackend({ cfg: freshConfig(), log: () => {} });
  assert.equal(typeof b.tidy, 'function');
});

test('tidyTabs 只保留一个有用页面，关掉 about:blank', async () => {
  const web = new KuaishouWeb({ cfg: freshConfig() });
  const closed = [];
  const mk = (u) => ({ url: () => u, close: async () => closed.push(u), bringToFront: async () => {} });
  const pages = [mk('about:blank'), mk('https://www.kuaishou.com/new-reco'), mk('about:blank')];
  web.context = { pages: () => pages };
  const r = await web.tidyTabs();
  assert.equal(r.closed, 2, `应关 2 个空白页，实际 ${r.closed}`);
  assert.deepEqual(closed, ['about:blank', 'about:blank']);
  assert.equal(r.kept.length, 1);
  assert.ok(r.kept[0].includes('kuaishou.com'), `保留页不对：${r.kept[0]}`);
});

test('tidyTabs 没有 context 时不崩', async () => {
  const web = new KuaishouWeb({ cfg: freshConfig() });
  web.context = null;
  const r = await web.tidyTabs();
  assert.equal(r.closed, 0);
});

test('tidyTabs 只有一页时不动', async () => {
  const web = new KuaishouWeb({ cfg: freshConfig() });
  const pages = [{ url: () => 'https://www.kuaishou.com/new-reco', close: async () => {}, bringToFront: async () => {} }];
  web.context = { pages: () => pages };
  const r = await web.tidyTabs();
  assert.equal(r.closed, 0);
});
