// agent 模式（"我自己刷"）的基础设施：
// 面板排队 → ks_agent_take 取走 → agent 用 ks_watch/ks_next 一条条来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetServer } from '../src/assets.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ksops-agent-'));

test('/agent/request：POST 排队，GET 读出来，take=1 取走清空', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'agent-run.json');
  const server = new AssetServer({
    dir,
    port: 0,
    log: () => {},
    agentQueue: async (opts) => {
      const request = { requestedAt: '2026-10-27T11:00:00.000Z', rounds: opts.rounds ?? 1 };
      fs.writeFileSync(file, JSON.stringify(request), 'utf8');
      return { request, file };
    },
    agentTake: async ({ take }) => {
      if (!fs.existsSync(file)) return { request: null };
      const request = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (take) fs.unlinkSync(file);
      return { request };
    }
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;
  try {
    const post = await fetch(`${base}/agent/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: 2 })
    });
    const pb = await post.json();
    assert.equal(pb.ok, true);
    assert.equal(pb.request.rounds, 2);

    const peek = await (await fetch(`${base}/agent/request`)).json();
    assert.equal(peek.request.rounds, 2);
    assert.ok(fs.existsSync(file), 'peek 不该清空');

    const taken = await (await fetch(`${base}/agent/request?take=1`)).json();
    assert.equal(taken.request.rounds, 2);
    assert.ok(!fs.existsSync(file), 'take=1 应该清空');

    const empty = await (await fetch(`${base}/agent/request`)).json();
    assert.equal(empty.request, null);
  } finally {
    await server.stop();
  }
});

test('没配 agent 队列时返回 503（不会静默成功）', async () => {
  const server = new AssetServer({ dir: tmpDir(), port: 0, log: () => {} });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;
  try {
    const r = await fetch(`${base}/agent/request`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 503);
  } finally {
    await server.stop();
  }
});

test('agent 模式提示词写了关键规矩（AI 身份、不刷量、一次只回一次）', () => {
  const body = fs.readFileSync(path.resolve('prompts/agent-mode.md'), 'utf8');
  assert.match(body, /AI/);
  assert.match(body, /不刷量/);
  assert.match(body, /回一次就够/);
  assert.match(body, /ks_watch/);
});
