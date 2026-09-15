/**
 * 从 LLM 文本输出里健壮地提取 JSON 对象。
 * 应对:```json 围栏、思维链前后缀、智能引号、尾随逗号。
 * 整段能解析才返回:一个字段坏就整段失败,由调用方重试整楼。
 */

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
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

  // 未闭合的检查块通常是输出被截断，不能把其中半成品 JSON 当最终结果。
  if (/^<think(?:ing)?\b/i.test(s) && !/<\/think(?:ing)?>/i.test(s)) return '';

  // 去掉 <think>…</think> / <thinking>…</thinking> 思维链(大小写不敏感)
  s = s.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // 前面可能已有一个完整检查块，后面又开启了被截断的新块。
  if (/<think(?:ing)?\b/i.test(s)) return '';

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

export function extractJsonObject<T = unknown>(raw: string): T | null {
  const body = prepareJsonBody(raw);
  if (!body) return null;
  return parseJsonObjectStrict<T>(body);
}
