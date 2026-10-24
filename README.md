# kuaishou-ops

快手运营自动化：**刷视频 / 读评论 / 回评论 / 点赞 / 剪辑生成视频 / 发视频 / 排程运营**。
既能当**命令行软件**直接跑，也能作为 **MCP server** 挂进 DeepSeek Harness（模型侧拿到 `ks_*` 工具）。

**两种后端，同一套工具**（`config.json` 的 `mode`，默认 `auto`）：

| 后端 | 驱动对象 | 需要什么 | 游客能做什么 | 登录后能做什么 |
|---|---|---|---|---|
| `adb` | MuMu 模拟器 / 真机上的**快手 App** | MuMu + adb + ADBKeyboard | 刷、读评论 | 赞、回复、发布 |
| `web` | **快手网页版**（真实 Edge/Chrome，CDP 驱动） | 本机 Edge 或 Chrome | 刷、读评论 | 赞、回复、发布（创作者服务平台） |

`auto` 的判据：找到 adb 且有在线设备 → `adb`；否则 → `web`。

## 装进 DSH 后的样子

```bash
cd kuaishou-ops
node install.mjs --profile desktop      # 或 --profile web
# 重启 DSH（或让它重载 profile）
```

装完你会得到两处入口：

| 位置 | 内容 |
|---|---|
| **设置 → kuaishou** | 后端选择、每轮/每日配额、配音语音、浏览器与 ffmpeg 路径、提示词映射（11 项，改完即时生效） |
| 对话里的工具 | 23 个 `ks_*` 工具（刷/赞/评论/发布/视频/提示词） |

设置页现在是**一个开关 + 环境检查 + 三组字段**：

| 区域 | 内容 |
|---|---|
| 顶部开关 | **启用快手插件**：打开就自动运行；关掉后所有动作工具（刷/赞/评论/发布/生成视频）直接拒绝，只留状态与环境检查 |
| 环境检查 | 一项一行 ✅/❌：开关、上传服务、后端、浏览器、登录态、ffmpeg、字体、语音、BGM/背景素材；红的直接给修法，可随时「重新检查」 |
| 说话与打字 | 它怎么称呼你、怎么自称、语气（温柔/冷静/毒舌/活泼/专业）、单条字数上限、口头禅、四个打字开关（emoji / ～ / 。 / 语气词）、禁区；带「预览效果」按钮，直接看生成的那段提示词 |
| 常用 | 人设、运行方式、四个配额 |
| 素材（视频模板） | 背景渐变/纯色/图/视频/模糊/压暗、字体/字号/颜色、语音引擎/语音名/语速、BGM |
| 高级 | 字幕位置与透明度、标题字号颜色、背景适配、Piper 路径、提示词 id、web 目录、浏览器/ffmpeg 路径、上传端口与素材目录、自定义人设 |

（字段总数 35，默认只展开「常用」，避免一屏几十个输入框。）

设置页可调的 13 项：`mode`、`webProfileDir`、`browserPath`、`scrollPerRun`、`replyPerRun`、
`likePerRun`、`publishPerDay`、`videoVoice`、`ffmpegPath`、`replyPromptId`、`scriptPromptId`、
**`personaId`（人设预设）**、**`personaOverride`（自定义人设）**。

值的合并顺序（后面的覆盖前面的）：`config.json` → `state/settings.json`（插件快照）→
profile `cordis.patch.yml` 里的 user 层（设置页刚点的保存，最新）。

设置页的实现与三个踩过的坑见 [`plugins/dsh-plugin-kuaishou/README.md`](plugins/dsh-plugin-kuaishou/README.md)。

## 换声音（要不要文件？分两种）

| 路线 | 需要文件吗 | 怎么换 | 现在能用吗 |
|---|---|---|---|
| **sapi**（系统语音） | **不需要** | 设置页「配音语音名」填名字，或调用时传 `voice` | ✅ 本机两个：`Microsoft Huihui Desktop`（中文女）、`Microsoft Zira Desktop`（英文女） |
| **piper**（自定义音色） | 需要 `.onnx` 模型 | 上传模型 → 填 `videoPiperExe` + `videoPiperModel` → 引擎选 piper | ⚠️ 代码已就绪，模型要自己放（离线、可换任意音色） |

```
ks_voice_list({})                                    // 看有哪些语音、piper 是否就绪
ks_voice_preview({ text: "换声音测试" })               // 用当前语音念一句，返回 wav
ks_voice_preview({ text: "This is Zira", voice: "Microsoft Zira Desktop" })
```

