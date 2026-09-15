import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ context: null as any }));

vi.mock('@/st/context', () => ({
  getContext: () => host.context,
}));

beforeEach(() => {
  vi.resetModules();
  host.context = null;
  Object.assign(globalThis, {
    window: new EventTarget(),
    localStorage: {
      getItem: () => null,
      removeItem: () => undefined,
    },
  });
});

describe('settings hydrate', () => {
  it('宿主设置未就绪时不放行，稍后可重试', async () => {
    const settings = await import('./settings');
    expect(settings.hydrateSettings()).toBe(false);

    host.context = {
      extensionSettings: {
        baibai_book: {
          llmPick: { enabled: true, maxLeaves: 7, maxPrequelChunks: 5 },
        },
      },
      saveSettingsDebounced: vi.fn(),
    };
    expect(settings.hydrateSettings()).toBe(true);
    expect(settings.apiSettings.llmPick).toEqual({
      enabled: true,
      maxLeaves: 7,
      maxPrequelChunks: 5,
    });
  });
});
