import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSmart } from '../src/publish.mjs';

const fakeVideo = () => {
  const f = path.join(os.tmpdir(), `pub-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.mp4`);
  fs.writeFileSync(f, 'x');
  return f;
};

/** 假 web：专门测"作品数是否增加"这条验证逻辑 */
function makeWeb({ worksBefore = 3, worksCounts = [4], toast = '' } = {}) {
  let summaryCalls = 0;
  const page = {
    async waitForTimeout() {}, async bringToFront() {}, async goto() {},
    url: () => 'https://cp.kuaishou.com/article/publish/video',
    locator() {
      return {
        first() { return this; }, last() { return this; },
        async count() { return 1; },
        last() { return this; },
        async scrollIntoViewIfNeeded() {},
        async isEnabled() { return true; },
        async setInputFiles() {}, async click() {}, async fill() {},
        async pressSequentially() {}, async press() {}
      };
    },
    getByText() { return { first: () => ({ async count() { return 0; }, async click() {} }) }; },
    getByRole() { return { first: () => ({ async count() { return 1; }, async isDisabled() { return false; }, async click() {} }) }; },
    mouse: { async click() {} },
    async evaluate(fn) {
      const src = String(fn);
      // 找发布按钮
      if (src.includes("!== '发布'")) return [{ x: 1, y: 1, disabled: false }];
      // 弹窗检测
      if (src.includes('hasGuide') || src.includes('作品信息') || src.includes('还有上次未发布')) {
        return { hasGuide: false, hasDraft: false };
      }
      // readState：必须给出完整的页面状态
      if (src.includes('fileInputs')) {
        return {
          url: 'https://cp.kuaishou.com/article/publish/video',
          fileInputs: 1,
          hasPublishUi: true,
          hasLoginUi: false,
          snippet: '上传视频'
        };
      }
      // 成功提示轮询
      return { url: 'https://cp.kuaishou.com/article/publish/video', text: toast };
    }
  };
  return {
    ensure: async () => page,
    sleep: async () => {},
    async readWorksSummary() {
      summaryCalls++;
      // 第 1 次是"发布前"，之后按 worksCounts 依次返回
      if (summaryCalls === 1) return { count: worksBefore, statuses: [] };
      const v = worksCounts[Math.min(summaryCalls - 2, worksCounts.length - 1)];
      return { count: v, statuses: [] };
    }
  };
}

test('作品数 +1 → 判定"真的发出去了"', async () => {
  const web = makeWeb({ worksBefore: 3, worksCounts: [4, 4, 4] });
  const r = await publishSmart(web, { file: fakeVideo(), caption: '测试' });
  assert.equal(r.published, true);
  assert.equal(r.confirmed, true, `应确认成功：${JSON.stringify(r).slice(0, 200)}`);
  assert.match(r.note, /作品数/, `note 应带作品数证据：${r.note}`);
});

test('作品数没变 → 不假装成功（"停在编辑页"就是这种）', async () => {
  const web = makeWeb({ worksBefore: 3, worksCounts: [3, 3, 3, 3], toast: '' });
  // 假时钟让 90 秒轮询快速结束
  const realNow = Date.now;
  let fake = realNow();
  const realSleep = web.sleep;
  web.sleep = async () => { fake += 30000; };
  Date.now = () => fake;
  try {
    const r = await publishSmart(web, { file: fakeVideo(), caption: '测试', retries: 0 });
    assert.equal(r.published, false, '作品数没增加不能报成功');
    assert.match(String(r.message || r.note), /没发出去|作品数/, `应说明原因：${r.message || r.note}`);
  } finally {
    Date.now = realNow;
    web.sleep = realSleep;
  }
});

test('拿不到作品数但页面有成功提示 → 降级判成功', async () => {
  const web = makeWeb({ worksBefore: null, worksCounts: [null], toast: '发布成功' });
  const r = await publishSmart(web, { file: fakeVideo(), caption: '测试' });
  assert.equal(r.published, true, `应判成功：${JSON.stringify(r).slice(0, 200)}`);
  assert.match(r.note, /成功提示/);
});
