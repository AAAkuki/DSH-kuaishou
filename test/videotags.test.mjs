import test from "node:test";
import assert from "node:assert/strict";
import { KuaishouWeb, parseCommentText } from "../src/web.mjs";

// readVideoTags 依赖真实页面，这里只测"从文本里抽标签"的纯逻辑
function extractTags(text) {
  const tags = [];
  for (const m of String(text).matchAll(/#([^\s#，。,.!?！？、]+)/g)) {
    const t = m[1].trim();
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

test("从视频描述抽 #话题", () => {
  assert.deepEqual(extractTags("我就说了句中文，Claude你怎么直接封我号啊？！ #deepseek #claude #chatgpt #大肥鱼"),
    ["deepseek", "claude", "chatgpt", "大肥鱼"]);
});

test("标签去重 + 去掉中文标点尾巴", () => {
  assert.deepEqual(extractTags("#deepseek #deepseek #ai，"), ["deepseek", "ai"]);
});

test("没有标签时返回空数组", () => {
  assert.deepEqual(extractTags("随便一句话"), []);
});

