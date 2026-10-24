#!/usr/bin/env node
// 命令行入口。后端自动选（adb 模拟器/真机，或快手网页版）。
//
//   node cli.mjs status          # 看用的哪个后端、是否登录
//   node cli.mjs feed --count 20
//   node cli.mjs comments
//   node cli.mjs reply --match "怎么" --content "我这边也在试"
//   node cli.mjs like
//   node cli.mjs publish --file D:\clip.mp4 --caption "今天的日常 #生活"
//   node cli.mjs web-login       # 开浏览器窗口，扫码登录（登录态存 .web-profile）
//   node cli.mjs plan / run / state / doctor
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, projectRoot } from './src/config.mjs';
import { discoverAdb } from './src/adb.mjs';
import { createBackend } from './src/driver.mjs';
import { KuaishouWeb } from './src/web.mjs';
import { OpsState, makePlan, runPlan } from './src/ops.mjs';
import { PromptLibrary } from './src/prompts.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --var key=value 可重复出现（比内联 JSON 在 PowerShell/cmd 下稳得多）
const rawVars = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--var' && process.argv[i + 1]) rawVars.push(process.argv[i + 1]);
}
const cliVars = rawVars.length
  ? Object.fromEntries(rawVars.map((s) => {
      const at = s.indexOf('=');
      return at > 0 ? [s.slice(0, at).trim(), s.slice(at + 1)] : [s.trim(), ''];
    }))
  : null;
const command = args._[0] ?? 'doctor';
const cfg = loadConfig();
if (args.dry === true) cfg.dryRun = true;
if (args.web === true) cfg.mode = 'web';
if (args.adb === true) cfg.mode = 'adb';

const log = (l) => process.stderr.write(`${l}\n`);
const state = new OpsState({ file: path.join(projectRoot(), cfg.stateFile) }).load();
const out = (x) => process.stdout.write(`${typeof x === 'string' ? x : JSON.stringify(x, null, 2)}\n`);

let backend = null;
const getBackend = async () => (backend ??= await createBackend({ cfg, log }));

