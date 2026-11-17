/**
 * 热词纠错：从题目上下文抽出领域专有名词，保守修正转写稿里的同音 / 形近误写。
 *
 * 设计底线（为什么这么写）：
 *   1. 宁可漏改不可改错 —— 任何一条替换都必须能在 changes 里说清依据；
 *      无法判断的词一律保持原样。
 *   2. 只在"当前题目确实会出现这个词"的前提下才修：中文音译 → 英文术语的替换，
 *      要求目标术语已经在本题热词表里，否则「索引」「拉取」这类正常中文词会被改坏。
 *   3. 只有"专名形态"的词才允许大小写归一（RAG / IndexedDB / K8s / P99）；
 *      普通首字母大写的词（Raft / Docker / The）不做大小写改写，
 *      否则会把 "the" 改成 "The"、把动词 "mean" 改成 "Mean"。
 *   4. 纯中文句子不产生任何英文候选，自然零改动。
 */

/**
 * 中文音译 → 英文术语。只放少数几个高置信度词对。
 * 目标术语必须命中本题热词表才会被套用（见 applyHomophoneFixes）。
 */
const HOMOPHONE_MAP = {
  拉夫特: 'Raft',
  卡夫卡: 'Kafka',
  瑞迪斯: 'Redis',
  阿帕奇: 'Apache',
  斯普林: 'Spring',
  谷歌: 'Google',
  微软: 'Microsoft',
  亚马逊: 'Amazon',
  脸书: 'Facebook',
  推特: 'Twitter',
  图灵: 'Turing',
  迪杰斯特拉: 'Dijkstra',
};

/**
 * 常见首字母大写英文词：它们在中文面试语境里多半是普通词而不是术语，
 * 直接从热词表里剔掉，避免把 "This" / "Because" 之类的词当成专名。
 */
const COMMON_CAPS = new Set(
  (
    'A An And Are As At Be Because Been Before But By Can Could Did Do Does For From Had Has Have He ' +
    'Her Here His How I If In Into Is It Its Just Me More Most My No Not Of On One Only Or Our Out ' +
    'Over She Should Since So Some Such Than That The Their Them Then There These They This Those ' +
    'Through To Too Under Up Us Very Was We Were What When Where Which While Who Why Will With Would ' +
    'You Your All Also Any Because Between Both Each Few Other Our Out Own Same Still Yet'
  ).split(' ')
);

/** 候选里最多保留的术语数量：再多会让纠错噪声变大，收益递减 */
const MAX_LEXICON = 12;

/**
 * 英文词元切分：
 *   - 字母开头：RAG / IndexedDB / Node.js / C++ / K8s
 *   - 数字开头：单独的数字段（"P 99" 里的 99、"80" 里的 80），
 *     只用于参与"相邻窗口"的拼接，本身不会被当成术语。
 */
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[.+#][A-Za-z0-9]+)*|[0-9]+/g;

/** 只允许空格（不含换行）连接的相邻词才可能被合并判定为"拆词发音" */
const JOINABLE_GAP_RE = /^[ \t\u3000]+$/;

/**
 * 是否是"专名形态"（允许大小写归一与拆词修正）：
 *   - 全大写缩写：RAG / BFF / TTFB
 *   - 含数字：P99 / K8s / Vue3
 *   - 驼峰（内部还有大写）：IndexedDB / LiveCaptionEngine
 */
function isStrongProper(tok) {
  if (/^[A-Z]{2,}[0-9]*$/.test(tok)) return true; // RAG / BFF / TTFB
  if (/^[A-Z][0-9]+[a-z]*$/.test(tok)) return true; // K8s
  if (/^[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(tok)) return true; // IndexedDB
  if (/^[A-Z][a-z]*[0-9]+[A-Za-z]*$/.test(tok)) return true; // Vue3 / Base64
  if (/^[A-Z][A-Z0-9]*[A-Z][a-z]/.test(tok)) return true; // SQLite3
  return false;
}

/** 是否是"普通专名形态"（首字母大写的普通词，如 Raft / Docker / Kafka） */
function isLooseProper(tok) {
  return /^[A-Z][a-z]{2,}$/.test(tok) && !COMMON_CAPS.has(tok);
}

/**
 * 收集题目里所有可能承载术语的文本。
 *
 * 分成两类是有原因的：题库的 keywords 是 BM25 分词产物，形如「试A / IA / Ag /
 * ge / en / nt」的**二元切分碎片**。这些碎片会伪造出 "IA"、"PP"、"PT" 这种
 * 看起来像缩写、其实只是相邻字被切开的东西 —— 一旦当成术语，纠错就会把
 * 正常文本改成乱码。所以：
 *   - prose：自然语句（标题/语境/追问/骨架），术语必须在这里出现过才算数；
 *   - keywords：只用来补充 3 个字母以上的长词（碎片几乎不会这么长）。
 */
function collectSources(question) {
  const q = question && typeof question === 'object' ? question : {};
  const prose = [];
  const keywords = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) prose.push(v);
  };
  const pushList = (v) => {
    if (!Array.isArray(v)) return;
    v.forEach(push);
  };
  push(q.title);
  push(q.context);
  push(q.followupFocus);
  push(q.focus);
  push(q.question);
  pushList(q.skeleton);
  if (Array.isArray(q.keywords)) {
    for (const k of q.keywords) {
      if (typeof k === 'string' && k.trim()) keywords.push(k);
    }
  }
  return { prose, keywords };
}

