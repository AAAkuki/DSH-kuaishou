// 运营层：配额、状态落盘、排程。业务动作都在 ks.mjs，这里只管「什么时候做、做多少」。
//
// 状态文件里只存**计数与时间戳**，不存评论正文、不存账号凭据 —— 丢一次不可惜。
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { writeJsonAtomic, readJsonSafe } from './safety.mjs';
import { pickSlang } from './slang.mjs';

export function todayKey(now = new Date(), tzOffsetMinutes = -now.getTimezoneOffset()) {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

export const EMPTY_STATE = {
  day: '',
  counts: { scroll: 0, reply: 0, like: 0, publish: 0 },
  lastRunAt: 0,
  lastPublishAt: 0,
  /** 今天最后一条总结视频（「不刷新」时直接沿用它，省一次 1~2 分钟的渲染） */
  lastVideo: null,
  /** 已经回过的评论（作者|前20字）：回复一次就够，除非对方追评 */
  repliedKeys: [],
  log: []
};

export class OpsState {
  constructor({ file = path.join(projectRoot(), 'state', 'ops-state.json') } = {}) {
    this.file = file;
    // 数组必须各实例一份：以前 repliedKeys/log 直接引用了 EMPTY_STATE 里的数组，
    // 结果所有实例共享同一个数组（"回过了"会跨实例串味，测试里也炸过）。
    this.data = { ...EMPTY_STATE, counts: { ...EMPTY_STATE.counts }, log: [], repliedKeys: [] };
    /** 这次 load 是不是从坏文件/备份里救回来的（给 trace 和 /env 用） */
    this.recovered = false;
  }

  load() {
    // 损坏自愈：坏文件留档 → 试 .bak → 再兜底成空状态（宁可少刷，不要因状态坏了重复发视频）
    const { value, recovered } = readJsonSafe(this.file, null);
    const raw = value;
    if (raw && typeof raw === 'object') {
      this.data = {
        ...EMPTY_STATE,
        ...raw,
        counts: { ...EMPTY_STATE.counts, ...(raw.counts ?? {}) },
        log: Array.isArray(raw.log) ? raw.log.slice(-200) : []
      };
    }
    this.recovered = recovered;
    this.rollDay();
    return this;
  }

  rollDay(now = new Date()) {
    const key = todayKey(now);
    if (this.data.day !== key) {
      this.data.day = key;
      this.data.counts = { scroll: 0, reply: 0, like: 0, publish: 0 };
    }
    return this;
  }

  add(kind, n = 1, meta = {}) {
    this.rollDay();
    this.data.counts[kind] = (this.data.counts[kind] ?? 0) + n;
    this.data.log.push({ at: Date.now(), kind, n, ...meta });
    if (this.data.log.length > 200) this.data.log = this.data.log.slice(-200);
    if (kind === 'publish') this.data.lastPublishAt = Date.now();
    this.data.lastRunAt = Date.now();
    return this.data.counts[kind];
  }

  /**
   * 已经回过的评论（作者|前20字）。同一个人追评（换了内容）才会是新的 key。
   */
  markReplied(key) {
    if (!key) return;
    if (!Array.isArray(this.data.repliedKeys)) this.data.repliedKeys = [];
    this.data.repliedKeys.push(String(key));
    if (this.data.repliedKeys.length > 800) this.data.repliedKeys = this.data.repliedKeys.slice(-800);
  }

  /** 这个人的这条评论回过了吗 */
  hasReplied(key) {
    return Array.isArray(this.data.repliedKeys) && this.data.repliedKeys.includes(String(key));
  }

  remaining(kind, quota) {
    this.rollDay();
    // quota <= 0 表示**不限**（用户要求：回消息/发评论/回评论不限额度）
    if (!(Number(quota) > 0)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Number(quota) - (this.data.counts[kind] ?? 0));
  }

  /** 配额用完就重置（用户要求：别停在"配额用完"，重置了接着刷） */
  resetQuotas({ keepPublish = true } = {}) {
    this.rollDay();
    const prev = { ...this.data.counts };
    this.data.counts.scroll = 0;
    this.data.counts.reply = 0;
    this.data.counts.like = 0;
    if (!keepPublish) this.data.counts.publish = 0;
    this.data.quotaResets = (this.data.quotaResets ?? 0) + 1;
    this.data.lastResetAt = Date.now();
    this.data.log.push({ at: Date.now(), kind: 'reset', n: 1, note: '配额重置', prev });
    if (this.data.log.length > 200) this.data.log = this.data.log.slice(-200);
    return prev;
  }

  /** 记录一次搜索（词、结果条数、顶部标题） */
  addSearch({ keyword, count, samples = [] } = {}) {
    this.rollDay();
    if (!Array.isArray(this.data.searches)) this.data.searches = [];
    this.data.searches.push({ at: Date.now(), keyword, count, samples: samples.slice(0, 5) });
    if (this.data.searches.length > 50) this.data.searches = this.data.searches.slice(-50);
    return this.data.searches[this.data.searches.length - 1];
  }

  searchesToday() {
    this.rollDay();
    const list = Array.isArray(this.data.searches) ? this.data.searches : [];
    return list.filter((x) => todayKey(new Date(x.at)) === this.data.day);
  }

  /** 请求停止（插件收到后不再继续刷） */
  requestStop(reason = '用户停止') {
    this.data.stopRequested = true;
    this.data.stopReason = reason;
    this.data.stopAt = Date.now();
    return this.data.stopRequested;
  }

  clearStop() {
    this.data.stopRequested = false;
    this.data.stopReason = '';
    return true;
  }

  shouldStop() {
    return this.data.stopRequested === true;
  }

  save() {
    // 原子写：写到一半被杀也只会留下完整旧文件，不会把计数清成 0（清 0 会导致重复发视频）
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (error) {
      // rename 被占用时退化成直写；这里再兜一层，绝不让保存失败把自动流程带崩
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      } catch {}
    }
    return this;
  }
}

