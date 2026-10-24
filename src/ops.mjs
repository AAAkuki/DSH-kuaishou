// 运营层：配额、状态落盘、排程。业务动作都在 ks.mjs，这里只管「什么时候做、做多少」。
//
// 状态文件里只存**计数与时间戳**，不存评论正文、不存账号凭据 —— 丢一次不可惜。
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';

export function todayKey(now = new Date(), tzOffsetMinutes = -now.getTimezoneOffset()) {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

export const EMPTY_STATE = {
  day: '',
  counts: { scroll: 0, reply: 0, like: 0, publish: 0 },
  lastRunAt: 0,
  lastPublishAt: 0,
  log: []
};

export class OpsState {
  constructor({ file = path.join(projectRoot(), 'state', 'ops-state.json') } = {}) {
    this.file = file;
    this.data = { ...EMPTY_STATE, counts: { ...EMPTY_STATE.counts }, log: [] };
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...EMPTY_STATE,
        ...raw,
        counts: { ...EMPTY_STATE.counts, ...(raw.counts ?? {}) },
        log: Array.isArray(raw.log) ? raw.log.slice(-200) : []
      };
    } catch {
      // 文件不存在/损坏都从零开始：宁可少刷，不要因为状态坏了重复发视频
    }
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

  remaining(kind, quota) {
    this.rollDay();
    return Math.max(0, quota - (this.data.counts[kind] ?? 0));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }
}

/** 评论 → 回复文案。模板按意图分组，避开「谢谢分享」这类会被判灌水的空话。 */
const REPLY_TEMPLATES = {
  question: ['这个我也不太确定，等我试试', '具体看情况，你说的是哪种', '你说的这个我之前也踩过坑', '这个得看版本，我这边能跑', '有链接吗，我看看原帖'],
  praise: ['谢谢，回头多交流', '哈哈你这么说我更有动力了', '被你发现了', '这波同感'],
  generic: ['确实', '同感', '有道理', '这个角度可以', '学到了', '我先记一下', '说得对']
};

export function pickReply(text, { random = Math.random } = {}) {
  const t = String(text ?? '');
  const pool = /[?？]|怎么|什么|哪|求|吗|有没有|推荐/.test(t)
    ? REPLY_TEMPLATES.question
    : /(好|棒|牛|厉害|喜欢|赞)/.test(t)
      ? REPLY_TEMPLATES.praise
      : REPLY_TEMPLATES.generic;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

/**
 * 生成一次运行计划。
 * @returns {Array<{kind:'scroll'|'reply'|'like'|'publish', count:number}>}
 */
export function makePlan({ quotas, state, random = Math.random, wantPublish = false } = {}) {
  const plan = [];
  const scroll = state ? state.remaining('scroll', quotas.scrollPerRun) : quotas.scrollPerRun;
  const reply = state ? state.remaining('reply', quotas.replyPerRun) : quotas.replyPerRun;
  const like = state ? state.remaining('like', quotas.likePerRun) : quotas.likePerRun;
  const publish = state ? state.remaining('publish', quotas.publishPerDay) : quotas.publishPerDay;

  if (scroll > 0) plan.push({ kind: 'scroll', count: scroll });
  if (reply > 0) plan.push({ kind: 'reply', count: reply });
  if (like > 0) plan.push({ kind: 'like', count: like });
  if (wantPublish && publish > 0) plan.push({ kind: 'publish', count: Math.min(publish, 1) });
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
