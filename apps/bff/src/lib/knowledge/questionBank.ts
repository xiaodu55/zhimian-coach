import fs from 'node:fs';
import { config } from '../../config.js';

export interface ViewpointCard {
  id: string;
  stance: string;
  summary: string;
  evidenceQuote: string;
  sourceUrl: string;
  author: string;
  upvotes: number;
  popularity: string;
}

export interface QuestionItem {
  id: string;
  track: string;
  difficulty: string;
  title: string;
  context: string;
  keywords: string[];
  expectedLength: [number, number];
  skeleton: string[];
  viewpointCards: ViewpointCard[];
}

export function loadBankFromDisk(): QuestionItem[] {
  try {
    const raw = fs.readFileSync(config.bankFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch {
    return [];
  }
}

export function queryBank(q = '', track = '', limit = 50): QuestionItem[] {
  const all = loadBankFromDisk();
  const kw = q.trim().toLowerCase();
  const tr = track.trim();

  return all
    .filter((item) => {
      const matchTrack = !tr || tr === '全部赛道' || item.track === tr;
      const matchKw =
        !kw ||
        item.title.toLowerCase().includes(kw) ||
        item.context.toLowerCase().includes(kw) ||
        item.keywords.some((k) => k.toLowerCase().includes(kw));
      return matchTrack && matchKw;
    })
    .slice(0, Math.min(200, Math.max(1, limit)));
}

export function getQuestionById(id: string): QuestionItem | null {
  return loadBankFromDisk().find((item) => item.id === id) || null;
}