想装更多**系统**音色：Windows 设置 → 时间和语言 → 语言和区域 → 中文 → 添加语音包，
装完 `ks_voice_list` 就能看到新名字（不需要任何项目文件）。

Edge 的神经语音（小晓/云希等）需要 wss + 自定义请求头，而 Node 内置 WebSocket 不允许加头，
所以没有塞进来——宁可没有，也不要「看起来支持其实连不上」。

```
adb 后端:  DSH agent ──MCP──> src/mcp.mjs ──> src/driver.mjs ──> src/ks.mjs ──> adb ──> App
web 后端:                                    └──> src/web.mjs ──> Edge(CDP) ──> www.kuaishou.com
                                        └──> src/ops.mjs（配额 / 状态 / 排程，两个后端共用）
```

## 网页版（不装模拟器的那条路）

实测（2026-10-24，Edge + PC 端快手）：
| 能力 | 游客态 | 说明 |
|---|---|---|
| 看推荐流、自动翻下一条 | ✅ | 点 `.next`；按视频真实时长停留，播完再翻 |
| 读评论（作者/内容/时间/赞数） | ✅ | 面板 `.side-area` → `.comment-list .comment-item` 结构化提取 |
| 点赞 | ⚠️ 会弹登录框 | 代码里直接拦下并提示先登录，不会假装成功 |
| 回复评论 | ⚠️ 同上 | 未登录时明确报错，不做无效点击 |
| 发视频 | ⚠️ 需要登录 | 走创作者服务平台 `cp.kuaishou.com`，`input[type=file]` 直传 |

登录（一次，之后不用重复）：

```bash
node cli.mjs web-login
# 弹出的 Edge 窗口里点「立即登录」扫码；脚本会每 5 秒轮询登录态，最多等 5 分钟
# 登录态保存在 .web-profile/（已在 .gitignore），之后所有网页版操作自动复用
node cli.mjs status --web     # 确认 loggedIn: true
```

网页版的关键实现细节（也是踩过的坑）：

- Playwright 的**自带浏览器不用下载**，直接用本机 Edge（`web.browserPath` 或自动探测），`playwright-core` 只有一个包
- `.side-area` **一直在 DOM 里**（滑出屏幕右侧），所以判断「评论面板开没开」不能看 `isVisible()`，要看里面有没有「共 N 条评论」
- 默认 `headless: false`：无头浏览器更容易被识别成自动化，且扫码需要人看窗口
- 登录态靠 `launchPersistentContext` 的 user-data-dir，Cookie 全在磁盘上，进程重启不影响

## 它为什么这么设计

| 决策 | 原因 |
|---|---|
| 一切走 `adb`，不碰私有协议 | 快手的私有接口每版都变；`input tap/swipe`、`uiautomator dump` 十年没变 |
| **刷视频不截图** | 模型每看一张图就是一次图像输入。纯 adb 循环刷 30 条，token 成本≈0 |
| 回评论先 dump 后点 | 要按文字定位，必须读一次控件树；读不到就把屏幕摘要塞进错误里，让模型自己改选择器 |
| 选择器全部可配 | `config.selectors` 里全是"候选数组"，改版时改 JSON，不改代码 |
| 配额 + 状态落盘 | 一口气刷几百条/连发几条视频 = 最容易被限流的操作 |
| 失败抛 `StepError` + 屏幕摘要 | 不给模型一句 "timeout"，给的是「当前屏幕上有什么、下一步怎么办」 |

## 视频流水线（剪辑 / 配音 / 字幕 / 封面）

本地跑，**不烧 token，不上传任何素材**。用的是 npm 自带的 ffmpeg 二进制 + Windows 系统 TTS（Microsoft Huihui Desktop，离线中文）。

| 工具 | 做什么 |
|---|---|
| `ks_video_probe` | 读时长/分辨率/帧率/编码/有无音轨 |
| `ks_video_tts` | 文字 → 中文 WAV（可调语速） |
| `ks_video_from_text` | **一条龙**：标题+逐句文案 → 配音 → 1080×1920 竖屏 → 逐句字幕 → 成片 + 封面 |
| `ks_video_compose` | 已有素材（视频/图片）→ 归一化 → 拼接 → 字幕 → 配音/BGM → 封面 |
| `ks_publish_video` | 把成片发出去（网页版走创作者平台 / adb 走 App 相册） |

