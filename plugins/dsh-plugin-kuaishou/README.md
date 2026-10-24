# dsh-plugin-kuaishou

快手一体化插件在 **DeepSeek Harness 设置页**里的那一页。它只做一件事：把可调项暴露成 DSH 的
settings 命名空间，并把值写进 `state/settings.json` / 让 MCP 侧读到。

## 它为什么必须是一个独立插件

DSH 的设置页只认 **loader entry**：

| 条件 | 说明 |
|---|---|
| entry id = 命名空间名 | 这里 id 必须是 `kuaishou`（见 `cordis.patch.yml`） |
| 插件导出 `Config` | schema 读 entry 的 `fiber.runtime.Config` |
| 至少一个字段带 `.extra('volatile', true)` | 可热改、不重挂载；没有它设置页会报 "no volatile fields" |

MCP server 是独立进程，不参与 profile 装配，拿不到这个位置。
qq-bridge 用 `qq-mode-console` 暴露 `qq-mode` 命名空间，是同一套机制。

## 三个坑（都踩过）

1. **entry 不能写进 home patch**（`profiles/<p>/cordis.patch.yml`）。
   写进去 DSH 会认为该命名空间被 patch 覆盖，设置页直接拒绝写：
   `Configuration for "kuaishou" is overridden by a home patch or command-line overlay`。
   必须由 **bundle 自己**的 `cordis.patch.yml` 提供 entry。
2. **bundle patch 里也不能写 `config:`**。同上，显式 config 会让该命名空间不可写。
   默认值只放在 `Config` 的 `.default()` 里。
3. **`apply(ctx, config)` 拿到的字段是 `{ get() }` 访问器**，不是裸值：
   `config.scrollPerRun.get() === 30`。直接 `String(config.scrollPerRun)` 会得到 `"[object Object]"`。

## 数据流

```
设置页改 → cordis 重新 apply(ctx, config) → 本插件拍平写 state/settings.json
用户点的「保存」还会被 DSH 写进 profile 的 cordis.patch.yml（user 层）
        → MCP server 的 loadConfig() 依次合并：config.json → settings.json → patch(user 层)
```

读 patch 那一层是必须的：`settings/update` 只写 user 层，**插件进程内的运行配置在重启前不变**，
所以"刚改的值"只有从 patch 里读才拿得到。

## 可调项

| 键 | 默认 | 作用 |
|---|---|---|
| `mode` | `auto` | `auto`=有 adb 设备走模拟器，否则网页版；`adb` / `web` 强制 |
| `webProfileDir` | `.web-profile` | 网页版登录态目录（扫码一次） |
| `browserPath` | 空 | 浏览器路径，空=自动找 Edge/Chrome |
| `scrollPerRun` | 30 | 每轮最多刷多少条 |
| `replyPerRun` | 8 | 每轮最多回多少条评论 |
| `likePerRun` | 5 | 每轮最多点多少赞 |
| `publishPerDay` | 2 | 每天最多发多少条 |
| `videoVoice` | `Microsoft Huihui Desktop` | 配音用的系统语音 |
| `ffmpegPath` | 空 | ffmpeg 路径，空=用 npm 自带那份 |
| `replyPromptId` | `reply` | 回评论用哪个提示词 |
| `scriptPromptId` | `script` | 口播脚本用哪个提示词 |

## 安装

由上一级的 `install.mjs` 负责（junction + profile dependencies + bundles + `dsh plugin install`）：

```bash
cd kuaishou-ops
node install.mjs --profile desktop
```

装完重启 DSH → 设置里出现 **kuaishou** 一页。
