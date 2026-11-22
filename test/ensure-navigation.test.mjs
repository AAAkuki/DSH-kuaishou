// `ensure({url})` 必须真的跳页。
// 真实 bug：ensure() 第一行是 `if (this.page && !isClosed()) return this.page`，
// 后面写的跳转永远执行不到 —— 于是「作品管理」一直停在评论管理页，
// `ks_own_works` 返回 count:0 / 一堆别的页面文字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { KuaishouWeb } from '../src/web.mjs';

function fakeWeb(currentUrl) {
  const calls = [];
  const w = Object.create(KuaishouWeb.prototype);
  w.page = {
    isClosed: () => false,
    url: () => currentUrl,
    goto: async (u) => { calls.push(u); }
  };
  w.sleep = async () => {};
  w.cfg = { web: { settleMs: 0 } };
  w.ensureAlive = async () => true;
  return { w, calls };
}

test('页面停在别的地址时，ensure({url}) 会跳过去', async () => {
  const { w, calls } = fakeWeb('https://cp.kuaishou.com/article/comment');
  await w.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' });
  assert.deepEqual(calls, ['https://cp.kuaishou.com/article/manage/video']);
});

test('已经是目标页就不跳（省一次刷新）', async () => {
  const { w, calls } = fakeWeb('https://cp.kuaishou.com/article/manage/video');
  await w.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' });
  assert.deepEqual(calls, []);
});

test('默认不传 url → 不跳（别把用户正在看的页面刷掉）', async () => {
  const { w, calls } = fakeWeb('https://www.kuaishou.com/new-reco');
  await w.ensure();
  assert.deepEqual(calls, []);
  await w.ensure({ url: 'https://www.kuaishou.com/' });
  assert.deepEqual(calls, []);
});

test('查询参数不同（搜索词）也算不同页面', async () => {
  const { w, calls } = fakeWeb('https://www.kuaishou.com/search/video?searchKey=ai');
  await w.ensure({ url: 'https://www.kuaishou.com/search/video?searchKey=deepseek' });
  assert.equal(calls.length, 1);
});

test('goto 失败不抛（页面照样能用）', async () => {
  const { w } = fakeWeb('https://cp.kuaishou.com/article/comment');
  w.page.goto = async () => { throw new Error('net::ERR'); };
  await assert.doesNotReject(() => w.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' }));
});
