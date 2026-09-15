import { describe, expect, it } from 'vitest';
import { filterSummaryFeedIndices } from './summaryFeed';

describe('filterSummaryFeedIndices', () => {
  const chat = [
    { is_user: true, mes: '玩家行动' },
    { is_user: false, is_system: false, mes: '角色回复' },
    { is_user: false, is_system: true, extra: { type: 'narrator' }, mes: '旁白' },
    { is_user: false, is_system: true, extra: { bbs_hidden: true }, mes: '已隐藏的旧回复' },
  ];

  it('keeps the original window when summarizing everyone', () => {
    expect(filterSummaryFeedIndices(chat, [0, 1, 2, 3], false)).toEqual([0, 1, 2, 3]);
  });

  it('drops user and narrator floors when summarizing AI output only', () => {
    expect(filterSummaryFeedIndices(chat, [0, 1, 2, 3], true)).toEqual([1, 3]);
  });
});