/**
 * 评论 → 回复文案。
 *
 * 用户反馈"刷视频的评论不要就那几个，多一点活人感"：
 * 每个意图都铺到 10+ 句，口吻是**鲸鱼女孩（傲娇但甜、聪明但懒）**，
 * 并且带一点具体反应（不是"确实""同感"这种万能句）。
 * 仍然避开「谢谢分享」这类会被判灌水的空话。
 */
const REPLY_TEMPLATES = {
  question: [
    '这个我得想想，主人别急',
    '诶嘿，我上次也卡这儿了',
    '看情况吧，你那版是多少',
    '有链接吗，我瞅一眼原帖',
    '这个我也在琢磨，回头细说',
    '我试过，能跑，但要改一行',
    '啧，这问题问得好，我得查查',
    '你先说说用在哪，我好判断',
    '我大概知道，怕说错',
    '这个坑我踩过，跟你说下'
  ],
  praise: [
    '诶嘿，尾巴都翘起来了',
    '主人这么说，我更有劲了',
    '被你发现了，偷偷得意一下',
    '别夸，我怕我懒得更厉害',
    '这话我爱听，再说一遍',
    '啧，算你有眼光',
    '我圆滚滚地滚过来收下这句',
    '行吧行吧，今天允许你夸我',
    '被你夸得不好意思了',
    '记下了，明天还这么夸'
  ],
  generic: [
    '确实是这样',
    '同感，我也有这感觉',
    '有道理，我记一下',
    '这个角度我之前没想到',
    '学到了，谢谢',
    '嗯……让我想想',
    '说得挺对的',
    '我懂你意思',
    '这条我赞成',
    '有被说到'
  ]
};

export function pickReply(text, { random = Math.random, slang = null, slangRate = 0.2 } = {}) {
  const t = String(text ?? '');
  const pool = /[?？]|怎么|什么|哪|求|吗|有没有|推荐/.test(t)
    ? REPLY_TEMPLATES.question
    : /(好|棒|牛|厉害|喜欢|赞|绝了|经典)/.test(t)
      ? REPLY_TEMPLATES.praise
      : REPLY_TEMPLATES.generic;
  // 避免连着两次说同一句（"活人感"最忌讳复读）
  const last = globalThis.__ksopsLastReply;
  let pick = pool[Math.floor(random() * pool.length) % pool.length];
  if (pool.length > 1 && pick === last) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
  globalThis.__ksopsLastReply = pick;

  // 学到的梗：低频掺一句（每条都带就一眼假）
  if (slang?.items?.length && random() < slangRate) {
    const term = pickSlang(slang, { random });
    if (term && !pick.includes(term) && `${pick}，${term}`.length <= 24) pick = `${pick}，${term}`;
  }
  return pick;
}

/**
 * 停止闸门（纯函数）：用户点过停止之后，所有对外动作都要被拦住。
 *
 * 以前只有脚本循环看这个标记，单步动作（看/滑/赞/回/发）照样执行 ——
 * 实测点了停止 40 秒后还在点赞、回评论。返回空串 = 可以继续。
 */
export function stopBlocker(state, tool = '动作') {
  if (!state?.data?.stopRequested) return '';
  const why = state.data.stopReason || '用户停止';
  return `你在设置页点了停止（${why}），${tool} 不会继续执行。要恢复：ks_stop({clear:true})，或在设置页再点一次停止清掉标记`;
}

