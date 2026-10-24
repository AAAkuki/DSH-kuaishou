import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adb, AdbError, discoverAdb, formatCommand } from '../src/adb.mjs';
import { makeExecImpl } from './fixtures.mjs';

test('formatCommand 对含空格的参数加引号', () => {
  assert.equal(formatCommand('adb', ['-s', 'emulator-5554', 'shell', 'input tap 1 2']), 'adb -s emulator-5554 shell input tap 1 2');
  assert.equal(formatCommand('', ['devices']), 'adb devices');
});

test('discoverAdb: 显式路径存在就用它', () => {
  const tmp = path.join(os.tmpdir(), `adb-${Date.now()}.exe`);
  fs.writeFileSync(tmp, 'x');
  assert.equal(discoverAdb({ explicit: tmp }), tmp);
  fs.unlinkSync(tmp);
});

test('discoverAdb: 显式路径不存在则回落（这里返回字符串）', () => {
  const got = discoverAdb({ explicit: 'C:\\nope\\adb.exe', env: {} });
  assert.equal(typeof got, 'string');
});

test('Adb.dryRun 只记录命令不执行', async () => {
  const adb = new Adb({ adbPath: 'C:\\fake\\adb.exe', dryRun: true });
  await adb.tap(10, 20);
  await adb.swipe(1, 2, 3, 4, 300);
  assert.equal(adb.commands.length, 2);
  assert.equal(adb.commands[0], 'C:\\fake\\adb.exe shell input tap 10 20');
});

test('Adb 拼 -s serial 前缀', async () => {
  const { execImpl, calls } = makeExecImpl();
  const adb = new Adb({ adbPath: 'adb', serial: 'emulator-5554', execImpl });
  await adb.tap(1, 2);
  assert.equal(calls.at(-1), '-s emulator-5554 shell input tap 1 2');
});

test('devices 解析与 resolveSerial 单设备自动选', async () => {
  const { execImpl } = makeExecImpl();
  const adb = new Adb({ adbPath: 'adb', execImpl });
  const list = await adb.devices();
  assert.equal(list.length, 1);
  assert.equal(list[0].serial, 'emulator-5554');
  assert.equal(await adb.resolveSerial(), 'emulator-5554');
});

test('resolveSerial 多设备时报错并提示配置 serial', async () => {
  const { execImpl } = makeExecImpl({ devices: [{ serial: 'a', state: 'device', model: 'X' }, { serial: 'b', state: 'device', model: 'Y' }] });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  await assert.rejects(() => adb.resolveSerial(), /请在 config.json 的 serial 指定一台/);
});

test('resolveSerial 无设备时给出可操作提示', async () => {
  const { execImpl } = makeExecImpl({ devices: [{ serial: 'x', state: 'offline', model: 'X' }] });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  await assert.rejects(() => adb.resolveSerial(), /没有在线设备/);
});

test('currentFocus 解出 pkg/activity', async () => {
  const { execImpl } = makeExecImpl({ focus: 'com.smile.gifmaker' });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  const f = await adb.currentFocus();
  assert.equal(f.pkg, 'com.smile.gifmaker');
});

test('inputText: ASCII 走 input text', async () => {
  const { execImpl, calls } = makeExecImpl();
  const adb = new Adb({ adbPath: 'adb', execImpl });
  await adb.inputText('hello world');
  assert.ok(calls.some((c) => c.startsWith('shell input text')));
});

test('inputText: 中文且没装 ADBKeyboard 时抛错并提示', async () => {
  const { execImpl } = makeExecImpl({ adbKeyboard: false });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  await assert.rejects(() => adb.inputText('你好'), /ADBKeyboard/);
});

test('inputText: 中文且已装 ADBKeyboard 时走 base64 广播', async () => {
  const { execImpl, calls } = makeExecImpl({ adbKeyboard: true });
  const adb = new Adb({ adbPath: 'adb', execImpl });
  await adb.inputText('你好');
  assert.ok(calls.some((c) => c.startsWith('shell ime set')));
  assert.ok(calls.some((c) => c.includes('ADB_INPUT_B64')));
  const b64 = calls.find((c) => c.includes('ADB_INPUT_B64')).split(' ').at(-1);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '你好');
});

test('screencap 返回 buffer', async () => {
  const { execImpl } = makeExecImpl();
  const adb = new Adb({ adbPath: 'adb', execImpl });
  const png = await adb.screencap();
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length >= 2048);
});

test('AdbError 保留 cmd/status', () => {
  const e = new AdbError('boom', { cmd: 'adb shell x', status: 1 });
  assert.equal(e.name, 'AdbError');
  assert.equal(e.cmd, 'adb shell x');
  assert.equal(e.status, 1);
});
