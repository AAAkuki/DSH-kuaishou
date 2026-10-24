---
name: kuaishou-ops
description: 快手一体化：刷视频、读/回评论、点赞、发视频、本地生成口播视频（配音/字幕/封面）+ 可编辑提示词库。双后端（adb 模拟器/真机 或 快手网页版）。
---

# 快手运营 skill

## 铁律

1. **先 `ks_status`，再动手。** 没有 adb / 设备不在线 / 快手不在前台，后面每一步都会白烧 token。
2. **写东西之前先取提示词。** 回评论、写脚本、写标题、写文案，都先 `ks_brief({kind})` 拿那份提示词，
   按它给的格式输出——提示词是可以被用户改的，你擅自发挥就脱离了对方的口径。
3. **能不截图就不截图。** 一张截图 = 一次图像输入。刷视频用 `ks_feed_scroll`（纯 adb 或网页版翻页），
   只有「必须确认画面」时才用 `ks_screen`。
4. **每次只做一小步，做完看结果。** 不要一口气规划十步然后盲跑——界面每一步都可能变。
5. **发视频前先看素材。** adb 后端先 `pushOnly` 确认相册能看到；网页版确认已登录创作者平台。

## 提示词在哪（用户可改，你不要改）

| 场景 | 提示词 id | 取法 |
|---|---|---|
| 账号人设 | `persona-whale-maid`（默认，鲸鱼女仆娘）/ `persona` / `persona-cool` / `persona-warm` / `persona-sharp` | `ks_brief({ kind: "persona" })`（用哪个由设置页 `personaId` 决定） |
| 回评论 | `reply` | `ks_brief({ kind: "reply", maxReplies: 3 })`（会顺手读回评论） |
| 挑评论 | `comment-pick` | `ks_brief({ kind: "pick" })` |
| 口播脚本 | `script` | `ks_brief({ kind: "script", topic: "...", durationSec: 30 })` |
| 视频标题 | `title` | `ks_brief({ kind: "title", topic: "..." })` |
| 发布文案 | `caption` | `ks_brief({ kind: "caption", topic: "视频标题" })` |
| 运营节奏 | `ops` | `ks_brief({ kind: "ops" })` |

文件在 `prompts/*.md`（内置），用户自己的覆盖在 `state/prompts/*.md`。
设置页的 `personaOverride` 非空时**优先于** `personaId` 指向的文件——用户手写的人设正文永远赢。
`ks_brief` 返回里的 `missing` 非空 = 有变量没填，别硬写，先补变量或问用户。
**不要用 `ks_prompt_save` 去改用户的口径**，除非用户明确让你改。

## 总开关

设置页顶部有「启用快手插件」。**关掉时**所有动作工具都会报错
（`插件总开关已关闭…需要先打开`），只有 `ks_status` / `ks_env` / `ks_plan` / `ks_state` / `ks_prompt_*` 还能用。
遇到这个报错不要去改 config.json，让用户去设置里打开开关。

## 标准动作

### 刷视频（最省 token）

```text
ks_feed_scroll({ count: 20 })
```

内部是：停留 6–22 秒随机 → 上滑（坐标/时长都抖动）→ 重复。
**不要**在每条之间调用 `ks_screen`，那是把成本乘以 20。

想靠近真人节奏就把区间拉长：

```text
ks_feed_scroll({ count: 10, dwellMinMs: 12000, dwellMaxMs: 35000 })
```

### 看到某条想互动

```text
ks_like({})                 // 双击屏幕中部
ks_comments({ limit: 20 })  // 读当前视频评论（文本 + 坐标）
```

### 回评论

单条（精准）：

```text
ks_reply({ match: "这个怎么做的", content: "我这边也在试，回头告诉你" })
```

批量（过白/黑名单 + 配额）：

```text
ks_reply_auto({ limit: 3, style: "gentle" })
```

回复内容会被三条红线拦住：太短（<2 字）、太长（>60 字）、命中拉黑词（加微信/互粉/返现/引流…）。
**被拦就换文案，不要绕过**——那类话术是账号被判营销的主要来源。

### 发视频

```text
ks_publish_video({ file: "D:\\clips\\2026-10-24.mp4", caption: "今天的日常 #生活", pushOnly: true })   // 先只推
ks_publish_video({ file: "D:\\clips\\2026-10-24.mp4", caption: "今天的日常 #生活" })                    // 再真发
```

