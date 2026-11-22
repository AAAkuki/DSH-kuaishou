import test from "node:test";
import assert from "node:assert/strict";
import { AdbBackend, WebBackend } from "../src/driver.mjs";
import { freshConfig } from "./helpers.mjs";

const cfg = freshConfig();

test("AdbBackend 必须有 readComments（autopilot 依赖）", () => {
  const b = new AdbBackend({ cfg, log: () => {} });
  assert.equal(typeof b.readComments, "function");
});

test("WebBackend 必须有 readComments / postComment / readVideoTags", () => {
  const b = new WebBackend({ cfg, log: () => {} });
  for (const m of ["readComments", "postComment", "readVideoTags", "listOwnWorks", "readSubReplies"]) {
    assert.equal(typeof b[m], "function", `WebBackend 缺 ${m}`);
  }
});

test("AdbBackend 不应引用不存在的 this.web", () => {
  const b = new AdbBackend({ cfg, log: () => {} });
  assert.equal(b.web, undefined, "AdbBackend 不该有 web 字段");
});

