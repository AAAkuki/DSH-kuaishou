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

  async comments({ keepOpen = false, limit = 50 } = {}) {
    await this.ks.ensureForeground();
    await this.ks.openComments();
    const list = (await this.ks.readComments()).slice(0, limit);
    if (!keepOpen) await this.ks.closeComments();
    return list;
  }

  async reply({ match, content, openPanel = true }) { return await this.ks.replyToComment({ match, content, openPanel }); }

  async publish({ file, caption = '', pushOnly = false }) {
    return await this.ks.publishVideo({ file, caption, dryPushOnly: pushOnly });
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

  async comments({ keepOpen = false, limit = 50 } = {}) {
    const list = await this.web.readComments({ limit });
    if (!keepOpen) await this.web.closeComments();
    return list;
  }

  async reply({ match, content, openPanel = true }) { return await this.web.replyToComment({ match, content, openPanel }); }
  async publish({ file, caption = '', pushOnly = false }) {
    if (pushOnly) {
      // 网页版没有"只推文件"这一步：上传即发布，必须明确拒绝，不能默默发出去
      throw new Error('网页版后端的 pushOnly 不支持（它走创作者平台直传，没有"先推后发"）。要去掉 pushOnly，或把 mode 切成 adb');
    }
    return await this.web.publishVideo({ file, caption });
  }
  async screenshot({ file } = {}) { return await this.web.screenshot({ file }); }
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
