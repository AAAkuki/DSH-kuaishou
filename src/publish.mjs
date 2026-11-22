// 让插件自己把事做完，别每步都回头问用户。
//
// 核心思路：把「需要人」的几件事改成「插件自己处理」——
//   1. 创作者平台没登录 → 自己打开窗口并留在那儿，返回明确的一步动作（而不是抛错让模型去问）
//   2. 发布前先把视频、文案、封面都准备好（缺什么补什么）
//   3. 上传/处理/发布全程自己轮询，等到出结果；失败自动重试一次
//   4. 发布结果自己回读（作品列表）确认，而不是"点了按钮就算成功"
import fs from 'node:fs';
import path from 'node:path';

const LOGIN_URL = 'https://cp.kuaishou.com';
const PROFILE_URL = 'https://cp.kuaishou.com/profile';

/** 说人话的失败原因 */
function explain(state = {}) {
  const url = state.url || '(未知页面)';
  const snippet = String(state.snippet ?? '').slice(0, 80);
  if (state.hasLoginUi && !state.ready) return `创作者平台要求登录（当前页 ${url}）`;
  if (!state.fileInputs && !state.hasPublishUi) {
    return `页面没出现上传入口（当前页 ${url}${snippet ? `，正文：${snippet}` : ''}）`;
  }
  return `页面状态未知（当前页 ${url}）`;
}

export async function publishSmart(web, { file, caption = '', cover = '', topics = [], title = '', retries = 1, keepOpenOnFail = true, discardDraft = false } = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`视频文件不存在：${abs}`);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(web, { abs, caption, cover, topics, title, discardDraft });
    } catch (error) {
      lastError = error;
      if (error.code === 'NEED_LOGIN') break;      // 登录问题重试没用，直接抛结构化的
      if (attempt < retries) await web.sleep(3000);
    }
  }

  if (keepOpenOnFail && (lastError?.code === 'NEED_LOGIN' || lastError?.code === 'NOT_READY')) {
    const needLogin = lastError.code === 'NEED_LOGIN';
    // 不抛"错误"，返回一个**可执行的结果**：窗口留在原地，用户做完那一步直接重跑即可
    return {
      published: false,
      needLogin,
      action: needLogin ? 'scan-qr-on-screen' : 'inspect-screen',
      url: lastError.url || LOGIN_URL,
      message: needLogin
        ? `已在边缘浏览器打开 ${LOGIN_URL}：扫码登录后直接重跑发布即可（不用再确认任何参数）`
        : `页面没就绪：${lastError.message}。窗口已停在当前页，处理一下再重跑即可`,
      file: abs,
      caption, topics, title
    };
  }
  throw lastError;
}

const EDITOR_URL = 'https://cp.kuaishou.com/article/publish/video?tabType=1';