字幕排版细节（都踩过）：

- **自适应字号**：中文按 1 字宽、ASCII 按 0.55 估算，放不下就缩字号，缩到底再折行（最多 2 行）
- **逐句对齐配音**：按字数比例把 TTS 总时长切给每一句，句间留 0.1s
- **不做字符串转义**：每条字幕写一个临时 `textfile=`，绕开 ffmpeg filter 里 `:` `,` `'` 的转义地狱
- 字幕底对齐（`y=h*ratio-text_h`），两行时向上长，不会溢出画面

实测（`demo/deepseek-demo.mp4`）：17.4 秒 / 1080×1920 / 30fps / h264+aac / 0.32 MB，生成耗时 **5.5 秒**。

```bash
node test/video-e2e.mjs                  # 内置示例：文案 → 成片
node test/video-e2e.mjs my-script.json   # 用自己的 {title, lines, voiceText}
node cli.mjs publish --file demo/deepseek-demo.mp4 --caption "今天的日常 #记录"
```

## 视频模板（背景 / 字体 / 声音都能自己定）

模板不是写死的，**三层优先级**：工具参数 > 设置页 / `config.json` 的 `video.*` > 内置默认。

| 类别 | 设置键（设置页同名） | 工具参数（`ks_video_from_text`） | 说明 |
|---|---|---|---|
| 背景 | `videoBgColor` / `videoBgImage` / `videoBgVideo` / `videoBgPreset` / `videoBgGradientFrom` / `videoBgGradientTo` / `videoBgGradientAxis` / `videoBgFit` / `videoBgDim` / `videoBgBlur` | `bgColor` / `bgImage` / `bgVideo` / `bgPreset` / `bgGradientFrom` / `bgGradientTo` / `bgGradientAxis` / `bgFit` / `bgDim` / `bgBlur` | **四种背景**：纯色 / 双色渐变 / 图片 / 视频（循环静音）。优先级 视频 > 图片 > 渐变 > 纯色 |
| 字体 | `videoFontPath` / `videoFontSize` / `videoTitleFontSize` / `videoFontColor` / `videoTitleColor` / `videoBoxAlpha` / `videoSubtitleY` | 同名 | 字体文件、字号、颜色、字幕底色透明度、字幕位置 |
| 声音 | `videoVoice` / `videoVoiceRate` / `videoBgmFile` / `videoBgmGainDb` | 同名 | 系统语音名、语速、BGM 文件与音量 |

**上传自己的素材**：设置页里 BGM / 背景图 / 背景视频 / 字体 四个字段右侧有「选择文件」，
选中即上传到 `state/assets/` 并把绝对路径填回字段（不用手抄路径）。

上传服务由宿主插件启动，只监听 `127.0.0.1:32801`（设置项 `assetsPort`）：
- 扩展名白名单：音频 mp3/wav/m4a/aac/flac/ogg、图片 png/jpg/webp/bmp/gif、视频 mp4/mov/mkv/webm、字体 ttf/ttc/otf
- 单文件上限 `assetsMaxMB`（默认 64MB），超限直接拒并清掉临时文件
- 文件名净化（去路径分隔符、去 `..`、限长 120），只会落在 `state/assets/` 里
- 跨域只接受 `OPTIONS/POST/GET`，非法路由 404

```
state/assets/          上传落盘目录（可用 assetsDir 改）
```

背景预设：`deep-sea`（深海）/ `night-purple`（夜紫）/ `whale-blue`（鲸蓝）/ `sakura`（樱粉）/ `paper`（米纸）/ `mint`（薄荷）。
图片/视频背景支持 `cover|contain` 适配、`gblur` 模糊（0~60）、压暗（0~1）。

看当前生效值：`ks_video_style({})`。实测样片：`demo/styled-demo.mp4`（图片背景 + 压暗 0.45 + 字幕 46px 黄色 + 位置 0.8 + 语速 2 + BGM -20dB）。

```bash
node test/video-style-e2e.mjs     # 图片背景 + 自定义字体/声音
node test/video-bg-e2e.mjs        # 三种背景各渲一条：渐变 / 图片+模糊 / 视频背景
npm test                          # 含上传服务：落盘、白名单、超限、路径穿越
```

样片：`demo/bg-gradient.mp4`、`demo/bg-image-blur.mp4`、`demo/bg-video.mp4`。

## 提示词（你要的「可以放提示词的地方」）

