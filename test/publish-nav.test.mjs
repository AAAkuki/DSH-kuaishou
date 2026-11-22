// 回归：发布前读过作品数后页面停在 /article/manage，必须强制跳回编辑页
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSmart } from '../src/publish.mjs';

test('读作品数后必须跳回 article/publish 编辑页', async () => {
  const f = path.join(os.tmpdir(), `t-${Date.now()}.mp4`);
  fs.writeFileSync(f, 'x');
  const visits = [];
  let summaryCalls = 0;

  const page = {
    async waitForTimeout() {},
    async bringToFront() {},
    async goto(u) { visits.push(u); },
    url: () => 'https://cp.kuaishou.com/article/manage/video',
    locator() {
      return {
        first() { return this; },
        last() { return this; },
        async scrollIntoViewIfNeeded() {},
        async isEnabled() { return true; },
        async count() { return 1; },
        last() { return this; },
        async scrollIntoViewIfNeeded() {},
        async isEnabled() { return true; },
        async setInputFiles() {},
        async click() {},
        async fill() {},
        async pressSequentially() {},
        async press() {}
      };
    },
    getByText() { return { first: () => ({ async count() { return 0; }, async click() {} }) }; },
    getByRole() { return { first: () => ({ async count() { return 1; }, async isDisabled() { return false; }, async click() {} }) }; },
    mouse: { async click() {} },
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes('!==')) return [{ x: 1, y: 1, disabled: false }];
      if (src.includes('hasGuide') || src.includes('作品信息') || src.includes('还有上次未发布')) {
        return { hasGuide: false, hasDraft: false };
      }
      if (src.includes('fileInputs')) {
        return {
          url: 'https://cp.kuaishou.com/article/publish/video',
          fileInputs: 1,
          hasPublishUi: true,
          hasLoginUi: false,
          snippet: '上传视频'
        };
      }
      return { url: 'https://cp.kuaishou.com/article/publish/video', text: '' };
    }
  };

  const web = {
    ensure: async () => page,
    sleep: async () => {},
    // 第一次是"发布前"=5，之后 =6（模拟作品数 +1，让确认逻辑立刻通过，测试不空等 90 秒）
    async readWorksSummary() { summaryCalls++; return { count: summaryCalls === 1 ? 5 : 6, statuses: [] }; }
  };

  await publishSmart(web, { file: f, caption: 'x', retries: 0 }).catch(() => {});
  assert.ok(
    visits.some((u) => u.includes('article/publish')),
    `应跳到编辑页，实际 visits=${JSON.stringify(visits)}`
  );
});
