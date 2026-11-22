// 全自动运营：一次调用，把「刷 → 赞 → 评 → 出片 → 发布」全做完，不需要人再点任何东西。
//
// 设计要点：
//   1. 每一步失败都**自动降级**，不停下来问人（发布失败→继续；评论没候选→跳过）
//   2. 配额自动算：今天还能做什么就做什么
//   3. **多轮**：run 完一轮接着刷、接着评论，直到配额用完或达到 rounds 上限
//   4. **内容模式**：视频不一定是"刷到了什么"，也可以是"我干了什么"（工作日志体）
//   5. **思维链**：每一步决策都通过 trace() 实时推给前端，点「一键全自动」能看到它在想什么
import fs from 'node:fs';
import path from 'node:path';
import { withTimeout } from './safety.mjs';
import { replyKey, pickReply } from './ops.mjs';
import { pickReplySticker } from './sticker.mjs';
import { projectRoot } from './config.mjs';

/**
 * @param {object} deps
 *   backend  ()=>Promise<Backend>
 *   state    OpsState
 *   cfg      生效配置
 *   studio   VideoStudio
 *   root     项目根
 *   trace    ({phase,message,ok,data})=>void   实时进度回调（可选）
 * @param {object} opts
 *   publish      是否发布（默认 true）
 *   rounds       跑几轮「刷→赞→评」（1~5，默认 1）
 *   contentMode  scrolled=刷到了什么 / journal=我干了什么 / auto=混合（默认 auto）
 *   topic        视频主题（不填自动生成）
 *   lineCount    字幕句数
 *   scroll/replies/likes  单轮配额覆盖
 */
/**
 * 记住今天这条总结视频（写进 ops-state.json）。
 * 「刷新总结视频」关掉时，下一次直接沿用它，不再花 1~2 分钟重新渲染。
 */
export function rememberVideo({ state, video, topic, caption }) {
  try {
    if (!state?.data || !video?.file) return null;
    state.data.lastVideo = {
      day: state.data.day,
      at: Date.now(),
      file: video.file,
      cover: video.cover || '',
      topic: topic || video.title || '',
      caption: caption || '',
      durationSec: Number(video.durationSec || 0)
    };
    state.save?.();
    return state.data.lastVideo;
  } catch { return null; }
}

/**
 * 找今天可复用的那条总结视频。
 * 条件：同一天 + 文件还在。任一不满足就返回 null（宁可重出一遍，也别发一个不存在的文件）。
 */
export function findReusableVideo({ state, root = '.' }) {
  const rec = state?.data?.lastVideo;
  if (!rec?.file) return null;
  if (state.data.day && rec.day && rec.day !== state.data.day) return null;
  try {
    const abs = path.isAbsolute(rec.file) ? rec.file : path.join(root, rec.file);
    if (!fs.existsSync(abs)) return null;
    return {
      file: abs,
      cover: rec.cover || '',
      title: rec.topic || '',
      lines: rec.caption ? [rec.caption] : [],
      durationSec: Number(rec.durationSec || 0),
      reused: true
    };
  } catch { return null; }
}