提示词不写在代码里，是 **markdown 文件**，两层：

```
prompts/           内置（随包发布，升级会覆盖）
  persona-whale-maid.md 人设预设：鲸鱼女仆娘（默认）
  persona.md       人设预设：温和技术宅
  persona-cool.md  人设预设：冷面技术宅
  persona-warm.md  人设预设：热心姐姐
  persona-sharp.md 人设预设：毒舌但真诚
  reply.md         回评论：怎么挑、怎么写、输出 JSON
  comment-pick.md  挑评论：哪条值得回、为什么
  script.md        口播脚本：钩子/过程/转折/落点 + 字数换算
  title.md         视频标题：12 字以内的 5 个候选
  caption.md       发布文案 + 话题
  ops.md           运营节奏：这一轮刷多少、回多少、发不发

state/prompts/     自定义覆盖（同名 .md 盖掉内置，升级不动它）
```

语法只有一种：`{{变量}}`。渲染时**未知变量保留原样并报 `missing`**，不会静默变空。

| 工具 | 用途 |
|---|---|
| `ks_style_preview` | 预览「说话与打字」拼出来的那段人设指南（设置页预览按钮同一份逻辑） |
| `ks_env` | **环境检查**：开关/上传服务/后端/浏览器/登录态/ffmpeg/字体/语音/素材，每项给"能不能用 + 怎么修" |
| `ks_prompt_list` | 列出全部提示词（含来源 builtin/custom 与生效映射） |
| `ks_prompt_get` | 读正文 + 它用到的变量名 |
| `ks_prompt_render` | 填变量渲染（自定义 > 内置） |
| `ks_prompt_save` | 写自定义覆盖，**立刻生效，不用重启** |
| `ks_prompt_reset` | 删覆盖，回落内置 |
| `ks_brief` | **最常用**：自动填好变量给你一段可直接照做的指令 |

`ks_brief` 的自动填充：

- `kind=reply` → 顺手读回当前视频评论，填进 `{{comments}}`，带 `maxReplies` / `maxChars` / 黑名单
- `kind=script` → 按 `durationSec` 算 `{{targetChars}}`（中文 4.5 字/秒）
- `kind=ops` → 填今日计数与配额
- `kind=caption/title` → 填平台、话题上限、文案上限

命令行同样能用：

```bash
node cli.mjs prompt list
node cli.mjs prompt get reply
node cli.mjs prompt render script --var topic=用AI写快手插件 --var durationSec=30
node cli.mjs prompt save reply --file D:\my-reply-prompt.md
node cli.mjs prompt reset reply
```

改提示词不需要改代码、不需要重启：文件改了下次 `ks_brief` 就生效。

## 前置

**二选一**：

- **网页版**：本机有 Edge 或 Chrome 即可（`web.browserPath` 留空会自动探测）
- **adb 路线**：MuMu Player 12/15，或任何开了 USB 调试的安卓设备

adb 路线还需要：

1. **adb**：装 MuMu 后自带（`<MuMu>\nx_main\adb.exe`）；或 `ANDROID_HOME/platform-tools/adb`
2. **中文输入**：装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) 并 `ime set com.android.adbkeyboard/.AdbIME`
   —— 否则 `input text` 只能打 ASCII，发中文文案/评论会被明确拒绝（不会静默变成乱码）
3. Node ≥ 20

```bash
npm install
node cli.mjs doctor        # 看 adb 找没找到、网页版 profile 在哪、最终选了哪个后端
```

## 配置

```bash
cp config.example.json config.json     # Windows: copy config.example.json config.json
```

| 键 | 说明 |
|---|---|
| `adbPath` / `serial` | 都可留空：自动探测 adb；只有一台设备时自动选它 |
| `dwell.minMs` / `maxMs` | 每条视频停留区间，默认 6–22 秒（看完再滑） |
| `jitter.*` | 点击坐标抖动、滑动时长抖动 —— 让轨迹不像机器 |
| `quotas.*` | 每轮/每日配额：刷 30 条、回 8 条、赞 5 个、发 2 条视频 |
| `reply.blacklist` | 命中就不回（引流/广告词），避免账号被判营销 |
| `reply.whitelist` | 只回带"问题/求推荐"意图的评论 |
| `publish.*` | 视频扩展名白名单、文案上限、话题数上限、推送目录、输入法 |
| `selectors.*` | **改版时只改这里** |
| `dryRun` | `true` = 只打印 adb 命令，不真发 |

