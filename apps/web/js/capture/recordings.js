/**
 * 录音持久化（双轨）：麦克风轨 = 我，系统音频轨 = 面试官。
 * 隐私：Blob 只存在本机 IndexedDB，不上传；导出时由用户主动下载文件。
 */
import { dbPut, dbGetAll, dbGet } from '../db.js';

export async function saveRecording({ id, questionId, micBlob, systemBlob, durationSec, captions, deviceLabel }) {
  // IndexedDB 可直接存 Blob（结构化克隆）
  return dbPut('recordings', {
    id,
    questionId: questionId || '',
    durationSec,
    deviceLabel: deviceLabel || '',
    hasSystemTrack: Boolean(systemBlob),
    micBlob: micBlob || null,
    systemBlob: systemBlob || null,
    captions: captions || [],
    createdAt: new Date().toISOString(),
  });
}

export async function listRecordings() {
  return dbGetAll('recordings');
}

export async function getRecording(id) {
  return dbGet('recordings', id);
}

/** 生成可播放的临时 URL（调用方负责 revoke） */
export function trackUrl(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}

/** 导出两条音轨为本地文件（用户在页面上点按钮触发，不含任何上传） */
export function downloadTrack(blob, filename) {
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** 把 Blob 转成 multipart 表单，供 /api/asr/transcribe 使用（仅在用户主动点「转写」时调用） */
export function toFormData(blob, filename, track) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('track', track);
  return fd;
}
