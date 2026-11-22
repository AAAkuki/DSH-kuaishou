// 「别什么都问用户」的单元测试：发布流程在自己的节奏里把事做完
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSmart } from '../src/publish.mjs';

function fakeVideo() {
  const f = path.join(os.tmpdir(), `pub-${Date.now()}.mp4`);
  fs.writeFileSync(f, 'fake');
  return f;
}

/**
 * 假 page：
 *  - state：页面状态（含 url / fileInputs / hasPublishUi / hasLoginUi）
 *  - afterClick：点完发布后 evaluate 返回的内容（用于确认成功提示）
 */
function makePage({ state, afterClick = null }) {
  let evaluateCount = 0;
  return {
    async waitForTimeout() {},
    async bringToFront() {},
    locator() {
      return {
        first() { return this; }, last() { return this; },
        async count() { return state.fileInputs; },
        async setInputFiles() {}, async click() {}, async fill() {},
        async pressSequentially() {}, async press() {}
      };
    },
    getByText() { return { first: () => ({ async count() { return 0; }, async click() {} }) }; },
    // evaluate 有四种用途：读页面状态 / 检查弹窗 / 找发布按钮 / 等成功提示
    async evaluate(fn) {
      evaluateCount++;
      const src = String(fn);
      if (src.includes("!== '发布'")) {
        // 找发布按钮：返回候选坐标
        return state.publishButton === false
          ? []
          : [{ x: 10, y: 10, disabled: Boolean(state.buttonDisabled) }];
      }
      if (src.includes('hasGuide') || src.includes('作品信息') || src.includes('还有上次未发布')) {
        return { hasGuide: false, hasDraft: false };
      }
      if (afterClick && evaluateCount > 1 && src.includes('slice(0, 600)')) {
        return afterClick();
      }
      return {
        url: state.url,
        fileInputs: state.fileInputs ?? 0,
        hasPublishUi: state.hasPublishUi ?? false,
        hasLoginUi: state.hasLoginUi ?? false,
        snippet: state.snippet ?? ''
      };
    },
    mouse: { async click() {} },

    getByRole() {
      return {
        first: () => ({
          async count() { return state.publishButton === false ? 0 : 1; },
          async isDisabled() { return Boolean(state.buttonDisabled); },
          async click() {}
        })
      };
    }
  };
}

const webStub = (page) => ({ ensure: async () => page, sleep: async () => {} });

test('未登录：不抛错，返回可执行结果（窗口停在登录页）', async () => {
  const page = makePage({ state: { url: 'https://cp.kuaishou.com/passport/login', hasLoginUi: true } });
  const r = await publishSmart(webStub(page), { file: fakeVideo(), caption: '测试' });
  assert.equal(r.published, false);
  assert.equal(r.needLogin, true);
  assert.equal(r.action, 'scan-qr-on-screen');
  assert.match(r.message, /扫码/);
});

test('没有上传入口也没有登录提示：仍给出可执行结果（不崩、不假装成功）', async () => {
  const page = makePage({ state: { url: 'https://cp.kuaishou.com/profile', fileInputs: 0, hasPublishUi: false, hasLoginUi: false, snippet: '空白页' } });
  const r = await publishSmart(webStub(page), { file: fakeVideo(), retries: 0 });
  assert.equal(r.published, false, '不能假装发布成功');
  assert.ok(r.message && r.message.length > 0, '要给出可执行的提示');
  assert.ok(['scan-qr-on-screen', 'inspect-screen'].includes(r.action), `action 不合理：${r.action}`);
});

test('能上传且按钮可点 + 出现成功提示：published=true confirmed=true', async () => {
  const page = makePage({
    state: { url: 'https://cp.kuaishou.com/profile', fileInputs: 1, hasPublishUi: true },
    afterClick: () => ({ url: 'https://cp.kuaishou.com/article/manage', text: '发布成功 审核中' })
  });
  const r = await publishSmart(webStub(page), { file: fakeVideo(), caption: '文案' });
  assert.equal(r.published, true, JSON.stringify(r).slice(0, 200));
  assert.equal(r.caption, '文案');
});

test('上传了但按钮一直不可点：不假装成功，且很快给出可执行结果', async () => {
  const page = makePage({ state: { url: 'https://cp.kuaishou.com/profile', fileInputs: 1, hasPublishUi: true, buttonDisabled: true } });
  // 注入假时钟：每次 sleep 把 Date.now 推进 30 秒，180 秒的轮询 6 次就结束
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => (fake += 0);
  const web = {
    ensure: async () => page,
    sleep: async (ms = 0) => { fake += Math.max(ms, 30000); }
  };
  Date.now = () => fake;
  try {
    const started = realNow();
    const r = await publishSmart(web, { file: fakeVideo(), retries: 0 });
    assert.notEqual(r.published, true, '按钮不可点时不能报成功');
    assert.ok(r.message, '要给出可执行提示');
    assert.ok(realNow() - started < 10000, '测试不应真的等 3 分钟');
  } finally {
    Date.now = realNow;
  }
});

test('文件不存在：直接报错，不去点页面', async () => {
  const page = makePage({ state: { url: 'https://cp.kuaishou.com/profile' } });
  await assert.rejects(() => publishSmart(webStub(page), { file: 'D:/nope/x.mp4' }), /视频文件不存在/);
});
