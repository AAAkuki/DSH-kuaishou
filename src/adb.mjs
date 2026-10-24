// adb 传输层：只做「拼命令 + 执行 + 报错」，不含任何快手业务逻辑。
//
// 两个关键设计：
//  1. execImpl 可注入 —— 离线测试用假实现，不碰真设备；
//  2. 所有失败都抛 AdbError（带 status/stderr/命令），上层据此决定重试还是报给模型看。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class AdbError extends Error {
  constructor(message, { cmd, status, stdout, stderr } = {}) {
    super(message);
    this.name = 'AdbError';
    this.cmd = cmd;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 自动探测 adb。顺序：显式配置 → 环境变量 → MuMu / 雷电 / 夜神 常见安装位 → PATH。
 * 找到返回绝对路径，找不到返回 ''（调用方给出可操作提示）。
 */
export function discoverAdb({ explicit = '', env = process.env } = {}) {
  if (explicit && isFile(explicit)) return explicit;
  if (env.KSOPS_ADB && isFile(env.KSOPS_ADB)) return env.KSOPS_ADB;

  const candidates = [];
  if (env.ANDROID_HOME) candidates.push(path.join(env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (env.ANDROID_SDK_ROOT) candidates.push(path.join(env.ANDROID_SDK_ROOT, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));

  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [
    path.join(pf, 'Netease', 'MuMuPlayer-12.0'),
    path.join(pf, 'Netease', 'MuMuPlayer-12.0', 'nx_main'),
    path.join(pf86, 'Netease', 'MuMuPlayer-12.0'),
    path.join(pf, 'Netease', 'MuMuPlayerGlobal-12.0'),
    path.join(local, 'Programs', 'MuMuPlayer'),
    'D:\\MuMuPlayer',
    'D:\\MuMuPlayer\\nx_main',
    'C:\\MuMuPlayer',
    path.join(pf, 'ldplayer', 'LDPlayer9'),
    path.join(pf86, 'Nox', 'Nox')
  ];
  for (const r of roots) {
    candidates.push(path.join(r, 'adb.exe'));
    candidates.push(path.join(r, 'adb'));
    candidates.push(path.join(r, 'shell', 'adb.exe'));
  }
  for (const c of candidates) if (isFile(c)) return c;
  return '';
}

/** 把参数数组变成一行可读命令（日志/干跑用）。 */
export function formatCommand(adbPath, args) {
  // 只用于日志/干跑：朴素拼接即可，别做 shell 转义（转义后的字符串反而不像用户能复制的命令）
  return [adbPath || 'adb', ...args].map((a) => String(a)).join(' ');
}

export class Adb {
  /**
   * @param {object} opts
   * @param {string} opts.adbPath adb 路径（空则 discoverAdb）
   * @param {string} [opts.serial] 目标设备
   * @param {number} [opts.timeoutMs] 默认超时
   * @param {boolean} [opts.dryRun] 干跑：只记录命令
   * @param {(cmd: string[], opts: object) => Promise<{stdout:string,stderr:string,status:number,binary?:Buffer}>} [opts.execImpl]
   */
  constructor({ adbPath = '', serial = '', timeoutMs = 20000, dryRun = false, execImpl = null, log = () => {} } = {}) {
    this.adbPath = adbPath || discoverAdb();
    this.serial = serial;
    this.timeoutMs = timeoutMs;
    this.dryRun = dryRun;
    this.execImpl = execImpl || null;
    this.log = log;
    this.commands = [];
  }

  /** 设备级参数前缀。 */
  prefix() {
    return this.serial ? ['-s', this.serial] : [];
  }

  async exec(args, { timeoutMs = this.timeoutMs, binary = false } = {}) {
    const cmd = [this.adbPath || 'adb', ...this.prefix(), ...args];
    this.commands.push(formatCommand(cmd[0], cmd.slice(1)));
    this.log(`[adb] ${formatCommand(cmd[0], cmd.slice(1))}`);
    if (this.dryRun && !this.execImpl) {
      return { stdout: '', stderr: '', status: 0, dryRun: true };
    }
    if (this.execImpl) return this.execImpl(cmd, { timeoutMs, binary });
    return await runProcess(cmd, { timeoutMs, binary });
  }

  async shell(command, opts) {
    return await this.exec(['shell', command], opts);
  }

  async shellText(command, opts) {
    const r = await this.shell(command, opts);
    return String(r.stdout ?? '').trim();
  }

  async devices() {
    const r = await this.exec(['devices', '-l']);
    return String(r.stdout ?? '')
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/);
        const meta = rest.join(' ');
        const model = /model:(\S+)/.exec(meta)?.[1] ?? '';
        return { serial, state, model };
      });
  }

  /** 选设备：配置了就用配置的；否则要求唯一在线设备。 */
  async resolveSerial() {
    if (this.serial) return this.serial;
    const list = (await this.devices()).filter((d) => d.state === 'device');
    if (list.length === 0) {
      throw new AdbError('没有在线设备：先启动 MuMu（或真机打开 USB 调试），再执行 adb devices 确认能看到设备');
    }
    if (list.length > 1) {
      throw new AdbError(`有 ${list.length} 台设备在线（${list.map((d) => d.serial).join(', ')}），请在 config.json 的 serial 指定一台`);
    }
    this.serial = list[0].serial;
    return this.serial;
  }

  /** 当前前台包名/Activity。 */
  async currentFocus() {
    const out = await this.shellText('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
    const m = /([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(out);
    return m ? { pkg: m[1], activity: m[2], raw: out } : { pkg: '', activity: '', raw: out };
  }

  async tap(x, y) {
    return await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1, y1, x2, y2, durationMs = 300) {
    return await this.shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`);
  }

  async key(code) {
    return await this.shell(`input keyevent ${code}`);
  }

  /** ASCII 文本输入（中文必须走 ADBKeyboard，见 inputText）。 */
  async typeAscii(text) {
    const escaped = String(text).replace(/([\\"'`$&|;<>()*?[\]{}~!#])/g, '\\$1').replace(/\s/g, '%s');
    return await this.shell(`input text "${escaped}"`);
  }

  async isAdbKeyboardInstalled(pkg = 'com.android.adbkeyboard') {
    const out = await this.shellText(`pm list packages ${pkg}`);
    return out.includes(pkg);
  }

  /**
   * 通用文本输入。
   *  - 纯 ASCII：input text 直接打；
   *  - 含中文：必须装 ADBKeyboard（广播 ADB_INPUT_TEXT），否则抛错并给出安装提示。
   */
  async inputText(text, { imeId = 'com.android.adbkeyboard/.AdbIME', imePackage = 'com.android.adbkeyboard' } = {}) {
    const s = String(text);
    if (/^[\x20-\x7E]*$/.test(s)) return await this.typeAscii(s);
    if (!(await this.isAdbKeyboardInstalled(imePackage))) {
      throw new AdbError('输入含中文，需要先安装 ADBKeyboard APK 并设为输入法（见 README 的「中文输入」一节）');
    }
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    await this.shell(`ime set ${imeId}`);
    const r = await this.shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
    return r;
  }

  /** 截屏 PNG buffer。 */
  async screencap() {
    const r = await this.exec(['exec-out', 'screencap -p'], { binary: true, timeoutMs: 30000 });
    return r.binary ?? Buffer.from(r.stdout ?? '');
  }

  /** dump 当前界面 XML。 */
  async dumpUi() {
    const tmp = '/sdcard/ksops_dump.xml';
    await this.shell(`uiautomator dump ${tmp}`, { timeoutMs: 30000 });
    const r = await this.exec(['exec-out', 'cat', tmp], { timeoutMs: 15000 });
    return String(r.stdout ?? '');
  }
}

/** 真正起进程。binary=true 时 stdout 收 Buffer。 */
export function runProcess(cmd, { timeoutMs = 20000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { windowsHide: true });
    const chunks = [];
    const errChunks = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new AdbError(`无法启动 adb（${cmd[0]}）：${error.message}`, { cmd: cmd.join(' ') }));
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      const outBuf = Buffer.concat(chunks);
      const err = Buffer.concat(errChunks).toString('utf8');
      const stdout = binary ? outBuf.toString('binary') : outBuf.toString('utf8');
      if (killed) {
        reject(new AdbError(`adb 超时（${timeoutMs}ms）：${cmd.join(' ')}`, { cmd: cmd.join(' '), status, stdout, stderr: err }));
        return;
      }
      if (status !== 0) {
        reject(new AdbError(`adb 失败（exit ${status}）：${err.trim() || cmd.join(' ')}`, { cmd: cmd.join(' '), status, stdout, stderr: err }));
        return;
      }
      resolve({ stdout, stderr: err, status, binary: binary ? outBuf : undefined });
    });
  });
}
