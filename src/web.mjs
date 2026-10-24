// 快手**网页版**驱动：同 adb 后端同一套能力（刷/赞/评论/发布），但走真实浏览器（CDP）。
//
// 为什么网页版可行：www.kuaishou.com 的推荐流在**游客态**就能播、能看评论；
// 点赞/回复/发布需要登录一次，登录态用持久化 user-data-dir 保存，之后不用重复扫码。
//
// 选择器来源：2026-10-24 在 Edge + 快手 web（PC 端）实测抓到的真实 DOM：
//   .like-btn      点赞按钮（text 是赞数）
//   .comment       评论入口
//   .prev / .next  上一条 / 下一条
//   .side-area     右侧评论面板（含「共 N 条评论」）
//   评论输入框       input[placeholder="说点什么..."]
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';

/** 最近一次真实确认「已登录」的时间写进 state/web-login.json，供环境检查引用。 */
function persistLoginMarker(info = {}) {
  try {
    const file = path.join(projectRoot(), 'state', 'web-login.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ loggedIn: true, at: new Date().toISOString(), ...info }, null, 2), 'utf8');
  } catch {}
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「1.7万」「3243」「1.2w」→ 数字（解析失败返回 null）。 */
export function normalizeCount(text) {
  const s = String(text ?? '').trim().toLowerCase();
  const m = /^([\d.]+)\s*([万w亿k])?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w') return Math.round(n * 10000);
  if (unit === '亿') return Math.round(n * 100000000);
  if (unit === 'k') return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * 评论面板文本 → 结构。
 * 面板 innerText 的形状是：`共 N 条评论` 之后每条 4 行：[昵称, 内容, 时间, 赞数]，
 * 昵称是 `@xxx` 时内容可能紧接着出现，所以这里用「时间行」做锚点回溯。
 */
export function parseCommentText(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '评论' && l !== 'TA 的作品');
  const out = [];
  const timeRe = /^(刚刚|\d+\s*(秒|分钟|小时|天|周|月)前|\d{4}-\d{2}-\d{2}|\d+天前)$/;
  for (let i = 0; i < lines.length; i++) {
    if (!timeRe.test(lines[i])) continue;
    const content = lines[i - 1] ?? '';
    const author = lines[i - 2] ?? '';
    const likes = lines[i + 1] ?? '';
    if (!content) continue;
    if (/^共\s*\d+\s*条评论$/.test(content) || /^共\s*\d+\s*条评论$/.test(author ?? '')) continue;
    out.push({ author, text: content, when: lines[i], likes: normalizeCount(likes) ?? 0 });
  }
  return out;
}

/**
 * 这条视频该等多久。
 * 有真实时长就等「播完 or 上限」，没读到时长就落在 [min, max] 里随机。
 */
export function planDwell({ durationSec = 0, minMs = 6000, maxMs = 22000, random = Math.random } = {}) {
  if (Number.isFinite(durationSec) && durationSec > 0.5) {
    const target = durationSec * 1000 * (0.85 + random() * 0.5); // 播完 + 一点余量
    return Math.round(Math.min(Math.max(target, minMs), Math.max(minMs, maxMs)));
  }
  return Math.round(minMs + random() * (Math.max(minMs, maxMs) - minMs));
}

/** 自动找本机 Chromium 系浏览器（Playwright 自带浏览器通常没下载）。 */
export function resolveBrowserPath({ explicit = '', env = process.env } = {}) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const candidates = [
    explicit,
    env.KSOPS_BROWSER || '',
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return '';
}

const SELECTORS = {
  likeBtn: '.like-btn',
  comment: '.comment',
  panel: '.side-area',
  next: '.next',
  prev: '.prev',
  video: 'video',
  commentInput: 'input[placeholder="说点什么..."], textarea[placeholder*="说点什么"]',
  loginCue: '.login-btn, .login-area, [class*="login"]'
};

export class KuaishouWeb {
  constructor({ cfg, log = () => {}, sleep = defaultSleep }) {
    this.cfg = cfg;
    this.log = log;
    this.sleep = sleep;
    this.ctx = null;
    this.page = null;
  }

  get mode() { return 'web'; }

  profileDir() {
    return path.resolve(projectRoot(), this.cfg.web?.profileDir ?? '.web-profile');
  }

  async ensure({ url = 'https://www.kuaishou.com/' } = {}) {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import('playwright-core');
    const browserPath = resolveBrowserPath({ explicit: this.cfg.web?.browserPath || '' });
    if (!browserPath) throw new Error('没找到 Edge/Chrome：把浏览器路径写进 config.json 的 web.browserPath（或设 KSOPS_BROWSER）');
    const headless = this.cfg.web?.headless === true;
    const dir = this.profileDir();
    fs.mkdirSync(dir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(dir, {
      executablePath: browserPath || undefined,
      headless,
      viewport: { width: this.cfg.web?.width ?? 1600, height: this.cfg.web?.height ?? 1000 },
      locale: 'zh-CN',
      args: ['--disable-blink-features=AutomationControlled', '--mute-audio']
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    if (!this.page.url().startsWith('http')) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await this.sleep(this.cfg.web?.settleMs ?? 3000);
    return this.page;
  }

  async close() {
    try { await this.ctx?.close(); } catch {}
    this.ctx = null;
    this.page = null;
  }

  /** 是否已登录：页面上没有「立即登录/登录即可享受」，且能看到头像/个人入口。 */
  async isLoggedIn() {
    const page = await this.ensure();
    const state = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const hasLoginCue = /立即登录|登录即可享受/.test(txt) && !/退出登录|我的主页/.test(txt);
      const avatar = document.querySelector('.avatar, [class*="avatar"] img, [class*="user-info"] img');
      return { loggedIn: !hasLoginCue, hasAvatar: Boolean(avatar) };
    });
    if (state.loggedIn) persistLoginMarker({ via: 'isLoggedIn', hasAvatar: state.hasAvatar });
    return state.loggedIn;
  }

  async currentVideo() {
    const page = await this.ensure();
    return await page.evaluate(() => {
      const v = document.querySelector('video');
      const like = document.querySelector('.like-btn');
      const desc = document.querySelector('.video-desc, .video-info .desc, [class*="video-desc"]');
      return {
        src: (v?.currentSrc || '').slice(0, 120),
        durationSec: Number(v?.duration ?? 0),
        currentSec: Number(v?.currentTime ?? 0),
        paused: Boolean(v?.paused),
        likeText: (like?.innerText || '').trim(),
        desc: (desc?.innerText || '').trim().slice(0, 200)
      };
    });
  }

  async status() {
    const page = await this.ensure();
    const v = await this.currentVideo();
    return {
      mode: 'web',
      url: page.url(),
      title: await page.title(),
      loggedIn: await this.isLoggedIn(),
      video: v
    };
  }

  /** 刷 N 条：等下一条视频稳定 → 按视频时长停留 → 点 .next。 */
  async feedScroll({ count = 10, onStep = null } = {}) {
    const page = await this.ensure();
    const steps = [];
    for (let i = 0; i < count; i++) {
      const before = await this.currentVideo();
      const dwellMs = planDwell({
        durationSec: before.durationSec,
        minMs: this.cfg.dwell.minMs,
        maxMs: this.cfg.dwell.maxMs,
        random: Math.random
      });
      await this.sleep(dwellMs);
      await page.click(SELECTORS.next, { timeout: 5000 }).catch(() => {});
      await this.sleep(900 + Math.round(Math.random() * 700));
      let after = await this.currentVideo();
      if (after.src === before.src && after.desc === before.desc) {
        // 偶发点击没生效（动画/Swiper 还在动），退一步再点一次
        await this.sleep(600);
        await page.click(SELECTORS.next, { timeout: 5000 }).catch(() => {});
        await this.sleep(900 + Math.round(Math.random() * 700));
        after = await this.currentVideo();
      }
      const step = {
        index: i + 1,
        dwellMs,
        durationSec: before.durationSec,
        likeText: after.likeText,
        changed: after.src !== before.src || after.desc !== before.desc
      };
      steps.push(step);
      if (onStep) await onStep(step);
    }
    return steps;
  }

  async like() {
    const page = await this.ensure();
    const before = await page.evaluate(() => (document.querySelector('.like-btn')?.innerText || '').trim());
    await page.evaluate(() => document.querySelector('.like-btn')?.click());
    await this.sleep(1200);
    const state = await page.evaluate(() => {
      const btn = document.querySelector('.like-btn');
      const cls = (btn?.className || '').toString();
      return {
        after: (btn?.innerText || '').trim(),
        // 赞数会被取整（4.4万 点完还是 4.4万），所以要看按钮的"已赞"样式/aria，
        // 只比文本会把成功误判成失败（真实踩到）
        active: /(^|\s)(active|liked|is-active|selected)(\s|$)/.test(cls) || btn?.getAttribute('aria-pressed') === 'true',
        className: cls,
        loginModal: /扫码登录|手机号登录|验证码登录|请先登录/.test(document.body.innerText || '')
      };
    });
    if (state.loginModal) {
      throw new Error('点赞需要登录：游客态点完会弹登录框。先登录一次（设置页扫码 / node cli.mjs web-login）');
    }
    // 没弹框但也没变化：多半还是没登录（快手对游客是静默忽略），必须说出来，
    // 否则上层会以为"点了但用户没点动"（真实踩到过）
    if (!state.active && before === state.after && !(await this.isLoggedIn())) {
      throw new Error('点赞未生效：当前是游客态（赞数没变，也没弹登录框）。扫码登录后再试');
    }
    return { before, after: state.after, changed: before !== state.after || Boolean(state.active), active: Boolean(state.active) };
  }

  async openComments() {
    const page = await this.ensure();
    // 关键：.side-area 一直在 DOM 里（滑出屏幕右侧），所以不能用 isVisible 判断；
    // 真正的判据是「面板里有没有评论内容」或「面板左边缘是否已进入视口」。
    const opened = await page.evaluate(() => {
      const panel = document.querySelector('.side-area');
      if (!panel) return false;
      const text = panel.innerText || '';
      if (/共s*\d+\s*条评论/.test(text)) return true;
      const r = panel.getBoundingClientRect();
      return r.width > 0 && r.x < window.innerWidth - 100;
    });
    if (opened) return true;
    await page.evaluate(() => document.querySelector('.comment')?.click());
    for (let i = 0; i < 12; i++) {
      await this.sleep(400);
      const ready = await page.evaluate(() => /共s*\d+\s*条评论/.test(document.querySelector('.side-area')?.innerText || ''));
      if (ready) return true;
    }
    return false;
  }

  async closeComments() {
    const page = await this.ensure();
    await page.keyboard.press('Escape').catch(() => {});
    await this.sleep(300);
    return true;
  }

  /**
   * 读评论（游客态也能读；返回 author/text/when/likes）。
   *
   * 优先按 DOM 结构取字段（.comment-list .comment-item 里的 .username .user / .content / 时间叶子节点），
   * 拿不到才回退到整块 innerText 的启发式解析 —— 后者会把「上一条的赞数」误当作者名。
   */
  async readComments({ limit = 50 } = {}) {
    await this.openComments();
    const page = await this.ensure();
    await page.waitForSelector(SELECTORS.panel, { timeout: 8000 });
    const items = await page.evaluate(() => {
      const root = document.querySelector('.side-area');
      const list = root?.querySelector('.comment-list') ?? root;
      const nodes = [...(list?.querySelectorAll('.comment-item') ?? [])];
      const timeRe = /^(刚刚|\d+\s*(秒|分钟|小时|天|周|月)前|\d{4}-\d{2}-\d{2})$/;
      return nodes.map((item) => {
        const author = (item.querySelector('.username .user, .username')?.innerText || '').trim();
        const contentEl = item.querySelector('.content');
        let text = (contentEl?.innerText || '').trim();
        if (!text && contentEl) {
          // 纯表情/纯图片评论：innerText 是空的，退回 alt 或给个占位（之前直接丢成 ""）
          const img = contentEl.querySelector('img');
          const alt = (img?.getAttribute('alt') || '').trim();
          text = alt && alt !== 'avatar' ? alt : (img ? '[表情]' : '');
        }
        const leaves = [...item.querySelectorAll('div,span')].filter((el) => el.children.length === 0);
        const when = leaves.map((el) => (el.innerText || '').trim()).find((t) => timeRe.test(t)) || '';
        let likeEl = [...item.querySelectorAll('[class*="like"]')].find((el) => /^[\d.]+\s*[万w]?$/i.test((el.innerText || '').trim()));
        if (!likeEl) {
          // 有些版本的点赞数没有 like 类名：取「时间行之后」的第一个纯数字叶子节点
          const idx = leaves.findIndex((el) => timeRe.test((el.innerText || '').trim()));
          if (idx >= 0) likeEl = leaves.slice(idx + 1).find((el) => /^\d+$/.test((el.innerText || '').trim()));
        }
        return { author, text, when, likes: likeEl ? (likeEl.innerText || '').trim() : '0' };
      }).filter((c) => c.author || c.text);
    });
    if (items.length) {
      return items
        .map((c) => ({ ...c, likes: normalizeCount(c.likes) ?? 0 }))
        .filter((c) => c.text || c.author)
        .slice(0, limit);
    }
    const raw = await page.evaluate(() => document.querySelector('.side-area')?.innerText ?? '');
    return parseCommentText(raw).slice(0, limit);
  }

  /**
   * 回一条评论。需要登录（未登录时快手会弹登录框，这里提前拦下来给明确提示）。
   * match：评论文本片段。
   */
  async replyToComment({ match, content, openPanel = true }) {
    if (!(await this.isLoggedIn())) {
      throw new Error('网页版回复评论需要先登录：在浏览器窗口里扫码登录一次，登录态会保存在 ' + this.profileDir());
    }
    const comments = openPanel
      ? await this.readComments({ limit: 100 })
      : parseCommentText(await this.ensure().then((p) => p.evaluate(() => document.querySelector('.side-area')?.innerText ?? '')));
    const target = comments.find((c) => c.text.includes(match));
    if (!target) {
      throw new Error(`评论面板里找不到包含「${match}」的评论（当前可见 ${comments.length} 条）`);
    }
    const page = await this.ensure();
    // 点这条评论（点内容所在行）→ 输入框出现 → 填入 → 回车
    await page.getByText(target.text, { exact: false }).first().click({ timeout: 5000 });
    await this.sleep(500);
    const input = page.locator(SELECTORS.commentInput).first();
    await input.click({ timeout: 5000 });
    await input.fill(content);
    await this.sleep(200);
    await page.keyboard.press('Enter');
    await this.sleep(1200);
    return { replied: content, matched: target.text, author: target.author };
  }

  async screenshot({ file } = {}) {
    const page = await this.ensure();
    const out = file || path.join(projectRoot(), 'state', `shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const buf = await page.screenshot({ path: out });
    return { file: out, bytes: buf.length };
  }

  /**
   * 发视频：走创作者服务平台（cp.kuaishou.com）的「上传视频」。
   * 必须已登录；未登录会停在登录页，这里直接报错而不是盲点。
   */
  async publishVideo({ file, caption = '' }) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`视频文件不存在：${abs}`);
    const page = await this.ensure({ url: 'https://cp.kuaishou.com/' });
    await page.waitForTimeout(2500);
    const needLogin = await page.evaluate(() => /登录|扫码/.test(document.body.innerText || '') && !/发布视频|作品管理/.test(document.body.innerText || ''));
    if (needLogin) {
      throw new Error('创作者服务平台未登录：先在打开的这个窗口里扫码登录，再重跑发布');
    }
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(abs);
    await this.sleep(4000);
    if (caption) {
      const box = page.locator('textarea, [contenteditable="true"]').first();
      await box.click({ timeout: 8000 });
      await box.fill(caption);
    }
    const btn = page.getByText('发布', { exact: true }).first();
    await btn.click({ timeout: 8000 });
    await this.sleep(2500);
    return { published: true, file: abs, caption };
  }
}