export async function runFullAuto(deps, opts = {}) {
  const { backend, state, cfg, studio, root, trace = () => {} } = deps;
  const rounds = Math.max(1, Math.min(Number(opts.rounds) || 1, 5));
  const contentMode = ['scrolled', 'journal', 'auto'].includes(opts.contentMode) ? opts.contentMode : 'auto';

  const log = [];
  const say = (text, extra = {}) => {
    log.push({ at: new Date().toISOString(), text, ...extra });
    trace({ phase: extra.phase || 'act', message: text, ok: extra.ok, data: extra.data });
  };
  const think = (message, data) => trace({ phase: 'think', message, data });

  /**
   * 看门狗：每个大步骤都套超时。
   * 浏览器卡在某个弹窗、ffmpeg 被占用不放——以前整轮就静默挂在那里，
   * 界面上永远是"运行中…"。现在超时就当这一步失败，跳过去继续。
   */
  const runStep = async (label, ms, fn, fallback) => {
    try {
      return await withTimeout(fn(), ms, label);
    } catch (error) {
      // 只有"超时"才降级跳过；真报错要往上抛，让调用方按失败处理（不然日志会骗人）
      if (!error?.isTimeout) throw error;
      say(`${label}卡住了（已跳过）：${String(error?.message || error).slice(0, 100)}`, { phase: 'act', ok: false });
      return fallback;
    }
  };

  /**
   * 轮内步骤（刷/赞/评）用这个：超时和真报错都只影响这一步，不炸整轮。
   * 轮外的出片/发布不用它 —— 那两步失败就该如实报"发布失败"。
   */
  const runRoundStep = async (label, ms, fn, fallback) => {
    try {
      return await runStep(label, ms, fn, fallback);
    } catch (error) {
      say(`${label}失败（已跳过）：${String(error?.message || error).slice(0, 100)}`, { phase: 'act', ok: false });
      return fallback;
    }
  };

  const result = {
    startedAt: new Date().toISOString(),
    rounds,
    contentMode,
    steps: [],
    countsBefore: { ...state.data.counts },
    log
  };

  const remaining = (kind, quota) => Math.max(0, quota - (state.data.counts[kind] ?? 0));

  think(`计划跑 ${rounds} 轮（刷→赞→评），最后出一条「${modeLabel(contentMode)}」的视频`, { rounds, contentMode });
  if (rounds > 1) say(`这次跑 ${rounds} 轮，每轮结束会自己接着刷`, { phase: 'plan' });

  // 每轮的统计，出片时用来写"我干了什么"
  const roundsStat = [];

  for (let round = 1; round <= rounds; round++) {
    if (state.shouldStop && state.shouldStop()) {
      say('收到停止指令，提前结束', { phase: 'round' });
      break;
    }
    say(`— 第 ${round}/${rounds} 轮开始 —`, { phase: 'round', data: { round } });
    const stat = { round, scroll: 0, like: 0, reply: 0, replyTexts: [], skipped: [], maxDur: 0, minDur: 0, likedNames: [] };

    stat.scroll = await runRoundStep('刷视频', 10 * 60 * 1000, () => doScroll({ backend, state, cfg, round, say, think, opts }), {});
    if (stat.scroll?.steps) {
      stat.minDur = stat.scroll.minDur;
      stat.maxDur = stat.scroll.maxDur;
      stat.scrollCount = stat.scroll.count;
    }
    stat.like = await runRoundStep('点赞', 4 * 60 * 1000, () => doLike({ backend, state, cfg, opts, say, think }), 0);
    const r = await runRoundStep('回评论', 4 * 60 * 1000, () => doReply({ backend, state, cfg, opts, say, think }), { count: 0, repliedTexts: [], skipped: [] });
    stat.reply = r.count;
    stat.replyTexts = r.repliedTexts;
    stat.skipped = r.skipped;
    roundsStat.push(stat);

    result.steps.push({ kind: 'round', ok: true, round, scroll: stat.scrollCount ?? 0, like: stat.like, reply: stat.reply });
    say(`第 ${round} 轮结束：刷 ${stat.scrollCount ?? 0} / 赞 ${stat.like} / 回 ${stat.reply}`, { phase: 'round', data: stat });

    // 配额都用完了就别空转
    const leftScroll = remaining('scroll', cfg.quotas.scrollPerRun);
    const leftReply = remaining('reply', cfg.quotas.replyPerRun);
    if (leftScroll <= 0 && leftReply <= 0) {
      const resetOn = cfg.loop?.resetQuotaOnExhaust !== false;
      if (resetOn && round < rounds) {
        if (typeof state.resetQuotas === 'function') { state.resetQuotas(); state.save(); }
        say('配额已用尽，已重置后继续刷', { phase: 'round' });
      } else if (round < rounds) {
        think(`配额已用尽（刷 ${state.data.counts.scroll}/${cfg.quotas.scrollPerRun}，回 ${state.data.counts.reply}/${cfg.quotas.replyPerRun}），提前结束循环`);
        break;
      }
    }
  }

  // ── 搜索（网上冲浪：顺手搜关键词，结果进总结视频）
  let searchInfo = null;
  if (cfg.search?.enabled !== false) {
    try {
      const b = await runStep('打开浏览器', 3 * 60 * 1000, () => backend(), null);
      if (!b) throw new Error('浏览器没起来');
      const wLayer = b.web || b;
      if (typeof wLayer.searchVideos === 'function') {
        const today = state.searchesToday().map((x) => x.keyword);
        const pool = (cfg.search.keywords ?? []).filter(Boolean);
        const kw = opts.searchKeyword || pool.find((k) => !today.includes(k)) || pool[today.length % Math.max(1, pool.length)] || '';
        if (kw) {
          trace({ phase: 'search', message: `搜一下「${kw}」，看看别人在聊什么` });
          const r = await runStep('搜索', 2 * 60 * 1000, () => wLayer.searchVideos({ keyword: kw, limit: Number(cfg.search.limit) || 6 }), null);
          if (!r) throw new Error('搜索超时');
          searchInfo = { keyword: r.keyword, count: r.count, samples: r.items.map((x) => x.title).filter(Boolean).slice(0, 4) };
          state.addSearch(searchInfo);
          state.save();
          say(`搜「${kw}」拿到 ${r.count} 条结果`, { phase: 'search', data: searchInfo });
        }
      }
    } catch (error) {
      say(`搜索失败（跳过）：${error.message.slice(0, 80)}`, { phase: 'search', ok: false });
    }
  }

  // ── 出片
  let video = null;
  try {
    think(`按「${modeLabel(contentMode)}」模式决定视频内容`, { contentMode, roundsStat: roundsStat.map((r) => ({ round: r.round, scroll: r.scrollCount, like: r.like, reply: r.reply })) });
    // 总结视频配额：一天最多 N 条（超过就不再出片，只刷不发）
    const perDay = Number(cfg.summary?.perDay ?? 0);  // 0 = 不限（测试/精简配置）
    const publishedToday = Number(state.data.counts.publish ?? 0);
    const skipVideo = perDay > 0 && publishedToday >= perDay;
    if (skipVideo) {
      think(`今天的总结视频已经发了 ${publishedToday} 条（上限 ${perDay}），这次不再出片`);
      result.steps.push({ kind: 'video', ok: true, skipped: true, reason: `总结视频已达每日上限 ${perDay} 条` });
    }

    // 自己的真实数据（播放量/点赞/净增粉丝/最新作品）：塞进文案里就有"活人感"
    let myStats = null;
    if (cfg.video?.stats !== false) {
      try {
        const b0 = await runStep('读数据', 90 * 1000, () => backend(), null);
        const w0 = b0?.web || b0;
        if (w0 && typeof w0.readMyStats === 'function') {
          myStats = await runStep('读数据', 60 * 1000, () => w0.readMyStats(), null);
          if (myStats?.plays || myStats?.fansDelta) {
            think(`看了下自己数据：播放 ${myStats.plays} / 点赞 ${myStats.likes} / 净增粉丝 ${myStats.fansDelta}`);
          }
        }
      } catch (error) {
        think(`读自己数据失败（跳过，不影响出片）：${String(error.message).slice(0, 60)}`);
      }
    }

    const topic = opts.topic || autoTopic(roundsStat, contentMode, state.data.counts);
    const lineCount = Math.max(2, Math.min(20, Number(opts.lineCount ?? cfg.video?.lineCount ?? 12) || 12));
    // 学到的梗：挑两个（最新的优先）念进视频
    let slangTerms = [];
    try {
      if (cfg.slang?.useInVideo !== false) {
        const { loadSlang } = await import('./slang.mjs');
        const store = loadSlang(root);
        slangTerms = [...store.items]
          .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
          .slice(0, 3)
          .map((x) => x.term);
      }
    } catch {}

    const baseLines = autoLines(topic, lineCount, roundsStat, contentMode, state.data.counts, myStats, cfg, slangTerms);
    // 把搜索发现揉进文案（用户要求：总结视频里带上搜到的东西）
    const searchLines = [];
    if (searchInfo && searchInfo.count) {
      searchLines.push(`顺手搜了「${searchInfo.keyword}」`);
      searchLines.push(`出来 ${searchInfo.count} 条结果`);
      for (const s of (searchInfo.samples || []).slice(0, Number(cfg.search?.feedToVideo ?? 3))) {
        const t = String(s).replace(/\s+/g, ' ').slice(0, 18);
        if (t) searchLines.push(`有人在做：${t}`);
      }
    }
    // 去 AI 味兜底清洗（prompts/de-ai.md 是给模型的要求，这里是机械版：只改说法，不动数字）
    let lines = [...baseLines, ...searchLines];
    if (cfg.text?.deai !== false) {
      try {
        const { deaiText } = await import('./deai.mjs');
        lines = lines.map((l) => deaiText(l)).filter(Boolean);
      } catch {}
    }
    say(`主题定了：「${topic}」，字幕 ${lines.length} 句`, { phase: 'plan', data: { topic, lines } });

    /**
     * 「刷新 / 不刷新」总结视频（用户要求：一天两条，可选刷新还是不刷新）
     *   refresh=true （默认）：每次都用最新数据重新出片
     *   refresh=false：今天已经出过片就直接沿用那条，不再渲染（省 1~2 分钟，也不重算配音）
     */
    const reused = !skipVideo && cfg.summary?.refresh === false ? findReusableVideo({ state, root }) : null;
    if (reused) {
      video = reused;
      think(`「刷新总结视频」是关着的，今天已经有这条了：${path.basename(reused.file)}（不再重新渲染）`);
      result.steps.push({ kind: 'video', ok: true, reused: true, file: reused.file, topic: reused.topic, lines });
      say(`沿用今天已出的片：${reused.topic || path.basename(reused.file)}`, { phase: 'video', data: { file: reused.file } });
    }

    if (!skipVideo && !video) {
      trace({ phase: 'video', message: `开始出片（${lines.length} 句，大约 ${Math.round(lines.length * 4.5)} 秒），渲染要 1~2 分钟…` });
      video = await runStep('出片', 8 * 60 * 1000, () => studio.fromText({
        title: topic,
        lines,
        voiceText: lines.join('，'),
        out: path.join(root, 'state', 'video', `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`)
      }), null);
      if (video) rememberVideo({ state, video, topic, caption: lines[0] });
    }
    if (video) {
      result.steps.push({
        kind: 'video', ok: true, file: video.file, cover: video.cover,
        durationSec: Number((video.durationSec ?? 0).toFixed(2)), topic, lines
      });
      say(`出了条视频：${topic}（${video.durationSec.toFixed(1)} 秒）`, { phase: 'video', data: { file: video.file } });
    }
  } catch (error) {
    result.steps.push({ kind: 'video', ok: false, error: error.message });
    say(`出片失败（已跳过）：${error.message}`, { phase: 'video', ok: false });
  }

  // ── 发布
  const wantPublish = opts.publish !== false && video;
  if (wantPublish) {
    const left = remaining('publish', cfg.quotas.publishPerDay);
    if (left <= 0) {
      result.steps.push({ kind: 'publish', ok: true, skipped: true, reason: '今日发布配额已满' });
      say('今日发布配额已满，视频已生成但没发', { phase: 'publish' });
    } else {
      try {
        const b = await runStep('打开浏览器', 3 * 60 * 1000, () => backend(), null);
        if (!b) throw new Error('浏览器没起来');
        const cover = resolveCover(cfg, root) || video.cover;
        const caption = (video.lines?.[0] || video.title || '').slice(0, cfg.publish.captionMax);
        // 去重：同一个片子 + 同一段文案 12 小时内不重复发（10-27 同一片被发过 4 次）
        try {
          const { publishKey, checkDuplicate } = await import('./publish-guard.mjs');
          const dup = checkDuplicate(state, publishKey({ file: video.file, caption }));
          if (dup.duplicate) {
            say(`这条 ${dup.agoMin} 分钟前已经发过了，跳过不重复发`, { phase: 'publish' });
            result.steps.push({ kind: 'publish', ok: true, skipped: true, reason: '重复发布已拦截' });
            throw Object.assign(new Error('duplicate'), { __dup: true });
          }
        } catch (error) {
          if (!error.__dup) { /* 查重失败就照常发，不能因为查重挂了就发不出去 */ }
          else throw error;
        }
        think(`发布：文案「${caption}」，话题 ${cfg.publish.topics.map((t) => '#' + t).join(' ')}`, { cover });
        // 发布用"两步式"，每一步都上报，界面不会看起来卡住
        trace({ phase: 'publish', message: '打开编辑页并上传视频…' });
        let pub;
        const webLayer = b.web || b;
        if (typeof webLayer.preparePublish === 'function') {
          const prep = await runStep('打开发布页', 4 * 60 * 1000, () => webLayer.preparePublish({
            file: video.file, caption, topics: cfg.publish.topics
          }), null);
          trace({ phase: 'publish', message: prep?.prepared ? '上传完成，按钮可点了，正在点发布…' : `准备没完成：${prep?.reason || '按钮不可点'}` });
          if (!prep?.prepared) {
            pub = { published: false, message: prep?.reason || '发布按钮不可点' };
          } else {
            pub = await runStep('点发布', 3 * 60 * 1000, () => webLayer.clickPublish({ verifyMs: 60000 }), null)
              ?? { published: false, message: '点发布超时' };
            trace({ phase: 'publish', message: pub.published ? `已发布（${pub.note || ''}）` : `发布没成功：${pub.reason || ''}` });
          }
        } else {
          pub = await runStep('发布', 5 * 60 * 1000, () => b.publish({
            file: video.file, caption, cover,
            topics: cfg.publish.topics, title: cfg.publish.title || video.title
          }), null) ?? { published: false, message: '发布超时' };
        }
        if (pub?.published) {
          state.add('publish', 1); state.lastPublishAt = Date.now(); state.save();
          try {
            const { publishKey, markPublished } = await import('./publish-guard.mjs');
            markPublished(state, publishKey({ file: video.file, caption }));
            state.save();
          } catch {}
        }
        result.steps.push({ kind: 'publish', ok: Boolean(pub?.published), confirmed: pub?.confirmed ?? false, caption, topics: cfg.publish.topics, message: pub?.message });
        say(pub?.published ? '已发布（话题/封面都带上了）' : `发布没成功：${pub?.message || '未知原因'}`, { phase: 'publish', ok: Boolean(pub?.published) });
      } catch (error) {
        result.steps.push({ kind: 'publish', ok: false, error: error.message });
        say(`发布失败（视频已保存在本地）：${error.message}`, { phase: 'publish', ok: false });
      }
    }
  }

  // 收尾：关掉跑过程中开出来的空白标签
  try {
    const bb = await backend();
    if (typeof bb.tidy === 'function') await bb.tidy();
  } catch {}

  // 收尾：清掉本次产生的中间文件，别越堆越多
  try {
    const { pruneVideoJunk } = await import('./maintenance.mjs');
    result.cleanup = pruneVideoJunk({ root, keepRecent: 5 });
  } catch {}

  result.roundsStat = roundsStat;
  result.countsAfter = state.data.counts;
  result.summary = log.map((l) => l.text).join('\n');
  trace({ phase: 'done', message: `全部完成。${result.summary.split('\n').slice(-2).join('；')}`, data: { countsAfter: result.countsAfter } });
  return result;
}

