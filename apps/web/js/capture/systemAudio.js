/**
 * 采集「系统声音 / 标签页声音」作为第二轨（面试官那一路）。
 *
 * 为什么需要它：线上面试时，对方的声音从扬声器出来，只靠一个麦克风采集会和我的人声混在一起，
 * 无法可靠区分"谁在说话"。物理上分成两路（麦克风=我，系统音频=面试官）比任何语音分离算法都稳。
 *
 * 浏览器限制（实测/已知）：
 *  - getDisplayMedia 必须带 video:true 才会弹选择器；选完立刻停掉 video 轨。
 *  - 用户必须在选择器里勾选"分享音频/系统音频"，否则拿不到音轨 → 明确报错，不静默。
 *  - Chrome/Edge 桌面版支持；WebView2（Tauri 桌面壳）与多数移动端不支持 → 明确降级提示。
 */
export function isSystemAudioSupported() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export async function captureSystemAudio() {
  if (!isSystemAudioSupported()) {
    throw new Error('当前环境不支持采集系统声音（移动端 / 桌面壳不支持），请改用单麦克风 + 手动标注说话人');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    throw new Error(`采集系统声音被取消或失败：${err.message}`);
  }
  // video 只是"门票"，拿到后立刻释放
  stream.getVideoTracks().forEach((t) => t.stop());
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('没有勾选「分享音频」：请在共享选择器里勾选系统音频后再试');
  }
  return { stream, tracks: audioTracks };
}
