import { describe, expect, it } from 'vitest';
import { clipTextToTokenBudget, estimateUtf8Tokens } from './injectBudget';

describe('clipTextToTokenBudget', () => {
  it('returns the original text when it already fits', () => {
    expect(clipTextToTokenBudget('短状态', 100, '\n截断')).toBe('短状态');
  });

  it('hard-clips oversized text so the result stays within the budget', () => {
    const body = '当前状态:'.padEnd(400, '甲');
    const suffix = '\n(状态已按预算截断)\n';
    const clipped = clipTextToTokenBudget(body, 40, suffix);
    expect(estimateUtf8Tokens(clipped)).toBeLessThanOrEqual(40);
    expect(clipped.endsWith(suffix)).toBe(true);
    expect(clipped.length).toBeLessThan(body.length + suffix.length);
  });
});
