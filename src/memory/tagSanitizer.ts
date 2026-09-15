const TAG_TOKEN = /<(\/?)\s*([\p{L}][\p{L}\p{N}_-]*)(?:\s[^>]*)?(\/?)>/giu;

interface OpenTag {
  name: string;
  start: number;
  tokenEnd: number;
}

interface Span {
  start: number;
  end: number;
}

/** 删除指定标签的完整配对块；落单标签只删标签本身，不误删后续正文。 */
export function stripConfiguredTagBlocks(raw: string, configuredTags: readonly string[]): string {
  const source = String(raw ?? '');
  const configured = new Set(configuredTags.map(tag => tag.toLocaleLowerCase()).filter(Boolean));
  if (!source || !configured.size) return source;

  const stack: OpenTag[] = [];
  const spans: Span[] = [];
  for (const match of source.matchAll(TAG_TOKEN)) {
    const name = match[2].toLocaleLowerCase();
    if (!configured.has(name) || match.index === undefined) continue;
    const token = { start: match.index, end: match.index + match[0].length };
    const closing = match[1] === '/';
    const selfClosing = match[3] === '/';
    if (selfClosing) {
      spans.push(token);
      continue;
    }
    if (!closing) {
      stack.push({ name, start: token.start, tokenEnd: token.end });
      continue;
    }
    let openIndex = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) {
        openIndex = i;
        break;
      }
    }
    if (openIndex < 0) {
      spans.push(token);
      continue;
    }
    spans.push({ start: stack[openIndex].start, end: token.end });
    stack.length = openIndex;
  }

  // 未闭合开标签与旧行为一致：只去标签外壳，正文继续保留。
  for (const open of stack) spans.push({ start: open.start, end: open.tokenEnd });
  if (!spans.length) return source;

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }

  let cursor = 0;
  let output = '';
  for (const span of merged) {
    output += source.slice(cursor, span.start);
    cursor = span.end;
  }
  return output + source.slice(cursor);
}
