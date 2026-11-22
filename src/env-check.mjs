// 环境自检：给设置页的「检查环境」按钮和 ks_env 工具共用。
//
// 设计原则：每项都返回「能不能用 + 具体证据 + 怎么修」，而不是只给一个红叉。
// 全部只读，不会启动浏览器、不会点任何东西（避免"检查一下就动了账号"）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverAdb } from './adb.mjs';
import { resolveTools, pickFont } from './video.mjs';
import { listSapiVoices } from './tts.mjs';
import { projectRoot } from './config.mjs';
import { recentCrashes } from './safety.mjs';
import { inspectProfile } from './profile-guard.mjs';

/** 结果项：{ id, label, ok, detail, hint? } */
const item = (id, label, ok, detail = '', hint = '') => ({ id, label, ok, detail, hint });

async function checkAssetsServer(port, timeoutMs = 1200) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/list`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, detail: `监听中，已上传 ${body.files?.length ?? 0} 个素材` };
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? '超时无响应' : (error?.message || '连不上'), hint: `端口 ${port} 没起来：重启 DSH，或改 assetsPort` };
  }
}

function checkBinary(bin, args = ['-version']) {
  if (!bin) return { ok: false, detail: '未找到' };
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return { ok: false, detail: r.stderr?.slice(0, 80) || `退出码 ${r.status}` };
  return { ok: true, detail: String(r.stdout || '').split('\n')[0]?.slice(0, 80) || 'ok' };
}

/**
 * 跑一遍环境检查。
 * @param {object} opts
 * @param {object} opts.cfg 生效配置（loadConfig 的结果）
 * @param {boolean} [opts.deep] true=额外探测 adb 设备/语音列表（慢一点）
 */
export async function checkEnvironment({ cfg, deep = false, assetsPort = null, root = null } = {}) {
  const items = [];
  const video = cfg.video ?? {};
  const au = video.audio ?? {};
  const bg = video.background ?? {};

  // 1) 插件开关
  const enabled = cfg.enabled !== false;
  items.push(item('enabled', '插件总开关', enabled, enabled ? '已开启（会自动执行）' : '已关闭（所有动作会被拒绝）', enabled ? '' : '在设置顶部打开开关'));

  // 2) 上传服务
  const port = Number(assetsPort ?? cfg.assets?.port ?? cfg.assetsPort ?? 32801) || 32801;
  const assets = await checkAssetsServer(port);
  items.push(item('assets', '素材上传服务', assets.ok, assets.detail, assets.hint || ''));

  // 3) 后端
  const mode = cfg.mode ?? 'auto';
  items.push(item('mode', '运行后端', true, mode === 'adb' ? 'adb（模拟器 / 真机）' : mode === 'web' ? 'web（快手网页版）' : 'auto（自动选）'));

  // 4) 浏览器 / 登录态（只查文件，不启动浏览器）
  const projectDir = root || projectRoot();
  const browserPath = cfg.web?.browserPath || '';
  // 关键：必须按项目根解析。用 path.resolve() 会跟着进程 cwd 走 —— DSH 的 cwd 不是项目根，
  // 于是永远查到一个不存在的目录，判定"没登录"（就是用户反馈的那个 bug）
  const profileDir = path.resolve(projectDir, cfg.web?.profileDir || '.web-profile');
  if (browserPath && !fs.existsSync(browserPath)) {
    items.push(item('browser', '浏览器', false, `路径不存在：${browserPath}`, '清空 browserPath 让插件自动找 Edge/Chrome'));
  } else {
    items.push(item('browser', '浏览器', true, browserPath || '自动探测（Edge/Chrome）'));
  }
  {
    const cookieCandidates = [
      path.join(profileDir, 'Default', 'Network', 'Cookies'),
      path.join(profileDir, 'Default', 'Cookies')
    ];
    const cookie = cookieCandidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 1024);
    const markerFile = path.join(projectDir, 'state', 'web-login.json');
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch {}
    const markerFresh = marker?.loggedIn === true && (Date.now() - Date.parse(marker.at || 0)) < 7 * 86400000;

    if (markerFresh) {
      const when = new Date(marker.at).toLocaleString('zh-CN', { hour12: false });
      items.push(item('webProfile', '网页版登录态', true, `已登录（${when} 确认过，账号：${marker.nickname || marker.uin || '已登录'}）`));
    } else if (cookie) {
      const mtime = fs.statSync(cookie).mtime.toLocaleString('zh-CN', { hour12: false });
      items.push(item('webProfile', '网页版登录态', true, `检测到登录 Cookie（${mtime} 更新）；最近没在会话里确认过，属正常`));
    } else if (fs.existsSync(profileDir)) {
      items.push(item('webProfile', '网页版登录态', false, `有 profile 目录但没有登录 Cookie：${profileDir}`, '在快手网页版窗口里扫码登录一次'));
    } else {
      items.push(item('webProfile', '网页版登录态', false, `还没有 profile：${profileDir}`, '第一次用网页版需要扫码登录一次'));
    }
  }

  // 5) ffmpeg / ffprobe
  const tools = resolveTools({ ffmpegPath: video.ffmpegPath, ffprobePath: video.ffprobePath });
  const ff = checkBinary(tools.ffmpeg);
  const fp = checkBinary(tools.ffprobe, ['-version']);
  items.push(item('ffmpeg', 'ffmpeg', ff.ok && fp.ok, ff.ok ? ff.detail : ff.detail, ff.ok ? '' : '装 @ffmpeg-installer/ffmpeg，或填 video.ffmpegPath'));

  // 6) 字体
  const font = pickFont(video.typography?.fontPath);
  items.push(item('font', '中文字体', Boolean(font), font || '没找到', font ? '' : '填 videoFontPath（如 C:/Windows/Fonts/msyh.ttc）'));

  // 7) 语音
  try {
    const voices = await listSapiVoices();
    const engine = au.engine || 'sapi';
    const piperReady = Boolean(au.piperExe && fs.existsSync(au.piperExe) && au.piperModel && fs.existsSync(au.piperModel));
    const names = voices.map((v) => v.name);
    const wantVoice = String(au.voice || '').trim();
    const voiceMissing = engine === 'sapi' && wantVoice && !names.includes(wantVoice);
    const ok = engine === 'piper' ? piperReady : (names.length > 0 && !voiceMissing);
    items.push(item(
      'voice', '语音合成', ok,
      engine === 'piper'
        ? (piperReady ? `piper：${path.basename(au.piperModel)}` : 'piper 未就绪（缺 exe 或模型）')
        : voiceMissing
          ? `配置的语音「${wantVoice}」不存在；系统里有：${names.join(' / ')}`
          : `sapi：${wantVoice || names.join(' / ') || '无语音'}`,
      ok ? '' : (engine === 'piper'
        ? '上传 .onnx 模型并填 videoPiperExe'
        : voiceMissing
          ? `把「配音语音名」改成：${names[0] || '（先装系统语音）'}`
          : '系统里没有可用语音')
    ));
  } catch (error) {
    items.push(item('voice', '语音合成', false, error.message, '检查 Windows 语音是否可用'));
  }

  // 8) 素材
  const bgm = au.bgmFile || '';
  items.push(item('bgm', 'BGM', !bgm || fs.existsSync(bgm), bgm ? (fs.existsSync(bgm) ? bgm : `文件不存在：${bgm}`) : '未配置（可选）'));
  for (const [key, label, value] of [['bgImage', '背景图', bg.image], ['bgVideo', '背景视频', bg.video]]) {
    if (!value) { items.push(item(key, label, true, '未配置（可选）')); continue; }
    const exists = fs.existsSync(value);
    items.push(item(key, label, exists, exists ? value : `文件不存在：${value}`, exists ? '' : '重新上传或改成正确路径'));
  }

  // 素材库：只统计**顶层文件**（子目录如 voices/ 是模型库，不是"待用素材"）。
  // 引用判断要覆盖所有能用素材的字段：背景图/背景视频/BGM/字体/发布封面/模板。
  try {
    const assetsDir = path.resolve(projectDir, cfg.assets?.dir ?? 'state/assets');
    const entries = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir, { withFileTypes: true })
      : [];
    const files = entries.filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name);
    const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);

    const abs = (p) => (p ? (path.isAbsolute(p) ? path.resolve(p) : path.resolve(projectDir, p)) : '');
    const referenced = new Set(
      [au.bgmFile, bg.image, bg.video, video.typography?.fontPath, cfg.publish?.coverFile, cfg.video?.template]
        .map(abs)
        .filter(Boolean)
    );
    const unused = files.filter((f) => !referenced.has(path.resolve(assetsDir, f)));

    if (files.length > 0) {
      items.push(item(
        'assetsUnused', '素材库', unused.length === 0,
        [
          `${files.length} 个素材文件，已使用 ${files.length - unused.length} 个`,
          unused.length ? `未使用：${unused.slice(0, 3).join('、')}${unused.length > 3 ? '…' : ''}` : '',
          dirs.length ? `另有子目录：${dirs.join('、')}（贴纸/模型，不在"未使用"里算）` : ''
        ].filter(Boolean).join('；'),
        unused.length ? '在设置里对应字段选中它再保存（背景图 / 模板 / BGM / 字体 / 发布封面）' : ''
      ));
    }
  } catch {}

  // 9) adb（仅在 deep 时探测设备）
  if (deep) {
    const adbPath = cfg.adbPath || discoverAdb();
    if (!adbPath) {
      items.push(item('adb', 'adb 设备', false, '没有 adb（不影响网页版）', '用网页版可不装 adb'));
    } else {
      const r = spawnSync(adbPath, ['devices'], { encoding: 'utf8', timeout: 20000 });
      const count = String(r.stdout || '').split('\n').filter((l) => /\tdevice\b/.test(l)).length;
      items.push(item('adb', 'adb 设备', count > 0, count > 0 ? `${count} 台在线` : '有 adb 但没有在线设备', count > 0 ? '' : '启动 MuMu 或插真机'));
    }
  }

  // 10) 插件自己的崩溃日志：有东西就说明某次异常被兜住了（宿主没倒，但值得看一眼）
  {
    const c = recentCrashes({ root: projectDir, limit: 3 });
    const ok = c.recent === 0;
    items.push(item(
      'crashLog', '崩溃日志',
      ok,
      c.exists
        ? (ok ? `最近 24 小时 0 条（累计 ${c.total} 条，${Math.round(c.bytes / 1024)}KB）` : `最近 24 小时 ${c.recent} 条：${String(c.last.at(-1) || '').slice(0, 120)}`)
        : '还没有崩溃记录',
      ok ? '' : '看 state/crash.log；插件已经把异常兜住了，宿主不会因为这个倒'
    ));
  }

  // 11) DSH 自己的认证 Cookie 堆积（2026-10-25 那次"打不开 App"的真凶）
  //     宿主每次启动加一个 dsh-auth-* cookie，30 天有效，从不清；
  //     堆到 ~70 个时 Cookie 头超过 Node 的 16KB 请求头上限 → welcome 认证失败 → 崩溃循环。
  {
    const cookieFile = path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
    if (!fs.existsSync(cookieFile)) {
      items.push(item('dshCookies', 'DSH 认证 Cookie', true, '没找到 DSH 的 Cookie 库（非桌面端或路径不同）'));
    } else {
      // DSH 运行时把 Cookies 库独占锁着（直接读会 EBUSY），所以先复制一份再读 —— 不然会误报"0 个"
      let count = null;
      let copyErr = '';
      try {
        const tmpCopy = path.join(os.tmpdir(), `ksops-cookies-${process.pid}-${Date.now()}.db`);
        fs.copyFileSync(cookieFile, tmpCopy);
        try {
          const buf = fs.readFileSync(tmpCopy, 'latin1');
          count = (buf.match(/dsh-auth-/g) || []).length;
        } finally { try { fs.rmSync(tmpCopy, { force: true }); } catch {} }
      } catch (error) {
        copyErr = String(error?.code || error?.message || error);
      }
      const warnAt = 40;
      if (count === null) {
        // 库被独占锁着，退而求其次：看插件自己记的「DSH 启动了几次没清理」
        let launches = null;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(projectDir, 'state', 'dsh-launches.json'), 'utf8'));
          launches = Number(rec.count) || 0;
        } catch {}
        if (launches === null) {
          items.push(item(
            'dshCookies', 'DSH 认证 Cookie', true,
            `读不到（DSH 正在占用 Cookie 库：${copyErr}），也没有启动计数`,
            `关掉 DSH 后跑：node C:/Users/wudiw/Documents/deepseek/fix-dsh-auth-cookies.mjs --dry`
          ));
        } else {
          const ok = launches < warnAt;
          items.push(item(
            'dshCookies', 'DSH 认证 Cookie', ok,
            `读不到（库被 DSH 独占），按启动次数估算：自上次清理以来启动 ${launches} 次 ≈ ${launches} 个（阈值 ${warnAt}）`,
            ok ? '' : '跑：node C:/Users/wudiw/Documents/deepseek/fix-dsh-auth-cookies.mjs（关掉 DSH 再跑）'
          ));
        }
      } else {
        const ok = count < warnAt;
        items.push(item(
          'dshCookies', 'DSH 认证 Cookie', ok,
          `${count} 个（超过 ${warnAt} 个就要清，否则 DSH 可能打不开）`,
          ok ? '' : '跑：node C:/Users/wudiw/Documents/deepseek/fix-dsh-auth-cookies.mjs'
        ));
      }
    }
  }

  // 12) profile 配置保险：DSH 崩一次就可能把 cordis.patch.yml 重置成 []，
  //     插件注册跟着丢（"设置页不见了、ks_* 工具全没了"）。这里只读 + 顺手拍快照。
  {
    try {
      const r = inspectProfile({ root: projectDir });
      items.push(item(
        'profileGuard', 'DSH 配置（插件注册）', r.ok,
        r.ok
          ? `cordis.patch.yml ${r.current.entries} 个条目，kuaishou 在（${r.current.bytes}B）；快照 ${r.good.exists ? `${r.good.entries} 个条目` : '还没有'}`
          : String(r.problem || '配置异常'),
        r.ok ? '' : '恢复：node tools/profile-guard.mjs restore（会先备份当前文件，重启 DSH 生效）'
      ));
    } catch (error) {
      items.push(item('profileGuard', 'DSH 配置（插件注册）', true, `检查跳过：${error.message}`));
    }
  }

  return {
    enabled,
    mode,
    debug: { projectRoot: projectDir, cwd: process.cwd(), profileDir, assetsPort: port },
    checks: items,
    okCount: items.filter((i) => i.ok).length,
    badCount: items.filter((i) => !i.ok).length,
    at: new Date().toISOString()
  };
}
