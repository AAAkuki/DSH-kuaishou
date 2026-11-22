// 快手设置页（DSH client half）— 重做版：一个总开关 + 环境检查 + 分三组的字段。
//
// 设计取舍：
//   · 开关放最上面，语义只有一句「打开就自动运行，关掉所有动作都会被拒绝」；
//   · 环境检查放在开关下面，一项一行 ✅/❌，红的那行直接给怎么修；
//   · 其余字段按「常用 / 素材 / 高级」折叠，默认只展开常用，避免一屏 37 个输入框；
//   · 保存按钮贴底（sticky），任何时候都能看到自己改了什么。
//
// 仍然是 `window.__ModuleLoader__.load({id, factory})` 形状；
// `apply` 全程 try/catch —— 客户端插件抛错会让 DSH 整个界面起不来（踩过三次）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-kuaishou',
  factory: (require) => {
    const React = require('react');
    const { useState, useEffect, useCallback, useRef } = React;
    const h = React.createElement;

    const NS = 'kuaishou';

    async function rpc(method, args) {
      const rpcId = `ks-${Math.random().toString(36).slice(2, 10)}`;
      const res = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
      if (body?.error) throw new Error(body.error.message || JSON.stringify(body.error).slice(0, 200));
      return body?.result?.value ?? body?.result;
    }

    /** 把裸 fetch 错误翻译成用户能懂的话（服务没起来最常见）。 */
    function explainNetError(error, port) {
      const msg = String(error?.message || error);
      if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) {
        return `连不上本地服务 http://127.0.0.1:${port}（插件可能没启动，或总开关被关掉了）`;
      }
      return msg;
    }

    /** 思维链：阶段 → 图标，让人一眼看出它此刻在干嘛。 */
    const TRACE_ICON = {
      start: '🚀', think: '💭', plan: '🗒', round: '🔄', scroll: '📜', search: '🔍',
      like: '❤️', reply: '💬', video: '🎬', publish: '📤', stop: '⏹', end: '🏁',
      done: '🏁', act: '▶'
    };
    function traceIcon(e) {
      if (e?.ok === false) return '⚠️';
      return TRACE_ICON[e?.phase] || '▶';
    }
    function fmtElapsed(sec) {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    }
    function fmtClock(at) {
      try {
        const d = new Date(at);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      } catch { return ''; }
    }

    async function uploadAsset(file, port, dir = '') {
      const q = `name=${encodeURIComponent(file.name)}` + (dir ? `&dir=${encodeURIComponent(dir)}` : '');
      const res = await fetch(`http://127.0.0.1:${port}/upload?${q}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/octet-stream' }
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `上传失败 HTTP ${res.status}`);
      return body.path;
    }

    // 字段定义：group 决定它落在哪一组
    const FIELDS = [
      // 说话与打字（图形化）
      { key: 'speakCallUser', group: 'speak', label: '它怎么称呼你', type: 'text', hint: '比如 主人 / 老板 / 亲爱的' },
      { key: 'speakCallSelf', group: 'speak', label: '它怎么自称', type: 'text', hint: '比如 我 / 本鲸 / 小的' },
      { key: 'speakTone', group: 'speak', label: '语气', type: 'select', options: [['gentle', '温柔：先接情绪再给建议'], ['calm', '冷静：句子短、信息密'], ['sharp', '毒舌：先怼一句再给真话'], ['lively', '活泼：节奏快、多短句'], ['pro', '专业：先结论后解释']] },
      { key: 'speakMaxChars', group: 'speak', label: '单条回复字数上限', type: 'number', hint: '5~500' },
      { key: 'speakCatchphrases', group: 'speak', label: '口头禅', type: 'text', hint: '逗号分隔，比如 啧,懂了懂了,这就去办' },
      { key: 'typeEmoji', group: 'speak', label: '可以用 emoji', type: 'toggle' },
      { key: 'typeTilde', group: 'speak', label: '可以用「～」', type: 'toggle' },
      { key: 'typePeriod', group: 'speak', label: '句末用「。」', type: 'toggle', hint: '关掉更像随手打字' },
      { key: 'typeParticles', group: 'speak', label: '可以带语气词', type: 'toggle', hint: '呀 / 啦 / 诶' },
      { key: 'speakForbid', group: 'speak', label: '禁区', type: 'text', hint: '逗号分隔，模型不会做这些' },
      { key: 'personaId', group: 'common', label: '人设', type: 'select', options: [['persona-cetacea', '鲸鱼女孩 CETACEA_LOLI（默认：傲娇又甜/爱米饭/聪明但懒）'], ['persona-whale-maid', '鲸鱼女仆娘'], ['persona', '温和技术宅'], ['persona-cool', '冷面技术宅'], ['persona-warm', '热心姐姐'], ['persona-sharp', '毒舌但真诚']] },
      { key: 'mode', group: 'common', label: '运行方式', type: 'select', options: [['auto', '自动（有模拟器就用模拟器）'], ['adb', '模拟器 / 真机（adb）'], ['web', '快手网页版']] },
      { key: 'scrollPerRun', group: 'common', label: '每轮刷视频条数', type: 'number', hint: '0 = 不限（按下面的分钟数兜底）' },
      { key: 'scrollRunMaxMinutes', group: 'common', label: '不限条数时最多刷几分钟', type: 'number', hint: '默认 10；刷满就收，中途点停止也会停' },
      { key: 'replyPerRun', group: 'common', label: '每轮回评论条数', type: 'number', hint: '0 = 不限额度（想限制就填数字）' },
      { key: 'likePerRun', group: 'common', label: '每轮点赞个数', type: 'number' },
      { key: 'publishPerDay', group: 'common', label: '每天发布条数', type: 'number' },
      { key: 'loopEnabled', group: 'common', label: '自动循环', type: 'switch', hint: '开着就一直刷；配额用完自动重置接着刷，直到点「停止」' },
      { key: 'loopResetQuota', group: 'common', label: '配额用完自动重置', type: 'switch', hint: '关掉就会在配额用完时停下' },
      { key: 'loopGapSec', group: 'common', label: '每轮间隔（秒）', type: 'number', hint: '默认 20' },
      { key: 'loopMaxRounds', group: 'common', label: '最多循环几巡', type: 'number', hint: '0 = 不限（一直跑，直到点停止）' },
      { key: 'searchEnabled', group: 'common', label: '搜索功能', type: 'switch', hint: '刷的时候顺手搜关键词，结果进总结视频' },
      { key: 'searchKeywords', group: 'common', label: '搜索关键词', type: 'text', hint: '逗号分隔，如 deepseek,ai 绘画；会轮着搜' },
      { key: 'searchLimit', group: 'common', label: '每次读几条搜索结果', type: 'number', hint: '默认 6' },
      { key: 'searchFeedToVideo', group: 'common', label: '几条结果进视频', type: 'number', hint: '默认 3；0 = 只提关键词' },
      { key: 'summaryPerDay', group: 'common', label: '总结视频每天几条', type: 'number', hint: '默认 2 条' },
      { key: 'summaryRefresh', group: 'common', label: '刷新总结视频', type: 'switch', hint: '关掉 = 沿用今天已生成的，不再重做' },
      { key: 'videoLineCount', group: 'media', label: '字幕句数', type: 'number', hint: '12 句 ≈ 一分钟；想更长就加到 14~16' },
      { key: 'videoStats', group: 'media', label: '视频里报自己的数据', type: 'switch', hint: '念昨天播放量、点赞、涨了多少粉、最新那条多少播放（没数据就不提）' },
      { key: 'goalFans', group: 'media', label: '目标粉丝数', type: 'number', hint: '默认 10000：视频里会说"冲一万粉"' },
      { key: 'textDeai', group: 'media', label: '去 AI 味', type: 'switch', hint: '出片前把八股连接词、客服腔、大词、形容词堆料去掉（数字和 AI 身份不动）' },
      { key: 'publishTopics', group: 'common', label: '默认话题标签', type: 'text', hint: '逗号分隔，如 deepseek,大肥鱼' },
      { key: 'publishCoverFile', group: 'common', label: '默认封面图', type: 'text', upload: 'image', hint: '可上传；留空用视频首帧' },
      { key: 'publishTitle', group: 'common', label: '默认标题', type: 'text', hint: '可留空' },

      { key: 'videoBgPreset', group: 'media', label: '背景渐变', type: 'select', options: [['', '不用（纯色）'], ['deep-sea', '深海'], ['night-purple', '夜紫'], ['whale-blue', '鲸蓝'], ['sakura', '樱粉'], ['paper', '米纸'], ['mint', '薄荷']] },
      { key: 'videoTitleBar', group: 'media', label: '左上栏目名', type: 'text', hint: '默认关闭；想显示就填，如「大肥鱼的生活日记」' },
      { key: 'videoAiBadge', group: 'media', label: 'AI 生成标识', type: 'text', hint: '默认关闭；填「大肥鱼 (AI) 生成内容」会显示在右上角' },
      { key: 'videoSpeakerName', group: 'media', label: '对话框名字', type: 'text', hint: '框左上角橙底白字标签，如「大肥鱼」' },
      { key: 'videoTyping', group: 'media', label: '打字光标', type: 'switch', hint: '字幕末尾闪烁光标' },
      { key: 'videoStickerFile', group: 'sticker', label: '上传表情（可多选）', type: 'text', upload: 'image', uploadDir: 'stickers', hint: '把你的表情图传进来，一张代表一种情绪；插件按文案情绪自己挑。留空 = 不贴' },
      {
        key: 'videoStickerPos', group: 'sticker', label: '贴纸位置', type: 'select',
        options: [
          ['beside-box', '字幕框左边'],
          ['left-top', '左上角'],
          ['left-bottom', '左下角'],
          ['right-top', '右上角'],
          ['right-bottom', '右下角'],
          ['center', '画面中间']
        ],
        hint: '选一个就行，不用填坐标'
      },
      {
        key: 'videoStickerSizeName', group: 'sticker', label: '贴纸大小', type: 'select',
        options: [['small', '小'], ['medium', '中'], ['large', '大']]
      },
      { key: 'videoStickerAutoEmotion', group: 'sticker', label: '按情绪自动选', type: 'switch', hint: '开了以后，文案开心就挑开心的贴纸，疑惑就挑问号那张' },
      { key: 'videoStickerPerLine', group: 'sticker', label: '每句换表情', type: 'switch', hint: '一句话换一张表情包（中途替换）；关掉就整条只用一张' },
      { key: 'videoStickerX2', group: 'sticker', label: '贴纸 X（横向）', type: 'number', hint: '0 = 最左，1 = 最右；预设位置只是快速设置，这里可以再微调' },
      { key: 'videoStickerY2', group: 'sticker', label: '贴纸 Y（纵向）', type: 'number', hint: '0 = 最上，1 = 最下' },
      {
        key: 'videoStickerKey', group: 'sticker', label: '自动抠底', type: 'select',
        options: [['auto', '自动抠（纯色背景）'], ['off', '不抠（保留原图）']],
        hint: '抠完边缘毛糙就选「不抠」'
      },
      { key: 'videoTargetDurationSec', group: 'media', label: '目标时长（秒）', type: 'number', hint: '想做成 1 分钟就填 58；文案不够长会自动补到这个长度' },
      { key: 'videoMinDurationSec', group: 'media', label: '最短时长（秒）', type: 'number', hint: '太短的片子容易被划走；默认 55' },
      { key: 'videoBgColor', group: 'media', label: '背景纯色', type: 'text', hint: '如 0x0f1419' },
      { key: 'videoBgGradientFrom', group: 'media', label: '自定义渐变·起点', type: 'text', hint: '0x0a1a33（填了就优先于上面的预设）' },
      { key: 'videoBgGradientTo', group: 'media', label: '自定义渐变·终点', type: 'text', hint: '0x1f5f8b' },
      { key: 'videoBgGradientAxis', group: 'media', label: '渐变方向', type: 'select', options: [['vertical', '上下'], ['horizontal', '左右']] },
      { key: 'videoBgImage', group: 'media', label: '背景图', type: 'text', upload: 'image', hint: '可上传' },
      { key: 'videoBgVideo', group: 'media', label: '背景视频', type: 'text', upload: 'video', hint: '循环+静音，可上传' },
      { key: 'videoBgBlur', group: 'media', label: '背景模糊', type: 'number', hint: '0~60' },
      { key: 'videoBgDim', group: 'media', label: '背景压暗', type: 'number', hint: '0~1' },
      { key: 'videoFontPath', group: 'media', label: '字体', type: 'text', upload: 'font', hint: '留空自动找微软雅黑' },
      { key: 'videoFontSize', group: 'media', label: '字幕字号', type: 'number' },
      { key: 'videoFontColor', group: 'media', label: '字幕颜色', type: 'text', hint: 'white / 0xFFE066' },
      { key: 'videoTtsEngine', group: 'media', label: '语音引擎', type: 'select', options: [['sapi', '系统语音（Windows 自带，免文件）'], ['piper', 'Piper 模型（自定义音色，需要 .onnx）']], hint: '大多数人用「系统语音」就够' },
      { key: 'videoVoice', group: 'media', label: '语音', type: 'voicelist', hint: '从系统已安装的语音里选；选完可点试听' },
      { key: 'videoVoiceRate', group: 'media', label: '语速', type: 'number', hint: '-10（慢）~ 10（快），0 是正常' },
      { key: 'videoVoiceCute', group: 'media', label: '萝莉音', type: 'select', options: [['', '不用'], ['loli', '萝莉（轻）'], ['loli_hard', '萝莉（明显）'], ['loli_soft', '萝莉（奶）'], ['natural', '自然（不升调，最稳）']], hint: '升调 + 童声塑形，需要 piper 模型；觉得"诡异"就选自然' },
      { key: 'cute_stutter', group: 'media', label: '口吃', type: 'toggle', hint: '偶尔重复开头第一个字（我我我）' },
      { key: 'cute_pause', group: 'media', label: '停顿', type: 'toggle', hint: '句间随机停顿，像在思考' },
      { key: 'cute_breath', group: 'media', label: '喘气', type: 'toggle', hint: '每三句左右插一次吸气声' },
      { key: 'videoLengthScale', group: 'media', label: '语速倍率', type: 'number', hint: '1.0 正常，1.12 稍慢（萝莉感更足）' },
      { key: 'videoVoiceSoften', group: 'media', label: '声音柔化', type: 'select', options: [['', '不处理'], ['clean', '去刺（保留原音色）'], ['soft', '柔和（推荐）'], ['softer', '更软'], ['mellow', '奶音（明显降调）']], hint: '降调 + 削齿音 + 加厚度，让声音不那么机械' },
      { key: 'videoBgmFile', group: 'media', label: 'BGM', type: 'text', upload: 'audio', hint: '可上传' },
      { key: 'videoBgmGainDb', group: 'media', label: 'BGM 音量(dB)', type: 'number' },

      { key: 'videoSubtitleY', group: 'advanced', label: '字幕位置', type: 'number', hint: '0.3~0.98' },
      { key: 'videoBoxAlpha', group: 'advanced', label: '字幕底色透明度', type: 'number' },
      { key: 'videoTitleFontSize', group: 'advanced', label: '标题字号', type: 'number' },
      { key: 'videoTitleColor', group: 'advanced', label: '标题颜色', type: 'text' },
      { key: 'videoBgFit', group: 'advanced', label: '背景适配', type: 'select', options: [['cover', '覆盖裁切'], ['contain', '完整留边']] },
      { key: 'videoPiperExe', group: 'advanced', label: 'Piper 程序', type: 'text' },
      { key: 'videoPiperModel', group: 'advanced', label: 'Piper 模型', type: 'text', upload: 'voice' },
      { key: 'replyVideoTagWhitelist', group: 'advanced', label: '视频标签白名单', type: 'text', hint: '只在带这些话题的视频下回评；逗号分隔，如 deepseek,ai,大模型（留空=不限制）' },
      { key: 'replyAtOwner', group: 'advanced', label: '运营评论时 @ 谁', type: 'text', hint: '填 主人 / 管理员 / 昵称；留空不 @。同一个人回一次就够，追评才再回' },
      { key: 'replyIncludeOwn', group: 'advanced', label: '自己作品评论也回', type: 'switch', hint: '开着就会去创作者后台「评论管理」回自己作品下的评论' },
      { key: 'liveRoomUrl', group: 'advanced', label: '直播间链接', type: 'text', hint: 'www.kuaishou.com 的直播页；AI 从这里读弹幕' },
      { key: 'liveTokenKey', group: 'advanced', label: 'DeepSeek API key（显示余额）', type: 'text', hint: '用来在直播画面显示 token 余额；留空读环境变量 DEEPSEEK_API_KEY' },
      { key: 'liveJumps', group: 'advanced', label: '一场玩几次跳一跳', type: 'number', hint: '默认 12' },
      { key: 'liveRecord', group: 'advanced', label: '录下直播画面', type: 'switch', hint: '录成 mp4，可当推流源' },
      { key: 'replyTagWhitelist', group: 'advanced', label: '评论标签白名单', type: 'text', hint: '逗号分隔；命中这些标签的评论直接回（如 #deepseek,求推荐,提问）' },
      { key: 'replyWhitelist', group: 'advanced', label: '关键词白名单', type: 'text', hint: '留空 = 只要不是黑名单都回（想积极就留空）；填了就只回含这些词的评论' },
      { key: 'replyPromptId', group: 'advanced', label: '回评论提示词', type: 'text' },
      { key: 'scriptPromptId', group: 'advanced', label: '口播提示词', type: 'text' },
      { key: 'webProfileDir', group: 'advanced', label: '网页版登录态目录', type: 'text' },
      { key: 'browserPath', group: 'advanced', label: '浏览器路径', type: 'text' },
      { key: 'webPersist', group: 'advanced', label: '网页常驻', type: 'switch', hint: '开着就跑完不关浏览器，下次直接用；关掉每次重启（慢且容易撞 profile 锁）' },
      { key: 'webIdleCloseMin', group: 'advanced', label: '闲置多少分钟关浏览器', type: 'number', hint: '默认 30；0 = 永不关' },
      { key: 'ffmpegPath', group: 'advanced', label: 'ffmpeg 路径', type: 'text' },
      { key: 'assetsPort', group: 'advanced', label: '上传服务端口', type: 'number' },
      { key: 'assetsDir', group: 'advanced', label: '素材目录', type: 'text' },
      { key: 'assetsMaxMB', group: 'advanced', label: '上传大小上限(MB)', type: 'number', hint: '默认 64' },
      { key: 'personaOverride', group: 'advanced', label: '自定义人设正文', type: 'textarea', hint: '填了优先于上面的预设' }
    ];

    const GROUP_LABEL = { speak: '说话与打字', common: '常用', sticker: '贴纸（自己导入）', media: '素材（视频模板）', advanced: '高级' };
    const INPUT_STYLE = { padding: '6px 8px', borderRadius: 6, border: '1px solid #8884', background: 'transparent', color: 'inherit' };

    function Switch({ checked, onChange }) {
      return h('button', {
        onClick: () => onChange(!checked),
        title: checked ? '点击关闭' : '点击开启',
        style: {
          width: 52, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
          background: checked ? '#2f9e44' : '#8a8f98', position: 'relative', transition: 'background .15s', flex: '0 0 auto'
        }
      }, h('span', { style: { position: 'absolute', top: 3, left: checked ? 27 : 3, width: 22, height: 22, borderRadius: 11, background: '#fff', transition: 'left .15s' } }));
    }

    function Field({ f, values, setValues, port, setStatus, setError, voices = [], voiceStatus = '', onReloadVoices = () => {} }) {
      if (f.type === 'voicelist') {
        return h('div', { style: { marginBottom: 10 } }, [
          h('div', { key: 'l', style: { fontSize: 12, opacity: 0.85, marginBottom: 4 } }, f.label),
          h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('select', {
              key: 's',
              value: values[f.key] ?? '',
              onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })),
              style: { ...INPUT_STYLE, flex: 1 }
            }, [
              h('option', { key: '__none', value: '' }, '（默认：第一个可用语音）'),
              ...(voices.length
                ? voices.map((v) => h('option', { key: v.name, value: v.name }, `${v.name}（${v.culture}）`))
                : [h('option', { key: '__none2', value: '', disabled: true }, '— 没读到系统语音，点右侧刷新 —')])
            ]),
            h('button', { key: 'r', onClick: onReloadVoices, title: '重新读取系统语音', style: { fontSize: 11, padding: '4px 8px', borderRadius: 6, cursor: 'pointer' } }, '刷新'),
            h('button', {
              key: 'p',
              onClick: async () => {
                setStatus('正在合成试听…');
                try {
                  const res = await fetch(`http://127.0.0.1:${port}/tts-preview`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      text: '主人，这是这段语音的试听效果～',
                      engine: values.videoTtsEngine || 'sapi',
                      voice: values[f.key] || '',
                      rate: Number(values.videoVoiceRate) || 0,
                      soften: values.videoVoiceSoften || ''
                    })
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    throw new Error(j.error || `HTTP ${res.status}`);
                  }
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const audio = new Audio(url);
                  await audio.play();
                  setStatus('试听中…');
                  setError('');
                  audio.onended = () => setStatus('');
                } catch (e) {
                  setStatus('');
                  setError(`试听失败：${explainNetError(e, port)}`);
                }
              },
              style: { fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }
            }, '▶ 试听')
          ]),
          h('div', { key: 'st', style: { fontSize: 10, opacity: 0.5, marginTop: 3 } },
            voiceStatus || '正在读取系统语音…'),
          f.hint ? h('div', { key: 'h', style: { fontSize: 10, opacity: 0.5 } }, f.hint) : null
        ]);
      }

      // 布尔字段两种写法都认：'toggle' 和 'switch'。
      // 以前只处理 'toggle'，而 FIELDS 里 9 个用的是 'switch' —— 它们全被当成文本框渲染，
      // 显示成 "true"/"false"，根本点不动（用户反馈"开关一点用都没有"就是这个）。
      if (f.type === 'toggle' || f.type === 'switch') {
        // 默认值按 schema 的意思走：没存过就当 true（这些开关大多是"默认开"）
        const raw = values[f.key];
        const on = raw === undefined || raw === null ? true : (typeof raw === 'string' ? raw !== 'false' && raw !== '' : Boolean(raw));
        return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 } }, [
          h('div', { key: 'l', style: { fontSize: 12, opacity: 0.85 } }, [
            h('div', { key: 't' }, f.label),
            f.hint ? h('div', { key: 'h', style: { fontSize: 10, opacity: 0.5 } }, f.hint) : null
          ]),
          h(Switch, { key: 's', checked: on, onChange: (v) => setValues((old) => ({ ...old, [f.key]: v })) })
        ]);
      }

      const control = f.type === 'select'
        ? h('select', { value: values[f.key] ?? '', onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })), style: INPUT_STYLE },
            f.options.map(([v, t]) => h('option', { key: v, value: v }, t)))
        : f.type === 'textarea'
          ? h('textarea', { rows: 3, value: values[f.key] ?? '', onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })), style: { ...INPUT_STYLE, fontFamily: 'inherit', resize: 'vertical' } })
          : h('input', {
              type: f.type === 'number' ? 'number' : 'text',
              value: values[f.key] ?? '',
              onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })),
              style: { ...INPUT_STYLE, flex: 1, minWidth: 0 }
            });

      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } }, [
        h('span', { key: 'l', style: { fontSize: 12, opacity: 0.85 } }, f.label),
        h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          control,
          f.upload
            ? h('input', {
                key: 'u', type: 'file',
                multiple: Boolean(f.uploadDir),
                accept: f.upload === 'image' ? 'image/*' : f.upload === 'video' ? 'video/*' : f.upload === 'audio' ? 'audio/*' : '.ttf,.ttc,.otf,.onnx,.json',
                title: f.uploadDir ? '可以一次选多张表情，自动按情绪挑' : '上传到 state/assets 并自动填路径',
                style: { width: 180, fontSize: 11 },
                onChange: async (e) => {
                  const picked = Array.from(e.target.files || []);
                  if (!picked.length) return;
                  // 多选 + 指定目录：一组表情直接进 stickers 目录，不写字段值
                  if (f.uploadDir && picked.length > 1) {
                    setStatus(`上传中：${picked.length} 张`);
                    try {
                      let ok = 0;
                      for (const file of picked) {
                        await uploadAsset(file, port, f.uploadDir);
                        ok++;
                      }
                      setStatus(`已上传 ${ok} 张表情 → 会自动按情绪挑；文件名带「开心/难过/疑惑/爱心」更容易对上`);
                    } catch (err) {
                      setStatus(`上传失败：${explainNetError(err, port)}`);
                    }
                    return;
                  }
                  const file = picked[0];
                  setStatus(`上传中：${file.name}`);
                  try {
                    const saved = await uploadAsset(file, port, f.uploadDir || '');
                    setValues((v) => ({ ...v, [f.key]: saved }));
                    // 上传完直接落盘：不然用户以为"设了"，其实只在自己屏幕上改了（踩过）
                    await rpc('settings/update', { ns: NS, patch: { [f.key]: saved } });
                    setStatus(`已上传并保存 → ${saved}`);
                    setError('');
                  } catch (err) {
                    setStatus('');
                    setError(`上传失败：${explainNetError(err, port)}`);
                  }
                }
              })
            : null
        ]),
        f.hint ? h('span', { key: 'h', style: { fontSize: 10, opacity: 0.5 } }, f.hint) : null
      ]);
    }

    function Panel() {
      const [values, setValues] = useState(null);
      const [error, setError] = useState('');
      const [status, setStatus] = useState('');
      const [env, setEnv] = useState(null);
      const [envBusy, setEnvBusy] = useState(false);
      const [open, setOpen] = useState({ speak: true, common: true, media: false, advanced: false });
      const [personaPreview, setPersonaPreview] = useState('');
      const [voices, setVoices] = useState([]);
      const [autoBusy, setAutoBusy] = useState(false);
      const [autoResult, setAutoResult] = useState('');
      const [autoTrace, setAutoTrace] = useState([]);
      const [voiceStatus, setVoiceStatus] = useState('');
      // 思维链的实时状态：宿主那边是不是还在跑、跑了多久、停止按钮是不是在发请求
      const [traceRunning, setTraceRunning] = useState(false);
      const [traceElapsed, setTraceElapsed] = useState(0);
      const [stopBusy, setStopBusy] = useState(false);
      const timerRef = useRef(null);
      const busyRef = useRef(false);
      const traceRef = useRef(null);

      const port = Number(values?.assetsPort) || 32801;

      const load = useCallback(async () => {
        try {
          const desc = await rpc('settings/describe', {});
          const ns = (desc?.namespaces ?? []).find((n) => n.ns === NS);
          if (!ns) throw new Error('DSH 里没有 kuaishou 命名空间（插件没加载）');
          setValues({ ...(ns.value ?? {}), ...(ns.user ?? {}) });
          setError('');
        } catch (e) {
          setError(String(e.message || e));
        }
      }, []);

      const runEnv = useCallback(async (p) => {
        setEnvBusy(true);
        try {
          const res = await fetch(`http://127.0.0.1:${p}/env`, { method: 'GET' });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '检查失败');
          setEnv(body.report);
          setError('');
        } catch (e) {
          const reason = explainNetError(e, p);
          setEnv({ checks: [{ id: 'env', label: '环境检查接口', ok: false, detail: reason, hint: '插件总开关可能是关的；打开后点「重新检查」' }], badCount: 1 });
        } finally {
          setEnvBusy(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      /**
       * 一键全自动：走宿主的 /autopilot 接口（宿主内部跑 runFullAuto）。
       * 思维链走 /autopilot/trace 轮询：点下去就能看到它在想什么、做到哪一步。
       */
      const fetchTrace = useCallback(async (p) => {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/autopilot/trace`, { cache: 'no-store' });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      }, []);

      /** 把一次 trace 响应贴进 state；返回「宿主那边是不是还在跑」。 */
      const applyTrace = useCallback((b) => {
        if (!b || b.ok !== true) return false;
        if (Array.isArray(b.events)) setAutoTrace(b.events);
        const running = Boolean(b.running);
        setTraceRunning(running);
        if (b.startedAt) {
          const span = Math.round((((b.now || Date.now()) - b.startedAt) / 1000));
          setTraceElapsed(Number.isFinite(span) && span >= 0 ? span : 0);
        }
        if (b.result?.summary) setAutoResult((old) => (old ? old : b.result.summary));
        return running;
      }, []);

      const stopPolling = useCallback(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      }, []);

      const startPolling = useCallback((stopWhenIdle) => {
        stopPolling();
        const tick = async () => {
          const b = await fetchTrace(port);
          if (!b) return;
          const running = applyTrace(b);
          if (stopWhenIdle && !running && !busyRef.current) {
            stopPolling();
            setAutoBusy(false);
          }
        };
        tick();
        timerRef.current = setInterval(tick, 800);
      }, [port, fetchTrace, applyTrace, stopPolling]);

      // 面板重新挂载（切页面/刷新）时把还在跑的任务接回来，不然一关设置页就看不到进度了
      useEffect(() => {
        let dropped = false;
        (async () => {
          const b = await fetchTrace(port);
          if (dropped || !b) return;
          if (applyTrace(b) && !busyRef.current) {
            setAutoBusy(true);
            startPolling(true);
          }
        })();
        return () => { dropped = true; stopPolling(); };
      }, [port, fetchTrace, applyTrace, startPolling, stopPolling]);

      // 新事件进来就把思维链滚到最新一行
      useEffect(() => {
        const el = traceRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [autoTrace.length]);

      const stopAuto = useCallback(async () => {
        setStopBusy(true);
        setAutoResult('已发出停止请求，等这一步跑完…');
        try {
          const r = await fetch(`http://127.0.0.1:${port}/autopilot/stop`, { method: 'POST' });
          const b = await r.json().catch(() => ({}));
          if (!r.ok || b.ok === false) throw new Error(b.error || `HTTP ${r.status}`);
          setAutoResult(b.running === false ? '已停止（本来就没在跑）' : '已发出停止：当前这一步跑完就停，不会再开新一轮');
        } catch (e) {
          setAutoResult(`停止失败：${explainNetError(e, port)}`);
        } finally {
          setStopBusy(false);
          if (!timerRef.current) startPolling(true);
        }
      }, [port, startPolling]);

      /**
       * 「我来刷」= agent 模式：不再起脚本，而是往队列里放一条请求，
       * 由 agent（我）用 ks_watch / ks_next / ks_reply / ks_publish_confirm 一条条自己做。
       * 脚本模式（runAuto）还留着，但按钮换成这个。
       */
      const requestAgent = useCallback(async () => {
        try {
          setAutoResult('排队中…');
          const res = await fetch(`http://127.0.0.1:${port}/agent/request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              rounds: Number(values?.autoRounds) || 1,
              contentMode: values?.autoContentMode || 'auto',
              lineCount: Number(values?.videoLineCount) || 0
            })
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '排队失败');
          setAutoResult(
            '已排队 ✅\n' +
            '现在去对话里发一句「开工」，我就开始：一条条看、挑着点赞、像聊天一样回评论，最后自己出一片发出去。\n' +
            `（排队时间 ${new Date(body.request?.requestedAt || Date.now()).toLocaleTimeString()}）`
          );
        } catch (e) {
          setAutoResult(`排队失败：${explainNetError(e, port)}`);
        }
      }, [port, values]);

      const runAuto = useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setAutoBusy(true);
        setAutoResult('开始运行…');
        setAutoTrace([]);
        setTraceElapsed(0);
        setTraceRunning(true);
        startPolling(false);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/autopilot`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              publish: true,
              rounds: Number(values?.autoRounds) || 2,
              contentMode: values?.autoContentMode || 'auto',
              loop: Boolean(values?.autoLoop)
            })
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '运行失败');
          setAutoResult(body.summary || JSON.stringify(body.steps, null, 1));
        } catch (e) {
          setAutoResult(`失败：${explainNetError(e, port)}`);
        } finally {
          busyRef.current = false;
          stopPolling();
          // 最后再拉一次，保证看到完整链条
          const b = await fetchTrace(port);
          if (b) applyTrace(b);
          setAutoBusy(false);
        }
      }, [port, values?.autoRounds, values?.autoContentMode, startPolling, stopPolling, fetchTrace, applyTrace]);

      const loadVoices = useCallback(async (p) => {
        try {
          setVoiceStatus('正在读取系统语音…');
          const res = await fetch(`http://127.0.0.1:${p}/voices`, { method: 'GET' });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '读取失败');
          const list = body.sapi || [];
          setVoices(list);
          const engine = body.engine || 'sapi';
          const piper = body.piper || {};
          setVoiceStatus(
            engine === 'piper'
              ? (piper.ready ? `引擎 piper：${(piper.model || '').split(/[\\/]/).pop()}` : '引擎 piper，但模型未就绪（上传 .onnx 并填 Piper 程序）')
              : `系统语音 ${list.length} 个：${list.map((v) => v.culture).join(' / ')}`
          );
        } catch (e) {
          setVoices([]);
          setVoiceStatus(`读取语音失败：${explainNetError(e, p)}`);
        }
      }, []);
      const previewPersona = useCallback(async (p) => {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/persona`, { method: 'GET' });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '预览失败');
          setPersonaPreview(body.guide || '（按当前设置不会追加额外说明）');
        } catch (e) {
          setPersonaPreview(`预览失败：${explainNetError(e, port)}`);
        }
      }, []);
      useEffect(() => { if (values && !env) runEnv(port); }, [values, env, port, runEnv]);
      useEffect(() => { if (values && voices.length === 0) loadVoices(port); }, [values, port, voices.length, loadVoices]);

      const save = useCallback(async () => {
        try {
          setStatus('保存中…');
          const patch = {};
          for (const f of FIELDS) {
            const v = values?.[f.key];
            if (v === undefined || v === null || v === '') continue;
            if (f.type === 'toggle' || f.type === 'switch') {
              // 布尔必须发真正的 boolean，发字符串 "false" 会被 schema 判不合法 → 整批保存失败
              patch[f.key] = typeof v === 'string' ? (v !== 'false' && v !== '0' && v !== '') : Boolean(v);
              continue;
            }
            if (f.type === 'number') {
              const n = Number(v);
              if (!Number.isFinite(n)) continue;   // 空的/写错的数字不发，别把整批带崩
              patch[f.key] = n;
              continue;
            }
            patch[f.key] = v;
          }
          if (typeof values?.enabled === 'boolean') patch.enabled = values.enabled;
          await rpc('settings/update', { ns: NS, patch });
          setStatus('已保存');
          setTimeout(() => setStatus(''), 3000);
          await load();
        } catch (e) {
          setStatus('');
          setError(`保存失败：${e.message}`);
        }
      }, [values, load]);

      if (!values) {
        return error
          ? h('div', { style: { padding: 16, color: '#e03131' } }, [h('div', { key: 'e' }, `读取失败：${error}`), h('button', { key: 'r', onClick: load, style: { marginTop: 10 } }, '重试')])
          : h('div', { style: { padding: 16, opacity: 0.6 } }, '读取中…');
      }

      const enabled = values.enabled !== false;
      const bad = (env?.checks ?? []).filter((c) => !c.ok);

      return h('div', { style: { padding: '2px 4px 72px', display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { key: 'switch', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid #8884', borderRadius: 10 } }, [
          h('div', { key: 'txt' }, [
            h('div', { key: 't', style: { fontSize: 15, fontWeight: 600 } }, '启用快手插件'),
            h('div', { key: 's', style: { fontSize: 11, opacity: 0.6, marginTop: 2 } },
              enabled ? '已开启：会自动刷视频 / 回评论 / 点赞' : '已关闭：所有动作都会被拒绝，只能看状态')
          ]),
          h(Switch, { key: 'sw', checked: enabled, onChange: (v) => setValues((old) => ({ ...old, enabled: v })) })
        ]),

        // ── 我来刷（agent 模式，替代原来的一键全自动） ──
        h('div', { key: 'auto', style: { border: '1px solid #8884', borderRadius: 10, padding: '10px 12px' } }, [
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } }, [
            h('div', { key: 'l' }, [
              h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 } }, '🧠 我来刷（不是脚本）'),
              h('div', { key: 's', style: { fontSize: 11, opacity: 0.6, marginTop: 2 } }, '我一条条看、挑着点赞、像聊天一样回评论，看完再出片发出去')
            ]),
            h('div', { key: 'btns', style: { display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' } }, [
              h('button', {
                key: 'run',
                disabled: !enabled,
                onClick: requestAgent,
                style: { padding: '7px 16px', borderRadius: 6, cursor: enabled ? 'pointer' : 'default', fontWeight: 600, opacity: enabled ? 1 : 0.5 }
              }, '🧠 我要自己刷'),
              h('button', {
                key: 'stop',
                // 以前是 disabled: !autoBusy —— 换成 agent 模式后 autoBusy 永远是 false，
                // 结果「停止」一直是灰的、点不动（用户点了停止还以为没生效）。
                // 现在永远可点：它只是写一个停止标记，脚本和 agent 的动作都会被拦住。
                disabled: stopBusy,
                onClick: stopAuto,
                title: '点一下就让所有动作停下（脚本和「我来刷」都算），再点一次清掉标记',
                style: {
                  padding: '7px 14px', borderRadius: 6, fontWeight: 600, background: 'transparent',
                  border: `1px solid ${stopBusy ? '#8886' : '#e03131'}`, color: stopBusy ? '#888' : '#e03131',
                  cursor: stopBusy ? 'default' : 'pointer', opacity: stopBusy ? 0.45 : 1
                }
              }, stopBusy ? '停止中…' : '⏹ 停止')
            ])
          ]),
          // 参数：轮数 + 内容模式
          h('div', { key: 'opts', style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap', fontSize: 12 } }, [
            h('label', { key: 'rounds', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
              h('span', { key: 'l', style: { opacity: 0.75 } }, '跑几轮'),
              h('input', {
                key: 'i', type: 'number', min: 1, max: 5,
                value: values.autoRounds ?? 2,
                onChange: (e) => setValues((v) => ({ ...v, autoRounds: e.target.value })),
                style: { width: 56, padding: '3px 6px', borderRadius: 5 }
              })
            ]),
            h('label', { key: 'mode', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
              h('span', { key: 'l', style: { opacity: 0.75 } }, '视频内容'),
              h('select', {
                key: 's',
                value: values.autoContentMode ?? 'auto',
                onChange: (e) => setValues((v) => ({ ...v, autoContentMode: e.target.value })),
                style: { padding: '3px 6px', borderRadius: 5 }
              }, [
                h('option', { key: 'a', value: 'auto' }, '刷到+干了什么'),
                h('option', { key: 'b', value: 'scrolled' }, '刷到了什么'),
                h('option', { key: 'c', value: 'journal' }, '我干了什么')
              ])
            ]),
            h('label', { key: 'loop', style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } }, [
              h('input', {
                key: 'i', type: 'checkbox',
                checked: Boolean(values.autoLoop),
                onChange: (e) => setValues((v) => ({ ...v, autoLoop: e.target.checked }))
              }),
              h('span', { key: 'l', style: { opacity: 0.75 } }, '跑完接着刷，直到我点停止')
            ])
          ]),
          // 实时状态：在跑 / 已结束 + 跑了多久（长任务时这一段就是"它还活着"的证据）
          (autoBusy || autoTrace.length)
            ? h('div', { key: 'live', style: { marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', fontSize: 11 } }, [
                h('span', { key: 'dot', style: { color: traceRunning ? '#12b886' : '#999', fontWeight: 600 } },
                  traceRunning ? '● 运行中' : '○ 已结束'),
                traceElapsed
                  ? h('span', { key: 't', style: { opacity: 0.65 } }, `已运行 ${fmtElapsed(traceElapsed)}`)
                  : null,
                autoTrace.length
                  ? h('span', { key: 'c', style: { opacity: 0.65 } }, `· ${autoTrace.length} 步`)
                  : null,
                traceRunning
                  ? h('span', { key: 'tip', style: { opacity: 0.45 } }, '· 点「停止」会在这步结束后停')
                  : null
              ])
            : null,
          // 思维链：实时显示它在想什么、做什么
          autoTrace.length
            ? h('div', {
                key: 'trace',
                ref: traceRef,
                style: { marginTop: 8, maxHeight: 280, overflowY: 'auto', border: '1px solid #8883', borderRadius: 8, padding: '8px 10px' }
              }, [
                h('div', { key: 'h', style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, `思维链（${autoTrace.length} 步）`),
                ...autoTrace.map((e, i) => h('div', {
                  key: e.seq ?? i,
                  style: {
                    fontSize: 11, lineHeight: 1.65, display: 'flex', gap: 6,
                    opacity: e.phase === 'think' ? 0.8 : 1,
                    fontStyle: e.phase === 'think' ? 'italic' : 'normal'
                  }
                }, [
                  h('span', { key: 'i', style: { flex: '0 0 auto' } }, traceIcon(e)),
                  h('span', { key: 'c', style: { flex: '0 0 auto', opacity: 0.35, fontVariantNumeric: 'tabular-nums' } }, fmtClock(e.at)),
                  h('span', { key: 'm', style: { flex: 1, overflowWrap: 'anywhere' } }, e.message)
                ]))
              ])
            : null,
          autoResult
            ? h('pre', { key: 'r', style: { marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.6, opacity: 0.85, fontFamily: 'inherit' } }, autoResult)
            : null
        ]),

        h('div', { key: 'env', style: { border: '1px solid #8884', borderRadius: 10, padding: '10px 12px' } }, [
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } }, [
            h('div', { key: 'l', style: { fontSize: 13, fontWeight: 600 } },
              env ? `环境检查：${env.checks.length - bad.length}/${env.checks.length} 通过` : '环境检查'),
            h('button', { key: 'b', onClick: () => runEnv(port), disabled: envBusy, style: { fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer' } },
              envBusy ? '检查中…' : '重新检查')
          ]),
          h('div', { key: 'list', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
            (env?.checks ?? []).map((c) => h('div', { key: c.id, style: { display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.5 } }, [
              h('span', { key: 'i' }, c.ok ? '✅' : '❌'),
              h('span', { key: 'l', style: { opacity: 0.9, flex: '0 0 auto' } }, c.label),
              h('span', { key: 'd', style: { opacity: 0.55, flex: 1, overflowWrap: 'anywhere' } }, c.detail),
              c.hint ? h('span', { key: 'h', style: { color: '#e8590c', flex: '0 0 auto' } }, c.hint) : null
            ])))
        ]),

        ...['speak', 'common', 'sticker', 'media', 'advanced'].map((g) => h('div', { key: g, style: { border: '1px solid #8884', borderRadius: 10 } }, [
          h('button', {
            key: 'h',
            onClick: () => setOpen((o) => ({ ...o, [g]: !o[g] })),
            style: { width: '100%', textAlign: 'left', padding: '9px 12px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', justifyContent: 'space-between' }
          }, [
            h('span', { key: 'l' }, GROUP_LABEL[g]),
            h('span', { key: 'c', style: { opacity: 0.5 } }, open[g] ? '收起' : `${FIELDS.filter((f) => f.group === g).length} 项`)
          ]),
          open[g]
            ? h('div', { key: 'b', style: { padding: '4px 12px 10px' } }, [
                g === 'speak'
                  ? h('button', {
                      key: 'pv',
                      onClick: () => previewPersona(port),
                      style: { marginBottom: 10, fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer' }
                    }, '预览效果')
                  : null,
                ...FIELDS.filter((f) => f.group === g).map((f) => h(Field, {
                  key: f.key, f, values, setValues, port, setStatus, setError,
                  voices, voiceStatus, onReloadVoices: () => loadVoices(port)
                }))
              ])
            : null
        ])),

        personaPreview ? h('div', { key: 'pv', style: { border: '1px solid #8884', borderRadius: 8, padding: '10px 12px' } }, [
          h('div', { key: 'hd', style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, '它会这样说（预览）'),
          h('pre', { key: 't', style: { whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.85, margin: 0, fontFamily: 'inherit' } }, personaPreview)
        ]) : null,

        error ? h('div', { key: 'err', style: { color: '#e03131', fontSize: 12, lineHeight: 1.6 } }, error) : null,

        h('div', {
          key: 'bar',
          style: { position: 'sticky', bottom: 0, display: 'flex', gap: 10, alignItems: 'center', padding: '10px 4px', backdropFilter: 'blur(6px)' }
        }, [
          h('button', { key: 's', onClick: save, style: { padding: '7px 20px', borderRadius: 6, cursor: 'pointer', fontWeight: 600 } }, '保存'),
          h('button', { key: 'r', onClick: load, style: { padding: '7px 12px', borderRadius: 6, cursor: 'pointer' } }, '重新读取'),
          status ? h('span', { key: 'st', style: { fontSize: 12, opacity: 0.7 } }, status) : null
        ])
      ]);
    }

    const name = 'dsh-plugin-kuaishou';
    const inject = ['slots'];

    function apply(ctx) {
      try {
        if (!ctx?.slots?.inject) throw new Error('ctx.slots.inject 不可用');
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NS, order: 45, label: () => '快手' },
            () => h(Panel)
          )
        );
      } catch (e) {
        const msg = `[kuaishou] client apply failed: ${e && e.stack ? e.stack : e}`;
        try { console.error(msg); } catch {}
        try { window.localStorage.setItem('kuaishou-client-error', msg); } catch {}
      }
    }

    const exports_ = { name, inject, apply };
    return exports_;
  }
});
