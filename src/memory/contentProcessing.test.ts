import { describe, expect, it } from 'vitest';
import { fitPrequelIndexesToBudget } from './prequel';
import { stripConfiguredTagBlocks } from './tagSanitizer';

describe('memory content processing', () => {
  it('正确删除同名嵌套块但保留其它契约标签', () => {
    const source = '<bbs_start>T</bbs_start><noise>甲<noise>乙</noise>丙</noise>正文<bbs_end>U</bbs_end>';
    expect(stripConfiguredTagBlocks(source, ['noise'])).toBe(
      '<bbs_start>T</bbs_start>正文<bbs_end>U</bbs_end>',
    );
  });

  it('落单开标签只删外壳，不吞掉后续正文', () => {
    expect(stripConfiguredTagBlocks('前文<noise>仍是正文', ['noise'])).toBe('前文仍是正文');
  });

  it('前情按候选优先级装入预算并恢复原文顺序', () => {
    const chunks = ['第一段短文', '第二段也不长', '第三段'];
    expect(fitPrequelIndexesToBudget(chunks, [2, 0, 1], 80)).toEqual([0, 1, 2]);
    expect(fitPrequelIndexesToBudget(chunks, [1, 0, 2], 20)).toEqual([1]);
  });
});