/** 同一词的多种写法里挑一个"最规范"的写法：全大写缩写 > 驼峰 > 含数字 > 首字母大写 */
function pickCanonical(variants) {
  const counts = new Map();
  for (const v of variants) counts.set(v, (counts.get(v) || 0) + 1);
  const rank = (s) => {
    if (/^[A-Z]{2,}[0-9]*$/.test(s)) return 4; // RAG / BFF / TTFB
    if (/^[A-Z][a-z0-9]*[A-Z]/.test(s)) return 3; // IndexedDB
    if (/^[A-Z][0-9]/.test(s)) return 2; // K8s / P99
    if (/^[A-Z][a-z]{2,}$/.test(s)) return 1; // Raft
    return 0;
  };
  return [...counts.entries()].sort(
    (a, b) => rank(b[0]) - rank(a[0]) || b[1] - a[1] || b[0].length - a[0].length
  )[0][0];
}

/**
 * 从题目里抽取领域专有名词（英文缩写 / 驼峰 / 中英混排里的英文部分）。
 *
 * 判为专名的条件：
 *   - 专名形态：缩写、含数字、驼峰 → 强候选，允许大小写归一；
 *   - 首字母大写的普通词（Raft / Kafka）→ 弱候选，只在同一词没有以纯小写
 *     形式出现过时才保留（否则 mean / react 这类同形歧义会被误改）；
 *   - 常见英文词（This / Because）直接剔除。
 *
 * @param {object} question 题目对象（keywords / title / context / skeleton / followupFocus 等）
 * @returns {string[]} 最多 12 个术语
 */
export function buildDomainLexicon(question) {
  const { prose, keywords } = collectSources(question);
  if (!prose.length && !keywords.length) return [];

  /** key（小写） → { variants: string[], count, strong, inProse } */
  const map = new Map();
  /** 出现过的纯小写单词 key（小写形态与专名同形时视为歧义） */
  const lowerOnly = new Set();

  const scan = (src, isProse) => {
    LATIN_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = LATIN_TOKEN_RE.exec(src)) !== null) {
      const tok = m[0];
      if (/^[0-9]+$/.test(tok)) continue; // 纯数字不是术语
      const key = tok.toLowerCase();
      if (isStrongProper(tok)) {
        const prev = map.get(key);
        if (prev) {
          prev.variants.push(tok);
          prev.count += 1;
          prev.strong = true;
          if (isProse) prev.inProse = true;
        } else {
          map.set(key, { variants: [tok], count: 1, strong: true, inProse: !!isProse });
        }
      } else if (isLooseProper(tok)) {
        const prev = map.get(key);
        if (prev) {
          prev.variants.push(tok);
          prev.count += 1;
          if (isProse) prev.inProse = true;
        } else {
          map.set(key, { variants: [tok], count: 1, strong: false, inProse: !!isProse });
        }
      } else if (/^[a-z]{3,}$/.test(tok)) {
        lowerOnly.add(key);
      }
    }
  };

  for (const src of prose) scan(src, true);
  for (const src of keywords) scan(src, false);

  const candidates = [];
  for (const [key, info] of map) {
    // 同形歧义（既见过专名形态又见过纯小写）→ 放弃，宁可漏改
    if (!info.strong && lowerOnly.has(key)) continue;
    const canonical = pickCanonical(info.variants);
    // 弱候选还要求：原写法确实是首字母大写（避免把句子开头的 "This" 收进来）
    if (!info.strong && !/^[A-Z][a-z]{2,}$/.test(canonical)) continue;
    // 碎片防线：短词（≤2 字母）必须出现在自然语句里才收，
    // 否则 "IA"/"PP"/"PT" 这类 BM25 切分碎片会混进热词表
    if (canonical.length <= 2 && !info.inProse) continue;
    candidates.push({
      term: canonical,
      key,
      strong: info.strong,
      score: info.count + (info.strong ? 1 : 0) + (info.inProse ? 0.5 : 0),
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.term.length - a.term.length || a.term.localeCompare(b.term));
  return candidates.slice(0, MAX_LEXICON).map((c) => c.term);
}

/** 术语归一：去重 + 折叠（去掉空格与符号）后的比较用形式 */
function normalizeLexicon(lexicon) {
  const list = Array.isArray(lexicon) ? lexicon : lexicon ? [lexicon] : [];
  const seen = new Map();
  for (const raw of list) {
    const term = String(raw || '').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      canonical: term,
      lower: key,
      collapsed: term.toLowerCase().replace(/[^a-z0-9]/g, ''),
      strong: isStrongProper(term),
    });
  }
  return [...seen.values()];
}

