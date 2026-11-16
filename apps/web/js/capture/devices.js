/**
 * 输入设备枚举与选择。
 * 注意：需要在 getUserMedia 授权之后才能拿到 device.label（否则是空字符串）。
 */
export async function listAudioInputs({ requestPermission = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  if (requestPermission) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* 拒绝授权时仍返回无标签列表，让用户知道有设备但看不到名字 */
    }
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `麦克风 ${i + 1}（未授权，名称不可见）`,
      isDefault: d.deviceId === 'default',
    }));
}

/**
 * 识别可能是"会议软件虚拟设备"的输入源，用于给出针对性提示。
 * 实测：腾讯会议 / 飞书 / 钉钉 会注册类似 "腾讯会议虚拟麦克风" 的设备。
 */
export function detectVirtualDevice(label = '') {
  return /(虚拟|Virtual|VB-Audio|VoiceMeeter|腾讯会议|飞书|钉钉|Zoom|Teams|OBS|Stereo Mix|混音)/i.test(label);
}
