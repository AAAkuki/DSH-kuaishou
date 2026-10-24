// 语音合成：把「换声音」拆成两条路——
//   1) sapi  ：Windows 自带语音（当前只有 Huihui 中文 / Zira 英文），**不需要任何文件**，填名字即可
//   2) piper ：Piper 的 .onnx 语音模型文件（离线、可自定义音色），需要 exe + 模型两个文件
//
// 为什么不内置 Edge 神经语音：它要 wss + 自定义请求头，而 Node 全局 WebSocket 不允许加头，
// 硬做要手写 TLS 握手与帧编解码。这里先不塞进来，免得"看起来支持、其实连不上"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class TtsError extends Error {
  constructor(message, { cmd, stderr } = {}) {
    super(message);
    this.name = 'TtsError';
    this.cmd = cmd;
    this.stderr = (stderr || '').slice(-800);
  }
}

/** 跑一个进程（piper 用）；powerShell 脚本走 runPowerShell。 */
function run(cmd, args, { input, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new TtsError(`超时（${timeoutMs}ms）：${cmd}`, { cmd: [cmd, ...args].join(' ') }));
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new TtsError(`无法启动 ${cmd}：${e.message}`, { cmd })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new TtsError(`${path.basename(cmd)} 退出码 ${code}`, { cmd: [cmd, ...args].join(' '), stderr: err }));
      else resolve({ stdout: out, stderr: err });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** 列出 Windows SAPI 语音（System.Speech 能看到的那批，SAPI 引擎另一侧写系统语音时同样可见）。 */
export async function listSapiVoices() {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object { $i = $_.VoiceInfo; "$($i.Name)|$($i.Culture.Name)|$($i.Gender)" }',
    '$s.Dispose()'
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 30000 });
  return String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, culture, gender] = l.split('|');
      return { name, culture, gender, engine: 'sapi' };
    });
}

/** 用 SAPI 合成到 WAV。语音名不存在时给可选项，而不是静默用默认音。 */
export async function synthesizeSapi({ text, out, voice = '', rate = 0 } = {}) {
  const sentence = String(text ?? '').trim();
  if (!sentence) throw new TtsError('需要 text');
  const target = path.resolve(out || path.join(os.tmpdir(), `tts-${Date.now()}.wav`));
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const avail = await listSapiVoices();
  if (voice && !avail.some((v) => v.name === voice)) {
    throw new TtsError(`没有这个语音「${voice}」；可用：${avail.map((v) => v.name).join(' / ') || '(无)'}`);
  }

  const txt = `${target}.txt`;
  const ps1 = `${target}.ps1`;
  fs.writeFileSync(txt, sentence, 'utf8');
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}')` : '',
    `$s.Rate = ${Number.isFinite(Number(rate)) ? Math.round(Number(rate)) : 0}`,
    `$s.SetOutputToWaveFile('${target.replace(/'/g, "''")}')`,
    `$s.Speak([IO.File]::ReadAllText('${txt.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
    '$s.Dispose()'
  ].filter(Boolean).join('; ');
  fs.writeFileSync(ps1, `\uFEFF${lines}\n`, 'utf8');
  try {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { timeoutMs: 180000 });
  } finally {
    fs.rmSync(txt, { force: true });
    fs.rmSync(ps1, { force: true });
  }
  if (!fs.existsSync(target) || fs.statSync(target).size < 100) {
    throw new TtsError('SAPI 没有生成有效 wav（检查语音是否可用）');
  }
  return { file: target, bytes: fs.statSync(target).size, engine: 'sapi', voice: voice || '(默认)' };
}

/** 用 Piper 的本地模型合成（离线、音色可自定义）。 */
export async function synthesizePiper({ text, out, exe, model } = {}) {
  const sentence = String(text ?? '').trim();
  if (!sentence) throw new TtsError('需要 text');
  if (!exe || !fs.existsSync(exe)) throw new TtsError(`Piper 可执行文件不存在：${exe || '(未配置 piperExe)'}`);
  if (!model || !fs.existsSync(model)) throw new TtsError(`Piper 模型不存在：${model || '(未配置 piperModel)'}`);
  const target = path.resolve(out || path.join(os.tmpdir(), `tts-piper-${Date.now()}.wav`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await run(exe, ['--model', model, '--output_file', target], { input: `${sentence}\n`, timeoutMs: 300000 });
  if (!fs.existsSync(target) || fs.statSync(target).size < 100) {
    throw new TtsError('Piper 没有生成有效 wav');
  }
  return { file: target, bytes: fs.statSync(target).size, engine: 'piper', voice: path.basename(model) };
}

/** 统一入口：engine = sapi | piper。 */
export async function synthesize({ engine = 'sapi', ...opts } = {}) {
  const e = String(engine || 'sapi').toLowerCase();
  if (e === 'sapi') return synthesizeSapi(opts);
  if (e === 'piper') return synthesizePiper(opts);
  throw new TtsError(`不支持的语音引擎「${engine}」；可选：sapi / piper`);
}