/** 只保留字母数字的折叠串（用于比较发音/拆词是否一致） */
function collapse(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 取数字序列：用于避免"8 IndexedDB"这种把数字吞掉的错误替换 */
function digitSeq(s) {
  return (String(s || '').match(/[0-9]/g) || []).join('');
}

/**
 * 最长公共子序列长度（滚动数组）。
 * 用于判断"识别结果是不是术语的删字版"：发音时丢掉一个音节，
 * 转写出来就会少一两个字母（IndexedDB → "in dex db" → "indexdb"）。
 */
function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(cur[j - 1], prev[j]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 判断"识别结果"能否通过删掉若干音节得到"术语"。
 *
 * 成立的充要条件：
 *   1. 识别结果是术语的**子序列**（顺序一致，只是少了字母），
 *      而不是随便一个相似的词 —— 这一条把 "indexdb"→"IndexedDB" 认出来，
 *      同时把 "database"→"IndexedDB" 挡住（顺序对不上）；
 *   2. 丢掉的字母不超过 2 个，且占比不超过术语长度的 1/3 —— 丢太多就可能是另一个词；
 *   3. 数字序列完全一致 —— 防止把 "P99" 认成别的词。
 *
 * 只有 5 个字母以上的长术语才走这条路：短词（"RAG"）容错空间太小，宁可不动。
 */
function canDropSyllable(found, term) {
  if (!found || !term) return false;
  if (term.length < 5 || found.length < 4) return false;
  if (found.length >= term.length) return false;
  if (term.length - found.length > 2) return false;
  if ((term.length - found.length) / term.length > 1 / 3) return false;
  if (digitSeq(found) !== digitSeq(term)) return false;
  return lcsLength(found, term) === found.length;
}

/**
 * 形近 / 拆词修正：
 *   "B FF"      → "BFF"      （发音把一个缩写拆成两段）
 *   "in dex db" → "IndexedDB"（长词按音节拆开）
 *   "rag"       → "RAG"      （大小写不规范）
 *
 * 保守边界（为什么这么分两类）：
 *   - **专名形态**的词（RAG / IndexedDB / P99 / K8s）形态独特，改错了概率极低，
 *     所以允许：大小写归一、拆词合并、吞音节删字；
 *   - **普通专名**的词（Raft / Kafka / Docker）本身就是常见英文单词
 *     （"raft" 是筏子、"note" 是笔记），单独出现时**不动**，
 *     只有被拆成多段（"ra ft"）才纠正 —— 逐字母拼读本身就是强证据，
 *     不可能是另一个词被误拆。
 */
function applyLatinFixes(src, terms, changes) {
  const usable = terms.filter((t) => t.collapsed);
  if (!usable.length) return src;

  const tokens = [];
  LATIN_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = LATIN_TOKEN_RE.exec(src)) !== null) {
    tokens.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (!tokens.length) return src;

  const used = new Set();
  const matches = [];

  for (let i = 0; i < tokens.length; i += 1) {
    if (used.has(i)) continue;
    let best = null;
    for (let w = 1; w <= 4 && i + w <= tokens.length; w += 1) {
      // 窗口内的词必须空格相邻且未被占用
      let ok = true;
      for (let k = i; k < i + w; k += 1) {
        if (used.has(k)) { ok = false; break; }
        if (k > i) {
          const gap = src.slice(tokens[k - 1].end, tokens[k].start);
          if (!JOINABLE_GAP_RE.test(gap)) { ok = false; break; }
        }
      }
      if (!ok) break; // 再往外扩展只会更不可能相邻

      const joined = tokens.slice(i, i + w).map((t) => t.raw).join('');
      const joinedCollapsed = collapse(joined);
      if (!joinedCollapsed) continue;

      for (const term of usable) {
        let score = 0;
        if (joinedCollapsed === term.collapsed) {
          if (term.strong) {
            // 完全一致：只是空格/大小写不同（"B FF" → "BFF"、"rag" → "RAG"）
            score = 1000 + term.collapsed.length;
          } else if (w >= 2) {
            // 普通专名只在"逐字母拼读"时纠正（"ra ft" → "Raft"）
            score = 900 + term.collapsed.length;
          }
        } else if (term.strong && canDropSyllable(joinedCollapsed, term.collapsed)) {
          // 删字版：发音时吞掉一个音节（"in dex db" → "indexdb" → "IndexedDB"）
          score = 800 + term.collapsed.length;
        }
        if (!score) continue;
        if (!best || score > best.score || (score === best.score && w > best.w)) {
          best = { score, w, term, joined, start: tokens[i].start, end: tokens[i + w - 1].end };
        }
      }
      if (best && best.score >= 1000) break; // 已经精确命中，不必再扩窗口
    }

    if (!best) continue;
    for (let k = i; k < i + best.w; k += 1) used.add(k);

    const original = src.slice(best.start, best.end);
    if (original === best.term.canonical) continue; // 本来就对，不产生噪声
    matches.push({ ...best, original });
  }

  if (!matches.length) return src;

  // 从后往前替换，避免前面的替换让后面的下标失效
  let out = src;
  for (let k = matches.length - 1; k >= 0; k -= 1) {
    const mt = matches[k];
    out = out.slice(0, mt.start) + mt.term.canonical + out.slice(mt.end);
    const onlyCase = mt.original.toLowerCase() === mt.term.canonical.toLowerCase();
    changes.unshift({
      from: mt.original,
      to: mt.term.canonical,
      reason: onlyCase
        ? `按热词表统一大小写：${mt.term.canonical}`
        : `按热词表修正发音拆词/形近误写：${mt.original} → ${mt.term.canonical}`,
    });
  }
  return out;
}

/**
 * 中文音译 → 英文术语。只有当目标术语确实在本题热词表里时才替换，
 * 避免把「索引」「拉取」这类正常中文词错换成英文。
 */
function applyHomophoneFixes(src, terms, changes) {
  if (!terms.length) return src;
  const known = new Map(terms.map((t) => [t.lower, t.canonical]));
  let out = src;

  const entries = Object.entries(HOMOPHONE_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [zh, en] of entries) {
    const canonical = known.get(en.toLowerCase());
    if (!canonical) continue; // 本题不涉及这个术语，别乱动
    if (!out.includes(zh)) continue;
    let guard = 0;
    while (out.includes(zh) && guard < 50) {
      const idx = out.indexOf(zh);
      out = out.slice(0, idx) + canonical + out.slice(idx + zh.length);
      changes.push({
        from: zh,
        to: canonical,
        reason: `中文音译误写，按本题热词表改为「${canonical}」`,
      });
      guard += 1;
    }
  }
  return out;
}

/**
 * 保守纠错主入口。
 *
 * @param {string} text 原始转写文本
 * @param {string[]} lexicon 领域术语表（一般来自 buildDomainLexicon）
 * @returns {{ text: string, changes: Array<{from:string,to:string,reason:string}> }}
 */
export function correctTranscript(text, lexicon = []) {
  const src = String(text ?? '');
  if (!src.trim()) return { text: src, changes: [] };
  const terms = normalizeLexicon(lexicon);
  if (!terms.length) return { text: src, changes: [] };

  const changes = [];
  let out = applyLatinFixes(src, terms, changes);
  out = applyHomophoneFixes(out, terms, changes);
  return { text: out, changes };
}

/**
 * 接收用户手工编辑后的修正并返回最终文本。
 *
 * fixes 支持：
 *   - null/undefined：原样返回（用户没改）
 *   - string：整段替换（编辑器整体取值）
 *   - {from,to} / {search,replace} / {old,new}：逐条替换，每条只替换第一处
 *   - 上述对象的数组
 */
export function applyManualFixes(text, fixes) {
  const base = String(text ?? '');
  if (fixes === null || fixes === undefined) return base;
  if (typeof fixes === 'string') return fixes;

  const list = Array.isArray(fixes) ? fixes : [fixes];
  let out = base;
  for (const f of list) {
    if (f === null || f === undefined) continue;
    if (typeof f === 'string') {
      out = f;
      continue;
    }
    const from = f.from ?? f.search ?? f.old ?? '';
    const to = f.to ?? f.replace ?? f.new ?? '';
    if (!from) continue;
    // 只替换第一处：用户手工指定的一处误写不该被全局放大
    out = out.replace(from, () => to);
  }
  return out;
}