// ── 单步实现 ────────────────────────────────────────────────────────────
/**
 * 这一步还能做多少。
 * 配额 <= 0 = **不限**（用户要求"回消息/发评论/回评论不限额度"），
 * 这时给一个"每次跑多少"的批量上限，避免一个人在那儿刷一整夜。
 */
function quotaLeft(state, kind, quota, whenUnlimited) {
  const n = state?.remaining ? state.remaining(kind, quota) : Number(quota);
  return Number.isFinite(n) ? n : whenUnlimited;
}

async function doScroll({ backend, state, cfg, round, say, think, opts }) {
  const quota = Number(cfg.quotas.scrollPerRun);
  const unlimited = !(quota > 0);           // 0 = 不限（用户："刷视频也不限额"）
  // 不限时按**时间**兜底，而不是按条数：刷满 N 分钟就收，避免一个人刷一整夜
  const runMaxMin = Math.max(1, Number(cfg.scroll?.runMaxMinutes ?? 10));
  const left = unlimited ? Number.POSITIVE_INFINITY : quotaLeft(state, 'scroll', quota, 30);
  const want = Math.min(Number(opts.scroll ?? left), Number.isFinite(left) ? left : 500);
  if (want <= 0) {
    say('刷视频配额已满，这轮跳过刷', { phase: 'scroll' });
    return { count: 0 };
  }
  try {
    const b = await backend();
    think(unlimited
      ? `一直刷，最多刷 ${runMaxMin} 分钟（按视频时长随机停留 6~22 秒，看完再滑）`
      : `刷 ${want} 条：按视频时长随机停留 6~22 秒，看完再滑`, { count: want });

    const startedAt = Date.now();
    const steps = [];
    const learnedAll = [];
    let learned = [];
    while (steps.length < want) {
      // 不限量：每批 10 条，中间检查时间/停止标记
      const batch = unlimited ? Math.min(10, want - steps.length) : (want - steps.length);
      if (batch <= 0) break;
      const got = await b.feedScroll({ count: batch });
      steps.push(...got);
      if (cfg.slang?.learn !== false) {
        try {
          const { extractMemes, loadSlang, learnMemes, saveSlang } = await import('./slang.mjs');
          const terms = got.flatMap((s) => extractMemes(s.desc || ''));
          if (terms.length) {
            const store = loadSlang(root);
            const r = learnMemes(store, terms);
            saveSlang(root, r.store);
            learnedAll.push(...r.fresh);
          }
        } catch {}
      }
      // 停止标记 / 时间到 → 收
      if (typeof state.shouldStop === 'function' && state.shouldStop()) {
        think('收到停止指令，先不刷了');
        break;
      }
      if (unlimited && (Date.now() - startedAt) / 60000 >= runMaxMin) {
        think(`刷满 ${runMaxMin} 分钟，收工（这轮刷了 ${steps.length} 条）`);
        break;
      }
      if (!got.length) break;
    }
    learned = [...new Set(learnedAll)];
    state.add('scroll', steps.length);
    state.save();
    if (learned.length) think(`记下 ${learned.length} 个新梗：${learned.slice(0, 5).join('、')}`);
    const durs = steps.map((s) => s.durationSec ?? 0);
    const minDur = durs.length ? Math.min(...durs) : 0;
    const maxDur = durs.length ? Math.max(...durs) : 0;
    const changedAll = steps.every((s) => s.changed !== false);
    say(`刷了 ${steps.length} 条，最短 ${Math.round(minDur)} 秒，最长 ${Math.round(maxDur)} 秒${changedAll ? '，全部换片成功' : '，有未换片'}`,
      { phase: 'scroll', data: { count: steps.length, minDur, maxDur } });
    return { count: steps.length, minDur, maxDur, steps: true, learned };
  } catch (error) {
    say(`刷视频失败（已跳过）：${error.message}`, { phase: 'scroll', ok: false });
    return { count: 0 };
  }
}

