// 「更软的声音」：用 ffmpeg 滤镜把 Piper 输出做柔化处理
// 思路（按贡献度排序）：
//   1. 略微降调（asetrate + atempo 保持时长）→ 声音更沉、更软，不尖
//   2. lowpass 削掉 6kHz 以上的齿音 → 去掉"电子感"的尖利
//   3. bass 轻微抬低频 → 增加胸腔共鸣的厚度
//   4. treble 轻微压高频 → 减少刺耳
//   5. aecho 极轻的短混响 → 空间感，不那么"贴脸"
//   6. acompressor 压一下动态 → 起伏更平缓，听感更柔和
import { spawnSync } from 'node:child_process';

const PRESETS = {
  // 柔和：降 1 个半音，削齿音，轻微胸腔共鸣 + 极短混响
  soft: {
    label: '柔和',
    pitch: 0.94,
    filters: 'lowpass=f=6200,equalizer=f=180:t=q:w=1:g=2.5,treble=g=-2.5,aecho=0.8:0.7:12:0.12,acompressor=threshold=-26dB:ratio=2.5:attack=8:release=180,volume=6dB'
  },
  // 更软：降 2 个半音，厚度更明显，混响稍长
  softer: {
    label: '更软',
    pitch: 0.89,
    filters: 'lowpass=f=5200,equalizer=f=160:t=q:w=1:g=3.5,treble=g=-4,aecho=0.8:0.6:18:0.18,acompressor=threshold=-28dB:ratio=3:attack=10:release=220,volume=9dB'
  },
  // 奶音：明显降调（接近女童音），慢一点，最大厚度
  mellow: {
    label: '奶音（明显降调）',
    pitch: 0.84,
    filters: 'lowpass=f=4800,equalizer=f=150:t=q:w=1:g=4,treble=g=-5,aecho=0.8:0.6:22:0.22,acompressor=threshold=-30dB:ratio=3.5:attack=12:release=260,volume=12dB'
  },
  // 广播：只去刺不降调，保留原音色
  clean: {
    label: '去刺（不降调）',
    pitch: 1,
    filters: 'lowpass=f=7000,treble=g=-2,acompressor=threshold=-24dB:ratio=2:attack=6:release=150,volume=4dB'
  },
  none: { label: '不处理', pitch: 1, filters: '' }
};

export const SOFT_PRESETS = PRESETS;

/**
 * 把 wav 做柔化处理。
 * @param {{ffmpeg:string}} tools  resolveTools() 的结果
 * @param {{input:string, out:string, preset?:string, pitch?:number}} opts
 */
export function softenAudio(tools, { input, out, preset = 'soft', pitch = null } = {}) {
  const resolved = PRESETS[preset] ? preset : 'soft';
  const p = PRESETS[resolved];
  const semis = pitch ?? p.pitch;

  const chain = [];
  // 降调：先改采样率再改回时长（atempo 补偿），这样音调变低但语速不变
  if (semis && semis !== 1) {
    chain.push(`asetrate=22050*${semis}`);
    chain.push(`atempo=${(1 / semis).toFixed(4)}`);
    chain.push('aresample=22050');
  }
  if (p.filters) chain.push(p.filters);

  if (chain.length === 0) {
    // 不处理就直接复制
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-y', '-i', input, '-c', 'copy', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`柔化失败：${(r.stderr || '').slice(-200)}`);
    return { out, preset: 'none', filters: '' };
  }

  const r = spawnSync(tools.ffmpeg, [
    '-hide_banner', '-y', '-i', input,
    '-af', chain.join(','),
    '-ar', '22050', '-ac', '1',
    out
  ], { encoding: 'utf8' });

  if (r.status !== 0) {
    throw new Error(`柔化失败：${(r.stderr || '').split('\n').slice(-4).join(' ').slice(-300)}`);
  }
  return { out, preset: resolved, requested: preset, pitch: semis, filters: chain.join(',') };
}