## 命令行用法

```bash
node cli.mjs doctor                       # 自检
node cli.mjs status                       # 前台包 + 屏幕文本摘要
node cli.mjs feed --count 20              # 刷 20 条
node cli.mjs comments                     # 读当前视频评论
node cli.mjs reply --match "怎么" --content "我这边也在试"
node cli.mjs like
node cli.mjs publish --file D:\clip.mp4 --caption "今天的日常 #生活"
node cli.mjs publish --file D:\clip.mp4 --push     # 只推文件不发布（调试用）
node cli.mjs plan                         # 看这一轮会做什么
node cli.mjs run --scroll 10 --replies 3 --likes 2
node cli.mjs feed --count 5 --dry         # 干跑：只打印 adb 命令
```

## 挂进 DeepSeek Harness

```bash
node install.mjs                  # 写进 desktop profile（自动备份，幂等）
node install.mjs --profile web    # 换 profile
node install.mjs --remove         # 摘掉
```

然后重启 DSH。也可以手动把 `cordis.patch.yml` 那段追加到
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`。

### 模型侧工具

| 工具 | 用途 | token 成本 |
|---|---|---|
| `ks_status` | adb/设备/前台/屏幕摘要 | 低 |
| `ks_devices` / `ks_launch` | 设备列表 / 拉起快手 | 低 |
| `ks_feed_scroll` | 刷 N 条（不截图） | **≈0** |
| `ks_like` | 双击点赞 | 低 |
| `ks_dump` | 控件树文本摘要 | 中 |
| `ks_screen` | 截屏（图片进对话） | **高**（一次图像输入） |
| `ks_comments` | 读评论（文本+坐标） | 中 |
| `ks_reply` | 按片段回一条 | 中 |
| `ks_reply_auto` | 批量模板回（过白/黑名单） | 中 |
| `ks_publish_video` | 发视频（相册→下一步→文案→发布） | 中 |
| `ks_plan` / `ks_run` / `ks_state` | 计划 / 执行一轮 / 今日计数 | 低 |

配套的模型玩法文档在 [`skill/SKILL.md`](skill/SKILL.md)。

## 成本参考

| 场景 | 大致 token |
|---|---|
| 刷 30 条（纯 adb） | <1k（一轮只回一次结果） |
| 刷 30 条 + 每条看截图 | 25k–40k |
| 读一次评论并回 3 条 | 3k–8k |
| 发一条视频 | 2k–5k |
| 开发/校准选择器（一次性） | 100k–300k |

## 当前版本的边界（必须知道）

- **界面选择器是"候选 + 兜底"，不是硬保证**。快手每次大版本更新都可能改 resource-id；
  找不到元素时工具会返回当前屏幕文本摘要，照着把 `config.selectors` 里的 `res`/`text` 补上即可。
- **发布流程**（拍摄页 → 相册 → 下一步 → 文案 → 发布）链路最长、最容易改版；建议先用 `--push` 只推文件，
  再手动确认相册里能看到，最后才跑完整发布。
- **账号风险**：高频滑动、批量回复、短时间重复发布是平台风控的重点。默认配额刻意保守；
  `reply.blacklist` 拦引流话术。要不要突破这些限制是使用者的选择，代码不替你做判断。
- 不做登录/注册/验证码，也不改包、不 hook —— 账号由使用者自己在模拟器里登录。

## 测试

```bash
npm test                 # 52 个离线用例：UI 解析、adb 命令拼装、KS 流程、配额与状态
node test/mcp-smoke.mjs  # MCP server 冒烟：initialize / tools/list / 实际调用
```

测试全部跑在 `test/fixtures.mjs` 的假 adb 上，**不需要 MuMu、不需要设备、不会真的操作任何账号**。

## 目录

```
src/config.mjs   配置默认值 / 覆盖 / 校验
src/adb.mjs      adb 传输层（自动探测、命令拼装、错误建模、中文输入）
src/ui.mjs       uiautomator XML 解析 + 元素查找 + 等待
src/ks.mjs       快手 App 驱动（刷/赞/评论/发布）
src/ops.mjs      配额、状态落盘、计划生成、runPlan
src/mcp.mjs      MCP server（14 个工具）
cli.mjs          命令行
install.mjs      写 DSH profile 挂载
skill/SKILL.md   模型玩法文档
test/            离线用例 + 假 adb 夹具
```
