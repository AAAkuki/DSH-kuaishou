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
import { execFileSync } from 'node:child_process';
import { projectRoot } from './config.mjs';
import { sanitizeReply } from './reply-guard.mjs';
import { detectEmotion, EMOTION_EMOJI } from './sticker.mjs';

/** 最近一次真实确认「已登录」的时间写进 state/web-login.json，供环境检查引用。 */
function persistLoginMarker(info = {}) {
  try {
    const file = path.join(projectRoot(), 'state', 'web-login.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ loggedIn: true, at: new Date().toISOString(), ...info }, null, 2), 'utf8');
  } catch {}
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 创作者后台的评论管理页：回"自己作品"的评论走这一页，比公共视频页可靠 */
const COMMENT_MANAGER_URL = 'https://cp.kuaishou.com/article/comment';

/**
 * 解析创作者首页「数据概览」那段文本，拿到自己的真实数据（纯函数，好测）。
 * 实际 innerText 压平后长这样：
 *   `… 数据概览 近期作品 时间 近7天 导出数据 播放量 昨日 +1.1万 1.1万 点赞量 昨日 +168 168 净增粉丝量 昨日 +8 8 完播率 21.0 …`
 */
export function parseCreatorStats(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const num = (s) => {
    const n = normalizeCount(String(s ?? '').replace(/^\+/, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const grab = (re) => { const m = re.exec(t); return m ? num(m[1]) : 0; };
  const plays = grab(/播放量[^0-9+]{0,8}\+?([\d.,]+\s*[万w亿]?)/);
  const likes = grab(/点赞量[^0-9+]{0,8}\+?([\d.,]+\s*[万w亿]?)/);
  const fansDelta = grab(/净增粉丝量[^0-9+]{0,8}\+?(-?[\d.,]+\s*[万w亿]?)/);
  const completion = (() => {
    const m = /完播率[^0-9]{0,6}([\d.]+)/.exec(t);
    return m ? Number(m[1]) : 0;
  })();
  // 「最新作品 #话题… 2832 7」：标题后面两个数 = 播放、点赞
  const last = (() => {
    const m = /最新作品\s*(.{0,60}?)\s(\d[\d,.]*[万w]?)\s+(\d[\d,.]*[万w]?)/.exec(t);
    return m ? { title: m[1].trim().slice(0, 30), plays: num(m[2]), likes: num(m[3]) } : null;
  })();
  return { plays, likes, fansDelta, completion, last, at: new Date().toISOString() };
}

/**
 * 解析评论管理页里一行 `.comment-item` 的文本（纯函数，方便单测）。
 * 形如：`鱿鱼的江苏入 4小时前 这个视频到底是真人做的还是由AI做的 0 回复 删除 举报 置顶`
 * 已经有回复时，整行会变成：
 *   `… 置顶 天晴瞪肥鱼回复鱿鱼的江苏入: 刚刚 真人剪的… 0 回复 删除 举报 收起回复`
 *
 * 这里的难点是**正文里本身也有数字和"回复"两个字**（"我回复了他 3 次"），
 * 所以不能拿第一个 `数字+回复` 当赞数，必须锚定行尾那串操作按钮：
 *   `0 回复 删除 举报 置顶 [展开查看N条回复] [回复块]`
 */
export function parseOwnCommentText(raw) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const row = norm(raw);
  if (!row) return { author: '', when: '', text: '', likes: 0, replies: [], rowText: '' };

  const TIME = String.raw`(?:刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|昨天|前天|\d{2}\.\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2})`;

  // ① 作者 + 时间：作者是紧挨在时间前面的那一截（时间要**捕获**，别回头再猜）
  const head = new RegExp(String.raw`^(.+?)\s+(${TIME})\s+([\s\S]*)$`).exec(row);
  if (!head) return { author: '', when: '', text: row, likes: 0, replies: [], rowText: row };
  const author = norm(head[1]);
  const when = norm(head[2]);
  // 先把「展开查看1条回复 / 收起回复」这种控件文字去掉：它没有空格、又含"回复"两个字，
  // 留着会被当成 `某人回复某人:` 的开头（实测把"展开查看1条"识别成回复作者）。
  const rest = norm(head[3])
    .replace(/展开查看\d+条回复|展开\d+条回复|收起回复/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * ② 先把"回复块"整体切出去：行内一旦出现 `某人回复某人: 时间`，后面全是子回复。
   * 之前没切，导致正文把子回复和它的按钮一起吞了（正文变成很长一串、赞数变成 0）。
   */
  const replyStartRe = new RegExp(String.raw`([^\s:：]+?)回复([^:：]+)[:：]\s*(${TIME})\s+`, 'g');
  const starts = [...rest.matchAll(replyStartRe)];
  const headPart = starts.length ? rest.slice(0, starts[0].index) : rest;

  // ③ 顶层评论的正文与赞数：取 headPart 里**最后一个** `N 回复 [删除]`
  //    （也兼容没有"回复"、只有 `8 删除` 的排布，见旧版评论管理页）
  const tailRe = /(\d+)\s*(?:回复|条回复|删除|举报|置顶)\s*(?:删除|举报|置顶)?/g;
  let last = null;
  for (const mm of headPart.matchAll(tailRe)) last = mm;
  let body = headPart;
  let likes = 0;
  if (last) {
    body = norm(headPart.slice(0, last.index));
    likes = Number(last[1]) || 0;
  }
  body = body.replace(/\s*(收起回复|展开查看\d+条回复|展开\d+条回复)\s*$/u, '').trim();

  // ④ 子回复：每条从它的起点切到下一个起点，再去掉尾巴上的按钮
  const replies = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const endIndex = i + 1 < starts.length ? starts[i + 1].index : rest.length;
    const rawText = rest.slice(s.index + s[0].length, endIndex);
    const cleaned = norm(rawText)
      .replace(/\s*\d+\s*(?:回复|条回复)\s*(?:删除|举报|置顶)?[\s\S]*$/u, '')
      .replace(/\s*(收起回复|展开查看\d+条回复)\s*/gu, ' ')
      .trim();
    const replyAuthor = norm(s[1]);
    if (!replyAuthor || !cleaned) continue;
    if (/^(展开|查看|收起|置顶|删除|举报)/.test(replyAuthor)) continue;
    replies.push({ author: replyAuthor, to: norm(s[2]), when: norm(s[3]), text: cleaned });
  }

  return { author, when, text: body, likes, replies, rowText: row };
}

/**
 * 解析「作品管理」页的表格文本（纯函数）。
 * 每一行长这样（压平后）：
 *   `已发布 2026-10-27 19:17 236 0 0 00:58 今天刷了六条，回了两句…`
 *   `已发布 10-26 00:54 4,103 1 9 00:58 刷 35 条，回 8 条`
 *   `未通过 2026-10-25 16:38 4,010 0 6 00:10 -`
 */
export function parseOwnWorksText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const blockRe = /(已发布|待发布|未通过|审核中|已删除)\s+((?:\d{4}-)?\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(\d{1,2}:\d{2})/g;
  const blocks = [...text.matchAll(blockRe)];
  const clean = (s) => String(s || '')
    .replace(/\s*(置顶|已置顶)\s*/gu, ' ')
    .replace(/\s*(已发布|待发布|未通过|审核中|已删除)\s*$/u, '')
    // 页面顶部的筛选条会被当成标题，这里统一剪掉
    .replace(/共\s*\d+\s*天/g, ' ')
    .replace(/全部作品|视频管理|作品管理|合集管理|时间范围|互动管理|数据中心|成长中心|创作服务|其他服务/g, ' ')
    .replace(/已发布\s+待发布\s+未通过|共\s*\d+\s*个作品/g, ' ')
    .replace(/^\s*\d{1,2}:\d{2}\s*/u, '')     // 行首的时长（00:45）
    .replace(/^[\s~-]+|[\s~-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const m = blocks[i];
    const endOfBlock = m.index + m[0].length;
    const nextStart = i + 1 < blocks.length ? blocks[i + 1].index : text.length;
    /**
     * 标题位置不固定：
     *   · 常规行：标题在统计块后面（"… 00:58 今天刷了六条…"）
     *   · 置顶行：标题在统计块前面（"# DeepSeek … 置顶 已发布 2026-10-26 …"）
     * 所以先看后面，只有第一行才回头看前面 —— 否则会把上一行的文案抢过来（实测踩到）。
     */
    const after = clean(text.slice(endOfBlock, nextStart));
    let before = '';
    if (i === 0) {
      // 第一行前面是整页头部；用**未清洗**的原文按"共 N 个作品"切开，再清洗
      const rawBefore = text.slice(0, m.index);
      const cut = Math.max(rawBefore.lastIndexOf('个作品'), rawBefore.lastIndexOf('个作品 '));
      const seg = cut >= 0 ? rawBefore.slice(cut + 3) : rawBefore.slice(-60);
      before = clean(seg).replace(/^\s*\d{1,2}:\d{2}\s*/u, '').replace(/^[\s~-]+/, '').trim();
    }
    const title = (after && after !== '-') ? after : (before && before !== '-' ? before.slice(-80) : '');
    out.push({
      status: m[1],
      at: `${m[2]} ${m[3]}`,
      plays: Number(String(m[4]).replace(/,/g, '')) || 0,
      likes: Number(String(m[5]).replace(/,/g, '')) || 0,
      comments: Number(String(m[6]).replace(/,/g, '')) || 0,
      duration: m[7],
      title: (title || '').slice(0, 80),
      href: ''
    });
  }
  return out;
}

/**
 * 把一张搜索卡片的文本解析成 {title, author, likes, href}（纯函数）。
 * 实测卡片长这样：
 *   `听说最近大家都在QQ养大肥鱼！🐟不急，现在就教你…\n腾讯QQ\n1.1万`
 *   `#DeepSeek登顶全球第一\n美丽浙江\n578`
 */
export function parseSearchCardText(raw, { href = '' } = {}) {
  const lines = String(raw || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return null;
  // 最后一行像赞数 → 它前面那行是作者，再前面是标题
  const likeIdx = lines.length - 1;
  const likes = /^\d[\d.,]*\s*[万w]?$/.test(lines[likeIdx]) ? lines[likeIdx] : '';
  let author = '';
  let titleLines = lines;
  if (likes) {
    author = lines.length >= 2 ? lines[likeIdx - 1] : '';
    titleLines = lines.slice(0, Math.max(1, likeIdx - 1));
  } else {
    // 没有赞数：最后一行短（≤12 字）就当作者
    const last = lines[lines.length - 1];
    if (lines.length >= 2 && last.length <= 12) {
      author = last;
      titleLines = lines.slice(0, -1);
    }
  }
  const title = titleLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) return null;
  return { title, author, likes, href: href || '' };
}

/**
 * 「1.7万」「3243」「1.2w」→ 数字（解析失败返回 null）。
 */
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

    /** 探测现有 context 是否还活着（浏览器被关/崩溃后必须重建，否则永远起不来）。 */
  async ensureAlive() {
    // 之前这里读的是 this.context，而启动时写的是 this.ctx —— 永远读不到，
    // 于是每次调用都重新 launch 一次浏览器（"网页不常驻"的根源）。统一用 this.ctx。
    if (!this.ctx) return false;
    try {
      await this.ctx.cookies();      // 常量级探活：挂了会抛
      const live = this.ctx.pages().filter((p) => !p.isClosed());
      if (this.page && !this.page.isClosed()) return true;
      if (live.length) { this.page = live[0]; return true; }
      this.page = await this.ctx.newPage();
      return true;
    } catch {
      try { await this.ctx.close?.(); } catch {}
      this.ctx = null;
      this.page = null;
      this.log?.('[kuaishou-web] 浏览器上下文已失效，重建中');
      return false;
    }
  }

/** 清掉 Edge profile 的 Singleton 锁（崩溃残留会让下次启动直接失败）。 */
  clearProfileLocks() {
    const dir = this.profileDir ? this.profileDir() : '';
    if (!dir || !fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(dir, f), { force: true }); n++; } catch {}
    }
    return n;
  }

  /**
   * 干掉"用我们这个登录目录的残留 Edge"。
   *
   * 场景：上一个进程（脚本/旧 MCP）把 Edge 留着没关，或者崩了。它一直占着 profile 锁，
   * 新的 launch 就会失败 —— 以前只会报错让人手动关，现在自己收拾。
   */
  killOrphanBrowsers() {
    const dir = this.profileDir();
    if (!dir) return 0;
    /**
     * 安全闸：如果**自己的浏览器还活着**就不许清。
     * 以前不加这层，两个调用同时进行时，后一个会把前一个刚起好的浏览器一起杀掉
     * （实测一次清掉 12 个 Edge，正在跑的页面直接没了）。
     */
    if (this.ctx && !this.ctx.isClosed?.() && this.ctx.pages?.().length) {
      this.log?.('[kuaishou-web] 自己的浏览器还活着，跳过清残留');
      return 0;
    }
    try {
      const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000 });
      const pids = String(out || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
      if (pids.length) this.log?.(`[kuaishou-web] 清掉 ${pids.length} 个残留 Edge：${pids.join(',')}`);
      return pids.length;
    } catch (error) {
      this.log?.(`[kuaishou-web] 清理残留 Edge 失败：${error.message}`);
      return 0;
    }
  }

  /**
   * 需要的时候才跳页。
   *
   * 坑点：`ensure()` 第一行是「页面开着就直接返回」，所以任何写在它后面的跳转都执行不到
   * —— 于是 `ensure({url:'.../manage/video'})` 会一直停在旧页面（评论管理页），
   * `ks_own_works` 读到的就是错的页。这里抽成独立方法，让两条返回路径都过一遍。
   */
  async gotoIfNeeded(url) {
    const FEED = 'https://www.kuaishou.com/';
    if (!url || url === FEED) return false;
    const page = this.page;
    if (!page || page.isClosed()) return false;
    const samePage = (a, b) => {
      try {
        const ua = new URL(a);
        const ub = new URL(b);
        if (ub.search) return ua.pathname === ub.pathname && ua.search.includes(ub.search.replace(/^\?/, ''));
        return ua.pathname === ub.pathname;
      } catch { return false; }
    };
    const cur = page.url();
    if (cur.startsWith('http') && samePage(cur, url)) return false;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await this.sleep(900);
    return true;
  }

async ensure({ url = 'https://www.kuaishou.com/' } = {}) {
    await this.ensureAlive();
    if (this.page && !this.page.isClosed()) {
      await this.gotoIfNeeded(url);
      return this.page;
    }
    const { chromium } = await import('playwright-core');
    const browserPath = resolveBrowserPath({ explicit: this.cfg.web?.browserPath || '' });
    if (!browserPath) throw new Error('没找到 Edge/Chrome：把浏览器路径写进 config.json 的 web.browserPath（或设 KSOPS_BROWSER）');
    const headless = this.cfg.web?.headless === true;
    const dir = this.profileDir();
    const launch = async () => {
      this.ctx = await chromium.launchPersistentContext(dir, {
        executablePath: browserPath || undefined,
        headless,
        viewport: { width: this.cfg.web?.width ?? 1600, height: this.cfg.web?.height ?? 1000 },
        locale: 'zh-CN',
        args: ['--disable-blink-features=AutomationControlled', '--mute-audio']
      });
    };
    fs.mkdirSync(dir, { recursive: true });
    let launchError = null;
    try {
      await launch();
    } catch (error) {
      launchError = error;
      // 被残留进程占着 → 清自己（只清用这个 profile 的 msedge）+ 清锁，再试一次
      const msg = String(error.message || '');
      if (/Target page, context or browser has been closed|ProcessSingleton|already in use|EBUSY/i.test(msg)) {
        this.log?.('[kuaishou-web] 启动失败，先清残留 Edge / 锁再重试');
        this.killOrphanBrowsers();
        this.clearProfileLocks();
        await this.sleep(1200);
        try {
          await launch();
          launchError = null;
        } catch (retryError) {
          launchError = retryError;
        }
      }
    }
    if (launchError) {
      const msg = String(launchError.message || '');
      if (/Target page, context or browser has been closed|ProcessSingleton|already in use|EBUSY/i.test(msg)) {
        throw new Error('浏览器启动失败：登录目录被占用，已自动清理残留进程仍失败。手动关掉所有自动化 Edge 窗口后重试。原始错误：' + msg.slice(0, 120));
      }
      throw launchError;
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    /**
     * 只有"页面还没打开"才 goto —— 这是原来的逻辑，但它有个大坑：
     * 页面已经在 cp.kuaishou.com 上（比如停在评论管理页），再调
     * `ensure({url:'.../article/manage/video'})` **不会跳转**，于是
     * `ks_own_works` 读到的是评论管理页（实测返回 count:0 / 一团文字）。
     * 现在：显式传了非默认 url 且路径不一致 → 真的跳过去（统一走 gotoIfNeeded）。
     */
    await this.gotoIfNeeded(url);
    await this.sleep(this.cfg.web?.settleMs ?? 3000);
    return this.page;
  }

  /**
   * 打开登录扫码页，并把二维码截图存下来。
   *
   * 为什么需要：www 的登录态会过期（实测 10-31 还能点赞，11-01 就变游客态，
   * 搜索直接 0 条、点赞/评论静默失败）。这时候唯一的解法是人扫一次码。
   */
  async showLoginQr({ file } = {}) {
    const page = await this.ensure({ url: 'https://www.kuaishou.com/' });
    // 先点右上角「登录」，没找到就直接去登录页
    const clicked = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div, span, button, a')];
      const hit = nodes.find((el) => el.children.length === 0 && /^(登录|立即登录)$/.test(String(el.innerText || '').trim()));
      if (hit) { hit.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) {
      await page.goto('https://www.kuaishou.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await this.sleep(2500);
    // 二维码一般在 canvas/img 里；等它出现
    await page.waitForTimeout(1200);
    const out = file || path.join(projectRoot(), 'state', `login-qr-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: false });
    const needLogin = !(await this.isLoggedIn());
    return { screenshot: out, needLogin, url: page.url(), clicked };
  }

  /**
   * 关掉浏览器。
   *
   * 默认**不关**（常驻）：反复启动/关闭是最容易出问题的一环 ——
   * 每次 launch 要 3~5 秒，profile 锁没清干净还会直接失败。
   * cfg.web.persist === false 时才真的关；真要关就走 closeForReal()。
   */
  async close({ force = false } = {}) {
    if (!force && this.cfg?.web?.persist !== false) {
      this.log?.('[kuaishou-web] 常驻：浏览器保持打开（要关就 close({force:true}) 或设 web.persist=false）');
      return;
    }
    try { await this.ctx?.close(); } catch {}
    this.ctx = null;
    this.page = null;
  }

  /** 真正关掉（MCP 进程退出、或用户点"关闭浏览器"时用） */
  async closeForReal() {
    return this.close({ force: true });
  }

  /** 是否已登录：页面上没有「立即登录/登录即可享受」，且能看到头像/个人入口。 */
  async isLoggedIn() {
    const page = await this.ensure();
    /**
     * 空白页/非快手页不能判成"已登录"。
     * 实测：页面停在 about:blank 时 `document.body.innerText` 是空的，
     * 于是"没有登录提示" → 误判 loggedIn=true（搜索结果却是 0 条）。
     */
    const url = page.url();
    if (!/^https?:\/\//.test(url) || !/kuaishou\.com/.test(url)) {
      return false;
    }
    const state = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      if (txt.trim().length < 20) return { loggedIn: false, hasAvatar: false, blank: true };
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
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const v = document.querySelector('video');
      const like = document.querySelector('.like-btn');
      const desc = document.querySelector('.video-desc, .video-info .desc, [class*="video-desc"]');
      const author = document.querySelector('.author-name, [class*="author"] [class*="name"], .profile-user-name');
      const commentBtn = document.querySelector('.comment-btn, [class*="comment"] [class*="count"]');

      /**
       * 兜底：新版推荐页的作者/文案在左下角，类名换来换去，上面那些选择器经常一条都匹配不到
       * （实测 author/desc 一直是空字符串）。这里按"位置 + 形状"再扫一遍：
       * 作者 = 以 @ 开头的那一行；文案 = 它下面那一行带 # 或比较长的那段。
       */
      let scanAuthor = '';
      let scanDesc = '';
      try {
        const h = window.innerHeight;
        const w = window.innerWidth;
        const cands = [];
        /**
         * 播放进度、控件、提示条都不能当"文案"。
         * 实测抓到过 "00:00 / 00:10" 和 "当前为静音，是否要打开声音?"（后者还被念进视频）。
         */
        const junkExact = /^(\d{1,2}:\d{2}(\s*\/\s*\d{1,2}:\d{2})?|\d+)$/;
        const junkPart = /是否要|打开声音|静音|倍速|连播|全屏|画中画|已关注|关注\+|举报|下载|拍同款|展开|收起|发送|分享到|复制链接|保存本地|不感兴趣/;
        const inToast = (el) => Boolean(el.closest('[class*="toast"], [class*="notice"], [class*="tip"], [class*="message"], [class*="popup"], [class*="dialog"]'));
        for (const el of document.querySelectorAll('span, div, a')) {
          if (el.children.length > 2) continue;
          if (inToast(el)) continue;
          const t = norm(el.innerText);
          if (!t || t.length > 120) continue;
          if (junkExact.test(t) || junkPart.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 8) continue;
          if (r.top < h * 0.45 || r.left < w * 0.12 || r.left > w * 0.85) continue;  // 左下角区域
          cands.push({ t, top: r.top, left: r.left });
        }
        cands.sort((a, b) => b.top - a.top || a.left - b.left);
        const authorHit = cands.find((c) => /^@[^\s]{1,20}/.test(c.t));
        scanAuthor = authorHit ? authorHit.t.replace(/^@/, '').replace(/\s*·.*$/, '').slice(0, 30) : '';
        // 文案优先要带话题的；没有就退而求其次取较长、且不是"@作者"的那行
        const descHit = cands.find((c) => c !== authorHit && c.t.includes('#'))
          || cands.find((c) => c !== authorHit && c.t.length >= 8 && !/^@/.test(c.t));
        scanDesc = descHit ? descHit.t.slice(0, 200) : '';
      } catch {}

      return {
        src: (v?.currentSrc || '').slice(0, 120),
        durationSec: Number(v?.duration ?? 0),
        currentSec: Number(v?.currentTime ?? 0),
        paused: Boolean(v?.paused),
        likeText: norm(like?.innerText),
        desc: norm(desc?.innerText).slice(0, 200) || scanDesc,
        author: norm(author?.innerText).slice(0, 30) || scanAuthor,
        commentText: norm(commentBtn?.innerText).slice(0, 20)
      };
    });
  }

  /**
   * 「我自己看这一条」：返回这条是什么，并按视频长度真的停一会儿。
   * 不是批量刷，是**一条一条看** —— agent 模式用它。
   */
  async watchCurrent({ maxSec = 30, minSec = 3 } = {}) {
    // 必须在推荐页才有视频：之前停在评论管理页时，这里读到一堆空字段还"看"了 3 秒
    const page = await this.ensure({ url: 'https://www.kuaishou.com/new-reco' });
    let info = await this.currentVideo();
    if (!info.durationSec && !info.src) {
      // 还读不到视频 → 滑一条试试（有些页面首屏是空白占位）
      await this.nextVideo().catch(() => {});
      await this.sleep(800);
      info = await this.currentVideo();
    }
    if (!info.durationSec && !info.src) {
      return { ...info, played: false, watchedSec: 0, hint: '当前页面没有视频（可能不在推荐页），先 ks_next 或重开浏览器' };
    }
    const dur = Number(info.durationSec) || 0;
    // 视频是暂停的就先点一下播放：不播的"看"没有意义（之前暂停时白等 30 秒）
    if (info.paused) {
      await page.click('video', { timeout: 3000 }).catch(() => {});
      await this.sleep(400);
    }
    // 真人不会每条都看满：按 60%~100% 的时长停留，再用 maxSec 截断
    const plan = dur ? Math.min(maxSec, Math.max(minSec, dur * (0.6 + Math.random() * 0.4))) : minSec;
    await this.sleep(Math.round(plan * 1000));
    const after = await this.currentVideo();
    return {
      ...after,
      desc: after.desc || info.desc,
      author: after.author || info.author,
      played: info.paused ? true : !after.paused,
      watchedSec: Math.round(plan)
    };
  }

  /** 滑到下一条（单条），返回新的这条是什么 */
  async nextVideo() {
    const page = await this.ensure();
    const before = await this.currentVideo();
    await page.click(SELECTORS.next, { timeout: 5000 }).catch(() => {});
    await this.sleep(1200 + Math.round(Math.random() * 900));
    let after = await this.currentVideo();
    if (after.src === before.src && after.desc === before.desc) {
      await this.sleep(700);
      await page.click(SELECTORS.next, { timeout: 5000 }).catch(() => {});
      await this.sleep(1200 + Math.round(Math.random() * 900));
      after = await this.currentVideo();
    }
    return { ...after, changed: after.src !== before.src || after.desc !== before.desc };
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
        // 文案（视频描述）—— 学"梗"就靠它
        desc: String(after.desc || before.desc || '').slice(0, 200),
        changed: after.src !== before.src || after.desc !== before.desc
      };
      steps.push(step);
      if (onStep) await onStep(step);
    }
    return steps;
  }

  async like() {
    const page = await this.ensure();
    const read = () => page.evaluate(() => {
      const btn = document.querySelector('.like-btn') || document.querySelector('[class*="like-btn"]');
      const cls = (btn?.className || '').toString();
      // 往上三层看有没有 active/liked 类：真实页面的"已赞"样式经常挂在父节点上
      let parentCls = '';
      let p = btn;
      for (let i = 0; i < 3 && p; i++) { p = p.parentElement; parentCls += ' ' + (p?.className || ''); }
      const all = `${cls} ${parentCls}`;
      const svg = btn?.querySelector('svg') || btn?.querySelector('img');
      return {
        text: (btn?.innerText || '').trim(),
        cls,
        active: /(^|\s)(active|liked|is-active|selected)(\s|$)/.test(all) || btn?.getAttribute('aria-pressed') === 'true'
      };
      void svg;
    });
    const before = await read();

    /**
     * 用**真实鼠标事件**点：之前是 evaluate 里 el.click()，
     * 实测在这个页面点不动（赞数不变、active 也是 false），上层只能当"已赞过"跳过。
     */
    let clicked = false;
    for (const sel of ['.like-btn', '[class*="like-btn"]', '.like-btn svg', '[class*="like"] svg']) {
      const loc = page.locator(sel).first();
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      await loc.click({ timeout: 4000 }).catch(() => {});
      clicked = true;
      break;
    }
    if (!clicked) {
      await page.evaluate(() => document.querySelector('.like-btn')?.click());
    }
    await this.sleep(1200);
    const after = await read();

    const loginModal = await page.evaluate(() => /扫码登录|手机号登录|验证码登录|请先登录/.test(document.body.innerText || ''));
    if (loginModal) {
      throw new Error('点赞需要登录：游客态点完会弹登录框。先登录一次（设置页扫码 / node cli.mjs web-login）');
    }
    if (!after.active && before.text === after.text && !(await this.isLoggedIn())) {
      throw new Error('点赞未生效：当前是游客态（赞数没变，也没弹登录框）。扫码登录后再试');
    }
    /**
     * 判定成功：赞数变了，或者出现"已赞"样式。
     * 注意赞数可能是"4.6万"这种取整值，点完还是 4.6万 —— 这时不能判失败，
     * 只要确实点到了按钮、没弹登录框，就按"点了"处理（active 拿不到也不骗人）。
     */
    const countChanged = before.text !== after.text;
    const succeeded = countChanged || Boolean(after.active) || clicked;
    return {
      before: before.text,
      after: after.text,
      changed: countChanged || Boolean(after.active),
      active: Boolean(after.active),
      clicked,
      rounded: /万|w/i.test(before.text),
      note: succeeded ? '' : '没点到点赞按钮（页面可能变了）'
    };
  }

  /**
   * 关键词搜索：打开搜索页，读前 N 条结果的标题/作者/点赞。
   * @returns {{keyword:string, count:number, items:Array<{title:string,author:string,likes:string,href:string}>}}
   */
  async searchVideos({ keyword, limit = 8 } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('搜索关键词不能为空');
    const url = `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(kw)}`;
    const page = await this.ensure({ url });
    try {
      if (!/search/.test(page.url()) || !page.url().includes(encodeURIComponent(kw))) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
    } catch {}
    await page.waitForTimeout(4000);

    /**
     * 结果卡片：新搜索页的卡片**不是 <a> 链接**（全是 div），
     * 以前按 `a[href*="/short-video/"]` 抓，结果永远是 0 条（实测搜索结果有 12 条、读到 0）。
     * 现在改成按"卡片形状"抓：一块区域里 2~4 行，最后一行是数字（赞数），
     * 倒数第二行是作者，前面那行是标题。href 抓不到就给空，不装作有链接。
     *
     * 另外：冷启动时页面要 4 秒以上才渲染出卡片（实测同一关键词昨天 6 条、今天 0 条），
     * 所以这里**重试 3 轮**，每轮往下滚一点触发懒加载。
     */
    const extract = (max) => page.evaluate((limitN) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const seen = new Set();
      // ① 先按老结构抓链接（旧版页面还能用）
      for (const a of document.querySelectorAll('a[href*="/short-video/"], a[href*="/photo/"]')) {
        const href = a.getAttribute('href') || '';
        const box = a.closest('li, div');
        const text = norm(box ? box.innerText : a.innerText);
        if (!text) continue;
        const key = 'a:' + href + text.slice(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, href });
        if (out.length >= limitN) break;
      }
      // ② 再按卡片形状抓（新版搜索页没有链接）
      if (out.length < limitN) {
        for (const el of document.querySelectorAll('div, li')) {
          const lines = String(el.innerText || '').split('\n').map(norm).filter(Boolean);
          if (lines.length < 2 || lines.length > 4) continue;
          const last = lines[lines.length - 1];
          if (!/^\d[\d.,]*\s*[万w]?$/.test(last)) continue;          // 最后一行是赞数
          if (lines[0].length < 6) continue;                          // 第一行是标题
          const r = el.getBoundingClientRect();
          if (r.width < 140 || r.width > 520 || r.height < 120) continue;
          const key = 'c:' + lines.join('|').slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ text: lines.join('\n'), href: '' });
          if (out.length >= limitN) break;
        }
      }
      return out;
    }, max).catch(() => []);

    let raw = [];
    for (let i = 0; i < 3; i++) {
      raw = await extract(limit);
      if (raw.length) break;
      await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
      await page.waitForTimeout(2500);
    }

    const items = raw.map((x) => parseSearchCardText(x.text, { href: x.href })).filter(Boolean).slice(0, limit);
    return { keyword: kw, count: items.length, items };
  }

  /** 读当前视频的描述与 #话题标签（用来做"视频标签白名单"）。 */
  async readVideoTags() {
    const page = await this.ensure();
    const info = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const cands = [
        '[class*="video-info"]', '[class*="video-desc"]', '[class*="desc"]', '.video-desc',
        '[class*="author-info"]', '[class*="caption"]'
      ];
      let text = '';
      for (const sel of cands) {
        for (const el of document.querySelectorAll(sel)) {
          const t = norm(el.innerText);
          if (t.length > text.length && /#/.test(t)) text = t;
        }
      }
      // 兜底：整页里"像视频描述"的那一行（含 # 且不在评论区）
      if (!text) {
        const area = document.querySelector('.side-area');
        const all = norm(document.body.innerText);
        const lines = all.split(/\n+/).map(norm).filter((l) => /#/.test(l) && (!area || !area.innerText.includes(l)));
        if (lines.length) text = lines[0];
      }
      const tags = [];
      for (const m of text.matchAll(/#([^\s#，。,.!?！？、]+)/g)) {
        const t = m[1].trim();
        if (t && !tags.includes(t)) tags.push(t);
      }
      return { text: text.slice(0, 300), tags };
    }).catch(() => ({ text: '', tags: [] }));
    return info;
  }

  /** 读评论区顶部的「共 N 条评论」，用来判断评论是否真的发出去。 */
  async readCommentCount() {
    const page = await this.ensure();
    const n = await page.evaluate(() => {
      const area = document.querySelector('.side-area') || document.body;
      const t = (area.innerText || '').slice(0, 600);
      const m = t.match(/共\s*(\d+)\s*条评论/);
      return m ? Number(m[1]) : null;
    }).catch(() => null);
    return n;
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
    const before = await this.readCommentCount();
    await input.click({ timeout: 5000 });
    // 出口把关：不许冒充真人（"真人剪的"这种话发不出去）
    {
      const g = sanitizeReply(content);
      if (g.changed) this.log?.(`[reply-guard] ${g.reason}`);
      content = g.text;
    }
    await input.fill(content);
    await this.sleep(400);

    const sendBtn = page.locator('button:has-text("发送"), [class*="send"]').first();
    let sent = false;
    if (await sendBtn.count().catch(() => 0)) {
      await sendBtn.click({ timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    if (!sent) {
      await input.press('Enter', { timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    await this.sleep(2000);

    const afterCount = await this.readCommentCount();
    const countGrew = before != null && afterCount != null && afterCount > before;
    return {
      replied: content, matched: target.text, author: target.author,
      sent, countBefore: before, countAfter: afterCount, verified: countGrew,
      note: countGrew ? '评论数 +1，确认发送成功' : '评论数没变，可能没发出去（内容被拦截或按钮没点中）'
    };
  }

  /**
   * 用表情包回一条评论（网页版）。
   *
   * 诚实策略：网页版评论框是纯文本 <input>，**本地图片表情包发不进去**。
   * 所以按能力分三档，发了什么就在 stickerSent 里如实说：
   *   image         表情面板里有图片表情（收藏的表情包），点了一张
   *   emoji         面板里只有文字 emoji，按对方评论的情绪点了一个
   *   text-fallback 连表情入口都没找到 → 把情绪 emoji 拼进文案（fallbackEmoji=false 时不拼）
   */
  async replyWithSticker({ match, content = '', sticker = '', mode = 'append', openPanel = true, fallbackEmoji } = {}) {
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
    const emotion = detectEmotion(target.text);
    const page = await this.ensure();
    await page.getByText(target.text, { exact: false }).first().click({ timeout: 5000 });
    await this.sleep(500);

    const input = page.locator(SELECTORS.commentInput).first();
    const before = await this.readCommentCount();
    await input.click({ timeout: 5000 });

    // 文字部分（append 模式；only 模式只发图）
    let text = String(content ?? '');
    if (mode !== 'only' && text.trim()) {
      const g = sanitizeReply(text);
      if (g.changed) this.log?.(`[reply-guard] ${g.reason}`);
      text = g.text;
      await input.fill(text);
      await this.sleep(300);
    }

    // 表情部分
    const wantFallback = fallbackEmoji ?? this.cfg?.reply?.sticker?.fallbackEmoji !== false;
    let stickerResult = await this._tryStickerPanel({ sticker, emotion });
    if (stickerResult.kind === 'none' && wantFallback) {
      // 降级：输入框还聚焦着，把情绪 emoji 打到文案末尾（only 模式没文字时它就是全部内容）
      const emoji = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.calm;
      try {
        await input.press('End').catch(() => {});
        await page.keyboard.type(emoji, { delay: 30 });
        stickerResult = { kind: 'text-fallback', emoji, reason: stickerResult.reason };
      } catch {}
    }

    const sendBtn = page.locator('button:has-text("发送"), [class*="send"]').first();
    let sent = false;
    if (await sendBtn.count().catch(() => 0)) {
      await sendBtn.click({ timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    if (!sent) {
      await input.press('Enter', { timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    await this.sleep(2000);

    const afterCount = await this.readCommentCount();
    const countGrew = before != null && afterCount != null && afterCount > before;
    return {
      replied: text, matched: target.text, author: target.author,
      emotion,
      stickerSent: stickerResult.kind,
      sticker: stickerResult.file || stickerResult.emoji || '',
      stickerNote: stickerResult.reason || '',
      sent, countBefore: before, countAfter: afterCount, verified: countGrew,
      note: countGrew ? '评论数 +1，确认发送成功' : '评论数没变，可能没发出去（内容被拦截或按钮没点中）'
    };
  }

  /**
   * 打开评论框旁边的表情面板，能点什么点什么。
   * 返回 { kind: 'image'|'emoji'|'none', file?, emoji?, reason? } —— 不抛错，找不到就 none。
   */
  async _tryStickerPanel({ sticker = '', emotion = 'calm' } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return { kind: 'none', reason: '页面已关闭' };

    // 表情入口：评论区范围内的 emoji/表情 按钮（快手网页版一般在输入框右侧）
    const entrySel = '.side-area [class*="emoji"], .side-area [class*="emotion"], .side-area [class*="sticker"], .side-area [title*="表情"], .side-area [aria-label*="表情"]';
    const entry = page.locator(entrySel).first();
    if (!(await entry.count().catch(() => 0))) {
      return { kind: 'none', reason: '评论框旁边没找到表情按钮（网页版可能不支持表情包评论）' };
    }
    await entry.click({ timeout: 4000 }).catch(() => {});
    await this.sleep(700);

    // ① 面板里的图片表情（img）：指定了文件名就按 src/alt 对，否则随机一张
    const imgSel = '[class*="emoji"] img, [class*="emotion"] img, [class*="sticker"] img';
    const imgs = await page.evaluate((sel) => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 16 && r.height >= 16 && r.bottom > 0 && r.top < window.innerHeight;
      };
      return [...document.querySelectorAll(sel)].filter(vis)
        .map((el) => ({ alt: el.getAttribute('alt') || '', src: (el.getAttribute('src') || '').slice(-100) }));
    }, imgSel).catch(() => []);
    if (imgs.length) {
      let idx = -1;
      const want = String(sticker || '').trim().toLowerCase();
      if (want) {
        const base = want.replace(/\.[a-z0-9]+$/i, '');
        idx = imgs.findIndex((i) => i.src.toLowerCase().includes(base) || i.alt.toLowerCase().includes(base));
      }
      if (idx < 0) idx = Math.floor(Math.random() * imgs.length);
      const target = page.locator(`${imgSel} >> visible=true`).nth(idx);
      await target.click({ timeout: 4000 }).catch(() => {});
      return { kind: 'image', file: imgs[idx]?.alt || imgs[idx]?.src || '', reason: want && idx >= 0 ? '' : '没对上指定文件名，随机挑了一张' };
    }

    // ② 文字 emoji 按钮：按情绪偏好挑（面板里没有图片表情时）
    const emojis = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 12 && r.height >= 12 && r.bottom > 0 && r.top < window.innerHeight;
      };
      return [...document.querySelectorAll('[class*="emoji"] span, [class*="emoji"] button, [class*="emoji"] li, [class*="emotion"] span, [class*="emotion"] button')]
        .filter((el) => vis(el) && /^\p{Extended_Pictographic}{1,3}$/u.test((el.textContent || '').trim()))
        .map((el) => (el.textContent || '').trim());
    }).catch(() => []);
    if (emojis.length) {
      const preferred = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.calm;
      const pick = emojis.includes(preferred) ? preferred : emojis[Math.floor(Math.random() * emojis.length)];
      const clicked = await page.evaluate((e) => {
        const els = [...document.querySelectorAll('[class*="emoji"] span, [class*="emoji"] button, [class*="emoji"] li, [class*="emotion"] span, [class*="emotion"] button')];
        const el = els.find((x) => (x.textContent || '').trim() === e);
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }, pick).catch(() => false);
      if (clicked) return { kind: 'emoji', emoji: pick, reason: '面板里没有图片表情，点了文字 emoji' };
    }

    // 面板没开起来：收起，别留一个遮罩把发送按钮挡住
    await page.keyboard.press('Escape').catch(() => {});
    return { kind: 'none', reason: '表情面板里既没有图片表情也没有 emoji' };
  }

  /** 直接发一条评论（不针对某条回复）。返回是否成功 + 页面上的证据。 */
  async postComment({ content } = {}) {
    if (!content || !String(content).trim()) throw new Error('content 不能为空');
    if (!(await this.isLoggedIn())) throw new Error('发评论需要先登录：在浏览器窗口里扫码一次');
    const page = await this.ensure();
    await this.openComments();
    await this.sleep(600);

    const input = page.locator(SELECTORS.commentInput).first();
    const n = await input.count().catch(() => 0);
    if (!n) throw new Error('页面上找不到评论输入框（可能需要先点开评论区）');

    const before = await this.readCommentCount();
    await input.click({ timeout: 8000 });
    {
      const g = sanitizeReply(content);
      if (g.changed) this.log?.(`[reply-guard] ${g.reason}`);
      content = g.text;
    }
    await input.fill(String(content));
    await this.sleep(400);

    // 先试「发送」按钮；没有就在输入框元素内按 Enter（关键：不要用 page.keyboard，
    // 焦点不在输入框时 Enter 会触发"下一个视频"，评论没发出去、视频还跳走了）
    const sendBtn = page.locator('button:has-text("发送"), [class*="send"]').first();
    let sent = false;
    if (await sendBtn.count().catch(() => 0)) {
      await sendBtn.click({ timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    if (!sent) {
      await input.press('Enter', { timeout: 5000 }).then(() => { sent = true; }).catch(() => {});
    }
    await this.sleep(2500);

    const afterCount = await this.readCommentCount();
    const after = await this.readComments({ limit: 30 });
    const appeared = after.some((c) => (c.text || '').includes(String(content).slice(0, 8)));
    const countGrew = before != null && afterCount != null && afterCount > before;
    return {
      commented: appeared || countGrew,
      content: String(content),
      sent,
      appeared,
      countBefore: before, countAfter: afterCount,
      readBack: after.length
    };
  }

  /** 读某条评论下面的回复（用来确认"回复真的发出去了"）。 */
  async readSubReplies({ match } = {}) {
    const page = await this.ensure();
    await this.openComments();
    await this.sleep(500);
    const clicked = await page.getByText(match, { exact: false }).first().click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (!clicked) return { found: false, replies: [] };
    await this.sleep(1500);
    const text = await page.evaluate(() => {
      // 展开后，回复一般挂在同一条评论的容器里
      const area = document.querySelector('.side-area') || document.body;
      return (area.innerText || '').slice(0, 4000);
    });
    return { found: true, text };
  }

  /**
   * 读「作品管理」页的汇总：共 N 个作品 + 每条的状态。
   * 发布是否成功，最终以这里的作品数 +1 为准（比 toast 可靠）。
   */
  async readWorksSummary() {
    const page = await this.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' });
    try {
      if (!/cp\.kuaishou\.com/.test(page.url())) {
        await page.goto('https://cp.kuaishou.com/article/manage/video', { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
    } catch {}
    await page.waitForTimeout(3000);

    const info = await page.evaluate(() => {
      const text = (document.body.innerText || '');
      const flat = text.replace(/\s+/g, ' ');
      const m = flat.match(/共\s*(\d+)\s*个作品/);
      const count = m ? Number(m[1]) : null;
      // 抓「已发布 / 审核中 / 未通过」这些状态词，判断最近一条的处境
      const statuses = [...flat.matchAll(/(已发布|审核中|未通过|待发布)/g)].map((x) => x[1]);
      return { count, statuses: statuses.slice(0, 5), snippet: flat.slice(0, 300) };
    }).catch(() => ({ count: null, statuses: [], snippet: '' }));
    return info;
  }

  /** 打开"我自己的作品"，返回作品列表（标题/链接）。 */
  async listOwnWorks({ limit = 5 } = {}) {
    const sum = await this.readWorksSummary();
    const page = await this.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' });
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const text = norm(document.body.innerText || '');
      return { text };
    }).catch(() => ({ text: '' }));

    // 页面上是一张表：状态 / 日期 时间 / 播放 / 赞 / 评论 / 时长 / 标题
    // 以前按"状态词前一段当标题"抓，结果把整行数字都当标题（实测一团乱），这里按表格行解析。
    const parsed = parseOwnWorksText(info.text);
    const works = parsed.slice(0, limit).map((w, i) => ({
      href: w.href || '', title: w.title || '(无标题)', index: i,
      status: w.status, at: w.at, plays: w.plays, likes: w.likes, comments: w.comments, duration: w.duration
    }));

    return {
      count: sum.count || parsed.length,
      statuses: parsed.length ? [...new Set(parsed.map((w) => w.status))] : (sum.statuses || []),
      works,
      pageText: info.text.slice(0, 400) || sum.snippet || ''
    };
  }

  /**
   * 打开创作者后台的「评论管理」页。
   *
   * 为什么要单独一条路：回自己作品的评论，公共视频页那条路走不通
   * （www.kuaishou.com 需要另一份登录态，而且自己作品页的评论区结构不一样）。
   * 创作者后台这一页 `.comment-item` 直接列出自己所有作品的评论，带 回复/删除/举报/置顶。
   */
  async ensureCommentManager() {
    const page = await this.ensure({ url: COMMENT_MANAGER_URL });
    if (!page.url().includes('/article/comment')) {
      await page.goto(COMMENT_MANAGER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    await page.waitForSelector('.comment-item', { timeout: 12000 }).catch(() => {});
    await this.sleep(800);
    return page;
  }

  /** 读自己的真实数据（播放量 / 点赞 / 净增粉丝 / 完播率 / 最新作品） */
  async readMyStats() {
    const page = await this.ensure({ url: 'https://cp.kuaishou.com/profile' });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => String(document.body.innerText || '')).catch(() => '');
    return parseCreatorStats(text);
  }

  /** 展开所有"共 N 条回复 / 展开回复"（不展开的话读不到子回复） */
  async expandOwnReplies(page) {
    let total = 0;
    // 用 Playwright 的 text 选择器点：页面上的「展开查看1条回复」是带处理器的元素，
    // JS 里直接 el.click() 点不动（实测无效），必须走真实鼠标事件。
    for (const sel of ['text=展开查看', 'text=条回复', 'text=展开回复']) {
      for (let i = 0; i < 10; i++) {
        const loc = page.locator(sel).first();
        const n = await loc.count().catch(() => 0);
        if (!n) break;
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) break;
        await loc.click({ timeout: 4000 }).catch(() => {});
        await this.sleep(700);
        total += 1;
      }
    }
    return total;
  }

  /** 当前评论管理页选中的是哪个作品（页面顶部有作品名/日期） */
  async readCommentManagerWork() {
    const page = await this.ensureCommentManager();
    return page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const head = norm(document.body.innerText).split('全部评论')[0] || '';
      return { title: head.slice(-120) };
    }).catch(() => ({ title: '' }));
  }

  /**
   * 读自己作品下的评论（评论管理页里的全部评论）。
   * 每项带 `replies`：这条下面已经有的回复（我们回过的会在这里出现）。
   */
  async listOwnComments({ limit = 50 } = {}) {
    const page = await this.ensureCommentManager();
    // 子回复默认是折叠的（折叠时 innerText 里根本没有回复内容，会误判成"没回成功"）
    await this.expandOwnReplies(page);
    // 页面里只取每行的纯文本，解析交给纯函数（同一条逻辑好测）
    const rows = await page.evaluate(() => [...document.querySelectorAll('.comment-item')]
      .map((el) => String(el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    ).catch(() => []);
    return rows.map((r) => parseOwnCommentText(r)).filter((c) => c.text || c.author).slice(0, limit);
  }

  /**
   * 回一条自己作品下的评论。
   * 流程：找那一行 → 点「回复」（回复框会带 placeholder「回复 XX：」）→ 填 → 点「确认」→ 回读校验。
   */
  async replyOwnComment({ match, content } = {}) {
    if (!content || !String(content).trim()) throw new Error('content 不能为空');
    const page = await this.ensureCommentManager();
    const before = await this.listOwnComments({ limit: 100 });
    const target = before.find((c) => c.text && c.text.includes(String(match)));
    if (!target) {
      throw new Error(`评论管理里找不到包含「${match}」的评论（当前 ${before.length} 条）`);
    }

    const row = page.locator('.comment-item').filter({ hasText: target.text }).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    // 悬停后操作按钮才可点
    await row.hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const replyBtn = row.locator('text=回复').first();
    if (!(await replyBtn.count().catch(() => 0))) throw new Error('这一行没有「回复」按钮（可能只有作者能回，或页面结构变了）');
    await replyBtn.click({ timeout: 5000 });

    // 回复框：优先用带「回复 XX」placeholder 的那个
    const box = row.locator('.comment-input, [contenteditable="true"]').first();
    await box.waitFor({ timeout: 6000 });
    const ph = await box.getAttribute('placeholder').catch(() => null);
    await box.click({ timeout: 5000 }).catch(() => {});
    {
      const g = sanitizeReply(content);
      if (g.changed) this.log?.(`[reply-guard] ${g.reason}`);
      content = g.text;
    }
    await box.fill(String(content));
    await page.waitForTimeout(300);

    // 确认按钮在这一行的 .comment-input__wrapper 里
    const okBtn = row.locator('text=确认').first();
    let clicked = false;
    if (this.cfg?.dryRun) {
      // 演练模式：字已经填进去了，但不点确认 —— 用来验证"点得开、填得上"而不真的发出去
      const cancel = row.locator('text=取消').first();
      if (await cancel.count().catch(() => 0)) await cancel.click({ timeout: 3000 }).catch(() => {});
      return {
        replied: content, matched: target.text, author: target.author,
        placeholder: ph || '', sent: false, dryRun: true, verified: false,
        note: 'dryRun：回复框已定位并填好，但没有点确认（没真的发出去）'
      };
    }
    if (await okBtn.count().catch(() => 0)) {
      await okBtn.click({ timeout: 5000 }).then(() => { clicked = true; }).catch(() => {});
    }
    if (!clicked) {
      // 有些版本是「发送」
      const send = row.locator('text=发送').first();
      if (await send.count().catch(() => 0)) await send.click({ timeout: 5000 }).then(() => { clicked = true; }).catch(() => {});
    }
    await page.waitForTimeout(2500);

    // 回读校验：自己发出去的回复是**嵌在那条评论下面**的（天晴瞪肥鱼回复XX: …），
    // 不是新的一条顶层评论 —— 所以要看 replies / rowText，只看 text 永远"没发出去"。
    const after = await this.listOwnComments({ limit: 100 });
    const short = String(content).slice(0, 8);
    const matchedRow = after.find((c) => (c.rowText || '').includes(target.text.slice(0, 8)))
      || after.find((c) => (c.text || '').includes(String(match)));
    const nested = Boolean(matchedRow && ((matchedRow.replies || []).some((r) => String(r.text || '').includes(short)))
      || (matchedRow?.rowText || '').includes(short));
    return {
      replied: content,
      matched: target.text,
      author: target.author,
      placeholder: ph || '',
      sent: clicked,
      verified: nested,
      nested,
      countBefore: before.length,
      countAfter: after.length,
      replies: row?.replies ?? [],
      note: nested ? '回读能在评论下面看到这条回复，确认发送成功'
        : (clicked ? '点了确认但回读没看到（可能被拦截/还在审核）' : '没找到确认按钮，没发出去')
    };
  }

  /**
   * 打开创作者后台的「评论管理」页（等价 ensureCommentManager，名字更直白）。
   */
  async openOwnWorks() {
    return this.ensureCommentManager();
  }

  /** 打开自己的某个作品页（用列表第 n 个）。 */
  async openOwnWork({ index = 0 } = {}) {
    const list = await this.listOwnWorks({ limit: 10 });
    if (!list.works.length) {
      throw new Error(`作品管理里没找到作品（共 ${list.count ?? '?'} 个）。页面文本：${String(list.pageText || '').slice(0, 120)}`);
    }
    const w = list.works[Math.min(index, list.works.length - 1)];
    if (w.href) {
      const page = await this.ensure({ url: w.href.startsWith('http') ? w.href : `https://www.kuaishou.com${w.href}` });
      await page.waitForTimeout(3000);
      return { opened: page.url(), href: w.href, title: w.title };
    }
    // 没有链接：按索引点作品卡片
    // 注意：以前是 `[class*="work"],[class*="feed"],[class*="item"]` 一把抓，
    // 结果点到了侧边栏的「成长中心」，页面直接跳走（实测 opened=.../growth/main）。
    // 现在只认"在作品表格里、且带视频/封面"的卡片，点不到就报错，不乱点。
    const page = await this.ensure({ url: 'https://cp.kuaishou.com/article/manage/video' });
    await page.waitForTimeout(1500);
    const clicked = await page.evaluate((idx) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const inNav = (el) => Boolean(el.closest('nav, aside, [class*="sidebar"], [class*="menu"]'));
      const cards = [...document.querySelectorAll('div, li')]
        .filter((el) => {
          if (inNav(el)) return false;
          if (!el.querySelector('img, video')) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 80) return false;      // 排除小图标
          if (r.left < 120) return false;                          // 排除左侧导航区
          const t = norm(el.innerText);
          return /已发布|待发布|未通过|审核中|\d{1,2}:\d{2}/.test(t);
        })
        // 由外到内排序：外层卡片优先
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height
                      - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
      const el = cards[idx];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }, index).catch(() => false);
    await page.waitForTimeout(3000);
    const after = page.url();
    // 点完还在作品管理页（或弹了预览）才算合理；跳到别的频道就是点错了
    if (!/manage\/video|short-video|\/photo\//.test(after)) {
      throw new Error(`点了作品卡片后跳到了别处（${after}），说明没点中，先不打开`);
    }
    return { opened: after, clicked, title: w.title, note: clicked ? '已点开作品卡片' : '没找到可点的作品卡片' };
  }

  /**
   * 收拾标签页：只留一个"有用的"页面，关掉 about:blank 和重复的快手页。
   * @param {object} opts keepUrls 需要保留的 URL 片段（默认保留快手相关页）
   * @returns {{closed:number, kept:string[]}}
   */
  async tidyTabs({ keepUrls = ['kuaishou.com', 'cp.kuaishou.com'] } = {}) {
    if (!this.context) return { closed: 0, kept: [] };
    const pages = this.context.pages();
    if (pages.length <= 1) return { closed: 0, kept: pages.map((p) => p.url()) };

    // 优先保留：当前活动页 > 最后一个快手页
    const useful = pages.filter((p) => keepUrls.some((k) => (p.url() || '').includes(k)));
    const keep = useful.length ? useful[useful.length - 1] : pages[0];

    let closed = 0;
    for (const p of pages) {
      if (p === keep) continue;
      const url = p.url() || '';
      const isBlank = url === 'about:blank' || url === '' || url === 'about:newtab';
      const isDuplicateKuaishou = keepUrls.some((k) => url.includes(k));
      // 空白页一律关；重复的快手页也关（真正的发布页保留在 keep 里）
      if (isBlank || isDuplicateKuaishou) {
        try { await p.close(); closed++; } catch {}
      }
    }
    // 让保留页成为前台
    try { await keep.bringToFront(); } catch {}
    return { closed, kept: [keep.url()] };
  }

  /** 诊断：列出页面上所有看起来像按钮的元素（文字/位置/是否禁用），用于排查点不到。 */
  async debugButtons({ scrollToBottom = true } = {}) {
    const page = await this.ensure();
    if (scrollToBottom) {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(700);
      }
    }
    const info = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('button, [role="button"], div, span, a')) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!txt || txt.length > 8) continue;
        if (el.children.length > 0 && el.querySelector('button')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.height < 12) continue;
        const key = `${txt}|${Math.round(r.x)},${Math.round(r.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cls = String(el.className || '');
        out.push({
          text: txt,
          tag: el.tagName.toLowerCase(),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          inView: r.top >= 0 && r.bottom <= window.innerHeight,
          disabled: el.disabled === true || /disabled/i.test(cls) || el.getAttribute('aria-disabled') === 'true'
        });
      }
      return { scrollY: window.scrollY, pageHeight: document.body.scrollHeight, viewport: window.innerHeight, buttons: out.slice(0, 60) };
    }).catch(() => ({ buttons: [] }));
    return info;
  }

  /** 诊断：在当前页面直接点一个坐标（用于人工确认过的位置）。 */
  async clickAt({ x, y }) {
    const page = await this.ensure();
    await page.mouse.click(x, y);
    await page.waitForTimeout(1500);
    return { clicked: true, x, y };
  }

  /**
   * 第一步：打开编辑页、上传视频、填文案，等「发布」按钮出现。
   * 不点发布 —— 这样单次调用短，不会超时。
   */
  async preparePublish({ file, caption = '', topics = [], waitMs = 45000 } = {}) {
    const fsMod = fs;
    if (!file || !fsMod.existsSync(file)) throw new Error(`视频文件不存在：${file}`);
    const EDITOR = 'https://cp.kuaishou.com/article/publish/video?tabType=1';
    const page = await this.ensure({ url: EDITOR });
    if (!/article\/publish/.test(page.url())) {
      await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.waitForTimeout(2500);

    // 传文件
    const input = page.locator('input[type="file"]').first();
    if (!(await input.count().catch(() => 0))) {
      return { prepared: false, reason: '编辑页没有文件上传框', url: page.url() };
    }
    await input.setInputFiles(path.resolve(file));

    // 填文案（作品描述）
    const text = [caption, ...topics.map((t) => `#${t}`)].filter(Boolean).join(' ');
    const boxSel = 'textarea, [contenteditable="true"]';
    const box = page.locator(boxSel).first();
    if (text && await box.count().catch(() => 0)) {
      await box.click({ timeout: 5000 }).catch(() => {});
      await box.fill(text).catch(async () => {
        await page.keyboard.type(text, { delay: 20 }).catch(() => {});
      });
    }

    // 等「发布」按钮出现且可点（最多 waitMs）
    const deadline = Date.now() + waitMs;
    let btn = null;
    while (Date.now() < deadline) {
      const found = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('button, [role="button"], div, span')];
        const cands = nodes.filter((el) => {
          const t = (el.innerText || el.textContent || '').trim();
          if (t !== '发布') return false;
          const r = el.getBoundingClientRect();
          return r.width > 24 && r.height > 12;
        });
        const el = cands[cands.length - 1];
        if (!el) return [];
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const cls = String(el.className || '');
        return [{
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          disabled: el.disabled === true || /disabled/i.test(cls) || el.getAttribute('aria-disabled') === 'true'
        }];
      }).catch(() => []);
      btn = (found || [])[0] || null;
      if (btn && !btn.disabled) break;
      await page.waitForTimeout(2500);
    }

    return {
      prepared: Boolean(btn && !btn.disabled),
      button: btn,
      caption: text,
      file: path.resolve(file),
      url: page.url()
    };
  }

  /** 第二步：点「发布」并用作品数验证（作品管理里 +1 才算成功）。 */
  async clickPublish({ verifyMs = 60000 } = {}) {
    const page = await this.ensure();

    // 读作品数（多次重试，宁可慢也别读成 null）
    const readCount = async (tries = 4) => {
      for (let i = 0; i < tries; i++) {
        try {
          const p = await page.context().newPage();
          await p.goto('https://cp.kuaishou.com/article/manage/video', { waitUntil: 'domcontentloaded', timeout: 25000 });
          await p.waitForTimeout(2500);
          const n = await p.evaluate(() => {
            const t = (document.body.innerText || '').replace(/\s+/g, ' ');
            const m = t.match(/共\s*(\d+)\s*个作品/);
            return m ? Number(m[1]) : null;
          }).catch(() => null);
          await p.close().catch(() => {});
          if (n != null) return n;
        } catch {}
        await page.waitForTimeout(1500);
      }
      return null;
    };

    const before = await readCount();

    // 找「发布」按钮并滚到可见
    const found = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], div, span')];
      const cands = nodes.filter((el) => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t !== '发布') return false;
        const r = el.getBoundingClientRect();
        return r.width > 24 && r.height > 12;
      });
      const el = cands[cands.length - 1];
      if (!el) return [];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const cls = String(el.className || '');
      return [{
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        disabled: el.disabled === true || /disabled/i.test(cls) || el.getAttribute('aria-disabled') === 'true'
      }];
    }).catch(() => []);

    const btn = (found || [])[0];
    if (!btn) return { published: false, reason: '页面上找不到「发布」按钮', worksBefore: before };

    await page.mouse.click(btn.x, btn.y);
    await page.waitForTimeout(2500);

    // 二次确认
    let confirmedDialog = false;
    for (const label of ['确认发布', '继续发布', '确定', '确认']) {
      const b = page.getByText(label, { exact: true }).first();
      if (await b.count().catch(() => 0)) {
        await b.click({ timeout: 4000 }).catch(() => {});
        confirmedDialog = true;
        await page.waitForTimeout(1500);
        break;
      }
    }

    const deadline = Date.now() + verifyMs;
    let after = before;
    let toast = '';
    while (Date.now() < deadline) {
      toast = await page.evaluate(() => (document.body.innerText || '').slice(0, 500)).catch(() => '');
      const n = await readCount(1);
      if (n != null) after = n;

      const toastOk = /发布成功|作品已提交|上传成功|审核中/.test(toast);
      if (before != null && after != null && after > before) {
        return { published: true, confirmed: true, worksBefore: before, worksAfter: after, note: `作品数 ${before} → ${after}` };
      }
      if (toastOk) {
        return { published: true, confirmed: true, worksBefore: before, worksAfter: after, note: '页面出现成功提示' };
      }
      await page.waitForTimeout(3000);
    }

    return {
      published: false,
      reason: '点了发布但没看到成功迹象',
      worksBefore: before,
      worksAfter: after,
      clickedButton: btn,
      confirmedDialog,
      toastTail: String(toast).replace(/\s+/g, ' ').slice(-160)
    };
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
  async publishVideo({ file, caption = '', cover = '', retries = 1 } = {}) {
    // 全部逻辑在 src/publish.mjs：自己等处理、自己重试、登录不上就停在扫码页
    const { publishSmart } = await import('./publish.mjs');
    const result = await publishSmart(this, { file, caption, cover, retries });
    // 发布过程中会开新标签页，收尾时把空白页/重复页关掉
    try { await this.tidyTabs(); } catch {}
    return result;
  }

}
