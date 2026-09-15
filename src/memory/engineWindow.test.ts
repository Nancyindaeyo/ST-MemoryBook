import { describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import { resolveKeepStart } from './engine';

const user = (mes: string) => ({ name: '玩家', is_user: true, is_system: false, mes, extra: {} });
const ai = (mes: string) => ({ name: '角色', is_user: false, is_system: false, mes, extra: {} });
const system = (mes: string) => ({
  name: '系统',
  is_user: false,
  is_system: true,
  mes,
  extra: { type: 'narrator' },
});

describe('keepRecent window', () => {
  it('只按真实 AI 楼计数，不让系统楼挤占保留窗口', () => {
    const oldKeep = apiSettings.keepRecent;
    apiSettings.keepRecent = 1;
    try {
      const chat = [ai('旧回复'), user('输入'), system('系统提示'), ai('新回复')];
      expect(resolveKeepStart(chat as any)).toBe(3);
    } finally {
      apiSettings.keepRecent = oldKeep;
    }
  });
});
