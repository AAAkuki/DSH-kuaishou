// 统一驱动门面：adb（模拟器/真机）与 web（快手网页版）两种后端，对上层（MCP/CLI）暴露同一套方法。
//
// 判据（mode=auto）：能找到 adb 且设备在线 → adb；否则 → web。
// 为什么不让上层感知后端：模型侧的玩法（刷/赞/评论/发布）和配额、状态、红线检查都是同一套，
// 换后端不该换工具名。
import fs from 'node:fs';
import path from 'node:path';
import { Adb, discoverAdb } from './adb.mjs';
import { Kuaishou } from './ks.mjs';
import { KuaishouWeb } from './web.mjs';
import { projectRoot } from './config.mjs';

export class AdbBackend {
  constructor({ cfg, log }) {
    this.mode = 'adb';
    this.cfg = cfg;
    this.adb = new Adb({ adbPath: cfg.adbPath, serial: cfg.serial, timeoutMs: cfg.timeouts.shell, dryRun: cfg.dryRun, log });
    this.ks = new Kuaishou({ adb: this.adb, cfg });
  }

  async ensure() {
    await this.adb.resolveSerial();
    return this.ks.ensureForeground();
  }

  async status() {
    await this.adb.resolveSerial();
    return { mode: 'adb', serial: this.adb.serial, adbPath: this.adb.adbPath, ...(await this.ks.status()) };
  }

  async feedScroll(opts) { return await this.ks.feedScroll(opts); }
  async like() { return await this.ks.like(); }

  /** autopilot / runPlan 都叫 readComments，这里做别名。 */
  async readComments({ limit = 50 } = {}) {
    return await this.comments({ keepOpen: false, limit });
  }

  async comments({ keepOpen = false, limit = 50 } = {}) {
    await this.ks.ensureForeground();
    await this.ks.openComments();
    const list = (await this.ks.readComments()).slice(0, limit);
    if (!keepOpen) await this.ks.closeComments();
    return list;
  }

  async reply({ match, content, openPanel = true }) { return await this.ks.replyToComment({ match, content, openPanel }); }
  async replyWithSticker(opts = {}) { return await this.ks.replyWithSticker(opts); }

  async publish({ file, caption = '', pushOnly = false, topics = [], title = '' } = {}) {
    // adb 后端走 App 发布界面，话题/封面需要额外 UI 操作，暂不支持——返回里说明，别静默丢
    const result = await this.ks.publishVideo({ file, caption, dryPushOnly: pushOnly });
    return {
      ...result,
      topicsSupported: false,
      note: topics.length || title
        ? 'adb 后端暂不支持自动填话题/标题/封面（网页版支持）'
        : result.note
    };
  }

  async screenshot() {
    await this.adb.resolveSerial();
    const png = await this.adb.screencap();
    const file = path.join(projectRoot(), 'state', `shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return { file, bytes: png.length };
  }

  async close() {}
}

export class WebBackend {
  constructor({ cfg, log }) {
    this.mode = 'web';
    this.cfg = cfg;
    this.web = new KuaishouWeb({ cfg, log });
  }

  async ensure() { await this.web.ensure(); return false; }
  async status() { return await this.web.status(); }
  async feedScroll(opts) { return await this.web.feedScroll(opts); }
  async like() { return await this.web.like(); }

  /** autopilot / runPlan 都叫 readComments，这里做别名（之前缺了 → "b.readComments is not a function"）。 */
  async readComments({ limit = 50 } = {}) {
    return await this.comments({ keepOpen: false, limit });
  }
  async postComment(opts = {}) { return await this.web.postComment(opts); }
  async readVideoTags() { return await this.web.readVideoTags(); }
  async listOwnWorks(opts = {}) { return await this.web.listOwnWorks(opts); }
  async openOwnWork(opts = {}) { return await this.web.openOwnWork(opts); }
  async readSubReplies(opts = {}) { return await this.web.readSubReplies(opts); }

  async comments({ keepOpen = false, limit = 50 } = {}) {
    const list = await this.web.readComments({ limit });
    if (!keepOpen) await this.web.closeComments();
    return list;
  }

  async reply({ match, content, openPanel = true }) { return await this.web.replyToComment({ match, content, openPanel }); }
  async replyWithSticker(opts = {}) { return await this.web.replyWithSticker(opts); }
  /**
   * agent 模式（自己一条条刷）：必须在这里转发，否则 ks_watch / ks_next 会报
   * "当前后端不支持单条观看" —— 之前漏了这两个转发，agent 模式等于不可用。
   */
  async watchCurrent(opts = {}) { return await this.web.watchCurrent(opts); }
  async nextVideo() { return await this.web.nextVideo(); }
  async currentVideo() { return await this.web.currentVideo(); }
  async publish({ file, caption = '', pushOnly = false, cover = '', topics = [], title = '', retries = 1 } = {}) {
    if (pushOnly) {
      // 网页版没有"只推文件"这一步：上传即发布，必须明确拒绝，不能默默发出去
      throw new Error('网页版后端的 pushOnly 不支持（它走创作者平台直传，没有"先推后发"）。要去掉 pushOnly，或把 mode 切成 adb');
    }
    return await this.web.publishVideo({ file, caption, cover, topics, title, retries });
  }
  async screenshot({ file } = {}) { return await this.web.screenshot({ file }); }
  /** 收拾标签页（关掉 about:blank 和重复页），对外暴露给 MCP 用。 */
  async tidy() { return await (this.web.tidyTabs ? this.web.tidyTabs() : { closed: 0 }); }

  async close() { await this.web.close(); }
}

/** 选后端。adb 探测会执行一次 `adb devices`，失败就落到 web。 */
export async function createBackend({ cfg, log = () => {} } = {}) {
  const mode = cfg.mode ?? 'auto';
  if (mode === 'web') return new WebBackend({ cfg, log });
  if (mode === 'adb') return new AdbBackend({ cfg, log });

  // auto
  const adbPath = cfg.adbPath || discoverAdb();
  if (adbPath) {
    try {
      const adb = new Adb({ adbPath, serial: cfg.serial });
      const list = await adb.devices();
      if (list.some((d) => d.state === 'device')) return new AdbBackend({ cfg, log });
      log('[auto] 找到 adb 但没有在线设备 → 用网页版');
    } catch (error) {
      log(`[auto] adb 探测失败（${error.message}）→ 用网页版`);
    }
  } else {
    log('[auto] 没找到 adb → 用网页版');
  }
  return new WebBackend({ cfg, log });
}