async function doLike({ backend, state, cfg, opts, say, think }) {
  const left = quotaLeft(state, 'like', cfg.quotas.likePerRun, 10);
  const want = Math.min(opts.likes ?? left, left);
  if (want <= 0) return 0;
  let liked = 0;
  const errors = [];
  try {
    const b = await backend();
    think(`最多点 ${want} 个赞；赞数不变就停（可能已赞过）`, { count: want });
    for (let i = 0; i < want; i++) {
      try {
        const r = await b.like();
        if (r?.changed) { state.add('like', 1); state.save(); liked++; }
        else break;
      } catch (e) { errors.push(e.message); break; }
    }
  } catch (error) { errors.push(error.message); }
  if (liked > 0) say(`点了 ${liked} 个赞`, { phase: 'like', data: { count: liked } });
  else if (errors.length) say(`没点成赞（已跳过）：${errors[0]}`, { phase: 'like', ok: false });
  else say('没点成赞：赞数没变化（可能已赞过），跳过', { phase: 'like' });
  return liked;
}

async function doReply({ backend, state, cfg, opts, say, think }) {
  const left = quotaLeft(state, 'reply', cfg.quotas.replyPerRun, 20);
  const want = Math.min(opts.replies ?? left, left);
  if (want <= 0) return { count: 0, repliedTexts: [], skipped: [] };
  try {
    const b = await backend();
    const readFn = b.readComments || b.comments;
    if (typeof readFn !== 'function') throw new Error('后端没有提供读评论方法（readComments/comments 都缺失）');
    const comments = await readFn.call(b, { limit: 30 });
    think(`读到 ${comments.length} 条评论，按「黑名单 → 标签白名单 → 关键词白名单」筛`, { read: comments.length });

    const judge = (text) => {
      const t = String(text ?? '').trim();
      if (!t) return { ok: false, why: '空评论' };
      if (t.length < cfg.reply.minChars) return { ok: false, why: '太短' };
      if (t.length > cfg.reply.maxChars) return { ok: false, why: '太长' };
      // 纯表情/纯符号不回（白名单留空=全回之后，这些会漏进来）
      if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return { ok: false, why: '纯表情/符号' };
      if ((cfg.reply.blacklist ?? []).some((w) => w && t.includes(w))) return { ok: false, why: '命中黑名单' };
      const tags = cfg.reply.tagWhitelist ?? [];
      if (tags.length && tags.some((tag) => tag && t.includes(tag))) return { ok: true, via: '评论标签白名单' };
      const wl = cfg.reply.whitelist ?? [];
      if (!wl.length) return { ok: true, via: '无白名单(全回)' };
      const hit = wl.find((w) => (w === '?' || w === '？' ? /[?？]/.test(t) : t.includes(w)));
      return hit ? { ok: true, via: `关键词「${hit}」` } : { ok: false, why: '不含互动词' };
    };

    const judged = comments.map((c) => ({ c, v: judge(c.text) }));
    const usableAll = judged.filter((x) => x.v.ok).map((x) => x.c);
    // 回复一次就够：同一个人说的是同一句话 → 已经回过就不再回（他追评换了内容才会再回）
    const usable = usableAll.filter((c) => !(typeof state.hasReplied === 'function' && state.hasReplied(replyKey(c.author, c.text))));
    const already = usableAll.length - usable.length;
    if (already) think(`其中 ${already} 条之前回过了（同一个人的同一句话只回一次），跳过`);
    const skipped = judged.filter((x) => !x.v.ok).map((x) => ({ author: x.c.author, text: x.c.text?.slice(0, 20), why: x.v.why }));
    think(`可回 ${usable.length} 条，计划回 ${Math.min(want, usable.length)} 条`, { usable: usable.length, want });

    let replied = 0;
    const repliedTexts = [];
    const failures = [];
    // 表情包回复：开了开关就按概率带图（图库 = state/assets/stickers，按对方评论的情绪挑）
    const stickerCfg = cfg.reply?.sticker ?? {};
    const stickerOn = stickerCfg.enabled === true && typeof b.replyWithSticker === 'function';
    const stickerRate = Math.min(1, Math.max(0, Number(stickerCfg.rate ?? 0.3)));
    if (stickerOn) think(`表情包回复已开：大约 ${Math.round(stickerRate * 100)}% 的回复会带一张表情包`);
    for (const c of usable.slice(0, want)) {
      const content = pickReplyText(c.text, b, cfg);
      try {
        let r = null;
        let stickerInfo = null;
        if (stickerOn && Math.random() < stickerRate) {
          const pick = pickReplySticker({ root: projectRoot(), commentText: c.text });
          if (pick.file) {
            r = await b.replyWithSticker({
              match: c.text.slice(0, 12), content,
              sticker: pick.file, mode: stickerCfg.mode || 'append', openPanel: false
            });
            stickerInfo = { emotion: pick.emotion, sent: r?.stickerSent ?? 'none', file: pick.file };
            if (r?.stickerSent === 'none' && r?.stickerNote) think(`表情包没发出去（${r.stickerNote}），这条是${r.replied ? '纯文字' : '空的'}`);
          }
        }
        if (!r) r = await b.reply({ match: c.text.slice(0, 12), content, openPanel: false });
        if (r?.verified === false) { failures.push({ author: c.author, error: r.note || '未确认发送' }); continue; }
        state.add('reply', 1); state.save();
        try { state.markReplied(replyKey(c.author, c.text)); state.save(); } catch {}
        replied++;
        repliedTexts.push(stickerInfo ? { to: c.author, content, sticker: stickerInfo } : { to: c.author, content });
      } catch (error) {
        failures.push({ author: c.author, text: c.text?.slice(0, 20), error: error.message });
      }
    }
    /**
     * 自己作品下的评论（创作者后台「评论管理」）。
     *
     * 用户反馈"回自己作品评论还是不行"：信息流那边只能回到刷到的视频，
     * 自己作品的评论得单独去后台那一页回。这里在刷到的不够时补上，
     * cfg.reply.includeOwn === false 可以关（默认开）。
     */
    let ownReplied = 0;
    if (cfg.reply?.includeOwn !== false && replied < want) {
      const w = b.web || b;
      if (typeof w.listOwnComments === 'function' && typeof w.replyOwnComment === 'function') {
        try {
          const own = await w.listOwnComments({ limit: 20 });
          const fresh = own.filter((c) => c.text && !(typeof state.hasReplied === 'function' && state.hasReplied(replyKey(c.author, c.text))));
          think(`自己作品下 ${own.length} 条评论，其中 ${fresh.length} 条还没回过`);
          for (const c of fresh) {
            if (replied >= want) break;
            const v = judge(c.text);
            if (!v.ok) continue;
            const content = pickReplyText(c.text, b, cfg);
            const r = await w.replyOwnComment({ match: String(c.text).slice(0, 12), content });
            if (r?.verified) {
              state.add('reply', 1); state.save();
              try { state.markReplied(replyKey(c.author, c.text)); state.save(); } catch {}
              replied++; ownReplied++;
              repliedTexts.push({ to: c.author, content, where: 'own' });
            } else {
              failures.push({ author: c.author, text: String(c.text).slice(0, 20), error: r?.note || '未确认发送' });
            }
          }
        } catch (error) {
          say(`回自己作品评论失败（已跳过）：${String(error.message).slice(0, 80)}`, { phase: 'reply', ok: false });
        }
      }
    }

    if (replied > 0) say(`回了 ${replied} 条评论${ownReplied ? `（其中自己作品 ${ownReplied} 条）` : ''}（候选 ${usable.length} / 读到 ${comments.length}）`, { phase: 'reply', data: { count: replied, own: ownReplied } });
    else if (failures.length) say(`回评论全部失败：${failures[0].error.slice(0, 80)}`, { phase: 'reply', ok: false });
    else say(`没找到可回的评论（读到 ${comments.length} 条）${skipped.length ? '，例如：' + skipped.slice(0, 2).map((s) => `「${s.text}」${s.why}`).join('、') : ''}`, { phase: 'reply' });

    return { count: replied, repliedTexts, skipped, failures, ownReplied };
  } catch (error) {
    say(`回评论失败（已跳过）：${error.message}`, { phase: 'reply', ok: false });
    return { count: 0, repliedTexts: [], skipped: [], failures: [{ error: error.message }] };
  }
}

