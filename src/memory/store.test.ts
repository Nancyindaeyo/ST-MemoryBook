import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ context: null as any }));

vi.mock('@/st/context', () => ({
  getContext: () => host.context,
  setMessageText: vi.fn(),
}));
vi.mock('./engine', () => ({
  isAiFloor: (message: any) => !!message && !message.is_user && !!message.mes && !message.extra?.type,
  pendingAiFloors: () => [],
}));

function ai(extra: Record<string, unknown> = {}) {
  return { name: '角色', is_user: false, is_system: false, mes: '正文', extra };
}

beforeEach(() => {
  vi.resetModules();
  host.context = null;
});

afterEach(() => {
  const cleanup = (globalThis as any).__bbs_memory_lifecycle_cleanup__;
  if (typeof cleanup === 'function') cleanup();
});

describe('memory store safety', () => {
  it('迁移 orphan 无可用落点时不部分写入并保留重试机会', async () => {
    const { migrateV2toV3 } = await import('./store');
    const occupied = ai({ bbs_leaf: { id: 'existing', text: '已有', delta: {}, createdAt: 1, v: 1 } });
    const raw = {
      version: 2,
      summaries: [
        { id: 'old-a', level: 0, text: '旧摘要', floorStart: 0, floorEnd: 0, delta: { location: '旧地点' } },
      ],
    };
    expect(() => migrateV2toV3(raw, [occupied] as any)).toThrow(/无法挂靠/);
    expect((occupied.extra as any).bbs_leaf.id).toBe('existing');
  });

  it('立即 flush 会取消防抖并只保存一次', async () => {
    const saveChat = vi.fn(async () => undefined);
    host.context = { saveChat };
    const { flushLeavesNow, scheduleLeafFlush } = await import('./store');
    scheduleLeafFlush();
    await flushLeavesNow();
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it('重复绑定会先卸载上一组聊天监听', async () => {
    const on = vi.fn();
    const off = vi.fn();
    host.context = {
      chat: [],
      chatMetadata: {},
      name1: '玩家',
      name2: '角色',
      getCurrentChatId: () => 'chat-a',
      eventSource: { on, off },
      eventTypes: { CHAT_CHANGED: 'chat-changed', PERSONA_CHANGED: 'persona-changed' },
      saveChat: vi.fn(async () => undefined),
      saveMetadataDebounced: vi.fn(),
    };
    const { bindChatLifecycle } = await import('./store');
    bindChatLifecycle();
    bindChatLifecycle();
    expect(off).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledTimes(4);
  });
});
