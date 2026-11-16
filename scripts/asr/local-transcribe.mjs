/**
 * 双轨本地转写（无云端 ASR 的兜底路线）
 *
 * 用法：
 *   node scripts/asr/local-transcribe.mjs mic.webm system.webm [--out transcript.txt]
 *   node scripts/asr/local-transcribe.mjs mic.wav                     # 只有一轨也可以
 *
 * 做什么：
 *   1) ffmpeg 把每个音轨转成 16k 单声道 wav
 *   2) 调本机 faster-whisper（scripts/asr/transcribe_local.py）拿带时间戳片段
 *   3) 用与前端同一套对齐逻辑（apps/web/js/capture/align.js）按时间轴合并
 *   4) 输出 `面试官：… / 我：…` 转写稿，直接粘回页面的「解析并生成复盘」
 *
 * 约定：第一个参数 = 麦克风（我），第二个参数 = 系统音频（面试官）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : 'transcript.txt';
const WITH_TIME = args.includes('--with-time');
const files = args.filter((a, i) => a !== '--out' && a !== '--with-time' && (outIdx < 0 || i !== outIdx + 1));

if (!files.length) {
  console.error('用法：node scripts/asr/local-transcribe.mjs mic.webm [system.webm] [--out transcript.txt]');
  process.exit(1);
}

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-asr-'));

function toWav(input, name) {
  const wav = path.join(TMP, `${name}.wav`);
  execFileSync('ffmpeg', ['-y', '-i', input, '-ac', '1', '-ar', '16000', wav], { stdio: 'ignore' });
  return wav;
}

/**
 * 检测说话起点偏移（秒）。
 * 为什么需要：whisper 对整段带前置静音的音频常常把 start 报成 0，
 * 两轨直接按 start 排序会丢时间关系（实测：延迟 3s 的麦克风轨仍报 start=0）。
 * 这里用 ffmpeg silencedetect 找第一个 >0.4s 的静音结束点，作为该轨的时间偏移。
 */
function detectSpeechStart(input) {
  // 必须读 stderr：ffmpeg 的 silencedetect 把结果打在 stderr，且退出码为 0，
  // 所以不能用 execFileSync 的 try/catch 分支去接（那样永远拿不到日志）。
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', input, '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const log = String(res.stderr || '');
  const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return ends.length ? ends[0] : 0;
}

function shift(segments, offset) {
  if (!offset) return segments;
  return segments.map((s, i) => (i === 0 && s.start < 0.5 ? { ...s, start: s.start + offset, end: s.end + offset } : s));
}

function transcribe(wav, name) {
  const out = path.join(TMP, `${name}.json`);
  const res = execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [path.join(ROOT, 'scripts/asr/transcribe_local.py'), wav, '--out', out, '--model', process.env.ASR_MODEL_NAME || 'small'],
    { encoding: 'utf8' }
  ).trim();
  console.log(`[asr] ${name}: ${res}`);
  return JSON.parse(fs.readFileSync(out, 'utf8')).segments || [];
}

async function main() {
  const { mergeTracks, toTranscriptText } = await import(
    pathToFileURL(path.join(ROOT, 'apps/web/js/capture/align.js')).href
  );

  const [micFile, sysFile] = files;
  const micWav = toWav(micFile, 'mic');
  const micOffset = detectSpeechStart(micWav);
  const micSegments = shift(transcribe(micWav, 'mic'), micOffset);
  if (micOffset) console.log(`[asr] mic 说话起点偏移 ${micOffset.toFixed(2)}s`);

  let sysSegments = [];
  if (sysFile) {
    const sysWav = toWav(sysFile, 'system');
    const sysOffset = detectSpeechStart(sysWav);
    sysSegments = shift(transcribe(sysWav, 'system'), sysOffset);
    if (sysOffset) console.log(`[asr] system 说话起点偏移 ${sysOffset.toFixed(2)}s`);
  }

  const merged = mergeTracks(micSegments, sysSegments);
  // 默认不带时间戳：粘回页面的解析器按「面试官：/我：」切分，时间戳只是干扰；需要时加 --with-time
  const text = toTranscriptText(merged, { withTime: WITH_TIME });
  fs.writeFileSync(OUT, text + '\n', 'utf8');

  console.log(`[asr] 合并 ${merged.length} 句（我 ${merged.filter((r) => r.speaker === 'me').length} / 面试官 ${merged.filter((r) => r.speaker === 'interviewer').length}）`);
  console.log(`[asr] 已写入 ${OUT}`);
  if (!merged.length) {
    console.log('[asr] 提示：没有识别到语音。若音轨是静音（被会议软件占用），请回到页面重录或导入会议转写稿。');
  }
}

main().catch((err) => {
  console.error('[asr] 失败：', err.message);
  process.exit(1);
});
