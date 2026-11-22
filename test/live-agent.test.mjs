// v2 决策逻辑（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAction, shouldRestart, DANGER_R } from '../src/live-agent.mjs';

const base = (over = {}) => ({
  state: 'idle', score: 0, combo: 0, power: 0,
  cur: { x: 0, y: 0, half: 0.8, topZ: 0.5 },
  nxt: { x: 3, y: 0, half: 0.9, topZ: 0.6 },
  need: 3,
  enemy: { x: 10, y: 10, z: 0.5 },
  ammo: { rice: 2, basin: 1, dsh: 1 },
  items: ['rice', 'basin', 'dsh'],
  consts: { MIN_JUMP: 1.2, MAX_JUMP: 4.9, CHARGE_MS: 1150, PERFECT_R: 0.24 },
  ...over
});

test('正常局面：按距离算按压时长', () => {
  const a = decideAction(base());
  assert.equal(a.action, 'press');
  // pw = (3-1.2)/(4.9-1.2) ≈ 0.486 → 约 559ms
  assert.ok(a.holdMs > 400 && a.holdMs < 700, String(a.holdMs));
});

test('敌人逼近又有弹药：优先投掷，不乱跳', () => {
  const a = decideAction(base({ enemy: { x: 1.0, y: 0, z: 0.5 } }));
  assert.equal(a.action, 'throw');
  assert.equal(a.item, 'rice');
  assert.ok(a.distance < DANGER_R);
});

test('敌人逼近但没弹药：不投掷（别空扔）', () => {
  const a = decideAction(base({ enemy: { x: 1.0, y: 0, z: 0.5 }, ammo: { rice: 0, basin: 0, dsh: 0 } }));
  assert.equal(a.action, 'idle');
});

test('弹药按顺序挑第一个有货的', () => {
  const a = decideAction(base({ enemy: { x: 1.0, y: 0, z: 0.5 }, ammo: { rice: 0, basin: 1, dsh: 1 } }));
  assert.equal(a.item, 'basin');
});

test('敌人远：不浪费弹药，继续跳', () => {
  const a = decideAction(base({ enemy: { x: 8, y: 8, z: 0.5 } }));
  assert.equal(a.action, 'press');
});

test('结算/被抓/未开始：重开', () => {
  for (const s of ['over', 'caught', 'ready']) {
    assert.equal(decideAction(base({ state: s })).action, 'restart', s);
  }
  assert.equal(shouldRestart({ state: 'over' }), true);
  assert.equal(shouldRestart({ state: 'idle' }), false);
});

test('跳跃中/蓄力中：什么都不做（等它落地）', () => {
  for (const s of ['jumping', 'falling', 'charging']) {
    assert.equal(decideAction(base({ state: s })).action, 'idle', s);
  }
});

test('nxt 为空 / need 是 NaN：不乱跳', () => {
  assert.equal(decideAction(base({ nxt: null, need: 0 })).action, 'press'); // 0 距离也会给最小力度
  assert.equal(decideAction(base({ need: Number.NaN })).action, 'idle');
  assert.equal(decideAction(null).action, 'idle');
});

test('极端距离：力度被夹在 0.06~1', () => {
  const near = decideAction(base({ need: 0.1 }));
  assert.ok(near.power >= 0.06);
  const far = decideAction(base({ need: 999 }));
  assert.equal(far.power, 1);
});