// ── 内容生成 ────────────────────────────────────────────────────────────
function modeLabel(mode) {
  return mode === 'journal' ? '我干了什么' : mode === 'scrolled' ? '今天刷到什么' : '刷到+干了什么';
}

function autoTopic(roundsStat, mode, counts) {
  // 本轮 + 今天累计取较大值：配额已满时本轮是 0，但今天其实干了很多
  const todayScroll = Number(counts?.scroll ?? 0);
  const todayReply = Number(counts?.reply ?? 0);
  const todayLike = Number(counts?.like ?? 0);
  const totalScroll = Math.max(roundsStat.reduce((s, r) => s + (r.scrollCount ?? 0), 0), todayScroll);
  const totalReply = Math.max(roundsStat.reduce((s, r) => s + (r.reply ?? 0), 0), todayReply);
  const totalLike = Math.max(roundsStat.reduce((s, r) => s + (r.like ?? 0), 0), todayLike);

  // 第一人称，我是这个号的主人
  if (mode === 'journal') {
    if (totalReply) return `今天刷了 ${totalScroll} 条，还回了 ${totalReply} 条`;
    if (totalLike) return `刷了 ${totalScroll} 条，点了 ${totalLike} 个赞`;
    return totalScroll ? `今天看了 ${totalScroll} 条视频` : '今天随便看看';
  }
  if (mode === 'scrolled') {
    return totalScroll ? `刷了 ${totalScroll} 条，有几条挺上头` : '刷到点东西，记一下';
  }
  if (totalReply) return `刷 ${totalScroll} 条，回 ${totalReply} 条`;
  return totalScroll ? `今天看了 ${totalScroll} 条` : '随便看看';
}