async function once(web, { abs, caption, cover, topics = [], title = '', discardDraft = false }) {
  // 快手点「发布视频」是**新开标签页**去编辑页，原标签页不会出现上传框。
  // 所以直接开编辑页；拿不到再回退到"点卡片 + 抓新标签页"。
  // ensure({url}) 只在首次启动时导航；页面已存在会留在刷视频页 → 必须显式 goto
  // 发布前先记一下「作品管理」里的作品数，发完用它验证
  let worksBefore = null;
  try {
    const sum = await web.readWorksSummary();
    worksBefore = sum.count;
  } catch {}

  let page = await web.ensure({ url: EDITOR_URL });
  try {
    const cur = page.url();
    // 必须判断"是不是**发布编辑页**"，而不是"是不是 cp.kuaishou.com"。
    // 因为前面读作品数已经跳到 /article/manage/video，光看域名会误以为不需要跳转。
    if (!/article\/publish/.test(cur)) {
      await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  } catch { /* 跳转失败继续，后面会给出可读原因 */ }
  await page.waitForTimeout(3500);
  let state = await readState(page);

  if (state.fileInputs === 0) {
    page = (await openEditorByClick(web)) || page;
    await web.sleep(2000);
    state = await readState(page);
  }

  if (!state.ready || state.fileInputs === 0) {
    const err = new Error(explain(state));
    err.code = state.needLoginReason || /passport|login/i.test(state.url) ? 'NEED_LOGIN' : 'NOT_READY';
    err.url = state.url;
    if (err.code === 'NEED_LOGIN') await page.bringToFront().catch(() => {});
    throw err;
  }

  // 4) 传文件
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(abs, { timeout: 30000 });
  await web.sleep(5000);

  // 5) 填标题（如果有标题输入框）
  if (title) {
    const titleBox = page.locator('input[placeholder*="标题"], input[placeholder*="填写标题"]').first();
    if (await titleBox.count().catch(() => 0)) {
      await titleBox.click({ timeout: 5000 }).catch(() => {});
      await titleBox.fill(title).catch(() => {});
      await web.sleep(400);
    }
  }

  // 6) 填文案 + 话题标签（快手把 #话题 写在正文里，输入后自动变成标签块）
  const hashtags = (topics || []).map((t) => `#${String(t).replace(/^#/, '')}`).join(' ');
  const finalText = [caption, hashtags].filter(Boolean).join(' ').trim();
  if (finalText) {
    const box = page.locator('textarea, [contenteditable="true"]').first();
    if (await box.count().catch(() => 0)) {
      await box.click({ timeout: 8000 }).catch(() => {});
      // React 受控组件：必须用 playwright 的 fill（改 value 不会触发更新）
      const filled = await box.fill(finalText, { timeout: 10000 }).then(() => true).catch(() => false);
      if (!filled) {
        // contenteditable 兜底：逐字输入，输入 # 后快手会弹候选，按空格确认
        await box.pressSequentially(finalText, { delay: 30 }).catch(() => {});
      }
      await web.sleep(1200);
      // 让话题生效：在末尾敲一个空格
      await box.press('Space').catch(() => {});
      await web.sleep(800);
    }
  }

  // 7) 设置封面（编辑页有"上传封面/选择封面"入口时用它）
  if (cover) {
    try {
      const coverBtn = page.getByText(/上传封面|选择封面|设置封面|更换封面/).first();
      if (await coverBtn.count().catch(() => 0)) {
        await coverBtn.click({ timeout: 6000 }).catch(() => {});
        await web.sleep(2500);
        const coverInput = page.locator('input[type="file"]').last();
        if (await coverInput.count().catch(() => 0)) {
          await coverInput.setInputFiles(cover, { timeout: 20000 }).catch(() => {});
          await web.sleep(2000);
          // 弹窗里如果有"确定/保存/完成"，点它
          for (const label of ['确定', '保存', '完成', '使用该封面']) {
            const okBtn = page.getByRole('button', { name: label }).first();
            if (await okBtn.count().catch(() => 0)) { await okBtn.click({ timeout: 5000 }).catch(() => {}); break; }
          }
          await web.sleep(1500);
        }
      }
    } catch { /* 封面是增强项，失败不影响发布 */ }
  }

  // 4.5) 上次未发布草稿的提示
  //  **不要点「放弃」**——那会把草稿删掉（实测把用户手传的一条删没了）。
  //  默认点「继续编辑」保留草稿，然后把我们的视频覆盖上传；只有显式传 discardDraft 才放弃。
  try {
    const hasDraft = await page.evaluate(() => /还有上次未发布的视频/.test(document.body.innerText || ''));
    if (hasDraft) {
      let kept = false;
      if (!discardDraft) {
        for (const label of ['继续编辑', '继续', '编辑']) {
          const b = page.getByText(label, { exact: true }).first();
          if (await b.count().catch(() => 0)) {
            await b.click({ timeout: 6000 }).catch(() => {});
            await web.sleep(3000);
            kept = true;
            break;
          }
        }
      }
      if (!kept) {
        const b = page.getByText('放弃', { exact: true }).first();
        if (await b.count().catch(() => 0)) { await b.click({ timeout: 6000 }).catch(() => {}); await web.sleep(2500); }
      }
    }
  } catch {}

  // 5.5) 走完/关掉「作品信息」必填引导弹窗（不处理会挡住发布按钮）
  await clearMustFillDialogs(page, web);

  // 6) 等视频处理完 + 发布按钮可点（最多 3 分钟）
  // 6) 滚到底，找「发布」按钮
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await web.sleep(900);
  }

  const findPublishButton = async () => {
    return await page.evaluate(() => {
      const vh = window.innerHeight;
      const cands = [];
      const push = (el, how) => {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 12) return;
        const cls = String(el.className || '');
        const txt = (el.innerText || el.textContent || '').trim();
        cands.push({
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          bottom: Math.round(r.bottom),
          text: txt.slice(0, 12),
          how,
          disabled: el.disabled === true || /disabled/i.test(cls) || el.getAttribute('aria-disabled') === 'true'
        });
      };
      // ① 标准按钮
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if ((el.innerText || '').trim() === '发布') push(el, 'role');
      }
      // ② 底部区域的叶子节点
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        if ((el.textContent || '').trim() !== '发布') continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < vh * 0.5) continue;   // 只要页面下半部分的
        push(el.parentElement || el, 'leaf');
      }
      // 优先 bottom 最大的（最靠下那个通常是发布栏）
      cands.sort((a, b) => b.bottom - a.bottom);
      return cands.slice(0, 5);
    }).catch(() => []);
  };

  // 找「发布」按钮：在页面里 scrollIntoView 再取坐标（编辑页是内部滚动，window.scrollTo 无效，
  // 之前用 rect 坐标直接点，按钮在视口外 → 点在空白处 → 静默失败）
  const findAndScroll = async () => {
    return await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], div, span, a')];
      // 文字正好是「发布」的可点节点（注意：这里保持 '!== 发布' 的写法，测试桩按它识别）
      const cands = nodes.filter((el) => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t !== '发布') return false;
        const r = el.getBoundingClientRect();
        return r.width > 24 && r.height > 12;
      });
      const el = cands[cands.length - 1];   // 底部发布栏通常在最后
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
  };

  const deadline = Date.now() + 120000;
  let clicked = false;
  let lastWhy = '';
  while (Date.now() < deadline && !clicked) {
    const cands = await findAndScroll();
    const usable = (cands || []).find((c) => !c.disabled);
    if (usable && usable.y > 0) {
      await page.mouse.click(usable.x, usable.y);
      clicked = true;
      break;
    }
    lastWhy = Array.isArray(cands) && cands.length ? '找到「发布」但按钮不可点（视频还在处理/缺少必填项）' : '页面上找不到「发布」按钮';
    await web.sleep(3000);
  }
  if (!clicked) {
    const err = new Error(`没点成发布按钮（${lastWhy}）`);
    err.code = 'NOT_READY';
    throw err;
  }

  // 6.5) 二次确认弹窗
  await web.sleep(1500);
  for (const label of ['确认发布', '继续发布', '确定', '确认']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await web.sleep(1500);
      break;
    }
  }

  // 7) 确认是否真的发出去了：以「作品管理」作品数 +1 为准
  let confirmed = false;
  let verifyNote = '';
  const okDeadline = Date.now() + 90000;
  while (Date.now() < okDeadline) {
    // ① 页面 toast / 跳转（快但不一定可靠）
    const after = await page.evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || '').slice(0, 600)
    })).catch(() => ({ url: '', text: '' }));
    const toastOk = /发布成功|作品已提交|上传成功/.test(after.text);

    // ② 作品数 +1（可靠判据）
    let worksAfter = null;
    try {
      const sum = await web.readWorksSummary();
      worksAfter = sum.count;
    } catch {}

    if (worksBefore != null && worksAfter != null && worksAfter > worksBefore) {
      confirmed = true;
      verifyNote = `作品数 ${worksBefore} → ${worksAfter}，确认已进入作品列表`;
      break;
    }
    if (worksBefore == null && toastOk) {
      confirmed = true;
      verifyNote = '页面出现成功提示（作品数拿不到，只能用 toast 判断）';
      break;
    }
    // 回到编辑器继续等
    await web.sleep(3000);
    try {
      if (!/article\/publish/.test(page.url())) await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {}
  }

  // 没确认到"作品数 +1"就不算发布成功，避免"停在编辑页"被当成已发布
  if (!confirmed) {
    const err = new Error('已点发布，但作品管理里作品数没增加——很可能没发出去（还停在编辑页）。检查：视频是否处理完、封面/标题是否必填、有没有弹确认框');
    err.code = 'NOT_READY';
    err.worksBefore = worksBefore;
    throw err;
  }

  return {
    published: true,
    confirmed: true,
    file: abs,
    caption, topics, title,
    cover,
    worksBefore,
    note: verifyNote
  };
}

