import test from "node:test";
import assert from "node:assert/strict";
import { runFullAuto } from "../src/autopilot.mjs";

function deps(counts) {
  const c = { scroll: 0, reply: 0, like: 0, publish: 0, ...counts };
  const state = { data: { counts: c, lastPublishAt: 0 }, add(k, n = 1) { c[k] = (c[k] ?? 0) + n; }, save() {} };
  const cfg = {
    quotas: { scrollPerRun: 30, replyPerRun: 8, likePerRun: 5, publishPerDay: 2 },
    reply: { minChars: 2, maxChars: 60, blacklist: [], whitelist: [], tagWhitelist: [] },
    publish: { captionMax: 120, topics: ["deepseek"], title: "" }
  };
  const backend = async () => ({
    async feedScroll() { return []; },
    async like() { return { changed: false }; },
    async readComments() { return []; },
    async reply() { return { replied: "ok" }; },
    async publish() { return { published: true, confirmed: true }; },
    async tidy() { return { closed: 0 }; }
  });
  const studio = { async fromText({ title, lines }) { return { file: "x.mp4", cover: "c.jpg", durationSec: 5, title, lines }; } };
  return { backend, state, cfg, studio, root: "." };
}

test("journal 文案：本轮没配额时用今天累计，不能写成 0 条", async () => {
  // 今天已经刷满、回满，本轮什么都不会做
  const d = deps({ scroll: 35, like: 6, reply: 8, publish: 1 });
  const r = await runFullAuto(d, { rounds: 1, publish: false, contentMode: "journal" });
  const video = r.steps.find((s) => s.kind === "video");
  const text = [video.topic, ...video.lines].join(" | ");
  assert.match(text, /35/, `应提到今天刷了 35 条：${text}`);
  assert.match(text, /8/, `应提到回了 8 条：${text}`);
  assert.ok(!/干了 0 条/.test(text), `不能写成 0 条：${text}`);
});