/**
 * 已经回过谁的评论（"回复一次就够，除非他再次追评"）。
 * key = 作者|评论前 20 字：同一个人说了新话 → key 变了 → 才会再回。
 */
export function replyKey(author, text) {
  return `${String(author ?? '').trim()}|${String(text ?? '').replace(/\s+/g, '').slice(0, 20)}`;
}

/**
 * 生成一次运行计划。
 *
 * 注意：`remaining()` 在"不限额度"（配额 <= 0）时返回 Infinity。
 * 这个值一旦进了计划，就会变成 JSON 里的 `null`，`runPlan` 里
 * `for (let i = 0; i < task.count; i++)` 要么一条不跑、要么跑不完。
 * 所以这里把 Infinity 换成"每次跑多少"的批量上限（和 doScroll 的兜底一致）。
 */
const PLAN_UNLIMITED_CAP = { scroll: 30, reply: 20, like: 10, publish: 1 };

function planCount(kind, left) {
  const cap = PLAN_UNLIMITED_CAP[kind] ?? 10;
  if (!Number.isFinite(left)) return cap;
  return Math.max(0, Math.min(left, cap === 1 ? 1 : Number.POSITIVE_INFINITY));
}

export function makePlan({ quotas, state, random = Math.random, wantPublish = false } = {}) {
  const plan = [];
  const scroll = state ? state.remaining('scroll', quotas.scrollPerRun) : quotas.scrollPerRun;
  const reply = state ? state.remaining('reply', quotas.replyPerRun) : quotas.replyPerRun;
  const like = state ? state.remaining('like', quotas.likePerRun) : quotas.likePerRun;
  const publish = state ? state.remaining('publish', quotas.publishPerDay) : quotas.publishPerDay;

  const scrollN = planCount('scroll', scroll);
  const replyN = planCount('reply', reply);
  const likeN = planCount('like', like);

  if (scrollN > 0) plan.push({ kind: 'scroll', count: scrollN });
  if (replyN > 0) plan.push({ kind: 'reply', count: replyN });
  if (likeN > 0) plan.push({ kind: 'like', count: likeN });
  if (wantPublish && publish > 0) plan.push({ kind: 'publish', count: 1 });
  // 打散顺序：先刷几条再看评论，比「机械按序」更像人
  if (plan.length > 2 && random() < 0.5) {
    const [first, ...rest] = plan;
    plan.splice(0, plan.length, ...rest, first);
  }
  return plan;
}

/**
 * 跑一次计划。
 * @param {object} args
 * @param {import('./ks.mjs').Kuaishou} args.ks
 * @param {OpsState} args.state
 * @param {Array} args.plan
 * @param {(e:object)=>void} [args.onEvent]
 * @param {(text:string)=>string} [args.replyText] 自定义回复生成（默认模板）
 */
export async function runPlan({ ks, state, plan, onEvent = () => {}, replyText = pickReply, random = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const events = [];
  const emit = (e) => { events.push(e); onEvent(e); };

  for (const task of plan) {
    if (task.kind === 'scroll') {
      const steps = await ks.feedScroll({ count: task.count, onStep: (s) => emit({ kind: 'scroll', ...s }) });
      state.add('scroll', steps.length);
      state.save();
      continue;
    }

    if (task.kind === 'like') {
      let done = 0;
      for (let i = 0; i < task.count; i++) {
        await ks.like();
        done++;
        state.add('like', 1);
        await sleep(400 + Math.round(random() * 800));
      }
      state.save();
      emit({ kind: 'like', count: done });
      continue;
    }

    if (task.kind === 'reply') {
      await ks.openComments();
      const comments = await ks.readComments();
      const candidates = comments.filter((c) => ks.shouldReply(c.text)).slice(0, task.count);
      let done = 0;
      for (const c of candidates) {
        const content = replyText(c.text);
        try {
          await ks.replyToComment({ match: c.text.slice(0, 12), content, openPanel: false });
          done++;
          state.add('reply', 1, { matched: c.text.slice(0, 40) });
        } catch (error) {
          emit({ kind: 'replyError', matched: c.text.slice(0, 40), message: error.message });
        }
        await sleep(1200 + Math.round(random() * 2000));
      }
      await ks.closeComments();
      state.save();
      emit({ kind: 'reply', count: done });
      continue;
    }

    if (task.kind === 'publish') {
      // 发布需要外部给文件与文案，runPlan 只负责记账；真正发布由 ks_publish_video 工具做
      emit({ kind: 'publish', note: 'publish 需要 file/caption，由 ks_publish_video 执行' });
    }
  }

  return { events, counts: state.data.counts };
}