async function readState(page) {
  const s = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      url: location.href,
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      hasPublishUi: /发布视频|作品管理|上传视频|发布作品|视频管理/.test(text),
      hasLoginUi: /扫码登录|手机号登录|验证码登录|立即登录|请先登录/.test(text),
      snippet: text.slice(0, 200).replace(/\\s+/g, ' ')
    };
  });
  // 能不能干活，只看有没有上传能力；登录文案只是"为什么干不了"的解释
  s.ready = s.fileInputs > 0 || s.hasPublishUi;
  s.needLoginReason = !s.ready && s.hasLoginUi;
  return s;
}

/** 点首页「发布视频」卡片，等新标签页出现并返回它。 */
async function openEditorByClick(web) {
  try {
    const home = await web.ensure({ url: PROFILE_URL });
    try {
      if (!/cp\.kuaishou\.com/.test(home.url())) await home.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {}
    await home.waitForTimeout(2000);
    const target = await home.evaluate(() => {
      for (const t of document.querySelectorAll('[class*="title"], .title')) {
        if ((t.innerText || '').trim() === '发布视频') {
          let el = t;
          for (let i = 0; i < 4 && el.parentElement; i++) {
            el = el.parentElement;
            if (String(el.className).split(' ').includes('item')) break;
          }
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
        }
      }
      return null;
    });
    if (!target) return null;

    const ctx = web.ctx || web.context || web._context;
    const before = new Set(ctx.pages());
    await home.mouse.click(target.x, target.y);
    // 等新标签页（最多 15 秒）
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await web.sleep(1000);
      const fresh = ctx.pages().filter((p) => !before.has(p));
      if (fresh.length) {
        const p = fresh[fresh.length - 1];
        await p.waitForLoadState('domcontentloaded').catch(() => {});
        await p.bringToFront().catch(() => {});
        return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 快手发布页会弹「作品信息 1/4」引导弹窗，挡住发布按钮。
 * 策略：最多点 8 次「下一步/完成/跳过」，每次重新检查；没弹窗的账号本来就不需要这一步。
 * 全程失败也不抛错，交给后面的按钮轮询兜底。
 */
async function clearMustFillDialogs(page, web) {
  for (let i = 0; i < 8; i++) {
    const st = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return { hasGuide: /作品信息\s*\d+\s*\/\s*\d+|便捷填写作品关键信息/.test(text) };
    }).catch(() => ({ hasGuide: false }));
    if (!st.hasGuide) return true;

    let advanced = false;
    for (const label of ['下一步', '完成', '跳过', '暂不填写']) {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 5000 }).catch(() => {});
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      const close = page.locator('[class*="close"]').first();
      if (await close.count().catch(() => 0)) {
        await close.click({ timeout: 4000 }).catch(() => {});
        advanced = true;
      }
    }
    if (!advanced) return false;
    await web.sleep(1200);
  }
  return true;
}
