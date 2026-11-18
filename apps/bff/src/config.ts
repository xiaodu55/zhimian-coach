import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// 优先级：--port 参数 > PORT 环境变量 > 8787（便于同机并行起多实例）
function readArgPort(): number | null {
  const idx = process.argv.indexOf('--port');
  if (idx === -1) return null;
  const n = Number(process.argv[idx + 1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export const config = {
  port: readArgPort() ?? Number(process.env.PORT || 8787),
  nodeEnv: process.env.NODE_ENV || 'development',
  zhihuAccessSecret: (process.env.ZHIHU_ACCESS_SECRET || '').trim(),
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://api.minimax.chat/v1').replace(/\/$/, ''),
  llmApiKey: (process.env.LLM_API_KEY || '').trim(),
  llmModel: (process.env.LLM_MODEL || 'MiniMax-Text-01').trim(),
  cacheTtlMs: Number(process.env.CACHE_TTL_HOURS || 24) * 3600 * 1000,
  // 公网分享口令：配了之后所有 /api 都要带 x-share-token（?k= 也行），防止演示链接被刷额度
  publicShareToken: (process.env.PUBLIC_SHARE_TOKEN || '').trim(),
  oauthAppId: (process.env.OAUTH_APP_ID || '').trim(),
  oauthAppKey: (process.env.OAUTH_APP_KEY || '').trim(),
  oauthRedirectUri: (process.env.OAUTH_REDIRECT_URI || '').trim(),
  // ASR（可选）：未配置时 /api/asr 返回 501 + 本地转写/导入的替代路径
  asrProvider: (process.env.ASR_PROVIDER || 'none').trim(),
  asrBaseUrl: (process.env.ASR_BASE_URL || '').trim(),
  asrApiKey: (process.env.ASR_API_KEY || '').trim(),
  asrModel: (process.env.ASR_MODEL || '').trim(),

  // PDF 兜底解析（按需开启；容器里通常没有 python OCR 依赖）
  repoRoot: path.resolve(__dirname, '../../..'),
  pdfOcrEnabled: (process.env.PDF_OCR || '1') === '1',
  tikaUrl: (process.env.TIKA_URL || '').trim(),
  mineruUrl: (process.env.MINERU_URL || '').trim(),

  webRoot: path.resolve(__dirname, '../../web'),
  bankFilePath: path.resolve(__dirname, '../../web/data/question-bank.json')
};

export function hasZhihuSecret(): boolean {
  return config.zhihuAccessSecret.length > 0;
}

export function hasLlmKey(): boolean {
  return config.llmApiKey.length > 0;
}
