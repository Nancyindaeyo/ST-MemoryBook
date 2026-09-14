/**
 * 从 LLM 文本输出里健壮地提取 JSON 对象。
 * 应对:```json 围栏、思维链前后缀、智能引号、尾随逗号。
 *
 * extractJsonObject:整段能解析才返回,一个字段坏就整段失败。
 * extractJsonObjectLoose:整段失败时按顶层字段隔离抢救——坏数组/坏对象丢掉,
 * 旁边的 summary / time 等合法字段仍写入。
 */

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function tryParseUnknown(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function tidyJson(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * 补转义:把「字符串值内部未转义的双引号」补成 \"。仅在直接/清洗解析都失败后作兜底。
 * 逐字符扫描并跟踪是否在字符串内:字符串内遇到 " 时,向后看第一个非空白字符——只有它是
 * 结构符(: , } ] 或结尾)时才当作结束引号,否则判为正文里的野引号并补成 \"。
 * 对本就合法的 JSON 是恒等变换(合法 JSON 的字符串内不存在未转义的 "),故绝不会把能解析的弄坏;
 * 遇到真正歧义(野引号紧贴 ASCII 逗号)时会解析失败落到重试,不会静默截断成错数据。
 */
function escapeStrayQuotes(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      // 保留转义对(\" \\ \n 等)整体原样搬过去,不误判其中的引号
      out += c;
      if (i + 1 < s.length) { out += s[i + 1]; i++; }
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
        out += c;        // 结束引号
        inString = false;
      } else {
        out += '\\"';    // 正文野引号 -> 补转义
      }
      continue;
    }
    out += c;
  }
  return out;
}

function stripThinkAndFence(raw: string): string {
  let s = raw.trim();

  // 去掉 <think>…</think> / <thinking>…</thinking> 思维链(大小写不敏感)
  s = s.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // assistant prefill 场景下,返回可能只包含续写的思维链正文 + </thinking> + JSON,
  // 没有开头 <thinking>。此时丢弃最后一个闭合标签及其之前的全部文本。
  const danglingThinkClose = s.match(/<\/think(?:ing)?>/gi);
  if (danglingThinkClose) {
    const lastClose = Math.max(
      s.toLowerCase().lastIndexOf('</think>'),
      s.toLowerCase().lastIndexOf('</thinking>'),
    );
    if (lastClose >= 0) {
      const close = s.slice(lastClose).match(/^<\/think(?:ing)?>/i)?.[0] ?? '';
      s = s.slice(lastClose + close.length).trim();
    }
  }

  // 去掉 ```json ... ``` / ``` ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

function prepareJsonBody(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = stripThinkAndFence(raw);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function parseJsonObjectStrict<T>(body: string): T | null {
  const direct = tryParse<T>(body);
  if (direct !== null) return direct;

  const cleaned = tidyJson(body);
  const cleanedParsed = tryParse<T>(cleaned);
  if (cleanedParsed !== null) return cleanedParsed;

  const repaired = tryParse<T>(escapeStrayQuotes(body));
  if (repaired !== null) return repaired;
  return tryParse<T>(escapeStrayQuotes(cleaned));
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 从 start 起切出一段 JSON 值原文(字符串 / 对象 / 数组 / 原子)。不平衡则返回 null。 */
function extractJsonValue(s: string, start: number): { raw: string; end: number } | null {
  const i = skipWs(s, start);
  if (i >= s.length) return null;
  const c = s[i];

  if (c === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '"') return { raw: s.slice(i, j + 1), end: j + 1 };
      j++;
    }
    return null;
  }

  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (ch === '\\') { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return { raw: s.slice(i, j + 1), end: j + 1 };
      }
    }
    return null;
  }

  let j = i;
  while (j < s.length && !/[,}\]]/.test(s[j])) j++;
  const raw = s.slice(i, j).trim();
  return raw ? { raw, end: j } : null;
}

function salvageAny(raw: string): unknown | undefined {
  const candidates = [raw, tidyJson(raw), escapeStrayQuotes(raw), escapeStrayQuotes(tidyJson(raw))];
  for (const c of candidates) {
    const parsed = tryParseUnknown(c);
    if (parsed.ok) return parsed.value;
  }
  const t = tidyJson(raw).trim();
  if (t.startsWith('{')) {
    const obj = salvageTopLevelObject(t);
    if (obj) return obj;
  }
  if (t.startsWith('[')) {
    const arr = salvageArray(t);
    if (arr) return arr;
  }
  return undefined;
}

function salvageArray(body: string): unknown[] | null {
  const s = tidyJson(body).trim();
  if (!s.startsWith('[')) return null;
  const out: unknown[] = [];
  let i = 1;
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length || s[i] === ']') break;
    const ev = extractJsonValue(s, i);
    if (!ev) break;
    const v = salvageAny(ev.raw);
    if (v !== undefined) out.push(v);
    i = skipWs(s, ev.end);
    if (s[i] === ',') i++;
  }
  return out;
}

function salvageTopLevelObject(body: string): Record<string, unknown> | null {
  const s = tidyJson(body).trim();
  if (!s.startsWith('{')) return null;
  const out: Record<string, unknown> = {};
  let i = 1;
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length || s[i] === '}') break;
    const keyTok = extractJsonValue(s, i);
    if (!keyTok) break;
    const keyParsed = tryParseUnknown(keyTok.raw);
    if (!keyParsed.ok || typeof keyParsed.value !== 'string') break;
    i = skipWs(s, keyTok.end);
    if (s[i] !== ':') break;
    i++;
    const valTok = extractJsonValue(s, i);
    if (!valTok) break;
    const v = salvageAny(valTok.raw);
    if (v !== undefined) out[keyParsed.value] = v;
    i = skipWs(s, valTok.end);
    if (s[i] === ',') i++;
  }
  return Object.keys(out).length ? out : null;
}

export function extractJsonObject<T = unknown>(raw: string): T | null {
  const body = prepareJsonBody(raw);
  if (!body) return null;
  return parseJsonObjectStrict<T>(body);
}

/**
 * 先走严格提取;整段 JSON 坏掉时按字段隔离抢救。
 * 坏掉的数组/对象被丢掉,旁边能解析的字段仍返回。没有任何字段则 null。
 */
export function extractJsonObjectLoose<T = unknown>(raw: string): T | null {
  const body = prepareJsonBody(raw);
  if (!body) return null;
  const strict = parseJsonObjectStrict<T>(body);
  if (strict !== null) return strict;
  return salvageTopLevelObject(body) as T | null;
}
