/**
 * 前情原文:粘贴进 chatMetadata 的旧剧情长文,不进森林、不覆盖楼层。
 * 本文件零 value import,供独立回归测试直接 transpile。
 */

export interface LeafCatalogItem {
  id: string;
  text: string;
  time?: string;
  floor?: number;
}

const DEFAULT_CHUNK = 420;
export const CATALOG_PREVIEW_CHARS = 96;

function clampInt(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** 按空行切段,超长段再硬切,供关键词抽段 / LLM 选题。 */
export function splitPrequelChunks(text: string, maxChars = DEFAULT_CHUNK): string[] {
  const cap = clampInt(maxChars, 80, 2000, DEFAULT_CHUNK);
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];
  const paras = src.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= cap) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += cap) {
      const piece = p.slice(i, i + cap).trim();
      if (piece) out.push(piece);
    }
  }
  return out.filter(Boolean);
}

function tokenize(haystack: string): string[] {
  const s = String(haystack ?? '');
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  // 滑动二字,避免「小红推门进来」整块对不上「小红推门」
  for (let i = 0; i < s.length - 1; i++) {
    if (/[\u4e00-\u9fff]/.test(s[i]) && /[\u4e00-\u9fff]/.test(s[i + 1])) add(s.slice(i, i + 2));
  }
  for (const w of s.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) add(w.toLowerCase());
  return out.slice(0, 80);
}

/** 按与近况文本的词重叠给前情分段打分,返回得分最高的下标(最多 max 条,保序)。 */
export function pickPrequelByKeywords(chunks: string[], haystack: string, max: number): number[] {
  const limit = clampInt(max, 1, 12, 3);
  const tokens = tokenize(haystack);
  if (!chunks.length || !tokens.length) return [];
  const scored = chunks.map((chunk, index) => {
    const hay = chunk.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t.toLowerCase())) score += t.length >= 4 ? 2 : 1;
    }
    return { index, score };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map(x => x.index).sort((a, b) => a - b);
}

/** 保守估算中英文混排 token，供前情选段在真正注入前执行硬预算。 */
export function estimatePrequelTokens(text: string): number {
  let cjk = 0;
  for (const char of String(text ?? '')) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) cjk++;
  }
  const other = Math.max(0, String(text ?? '').length - cjk);
  return Math.ceil((cjk * 1.35 + other * 0.45 + 8) * 1.15);
}

/**
 * 按候选优先级装入预算，再恢复原文顺序。单段超预算时跳过，避免一段长前情挤掉其余命中。
 */
export function fitPrequelIndexesToBudget(chunks: string[], indexes: number[], maxTokens: number): number[] {
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!budget) return [];
  const selected: number[] = [];
  const seen = new Set<number>();
  let used = 0;
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= chunks.length || seen.has(index)) continue;
    const cost = estimatePrequelTokens(chunks[index]);
    if (used + cost > budget) continue;
    seen.add(index);
    selected.push(index);
    used += cost;
  }
  return selected.sort((a, b) => a - b);
}

/**
 * 读模型返回的编号数组。提示词约定 1-based;若看起来全是 0-based 再兼容一次。
 * 返回去重后的 0-based 下标。
 */
export function parseOneBasedIndexes(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw) || max <= 0) return [];
  const nums: number[] = [];
  for (const x of raw) {
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    if (!Number.isInteger(n)) continue;
    nums.push(n);
  }
  if (!nums.length) return [];
  const looksZeroBased = nums.every(n => n >= 0 && n < max) && nums.some(n => n === 0);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of nums) {
    const idx = looksZeroBased ? n : n - 1;
    if (idx < 0 || idx >= max || seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out;
}

export function buildLeafCatalog(
  leaves: Array<{ id: string; text: string; msgIndex: number; stale?: boolean; timeStart?: string; timeLabel?: string; quotes?: { text: string }[] }>,
  excludeIds: Set<string>,
  max = 40,
): LeafCatalogItem[] {
  const cap = clampInt(max, 4, 80, 40);
  const items: LeafCatalogItem[] = [];
  const seen = new Set<string>();
  const sorted = [...leaves].sort((a, b) => b.msgIndex - a.msgIndex);
  for (const leaf of sorted) {
    if (leaf.stale || excludeIds.has(leaf.id) || seen.has(leaf.id)) continue;
    const quoteBit = (leaf.quotes ?? []).map(q => q.text).filter(Boolean).join(' ');
    const text = [leaf.text, quoteBit].join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    seen.add(leaf.id);
    items.push({
      id: leaf.id,
      // 目录全文留给注入;选题提示词另行截预览,避免 96 字预览把召回正文裁掉。
      text,
      time: leaf.timeStart || leaf.timeLabel,
      floor: leaf.msgIndex,
    });
    if (items.length >= cap) break;
  }
  return items;
}
