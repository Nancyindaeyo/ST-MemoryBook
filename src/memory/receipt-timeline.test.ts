import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { formatDiagnostic, noteDrops, noteFailure, sanitizeDiagnosticMessage } from './diagnostic';
import { ApiError } from '@/api/client';
import { groupPlans, publicStoryDate } from './planTimeline';
import { readRecallReceipt, userTextHash } from './recallReceipt';
import type { STMessage } from '@/st/context';
import { recallTurn } from './vector/recall';
import type { MemPlan } from './types';

function plan(partial: Partial<MemPlan> & Pick<MemPlan, 'id' | 'content'>): MemPlan {
  return {
    kind: 'plan',
    status: 'open',
    createdAt: 1,
    ...partial,
  };
}

describe('召回回执', () => {
  it('续写、重生、翻页复用,安静生成跳过', () => {
    expect(recallTurn('continue')).toBe('reuse');
    expect(recallTurn('regenerate')).toBe('reuse');
    expect(recallTurn('swipe')).toBe('reuse');
    expect(recallTurn('normal')).toBe('fresh');
    expect(recallTurn('quiet')).toBe('skip');
  });

  it('用户消息改过之后,旧回执不再命中', () => {
    const message = {
      is_user: true,
      mes: '去城西',
      extra: {
        bbs_recall: {
          v: 1 as const,
          userHash: userTextHash('去城西'),
          vectorText: '旧记忆',
          pickText: '',
          lines: [{ source: '#2', preview: '城门' }],
        },
      },
    } as STMessage;
    expect(readRecallReceipt(message)?.vectorText).toBe('旧记忆');
    message.mes = '改去城东';
    expect(readRecallReceipt(message)).toBeNull();
  });
});

describe('坏字段只记类别', () => {
  it('留下合法物品,并记下丢掉的条数', () => {
    const notes: string[] = [];
    const stored = finalizeDelta({
      summary: '拿到一把剑。',
      items: { add: [{ name: '' }, { name: '剑', desc: '旧' }] },
    }, [], [], notes);
    expect(stored.items?.add?.map(item => item.name)).toEqual(['剑']);
    expect(notes).toEqual(['物品新增 1 条']);
  });
});

describe('安全诊断', () => {
  it('去掉地址和密钥', () => {
    noteFailure({
      stage: '摘要',
      error: new ApiError('副 API 请求失败 (524): https://example.com/v1 Bearer sk-abcdefghi', 524),
      retries: 1,
      stream: false,
      prefill: false,
    });
    noteDrops(['物品新增 1 条']);
    const text = formatDiagnostic();
    expect(text).toContain('阶段: 摘要');
    expect(text).toContain('HTTP: 524');
    expect(text).toContain('流式: 关');
    expect(text).toContain('丢掉: 物品新增 1 条');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('sk-');
    expect(sanitizeDiagnosticMessage('see https://secret.example/a')).toBe('see [地址]');
  });
});

describe('计划时间线', () => {
  it('同一天归在一起,模糊时间进时间不明', () => {
    const groups = groupPlans([
      plan({ id: 'a', content: '赴宴', targetTime: '2024/8/31 夜', createdAt: 2 }),
      plan({ id: 'b', content: '再议', targetTime: '2024年8月31日', createdAt: 1 }),
      plan({ id: 'c', content: '以后再说', targetTime: '以后' }),
    ]);
    expect(groups[0].label).toBe('2024-8-31');
    expect(groups[0].items.map(item => item.id).sort()).toEqual(['a', 'b']);
    expect(groups.at(-1)?.label).toBe('时间不明');
    expect(publicStoryDate('2024/8/31')).toEqual({ year: 2024, month: 8, day: 31 });
    expect(publicStoryDate('以后')).toBeNull();
  });
});