文案约束：≤120 字、话题 ≤5 个、扩展名在白名单里、文件必须存在。

### 做一条口播视频（不用素材，纯文案）

```text
ks_video_from_text({
  title: "我用 DeepSeek 写了个快手插件",
  lines: ["它自己刷视频、读评论", "还能把文案做成口播视频", "配音字幕封面全自动"],
  bgColor: "0x0b1020"
})
```

返回 `file`（mp4）、`cover`（jpg）、`durationSec`、逐句字幕时间轴。
生成是**本地 ffmpeg + 系统 TTS**，约 5–10 秒一条，不花 token。

素材来源：用户在设置页「选择文件」上传后，文件落在 `state/assets/` 并把绝对路径填进字段；
你也可以直接把路径传进工具参数（不需要经过上传）。

模板样式（背景/字体/声音）默认取设置页，也可在调用时覆盖：

```text
ks_video_style({})                                  // 先看当前生效值
ks_video_from_text({
  title: "...", lines: ["..."],
  bgPreset: "whale-blue",                            // 渐变预设（深海/夜紫/鲸蓝/樱粉/米纸/薄荷）
  bgImage: "D:\\bg.jpg", bgBlur: 18, bgDim: 0.45,    // 图片背景 + 模糊 + 压暗
  bgVideo: "D:\\bg.mp4",                           // 视频背景（循环+静音，优先级最高）
  fontColor: "0xFFE066", fontSize: 46, subtitleY: 0.8,
  rate: 2, bgmFile: "D:\\bgm.mp3", bgmGainDb: -20
})
```

要自己录的素材：

```text
ks_video_compose({
  clips: ["D:\\clips\\a.mp4", "D:\\clips\\b.mp4"],
  lines: ["第一句字幕", "第二句字幕"],
  voiceText: "整段配音文案",
  bgmFile: "D:\\bgm.mp3"
})
```

然后发出去：

```text
ks_publish_video({ file: "<上一步返回的 file>", caption: "今天的日常 #生活" })
```

**注意**：文案自己写，不要抄别人的视频/文案；配音是系统合成音，别冒充真人。

### 运营一轮

```text
ks_plan({ wantPublish: false })   // 先看计划：这一轮刷多少、回几条、赞几个
ks_run({ scroll: 10, replies: 3, likes: 2 })
ks_state({})                      // 今日计数、上次运行、最近日志
```

## 出问题了怎么修

**工具返回 `StepError` 并带「当前屏幕文本」** —— 这是最有用的信息，不要忽略：

| 现象 | 处理 |
|---|---|
| 找不到「评论入口」 | 屏幕摘要里看真实按钮叫什么，把 `config.selectors.commentEntry.text` 补上 |
| 找不到输入框 / 发送按钮 | 同上，改 `commentInput` / `sendButton` |
| 找不到「下一步 / 发布」 | 快手发布流程改版了；先用 `ks_dump` 看当前页，再改 `publishNext` / `publishConfirm` |
| 中文打不出来（提示 ADBKeyboard） | 装 ADBKeyboard 并 `ime set`，或在配置里改成先发纯 ASCII 文案 |
| 相册里没有刚推的视频 | 媒体扫描没生效：`ks_publish_video({ pushOnly: true })` 会打广播，仍不行就重进一次相册页 |
| `没有在线设备` | 启动 MuMu，`adb devices` 看到 `device` 状态再试 |
| 有多台设备 | 在 `config.json` 的 `serial` 指定一台 |

## 成本纪律

| 做法 | 结论 |
|---|---|
| 纯 `ks_feed_scroll` 刷几十条 | ✅ 几乎不花钱 |
| 每条刷完都 `ks_screen` 确认 | ❌ 25k–40k/30 条 |
| 用 `ks_dump`（文本）代替截图定位 | ✅ 便宜 10 倍以上 |
| 一次 `ks_run` 干完刷+回+赞 | ✅ 一条命令、一次记账 |

## 不做的事

- 不登录、不注册、不接验证码 —— 账号由使用者在模拟器里自己登
- 不改包、不 hook、不伪造设备指纹
- 不批量私信、不刷赞 —— 配额和黑名单就是为拦这些
