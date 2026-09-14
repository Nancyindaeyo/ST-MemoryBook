/**
 * 精确引文:口令、数字、日期、誓约等必须逐字保留的原句。
 * 挂在叶子上,不进重放账本。零 value import,供独立回归测试。
 */

export interface ExactQuote {
  text: string;
  why?: string;
}

export const QUOTE_LIMIT = 6;
const TEXT_MAX = 80;
const WHY_MAX = 40;

function oneLine(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compact(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
}

/** 原句必须能在本楼正文里找到,防止模型改写或编造。 */
export function quoteInSource(quote: string, source: string): boolean {
  const q = oneLine(quote, TEXT_MAX);
  if (q.length < 2) return false;
  const src = String(source ?? '');
  if (src.includes(q)) return true;
  const cq = compact(q);
  const cs = compact(src);
  return cq.length >= 2 && cs.includes(cq);
}

export function cleanExactQuotes(raw: unknown, sourceText: string): ExactQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: ExactQuote[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= QUOTE_LIMIT) break;
    const text = typeof item === 'string' ? oneLine(item, TEXT_MAX) : oneLine((item as { text?: unknown })?.text, TEXT_MAX);
    if (text.length < 2 || seen.has(text) || !quoteInSource(text, sourceText)) continue;
    seen.add(text);
    const why = typeof item === 'object' && item ? oneLine((item as { why?: unknown }).why, WHY_MAX) : '';
    out.push(why ? { text, why } : { text });
  }
  return out;
}

export function fmtExactQuotes(quotes: ExactQuote[]): string {
  if (!quotes.length) return '';
  return quotes
    .map(q => `  - 原句「${q.text}」${q.why ? `（${q.why}）` : ''}`)
    .join('\n');
}

export function collectHiddenQuotes(
  leaves: Array<{ quotes?: ExactQuote[]; active?: boolean; stale?: boolean; msgIndex?: number }>,
  max = 8,
): ExactQuote[] {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 8;
  const sorted = [...leaves]
    .filter(l => !l.stale && l.active && l.quotes?.length)
    .sort((a, b) => (b.msgIndex ?? 0) - (a.msgIndex ?? 0));
  const out: ExactQuote[] = [];
  const seen = new Set<string>();
  for (const leaf of sorted) {
    for (const q of leaf.quotes ?? []) {
      if (out.length >= cap) return out;
      if (!q.text || seen.has(q.text)) continue;
      seen.add(q.text);
      out.push(q);
    }
  }
  return out;
}