/**
 * 按日期/数据播种的随机数：同一天的同一批数据说法固定，
 * 换一天就换一套说法 —— 不然每天听起来都像同一个模板念稿。
 */
function seededRnd(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function autoLines(topic, n, roundsStat, mode, counts, myStats = null, cfg = null, slangTerms = []) {
  const todayScroll = Number(counts?.scroll ?? 0);
  const todayLike = Number(counts?.like ?? 0);
  const todayReply = Number(counts?.reply ?? 0);
  const totalScroll = Math.max(roundsStat.reduce((s, r) => s + (r.scrollCount ?? 0), 0), todayScroll);
  const totalLike = Math.max(roundsStat.reduce((s, r) => s + (r.like ?? 0), 0), todayLike);
  const totalReply = Math.max(roundsStat.reduce((s, r) => s + (r.reply ?? 0), 0), todayReply);
  const maxDur = Math.max(0, ...roundsStat.map((r) => r.maxDur ?? 0));
  const replySamples = roundsStat.flatMap((r) => r.replyTexts ?? []).slice(0, 2);
  const goalFans = Math.max(0, Number(cfg?.goal?.fans ?? 10000) || 0);

  /**
   * 全部第一人称，但**不能像模板**：用户说"说话方式太像模板了"。
   * 做法：每类句子给 4~6 种说法，用「日期+数据」播种随机挑一个 ——
   * 同一天稳定，换一天就换一套，听起来不像每天念同一段稿。
   */
  const rnd = seededRnd(`${mode}|${totalScroll}|${totalLike}|${totalReply}|${new Date().toDateString()}`);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const many = (arr, k) => {
    const out = [];
    const copy = [...arr];
    while (out.length < k && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
    return out;
  };

  const pool = [];

  // ① 开场：不只是"今天照旧刷了会儿视频"
  const openers = mode === 'scrolled'
    ? [topic, `今天刷到点东西：${topic}`, topic]
    : mode === 'journal'
      ? ['今天照旧刷了会儿视频', '又是一天，先刷会儿', '开工，先刷两条', '今天也没少刷', '照旧，边刷边记']
      : [topic, '今天刷的加我干的，都在这儿', '先说刷的'];
  pool.push(pick(openers));

  // ② 事实句：同一件事换着说
  if (totalScroll) {
    const n1 = totalScroll;
    pool.push(pick([
      `今天刷了 ${n1} 条`,
      `刷了 ${n1} 条，手指都麻了`,
      `${n1} 条，眼睛快瞎了`,
      `一口气刷了 ${n1} 条`,
      `数了下，${n1} 条`
    ]));
    if (n1 >= 10) pool.push(pick(['手指都划酸了', '拇指快废了', '从早刷到晚']));
  }
  if (totalLike) {
    pool.push(pick([`顺手点了 ${totalLike} 个赞`, `点了 ${totalLike} 个赞`, `赞了 ${totalLike} 下`]));
  }
  if (totalReply) {
    pool.push(pick([`回了 ${totalReply} 条评论`, `评论回了 ${totalReply} 条`, `跟 ${totalReply} 个人聊了两句`]));
  }
  if (replySamples.length) {
    // repliedTexts 里 content 是**我发出去的那句**（不是对方的问题），别写成"有人问我"。
    // 顺手清掉 @提及 和路径类字符：这些是评论区的脏东西，念出来很怪
    const clean = String(replySamples[0].content ?? '')
      .replace(/@+\S+/g, '')
      .replace(/[\\/|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12);
    if (clean) pool.push(`我回了句「${clean}」`);
  }
  if (maxDur) {
    const mins = Math.round(maxDur / 60) || 1;
    pool.push(pick([`最长一条看了 ${mins} 分钟`, `有条看了 ${mins} 分钟`, `${mins} 分钟那条，我看完了`]));
  }

  // 感受句：换着说，别每天都那四句
  const feelings = mode === 'scrolled'
    ? ['有的几十万赞，有的几千', '刷完就忘了', '有几条我记下来了', '评论区比视频还有意思',
       '有的标题党，点进去就那样', '算法真懂我', '刷着刷着天就黑了', '看完啥也没记住']
    : mode === 'journal'
      ? ['都是我一条条看过去的', '中间还停下来回了会儿消息', '有几条我反复看了两遍', '手上的事也没落下',
         '没什么特别的，就是日常', '反正闲着也是闲着', '今天状态一般', '电脑一直开着']
      : ['有的看完就划走了', '有几条我反复看了两遍', '评论区比视频还有意思', '中间还停下来回了会儿消息',
         '刷到一半去倒了杯水', '有几条确实好看'];
  pool.push(...many(feelings, 4));

  /**
   * 「活人感」那一层：拿自己账号的真实数字说话（播放量 / 点赞 / 涨粉 / 最新一条）。
   * 没有数据就一句都不编 —— 编数字比没有更假。
   */
  if (myStats) {
    const plays = Number(myStats.plays || 0);
    const likes = Number(myStats.likes || 0);
    const fans = Number(myStats.fansDelta || 0);
    if (plays) pool.push(...many([`昨天播放 ${fmtNum(plays)}`, `${fmtNum(plays)} 播放里有你几条`, `一天 ${fmtNum(plays)} 播放，还行`], 2));
    if (likes) pool.push(pick([`点了 ${fmtNum(likes)} 个赞，比我想的多`, `${fmtNum(likes)} 个赞，谢谢`]));
    if (fans > 0) {
      // 一定有一条说"粉丝/涨"，其余口味随机（测试和文案都稳）
      pool.push(`涨了 ${fmtNum(fans)} 个粉丝`);
      if (rnd() < 0.6) pool.push(pick([`${fmtNum(fans)} 个新面孔，我记住你们了`, `+${fmtNum(fans)} 粉，开心`]));
    }
    else if (fans < 0) pool.push(pick(['掉粉了，得想想为啥', '少了几个人，无所谓']));
    if (myStats.last?.plays) pool.push(pick([`最新那条 ${fmtNum(myStats.last.plays)} 播放`, `新视频已经 ${fmtNum(myStats.last.plays)} 播放`]));
    if (myStats.completion) pool.push(pick([`完播率 ${myStats.completion}%，还行吧`, `${myStats.completion}% 看完，可以了`]));
  }

  // 目标：冲一万粉（数字来自配置，不写死）
  if (goalFans > 0) {
    const goalText = goalFans >= 10000 ? '一万粉' : `${goalFans} 粉`;
    pool.push(`我的目标是${goalText}`, `离${goalText}还远`, pick([`${goalText}，慢慢来`, '有你们在，涨粉才有意思']));
  }

  // 读评论：真读过就说读过
  if (totalReply) pool.push('评论我一条条看，不是自动回的', '有人问我真人还是 AI，我照实说');

  // 学到的梗：挑一个念出来（用户要"学习刷到的网络梗"）
  if (slangTerms?.length) {
    const term = slangTerms[0];
    pool.push(`今天学的梗：${term}`, `${term}，记住了`, `刷到个词：${term}`);
  }

  // 搜索发现（有就带一句）
  if (totalScroll === 0 && totalReply === 0) pool.push('今天没怎么动，就随便看看');

  // 收尾：换着说，别每天都"明天接着刷 / 就这样"
  pool.push(...many([
    '不知道你们今天刷了啥', '明天接着刷', '就这样', '先睡了', '明天见',
    '有好看的记得喊我', '刷到这儿，收工'
  ], 2));

  const picked = [...new Set(pool.filter(Boolean))].slice(0, Math.max(2, n));

  /**
   * 保证"目标"和"真实数据"一定进片：
   * 之前池子太长，切片时把目标那几句挤掉了 —— 用户要"冲击10000粉丝"的内容就白写了。
   */
  const goalLine = goalFans > 0 ? (goalFans >= 10000 ? '我的目标是一万粉' : `我的目标是 ${goalFans} 粉`) : '';
  // 注意别用 /粉/ 判断：'涨了 8 个粉丝' 也会命中，结果目标那句永远进不去
  if (goalLine && !picked.some((l) => /目标|一万粉/.test(l))) {
    if (picked.length >= 3) picked.splice(picked.length - 2, 0, goalLine);
    else if (picked.length >= 2) picked[picked.length - 1] = goalLine;
    else picked.push(goalLine);
  }
  const hasStatsLine = picked.some((l) => /播放|涨了|粉丝|完播/.test(l));
  if (myStats && (myStats.plays || myStats.fansDelta) && !hasStatsLine) {
    const statLine = myStats.plays ? `昨天播放 ${fmtNum(myStats.plays)}` : `涨了 ${fmtNum(myStats.fansDelta)} 个粉丝`;
    if (picked.length >= 2) picked.splice(Math.max(1, picked.length - 2), 0, statLine);
    else picked.push(statLine);
  }
  // 学到的梗也要保证有一条（不然池子一长就被切没了，学梗白学）
  if (slangTerms?.length && !picked.some((l) => slangTerms.some((t) => l.includes(t)))) {
    const line = `今天学的梗：${slangTerms[0]}`;
    if (picked.length >= 2) picked.splice(Math.max(1, picked.length - 2), 0, line);
    else picked.push(line);
  }
  return picked;
}

/** 11000 → 1.1万；832 → 832 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(v));
}

/**
 * 回评文案：走"鲸鱼女孩"口吻的模板池（ops.pickReply），比写死的三句话有活人感。
 * 需要 @ 主人/管理员时，由 cfg.reply.atOwner 决定前缀（见 atPrefix）。
 */
function pickReplyText(commentText, backend, cfg) {
  const t = String(commentText);
  if (backend?.ks?.constructor?.name === 'Kuaishou' && backend.ks.pickReply) {
    try {
      const r = backend.ks.pickReply();
      if (r) return `${atPrefix(cfg)}${r}`;
    } catch {}
  }
  return `${atPrefix(cfg)}${pickReply(t)}`;
}

/** @主人 / @管理员：配置里填了昵称就加上（没填就不加，别乱 @ 人） */
function atPrefix(cfg) {
  const who = String(cfg?.reply?.atOwner ?? '').trim();
  if (!who) return '';
  if (who === '管理员' || who === 'admin') return '@管理员 ';
  return `@${who} `;
}

function resolveCover(cfg, root) {
  const c = cfg.publish?.coverFile;
  if (!c) return '';
  const p = path.isAbsolute(c) ? c : path.join(root, c);
  return fs.existsSync(p) ? p : '';
}
