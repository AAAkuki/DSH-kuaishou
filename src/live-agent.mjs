// v2（跳一跳 + 敌人/道具）的自动玩法：跳 + 被抓前用道具把敌人打退。
// 单独成文件，方便单测和直播窗口复用。
import { pickLiveReply, fitBubble } from './live-reply.mjs';

/** 敌人离玩家多近算危险（游戏里 CATCH_R=0.55，2.2 内会警告） */
export const DANGER_R = 1.9;

/**
 * 决策（纯函数）：给定局面，返回这一拍该做什么。
 *   { action: 'idle' | 'press' | 'throw' | 'restart', ... }
 * 优先级：被抓/结算 → 重开；敌人逼近且有弹药 → 投掷；否则正常跳。
 */
export function decideAction(st) {
  if (!st) return { action: 'idle', reason: 'no state' };
  if (st.state === 'over' || st.state === 'caught' || st.state === 'ready') {
    return { action: 'restart', reason: `state=${st.state}` };
  }
  if (st.state !== 'idle') return { action: 'idle', reason: `state=${st.state}` };

  // 敌人逼近：有弹药就打
  if (st.enemy && st.ammo) {
    const dx = st.enemy.x - st.cur.x;
    const dy = st.enemy.y - st.cur.y;
    const d = Math.hypot(dx, dy);
    if (d < DANGER_R) {
      const order = st.items && st.items.length ? st.items : ['rice', 'basin', 'dsh'];
      const usable = order.find((k) => Number(st.ammo[k]) > 0);
      if (usable) return { action: 'throw', item: usable, distance: d, reason: '敌人逼近' };
      return { action: 'idle', reason: '没弹药了' };
    }
  }

  // 正常跳
  const { MIN_JUMP = 1.2, MAX_JUMP = 4.9, CHARGE_MS = 1150 } = st.consts || {};
  const need = Number(st.need);
  if (!Number.isFinite(need)) return { action: 'idle', reason: '需要跳的距离不可信' };
  let pw = (need - MIN_JUMP) / (MAX_JUMP - MIN_JUMP);
  if (!Number.isFinite(pw)) pw = 0.5;
  pw = Math.max(0.06, Math.min(1, pw));
  return { action: 'press', power: pw, holdMs: Math.round(pw * CHARGE_MS), reason: '正常跳' };
}

/** 被抓/死亡后要不要重开（游戏自己会切到 over，稍等再点） */
export function shouldRestart(st, { overWaitMs = 900 } = {}) {
  if (!st) return false;
  if (st.state === 'ready') return true;
  if (st.state === 'over') return true;
  return false;
}

export { pickLiveReply, fitBubble };
