// 快手 App 驱动层：只做「看得懂快手界面」的事，不含配额/排程（那是 ops 层）。
//
// 每个动作都按「先确认在前台 → 找元素 → 点/输入 → 等结果」四段写，
// 找不到元素时抛 StepError 并附上当前屏幕文本摘要 —— 让模型能自己改选择器，
// 而不是只拿到一句 "timeout"。
import fs from 'node:fs';
import path from 'node:path';
import { parseUiXml, findNodes, findOne, findByText, summarize, waitForNode } from './ui.mjs';

export class StepError extends Error {
  constructor(message, { step, screen = [], hint = '' } = {}) {
    super(message);
    this.name = 'StepError';
    this.step = step;
    this.screen = screen;
    this.hint = hint;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Kuaishou {
  /**
   * @param {object} opts
   * @param {import('./adb.mjs').Adb} opts.adb
   * @param {object} opts.cfg 见 config.mjs
   * @param {(ms:number)=>Promise<void>} [opts.sleep]
   * @param {()=>number} [opts.random]
   */
  constructor({ adb, cfg, sleep = defaultSleep, random = Math.random }) {
    this.adb = adb;
    this.cfg = cfg;
    // 干跑时既不真等（否则一条命令要等几十秒），也不去校验前台（没有真设备可问）
    this.sleep = adb?.dryRun ? async () => {} : sleep;
    this.random = random;
    this._size = null;
  }

  // ── 基础 ────────────────────────────────────────────────────────────────
  rand(min, max) {
    return min + this.random() * (max - min);
  }

  async screenSize() {
    if (this._size) return this._size;
    const out = await this.adb.shellText('wm size');
    const m = /(\d+)\s*x\s*(\d+)/.exec(out);
    if (!m) {
      // 干跑没有真设备：给个常见分辨率，让坐标计算还能继续（否则 dryRun 直接被尺寸卡死）
      if (this.adb.dryRun) return (this._size = { width: 1080, height: 2400 });
      throw new StepError(`读不到屏幕尺寸：${out || '(空)'}`, { step: 'screenSize', hint: '确认 adb shell wm size 能返回 Physical size' });
    }
    this._size = { width: Number(m[1]), height: Number(m[2]) };
    return this._size;
  }

  async nodes() {
    return parseUiXml(await this.adb.dumpUi());
  }

  async foreground() {
    return await this.adb.currentFocus();
  }

  async isKuaishouForeground() {
    const f = await this.foreground();
    return f.pkg === this.cfg.pkg;
  }

  /** 确保快手在前台；不在就拉起来。返回 true 表示本次发生了启动。 */
  async ensureForeground({ relaunch = true } = {}) {
    if (this.adb.dryRun) return false; // 干跑：跳过前台校验
    if (await this.isKuaishouForeground()) return false;
    const f = await this.foreground();
    if (!relaunch) {
      throw new StepError(`快手不在前台，当前是 ${f.pkg || '(未知)'}`, { step: 'ensureForeground', hint: '先调 ks_launch 或把模拟器切到快手' });
    }
    await this.adb.shell(`am start -n ${this.cfg.pkg}/${this.cfg.launcherActivity}`, { timeoutMs: this.cfg.timeouts.launch });
    for (let i = 0; i < 20; i++) {
      await this.sleep(500);
      if (await this.isKuaishouForeground()) return true;
    }
    throw new StepError('快手启动后仍未到前台', { step: 'ensureForeground', hint: '检查 launcherActivity 是否对（可用 ks_dump 看前台 activity）' });
  }

  /** 找元素；找不到时带上屏幕摘要抛错。 */
  async require(spec, { step, timeoutMs = 8000, clickableOnly = false, what = '元素' } = {}) {
    const node = await waitForNode(this.adb, spec, { timeoutMs, clickableOnly, sleep: this.sleep });
    if (!node) {
      const screen = summarize(await this.nodes());
      throw new StepError(`找不到${what}（步骤 ${step}）`, { step, screen, hint: '用 ks_dump 看真实界面文本/resource-id，然后在 config.json 的 selectors 里补上' });
    }
    return node;
  }

  async tapNode(node, { jitterPx = this.cfg.jitter.tapPx } = {}) {
    const dx = jitterPx ? Math.round(this.rand(-jitterPx, jitterPx)) : 0;
    const dy = jitterPx ? Math.round(this.rand(-jitterPx, jitterPx)) : 0;
    const x = Math.max(1, Math.min(node.bounds.cx + dx, node.bounds.x2 - 1));
    const y = Math.max(1, Math.min(node.bounds.cy + dy, node.bounds.y2 - 1));
    await this.adb.tap(x, y);
    return { x, y };
  }

  /** 上滑一屏（看下一条）。jittered 起点/时长，避免每次都是同一条轨迹。 */
  async swipeUp({ durationMs } = {}) {
    const { width, height } = await this.screenSize();
    const dur = durationMs ?? Math.round(this.rand(this.cfg.jitter.swipeDurMin, this.cfg.jitter.swipeDurMax));
    const x = Math.round(width * this.rand(0.45, 0.55));
    const y1 = Math.round(height * this.rand(0.72, 0.82));
    const y2 = Math.round(height * this.rand(0.2, 0.32));
    await this.adb.swipe(x, y1, x, y2, dur);
    return { x, y1, y2, durationMs: dur };
  }

  // ── 刷视频 ──────────────────────────────────────────────────────────────
  /**
   * 刷 count 条：每条停留 dwell 区间后上滑。
   * 纯 adb 循环，不等画面、不截图 —— 这是 token 成本最低的用法。
   */
  async feedScroll({ count = 10, onStep = null, dwell } = {}) {
    await this.ensureForeground();
    const results = [];
    for (let i = 0; i < count; i++) {
      const stay = dwell ? this.rand(dwell.minMs, dwell.maxMs) : this.rand(this.cfg.dwell.minMs, this.cfg.dwell.maxMs);
      await this.sleep(Math.round(stay));
      const swipe = await this.swipeUp();
      const item = { index: i + 1, dwellMs: Math.round(stay), swipe };
      results.push(item);
      if (onStep) await onStep(item);
    }
    return results;
  }

  /** 点赞当前视频（双击屏幕中央是最稳的通用做法）。 */
  async like() {
    await this.ensureForeground();
    const { width, height } = await this.screenSize();
    const x = Math.round(width * this.rand(0.45, 0.55));
    const y = Math.round(height * this.rand(0.42, 0.55));
    await this.adb.tap(x, y);
    await this.sleep(120);
    await this.adb.tap(x, y);
    return { x, y };
  }

  // ── 评论 ────────────────────────────────────────────────────────────────
  async openComments() {
    await this.ensureForeground();
    const entry = await this.require(this.cfg.selectors.commentEntry, { step: 'openComments', clickableOnly: true, what: '评论入口' });
    await this.tapNode(entry);
    await this.sleep(600);
    return true;
  }

  async closeComments() {
    await this.adb.key(4); // KEYCODE_BACK
    await this.sleep(400);
  }

  /** 读当前视频的评论列表（文本 + 坐标），按屏幕顺序。 */
  async readComments() {
    const nodes = await this.nodes();
    const listSpec = this.cfg.selectors.commentList;
    let rows = findNodes(nodes, listSpec);
    if (rows.length === 0) {
      // 退化：取所有非空文本节点里、位于屏幕下半部分的
      const { height } = await this.screenSize();
      rows = nodes.filter((n) => (n.text || '').trim() && n.bounds.cy > height * 0.4);
    }
    const ignore = new Set([...(this.cfg.reply.ignore ?? []), '说点什么', '发送', '回复', '展开', '收起']);
    return rows
      .filter((n) => {
        const t = (n.text || '').trim();
        if (t.length < 2 || t.length > 200) return false;
        if (/EditText|Button/i.test(n.className)) return false;   // 输入框/按钮不是评论
        if (/\/comment_editor$|\/send$/i.test(n.resourceId)) return false;
        if (ignore.has(t)) return false;
        if (/^\d+条回复$|^回复 @/.test(t)) return false;
        return true;
      })
      .map((n) => ({ text: n.text.trim(), cx: n.bounds.cx, cy: n.bounds.cy, id: n.resourceId }));
  }

  /**
   * 回一条评论。
   * @param {{match:string, content:string}} args match 为评论文本片段（模糊）
   */
  async replyToComment({ match, content, openPanel = true }) {
    if (!match) throw new StepError('match 不能为空', { step: 'replyToComment' });
    this.assertReplyText(content);
    // openPanel=false：调用方（ops.runPlan / ks_reply_auto）已经打开过面板，
    // 再开一次会先关后开，既慢又容易点空（真实 bug）
    if (openPanel) await this.openComments();
    const nodes = await this.nodes();
    const target = findNodes(nodes, { text: [match] })[0];
    if (!target) {
      await this.closeComments();
      throw new StepError(`评论列表里找不到包含「${match}」的评论`, {
        step: 'replyToComment',
        screen: summarize(nodes),
        hint: '先 ks_comments 看当前可选评论，再挑一条'
      });
    }
    await this.tapNode(target);
    await this.sleep(500);
    const box = await this.require(this.cfg.selectors.commentInput, { step: 'replyToComment', clickableOnly: true, what: '评论输入框' });
    await this.tapNode(box, { jitterPx: 0 });
    await this.sleep(300);
    await this.adb.inputText(content, { imeId: this.cfg.publish.imeId, imePackage: this.cfg.publish.imePackage });
    const send = await this.require(this.cfg.selectors.sendButton, { step: 'replyToComment', clickableOnly: true, what: '发送按钮' });
    await this.tapNode(send);
    await this.sleep(800);
    if (openPanel) await this.closeComments();
    return { replied: content, matched: target.text };
  }

  /** 文案红线：长度、拉黑词、纯空白。 */
  assertReplyText(content) {
    const s = String(content ?? '').trim();
    if (s.length < this.cfg.reply.minChars) throw new StepError(`回复太短（<${this.cfg.reply.minChars} 字）`, { step: 'assertReplyText' });
    if (s.length > this.cfg.reply.maxChars) throw new StepError(`回复太长（>${this.cfg.reply.maxChars} 字）`, { step: 'assertReplyText' });
    const hit = this.cfg.reply.blacklist.find((w) => w && s.includes(w));
    if (hit) throw new StepError(`回复命中拉黑词「${hit}」`, { step: 'assertReplyText', hint: '引流话术会被判营销，换掉' });
    return s;
  }

  /** 这条评论值不值得回：命中 whitelist 且不命中 blacklist。 */
  shouldReply(text) {
    const t = String(text ?? '').trim();
    if (t.length < this.cfg.reply.minChars) return false;
    if (this.cfg.reply.blacklist.some((w) => w && t.includes(w))) return false;
    const wl = this.cfg.reply.whitelist;
    if (!wl || wl.length === 0) return true;
    return wl.some((w) => (w === '?' || w === '？' ? /[?？]/.test(t) : t.includes(w)));
  }

  // ── 发视频 ──────────────────────────────────────────────────────────────
  assertPublishInput({ file, caption }) {
    if (!file) throw new StepError('file 不能为空', { step: 'publishVideo' });
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new StepError(`视频文件不存在：${abs}`, { step: 'publishVideo' });
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size === 0) throw new StepError(`不是有效文件：${abs}`, { step: 'publishVideo' });
    const ext = path.extname(abs).toLowerCase();
    if (!this.cfg.publish.videoExt.includes(ext)) {
      throw new StepError(`扩展名 ${ext} 不在允许列表（${this.cfg.publish.videoExt.join(', ')}）`, { step: 'publishVideo' });
    }
    const cap = String(caption ?? '');
    if (cap.length > this.cfg.publish.captionMax) {
      throw new StepError(`文案超过 ${this.cfg.publish.captionMax} 字（当前 ${cap.length}）`, { step: 'publishVideo' });
    }
    const topics = (cap.match(/#[^\s#]+/g) ?? []).length;
    if (topics > this.cfg.publish.topicsMax) {
      throw new StepError(`话题数 ${topics} 超过上限 ${this.cfg.publish.topicsMax}`, { step: 'publishVideo' });
    }
    return { abs, size: stat.size, ext };
  }

  /** 把视频推进设备相册并触发媒体扫描（否则快手相册里看不到）。 */
  async pushVideo(abs) {
    const name = `${Date.now()}${path.extname(abs)}`;
    const remote = `${this.cfg.publish.deviceDir}/${name}`;
    await this.adb.shell(`mkdir -p ${this.cfg.publish.deviceDir}`);
    await this.adb.exec(['push', abs, remote], { timeoutMs: 120000 });
    await this.adb.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`);
    return remote;
  }

  /**
   * 发布流程：拍摄页 → 相册 → 选最新视频 → 下一步 → 填文案 → 发布。
   *
   * ⚠️ 这条链每一步都依赖快手当前版本的实际界面；任何一步找不到元素都会抛 StepError
   * 并附当前屏幕文本，方便立刻改 config.selectors 重试（不需要改代码）。
   */
  async publishVideo({ file, caption = '', dryPushOnly = false }) {
    const { abs, size, ext } = this.assertPublishInput({ file, caption });
    const remote = await this.pushVideo(abs);
    if (dryPushOnly) return { pushed: remote, size, ext, published: false };

    await this.ensureForeground();
    const entry = await this.require(this.cfg.selectors.publishEntry, { step: 'publishVideo.entry', clickableOnly: true, what: '发布/拍摄入口' });
    await this.tapNode(entry);
    await this.sleep(800);

    const album = await this.require(this.cfg.selectors.albumPick, { step: 'publishVideo.album', clickableOnly: true, what: '相册入口' });
    await this.tapNode(album);
    await this.sleep(1200);

    // 相册里选第一个（最新）视频：取所有可点的缩略图里最靠左上的那个
    const nodes = await this.nodes();
    const thumbs = findNodes(nodes, (n) => n.className.includes('ImageView') && n.bounds.width > 80 && n.bounds.height > 80)
      .sort((a, b) => (a.bounds.cy - b.bounds.cy) || (a.bounds.cx - b.bounds.cx));
    if (thumbs.length === 0) {
      throw new StepError('相册里没找到可选视频缩略图', { step: 'publishVideo.pick', screen: summarize(nodes), hint: '确认 push 到了相册目录并已触发媒体扫描' });
    }
    await this.tapNode(thumbs[0], { jitterPx: 0 });
    await this.sleep(600);

    const next = await this.require(this.cfg.selectors.publishNext, { step: 'publishVideo.next', clickableOnly: true, what: '下一步' });
    await this.tapNode(next);
    await this.sleep(1000);

    if (caption) {
      const box = await this.require(this.cfg.selectors.captionBox, { step: 'publishVideo.caption', clickableOnly: true, what: '文案输入框' });
      await this.tapNode(box, { jitterPx: 0 });
      await this.sleep(300);
      await this.adb.inputText(caption, { imeId: this.cfg.publish.imeId, imePackage: this.cfg.publish.imePackage });
      await this.sleep(300);
    }

    const confirm = await this.require(this.cfg.selectors.publishConfirm, { step: 'publishVideo.confirm', clickableOnly: true, what: '发布按钮' });
    await this.tapNode(confirm);
    await this.sleep(1500);
    return { pushed: remote, size, ext, published: true, caption };
  }

  /** 一句话状态：前台包、屏幕文本摘要、尺寸。给模型「不开图也能定位」。 */
  async status() {
    const fg = await this.foreground();
    let screen = [];
    let size = null;
    try {
      size = await this.screenSize();
      screen = summarize(await this.nodes(), { max: 25 });
    } catch {}
    return { foreground: fg, kuaishouForeground: fg.pkg === this.cfg.pkg, screenSize: size, screen };
  }
}

export { findByText };
