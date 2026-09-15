import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ context: null as any }));

vi.mock('@/st/context', () => ({
  getContext: () => host.context,
}));

beforeEach(() => {
  vi.resetModules();
  const chat: unknown[] = [];
  host.context = {
    chat,
    name1: '玩家',
    name2: '角色',
    characterId: 0,
    characters: [{ avatar: 'char.png' }],
    getCurrentChatId: () => 'chat-a',
  };
});

describe('memory session guard', () => {
  it('内存镜像未完成当前聊天载入时不允许任务提交', async () => {
    const { beginMemorySessionOperation } = await import('./session');
    const operation = beginMemorySessionOperation();
    expect(operation.signal.aborted).toBe(true);
    expect(operation.isCurrent()).toBe(false);
  });

  it('聊天引用变化后拒绝旧任务提交', async () => {
    const { beginMemorySessionOperation, markMemorySessionLoaded, StaleMemorySessionError } = await import('./session');
    markMemorySessionLoaded();
    const operation = beginMemorySessionOperation();
    host.context = { ...host.context, chat: [] };
    expect(operation.isCurrent()).toBe(false);
    expect(() => operation.assertCurrent()).toThrow(StaleMemorySessionError);
  });

  it('主动失效会取消可取消的网络请求', async () => {
    const { beginMemorySessionOperation, invalidateMemorySession, markMemorySessionLoaded } = await import('./session');
    markMemorySessionLoaded();
    const operation = beginMemorySessionOperation();
    invalidateMemorySession();
    expect(operation.signal.aborted).toBe(true);
    expect(operation.isCurrent()).toBe(false);
  });
});
