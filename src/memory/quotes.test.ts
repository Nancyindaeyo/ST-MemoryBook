import { describe, expect, it } from 'vitest';
import { cleanExactQuotes, quoteInSource } from './quotes';

describe('exact quotes', () => {
  it('accepts a verbatim substring from the source floor', () => {
    expect(quoteInSource('今夜口令是赤鸢', '卫兵低声说:今夜口令是赤鸢。')).toBe(true);
    expect(cleanExactQuotes([{ text: '今夜口令是赤鸢', why: '口令' }], '卫兵低声说:今夜口令是赤鸢。')).toEqual([
      { text: '今夜口令是赤鸢', why: '口令' },
    ]);
  });

  it('rejects tag-wrapped fabrications that would match after stripping tags', () => {
    expect(quoteInSource('<fake>今夜口令是赤鸢', '卫兵低声说:今夜口令是赤鸢。')).toBe(false);
    expect(cleanExactQuotes(['<fake>今夜口令是赤鸢'], '卫兵低声说:今夜口令是赤鸢。')).toEqual([]);
  });

  it('still matches across extra whitespace', () => {
    expect(quoteInSource('今夜口令是赤鸢', '今夜口令是\n赤鸢')).toBe(true);
  });
});