try {
  switch (command) {
    case 'doctor': {
      const adbPath = cfg.adbPath || discoverAdb();
      const info = {
        projectRoot: projectRoot(),
        mode: cfg.mode,
        adbPath: adbPath || null,
        adbFound: Boolean(adbPath),
        webProfile: path.resolve(projectRoot(), cfg.web.profileDir),
        package: cfg.pkg
      };
      const b = await getBackend();
      info.backend = b.mode;
      out(info);
      break;
    }

    case 'web-login': {
      // 打开浏览器停在首页，等用户扫码；登录态写进 profile 目录
      const web = new KuaishouWeb({ cfg, log });
      await web.ensure();
      out({
        opened: true,
        profile: web.profileDir(),
        next: '在弹出的窗口里点「立即登录」扫码；登录成功后回来运行 node cli.mjs status 确认 loggedIn=true，然后关闭窗口（或直接留着）'
      });
      // 轮询登录状态，最多 5 分钟
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        let logged = false;
        try { logged = await web.isLoggedIn(); } catch {}
        process.stderr.write(`[web-login] ${(i + 1) * 5}s loggedIn=${logged}\n`);
        if (logged) { out({ loggedIn: true, profile: web.profileDir() }); break; }
      }
      await web.close();
      break;
    }

    case 'status': {
      out(await (await getBackend()).status());
      break;
    }

    case 'feed': {
      const b = await getBackend();
      const steps = await b.feedScroll({ count: Number(args.count ?? 10) });
      state.add('scroll', steps.length);
      state.save();
      out({ backend: b.mode, steps, counts: state.data.counts });
      break;
    }

    case 'like': out(await (await getBackend()).like()); break;

    case 'comments': {
      const b = await getBackend();
      out({ backend: b.mode, comments: await b.comments({ keepOpen: args.keep === true, limit: Number(args.limit ?? 30) }) });
      break;
    }

    case 'reply': {
      out(await (await getBackend()).reply({ match: String(args.match ?? ''), content: String(args.content ?? '') }));
      break;
    }

    case 'publish': {
      const b = await getBackend();
      const result = await b.publish({ file: String(args.file ?? ''), caption: String(args.caption ?? ''), pushOnly: args.push === true });
      if (result.published) { state.add('publish', 1); state.save(); }
      out(result);
      break;
    }

    case 'plan': out({ counts: state.data.counts, plan: makePlan({ quotas: cfg.quotas, state, wantPublish: args.publish === true }) }); break;

    case 'run': {
      const b = await getBackend();
      const ksLike = {
        feedScroll: (o) => b.feedScroll(o),
        like: () => b.like(),
        openComments: async () => await b.comments({ keepOpen: true, limit: 1 }),
        readComments: async () => await b.comments({ keepOpen: true, limit: 100 }),
        closeComments: async () => {},
        replyToComment: (a) => b.reply(a),
        shouldReply: (t) => {
          const s = String(t);
          if (s.length < cfg.reply.minChars) return false;
          if (cfg.reply.blacklist.some((w) => w && s.includes(w))) return false;
          const wl = cfg.reply.whitelist ?? [];
          return wl.length === 0 || wl.some((w) => (w === '?' || w === '？' ? /[?？]/.test(s) : s.includes(w)));
        }
      };
      let plan = makePlan({ quotas: cfg.quotas, state });
      if (args.scroll || args.replies || args.likes) {
        plan = [];
        if (args.scroll) plan.push({ kind: 'scroll', count: Number(args.scroll) });
        if (args.replies) plan.push({ kind: 'reply', count: Number(args.replies) });
        if (args.likes) plan.push({ kind: 'like', count: Number(args.likes) });
      }
      const result = await runPlan({ ks: ksLike, state, plan, onEvent: (e) => process.stderr.write(`[ops] ${JSON.stringify(e)}\n`) });
      out({ backend: b.mode, plan, counts: result.counts, events: result.events.slice(-30) });
      break;
    }

    case 'state': out(state.data); break;

    case 'prompt': {
      const lib = new PromptLibrary({ cfg });
      const sub = args._[1] ?? 'list';
      const id = args._[2] ?? args.id;
      if (sub === 'list') { out({ dir: cfg.prompts.dir, customDir: cfg.prompts.customDir, active: cfg.prompts.active, prompts: lib.list() }); break; }
      if (sub === 'get') { out(lib.get(id)); break; }
      if (sub === 'render') {
        const vars = cliVars ?? (args.vars ? JSON.parse(String(args.vars)) : {});
        out(lib.render(id, vars));
        break;
      }
      if (sub === 'save') {
        const file = args.file ? String(args.file) : '';
        if (!file || !path.isAbsolute(file)) throw new Error('save 需要 --file <绝对路径>（正文从文件读，避免命令行转义地狱）');
        out(lib.save(id, fs.readFileSync(file, 'utf8')));
        break;
      }
      if (sub === 'reset') { out(lib.reset(id)); break; }
      throw new Error(`prompt 子命令：list | get <id> | render <id> [--vars '{"k":"v"}'] | save <id> --file <path> | reset <id>`);
    }

    default:
      out(`未知命令：${command}\n可用：doctor web-login status feed like comments reply publish plan run state prompt`);
      process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`❌ ${error.name}: ${error.message}\n`);
  if (error.step) process.stderr.write(`   步骤：${error.step}\n`);
  if (error.hint) process.stderr.write(`   建议：${error.hint}\n`);
  if (Array.isArray(error.screen) && error.screen.length) {
    process.stderr.write(`   当前屏幕：\n${error.screen.slice(0, 15).map((n) => `     - ${n.text} @(${n.cx},${n.cy})`).join('\n')}\n`);
  }
  process.exitCode = 1;
} finally {
  try { await backend?.close?.(); } catch {}
}
