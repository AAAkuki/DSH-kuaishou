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
    const { useState, useEffect, useCallback } = React;
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

    async function uploadAsset(file, port) {
      const res = await fetch(`http://127.0.0.1:${port}/upload?name=${encodeURIComponent(file.name)}`, {
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
      { key: 'personaId', group: 'common', label: '人设', type: 'select', options: [['persona-whale-maid', '鲸鱼女仆娘（默认）'], ['persona', '温和技术宅'], ['persona-cool', '冷面技术宅'], ['persona-warm', '热心姐姐'], ['persona-sharp', '毒舌但真诚']] },
      { key: 'mode', group: 'common', label: '运行方式', type: 'select', options: [['auto', '自动（有模拟器就用模拟器）'], ['adb', '模拟器 / 真机（adb）'], ['web', '快手网页版']] },
      { key: 'scrollPerRun', group: 'common', label: '每轮刷视频条数', type: 'number' },
      { key: 'replyPerRun', group: 'common', label: '每轮回评论条数', type: 'number' },
      { key: 'likePerRun', group: 'common', label: '每轮点赞个数', type: 'number' },
      { key: 'publishPerDay', group: 'common', label: '每天发布条数', type: 'number' },

      { key: 'videoBgPreset', group: 'media', label: '背景渐变', type: 'select', options: [['', '不用（纯色）'], ['deep-sea', '深海'], ['night-purple', '夜紫'], ['whale-blue', '鲸蓝'], ['sakura', '樱粉'], ['paper', '米纸'], ['mint', '薄荷']] },
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
      { key: 'videoTtsEngine', group: 'media', label: '语音引擎', type: 'select', options: [['sapi', '系统语音（免文件）'], ['piper', 'Piper 模型（自定义音色）']] },
      { key: 'videoVoice', group: 'media', label: '语音名', type: 'text', hint: 'Microsoft Huihui Desktop / Microsoft Zira Desktop' },
      { key: 'videoVoiceRate', group: 'media', label: '语速', type: 'number', hint: '-10~10' },
      { key: 'videoBgmFile', group: 'media', label: 'BGM', type: 'text', upload: 'audio', hint: '可上传' },
      { key: 'videoBgmGainDb', group: 'media', label: 'BGM 音量(dB)', type: 'number' },

      { key: 'videoSubtitleY', group: 'advanced', label: '字幕位置', type: 'number', hint: '0.3~0.98' },
      { key: 'videoBoxAlpha', group: 'advanced', label: '字幕底色透明度', type: 'number' },
      { key: 'videoTitleFontSize', group: 'advanced', label: '标题字号', type: 'number' },
      { key: 'videoTitleColor', group: 'advanced', label: '标题颜色', type: 'text' },
      { key: 'videoBgFit', group: 'advanced', label: '背景适配', type: 'select', options: [['cover', '覆盖裁切'], ['contain', '完整留边']] },
      { key: 'videoPiperExe', group: 'advanced', label: 'Piper 程序', type: 'text' },
      { key: 'videoPiperModel', group: 'advanced', label: 'Piper 模型', type: 'text', upload: 'voice' },
      { key: 'replyPromptId', group: 'advanced', label: '回评论提示词', type: 'text' },
      { key: 'scriptPromptId', group: 'advanced', label: '口播提示词', type: 'text' },
      { key: 'webProfileDir', group: 'advanced', label: '网页版登录态目录', type: 'text' },
      { key: 'browserPath', group: 'advanced', label: '浏览器路径', type: 'text' },
      { key: 'ffmpegPath', group: 'advanced', label: 'ffmpeg 路径', type: 'text' },
      { key: 'assetsPort', group: 'advanced', label: '上传服务端口', type: 'number' },
      { key: 'assetsDir', group: 'advanced', label: '素材目录', type: 'text' },
      { key: 'assetsMaxMB', group: 'advanced', label: '上传大小上限(MB)', type: 'number', hint: '默认 64' },
      { key: 'personaOverride', group: 'advanced', label: '自定义人设正文', type: 'textarea', hint: '填了优先于上面的预设' }
    ];

    const GROUP_LABEL = { speak: '说话与打字', common: '常用', media: '素材（视频模板）', advanced: '高级' };
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

    function Field({ f, values, setValues, port, setStatus, setError }) {
      if (f.type === 'toggle') {
        const on = values[f.key] !== false;
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
                accept: f.upload === 'image' ? 'image/*' : f.upload === 'video' ? 'video/*' : f.upload === 'audio' ? 'audio/*' : '.ttf,.ttc,.otf,.onnx,.json',
                title: '上传到 state/assets 并自动填路径',
                style: { width: 150, fontSize: 11 },
                onChange: async (e) => {
                  const file = e.target.files && e.target.files[0];
                  if (!file) return;
                  setStatus(`上传中：${file.name}`);
                  try {
                    const saved = await uploadAsset(file, port);
                    setValues((v) => ({ ...v, [f.key]: saved }));
                    // 上传完直接落盘：不然用户以为"设了"，其实只在自己屏幕上改了（踩过）
                    await rpc('settings/update', { ns: NS, patch: { [f.key]: saved } });
                    setStatus(`已上传并保存 → ${saved}`);
                    setError('');
                  } catch (err) {
                    setStatus('');
                    setError(`上传失败：${err.message}（上传服务 ${port} 未就绪？）`);
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
          setEnv({ checks: [{ id: 'env', label: '环境检查接口', ok: false, detail: e.message, hint: `上传服务 ${p} 未启动：重启 DSH` }], badCount: 1 });
        } finally {
          setEnvBusy(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);
      const previewPersona = useCallback(async (p) => {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/persona`, { method: 'GET' });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || '预览失败');
          setPersonaPreview(body.guide || '（按当前设置不会追加额外说明）');
        } catch (e) {
          setPersonaPreview(`预览失败：${e.message}`);
        }
      }, []);
      useEffect(() => { if (values && !env) runEnv(port); }, [values, env, port, runEnv]);

      const save = useCallback(async () => {
        try {
          setStatus('保存中…');
          const patch = {};
          for (const f of FIELDS) {
            const v = values?.[f.key];
            if (v === undefined || v === null || v === '') continue;
            patch[f.key] = f.type === 'number' ? Number(v) : v;
          }
          for (const f of FIELDS) {
            if (f.type === 'toggle' && typeof values?.[f.key] === 'boolean') patch[f.key] = values[f.key];
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

        ...['speak', 'common', 'media', 'advanced'].map((g) => h('div', { key: g, style: { border: '1px solid #8884', borderRadius: 10 } }, [
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
                ...FIELDS.filter((f) => f.group === g).map((f) => h(Field, { key: f.key, f, values, setValues, port, setStatus, setError }))
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
