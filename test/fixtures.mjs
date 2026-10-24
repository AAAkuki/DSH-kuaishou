// 离线测试用的假 adb：实现 Adb.exec 的 execImpl 契约，把命令映射成固定的假输出。
//
// 这样 KS 层的「找元素 → 点击 → 输入 → 等待」全链路都能在没有设备、没有 MuMu 的
// 机器上跑通，CI 里也能验证改代码没把命令拼错。

export const HOME_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="1" text="推荐" resource-id="com.smile.gifmaker:id/tab_title" class="android.widget.TextView" bounds="[60,2200][220,2320]" clickable="true" enabled="true" />
    <node index="2" text="评论" resource-id="" class="android.widget.TextView" bounds="[900,1900][1000,2000]" clickable="true" enabled="true" content-desc="评论" />
    <node index="3" text="说点什么" resource-id="com.smile.gifmaker:id/comment_editor" class="android.widget.EditText" bounds="[40,2250][900,2350]" clickable="true" enabled="true" />
  </node>
</hierarchy>`;

export const COMMENT_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="1" text="这个怎么做的？" resource-id="com.smile.gifmaker:id/comment_text" class="android.widget.TextView" bounds="[60,1400][700,1460]" clickable="true" enabled="true" />
    <node index="2" text="加微信领资料" resource-id="com.smile.gifmaker:id/comment_text" class="android.widget.TextView" bounds="[60,1500][700,1560]" clickable="true" enabled="true" />
    <node index="3" text="说点什么" resource-id="com.smile.gifmaker:id/comment_editor" class="android.widget.EditText" bounds="[40,2250][900,2350]" clickable="true" enabled="true" />
    <node index="4" text="发送" resource-id="com.smile.gifmaker:id/send" class="android.widget.TextView" bounds="[940,2250][1060,2350]" clickable="true" enabled="true" />
  </node>
</hierarchy>`;

export const PUBLISH_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="1" text="相册" resource-id="" class="android.widget.TextView" bounds="[100,2100][300,2200]" clickable="true" enabled="true" />
    <node index="2" text="" resource-id="com.smile.gifmaker:id/thumb" class="android.widget.ImageView" bounds="[40,300][340,600]" clickable="true" enabled="true" />
    <node index="3" text="下一步" resource-id="" class="android.widget.TextView" bounds="[800,2200][1040,2320]" clickable="true" enabled="true" />
    <node index="4" text="添加作品描述" resource-id="com.smile.gifmaker:id/caption" class="android.widget.EditText" bounds="[60,1900][1000,2000]" clickable="true" enabled="true" />
    <node index="5" text="发布" resource-id="com.smile.gifmaker:id/publish" class="android.widget.TextView" bounds="[860,2220][1040,2340]" clickable="true" enabled="true" />
  </node>
</hierarchy>`;

/**
 * 造一个 execImpl。
 * @param {object} opts
 * @param {() => string} [opts.xml] 当前 dump 返回的 XML
 * @param {string} [opts.focus] 前台包名
 * @param {Array} [opts.devices] adb devices 输出
 */
export function makeExecImpl({ xml = () => HOME_XML, focus = 'com.smile.gifmaker', devices = [{ serial: 'emulator-5554', state: 'device', model: 'MuMu' }], adbKeyboard = true, size = 'Physical size: 1080x2400' } = {}) {
  const calls = [];
  const execImpl = async (cmd) => {
    const line = cmd.slice(1).join(' ');
    calls.push(line);

    if (line === 'devices -l') {
      const body = devices.map((d) => `${d.serial}\t${d.state} product:MuMu model:${d.model} device:${d.model}`).join('\n');
      return { stdout: `List of devices attached\n${body}\n`, stderr: '', status: 0 };
    }
    if (line.startsWith('shell wm size')) return { stdout: `${size}\n`, stderr: '', status: 0 };
    if (line.startsWith('shell dumpsys window')) {
      return { stdout: `  mCurrentFocus=Window{1 u0 ${focus}/${focus}.HomeActivity}\n`, stderr: '', status: 0 };
    }
    if (line.startsWith('shell uiautomator dump')) return { stdout: 'UI hierchary dumped to: /sdcard/ksops_dump.xml\n', stderr: '', status: 0 };
    if (line.startsWith('exec-out cat')) return { stdout: xml(), stderr: '', status: 0 };
    if (line.startsWith('shell pm list packages')) {
      return { stdout: adbKeyboard ? 'package:com.android.adbkeyboard\n' : '', stderr: '', status: 0 };
    }
    if (line.startsWith('exec-out screencap')) {
      const fake = Buffer.alloc(2048, 0x89);
      return { stdout: fake.toString('binary'), stderr: '', status: 0, binary: fake };
    }
    if (line.startsWith('push ')) return { stdout: '1 file pushed.\n', stderr: '', status: 0 };
    // tap / swipe / keyevent / am / ime / mkdir / broadcast 全部当成功
    return { stdout: '', stderr: '', status: 0 };
  };
  return { execImpl, calls };
}
