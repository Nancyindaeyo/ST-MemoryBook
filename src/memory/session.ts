import { getContext, type STMessage } from '@/st/context';

/**
 * 轻量会话闸门。异步任务只能提交到启动时捕获的聊天；切聊天、切 Persona、
 * 关闭插件或热重载都会使旧任务失效并中止可取消的网络请求。
 */
export interface MemorySessionOperation {
  readonly epoch: number;
  readonly chatId: string;
  readonly character: string;
  readonly persona: string;
  readonly chat: STMessage[];
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
  dispose(): void;
}

export class StaleMemorySessionError extends Error {
  constructor() {
    super('记忆任务所属聊天已变化');
    this.name = 'StaleMemorySessionError';
  }
}

let epoch = 0;
const controllers = new Set<AbortController>();
let loadedIdentity: ReturnType<typeof identity> | null = null;
const loadedListeners = new Set<() => void>();
const invalidatedListeners = new Set<() => void>();

function identity() {
  const ctx = getContext();
  return {
    ctx,
    chatId: ctx?.getCurrentChatId?.() ?? '',
    character: String(ctx?.characters?.[Number(ctx?.characterId)]?.avatar ?? ctx?.groupId ?? ctx?.name2 ?? ''),
    persona: String(ctx?.user_avatar ?? ctx?.name1 ?? ''),
    chat: ctx?.chat ?? [],
  };
}

function loadedMatches(current = identity()): boolean {
  return !!loadedIdentity &&
    loadedIdentity.chat === current.chat &&
    loadedIdentity.chatId === current.chatId &&
    loadedIdentity.character === current.character &&
    loadedIdentity.persona === current.persona;
}

export function memorySessionLoadedHere(): boolean {
  return loadedMatches();
}

export function waitForMemorySessionLoaded(timeoutMs = 5000): Promise<boolean> {
  if (loadedMatches()) return Promise.resolve(true);
  const expected = identity();
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loadedListeners.delete(onLoaded);
      invalidatedListeners.delete(onInvalidated);
      resolve(value);
    };
    const stillExpected = () => {
      const current = identity();
      return current.chat === expected.chat &&
        current.chatId === expected.chatId &&
        current.character === expected.character &&
        current.persona === expected.persona;
    };
    const onLoaded = () => finish(stillExpected() && loadedMatches());
    const onInvalidated = () => {
      if (!stillExpected()) finish(false);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    loadedListeners.add(onLoaded);
    invalidatedListeners.add(onInvalidated);
  });
}

export function invalidateMemorySession(): void {
  epoch += 1;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  for (const listener of invalidatedListeners) listener();
}

export function markMemorySessionUnloaded(): void {
  loadedIdentity = null;
}

export function markMemorySessionLoaded(): void {
  loadedIdentity = identity();
  for (const listener of loadedListeners) listener();
}

export function onMemorySessionLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
}

export function onMemorySessionInvalidated(listener: () => void): () => void {
  invalidatedListeners.add(listener);
  return () => invalidatedListeners.delete(listener);
}

export function beginMemorySessionOperation(): MemorySessionOperation {
  const captured = identity();
  if (!captured.ctx) throw new StaleMemorySessionError();
  const loadedAtCapture = loadedMatches(captured);
  const operationEpoch = epoch;
  const controller = new AbortController();
  if (loadedAtCapture) controllers.add(controller);
  else controller.abort();

  const isCurrent = () => {
    if (!loadedAtCapture || controller.signal.aborted || operationEpoch !== epoch) return false;
    const current = identity();
    return (
      loadedMatches(current) &&
      current.chatId === captured.chatId &&
      current.character === captured.character &&
      current.persona === captured.persona &&
      current.chat === captured.chat
    );
  };

  return {
    epoch: operationEpoch,
    chatId: captured.chatId,
    character: captured.character,
    persona: captured.persona,
    chat: captured.chat,
    signal: controller.signal,
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) throw new StaleMemorySessionError();
    },
    dispose() {
      controllers.delete(controller);
    },
  };
}

export function isStaleMemorySessionError(error: unknown): boolean {
  return error instanceof StaleMemorySessionError;
}
