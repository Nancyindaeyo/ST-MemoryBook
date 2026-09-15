import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, editLeafFull, editNpc, finalizeDelta, upsertNpc } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { affinityLevelFromInput, applyNpcAffinity, cleanNpcAffinityLevel, fmtNpcAffinity, fmtNpcSummaryList, NPC_AFFINITY_BRIEFING } from './npcRelations';
import { buildSummaryPrompt, RULE_NPC_AFFINITY } from './prompts';
import { markMemorySessionLoaded } from './session';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type NpcAffinity, type NpcDelta, type StoredDelta, type SummaryDelta } from './types';

const name = '艾琳';
const initial: NpcDelta = { name, affinityInner: 1, affinityOuter: -1, affinityNote: '在意,但以冷淡掩饰', personality: '嘴硬、护短' };
const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: 'Character', is_user: false, is_system: false, mes: '一段明确发生的剧情。',
  extra: { bbs_leaf: { id: `affinity-${++seq}`, text: '剧情摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const base = () => message({ npcs: { add: [{ ...initial }] } });
const patch = (values: Omit<NpcDelta, 'name'>) => message({ npcs: { update: [{ name, ...values }] } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'User', name2: 'Character',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'affinity-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  markMemorySessionLoaded();
  recomputeDerived();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.npcs = true;
  settings.apiSettings.injection.scenes = true;
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('定性档位与未知', () => {
  it.each([-2, -1, 0, 1, 2, null] as const)('保留有效值 %s', value => {
    expect(cleanNpcAffinityLevel(value)).toBe(value);
    const delta = finalizeDelta({ npcs: { add: [{ name, affinityInner: value }] } }, []);
    expect(deriveMemory([message(delta)]).npcs[0].affinityInner).toBe(value);
  });
  it.each([undefined, -3, 3, 50, 0.5, NaN, Infinity, '1', '', true, false, {}, []])('拒绝非法值 %j,不能转成中性或极值', value => {
    expect(cleanNpcAffinityLevel(value)).toBeUndefined();
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: value }] } } as unknown as SummaryDelta, []);
    expect(deriveMemory([base(), message(delta)]).npcs[0]).toMatchObject(initial);
  });
  it('下拉框空值是未知,零是中性;旧角色不凭空产生记录', () => {
    expect(affinityLevelFromInput('')).toBeNull();
    expect(affinityLevelFromInput('0')).toBe(0);
    expect(affinityLevelFromInput('-2')).toBe(-2);
    expect(fmtNpcAffinity({})).toBe('');
    expect(fmtNpcAffinity({ affinityInner: 0, affinityOuter: null })).toBe('内心好感:无明显好恶;外在态度:未知');
    expect(deriveMemory([message({ npcs: { add: [{ name }] } })]).npcs[0].affinityInner).toBeUndefined();
  });
  it('楼层只展示真正提供的字段,清空说明可见', () => {
    expect(fmtNpcAffinity({ affinityInner: 2 }, true)).toBe('内心好感:感情深厚');
    expect(fmtNpcAffinity({ affinityOuter: null }, true)).toBe('外在态度:未知');
    expect(fmtNpcAffinity({ affinityNote: '' }, true)).toBe('好感说明:清空');
    expect(fmtNpcAffinity({ affinityNote: '表面客套\n内心不信任' }, true)).toBe('说明:表面客套 内心不信任');
  });
});

describe('独立、绝对覆盖、可回滚的角色补丁', () => {
  it.each([
    [{ affinityInner: 2 }, 2, -1],
    [{ affinityOuter: 1 }, 1, 1],
    [{ affinityInner: -2, affinityOuter: 2 }, -2, 2],
    [{ affinityInner: null }, null, -1],
    [{ affinityOuter: 0 }, 1, 0],
    [{ title: '掌柜' }, 1, -1],
  ] as const)('补丁 %j 不联动另一侧', (values, inner, outer) => {
    const chat = [base(), patch(values)];
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ affinityInner: inner, affinityOuter: outer, affinityNote: initial.affinityNote });
    expect(deriveMemory(chat)).toEqual(deriveMemory(chat));
  });
  it('没有好感补丁时,多轮普通互动保持档位和说明,不暗中累计', () => {
    const chat = [base(), ...Array.from({ length: 25 }, () => message({}))];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    expect(deriveMemory([...chat, patch({ affinityInner: 1 }), patch({ affinityInner: 1 })]).npcs[0].affinityInner).toBe(1);
  });
  it('重复 add 只补空缺,不覆盖已经建立的档位与说明', () => {
    const chat = [base(), message({ npcs: { add: [{ name, affinityInner: -2, affinityOuter: 2, affinityNote: '不应覆盖' }] } })];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    const target: NpcAffinity = { affinityInner: null, affinityOuter: 0 };
    applyNpcAffinity(target, { affinityInner: 1, affinityOuter: 2 }, true);
    expect(target).toEqual({ affinityInner: 1, affinityOuter: 0 });
  });
  it('撤回未知与清空说明通过 JSON 存储后仍有效', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: null, affinityNote: '' }] } }, []);
    const npc = deriveMemory([base(), message(JSON.parse(JSON.stringify(delta)))]).npcs[0];
    expect(npc).toMatchObject({ affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('遗漏、删除、切换 swipe 和重摘的截止点都不泄漏未来好感', () => {
    const changed = patch({ affinityInner: 2, affinityOuter: 2 });
    const chat = [base(), changed];
    expect(deriveMemory(chat, 1).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = true;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = false;
    changed.swipe_id = 1;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    delete changed.extra!.bbs_leaf;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
  });
  it('已锁好感不被后续摘要覆盖,同操作解锁则可写', () => {
    const chat = [
      message({ npcs: { add: [{ name, affinityInner: 1, affinityOuter: -1, lock: ['affinityInner'] }] } }),
      patch({ affinityInner: 2, affinityOuter: 2 }),
    ];
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ affinityInner: 1, affinityOuter: 2 });
    chat.push(patch({ affinityInner: 2, unlock: ['affinityInner'] }));
    expect(deriveMemory(chat).npcs[0].affinityInner).toBe(2);
  });
  it('合并裂开的同一人时不覆盖已锁好感', () => {
    const chat = [message({
      npcs: {
        add: [
          { name, affinityInner: 1, lock: ['affinityInner'] },
          { name: '红红', affinityInner: -2, affinityNote: '另一条记录' },
        ],
        merge: [{ from: '红红', into: name }],
      },
    })];
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ name, affinityInner: 1, affinityNote: '另一条记录' });
  });
  it('角色新增/校正/改名往返保留两侧,无关编辑不写入好感补丁', () => {
    const chat = [message(), message()];
    useChat(chat);
    expect(upsertNpc(initial)).toBe(true);
    expect(editNpc(name, { title: '新身份' })).toBe(true);
    const unrelated = chat[1].extra!.bbs_leaf!.delta.npcs!.update!.at(-1)!;
    expect(unrelated.affinityInner).toBeUndefined();
    expect(unrelated.affinityOuter).toBeUndefined();
    expect(editNpc(name, { name: '新名字' })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ name: '新名字', affinityInner: 1, affinityOuter: -1, affinityNote: initial.affinityNote });
    expect(editNpc('新名字', { name, affinityInner: null, affinityNote: '' })).toBe(true);
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ name, affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('编辑楼层可以清空说明且不把未提供的另一侧改成未知', () => {
    const chat = [base(), patch({ affinityInner: 2, affinityNote: '新的依据' })];
    useChat(chat);
    const delta: StoredDelta = { npcs: { update: [{ name, affinityInner: 0, affinityNote: '' }] } };
    expect(editLeafFull(1, { text: '剧情摘要', timeStart: '', timeEnd: '', delta })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 0, affinityOuter: -1, affinityNote: '' });
  });
});

const promptArgs: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User', char: 'Character', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [initial], openPlans: [], resolvedPlans: [],
  history: '先前事实', content: '这次只是普通交谈', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
describe('摘要与主对话的提示词边界', () => {
  it.each(['', 'CUSTOM {{content}}', 'CUSTOM {{npcs_block}} {{content}}'])('默认及自定义摘要模板都有协议与先前基线: %s', custom => {
    settings.apiSettings.prompts.summary = custom;
    const prompt = buildSummaryPrompt(promptArgs);
    expect(prompt.system).toContain('【内心好感与外在态度规则】');
    expect(prompt.system).not.toContain(initial.affinityNote);
    expect(prompt.user).toContain(fmtNpcSummaryList([initial]));
    expect(prompt.user.split('对主角的好感与态度估计[')).toHaveLength(2);
    expect(prompt.user).toContain('性格:嘴硬、护短');
  });
  it('明确默认稳定、内外独立、说明稳定及估计不能成为事实', () => {
    for (const contract of ['【默认保持,跨档才更新】', '【内外完全独立】', '【说明也要稳定】', '不是每轮重新打分',
      '两侧与说明均省略', '禁止增量', '禁止每轮升级修辞', '不要默认填 0', '不得把它抄入 summary/relation/ties/personality']) {
      expect(RULE_NPC_AFFINITY).toContain(contract);
    }
  });
  it('四档在场状态均注入独立好感,远处省略说明且守住角色视角', () => {
    const chat = [message({
      location: '房间', locationPath: ['城', '客栈', '房间'],
      scenes: { add: [{ path: ['城'], desc: '城市' }, { path: ['城', '客栈'], desc: '客栈' },
        { path: ['城', '客栈', '房间'], desc: '房间' }, { path: ['城', '客栈', '厨房'], desc: '厨房' }] },
      npcs: { add: [
        { ...initial, important: true },
        { name: '同伴', affinityInner: null, affinityOuter: 1, follow: true },
        { name: '厨师', affinityInner: -1, affinityOuter: 1, affinityNote: '保持礼貌', location: '厨房' },
        { name: '远客', affinityInner: -2, affinityOuter: 2, affinityNote: '远处说明不应注入', location: '远方' },
      ] },
    })];
    useChat(chat);
    const text = inject.buildStateInjectionText();
    expect(text.split(NPC_AFFINITY_BRIEFING)).toHaveLength(2);
    expect(text).toContain('内心好感:未知;外在态度:友善亲近');
    expect(text).toContain('内心好感:不喜欢;外在态度:友善亲近;说明:保持礼貌');
    expect(text).toContain('内心好感:强烈反感;外在态度:明显亲近、积极表达');
    expect(text).not.toContain('远处说明不应注入');
    expect(text).toContain('不代表主角或其他角色知情');
  });
  it('旧角色无好感记录时零额外注入,关闭注入/纯摘要模式仍有效', () => {
    useChat([message({ npcs: { add: [{ name }] } })]);
    expect(inject.buildStateInjectionText()).not.toContain('好感');
    useChat([base()]);
    settings.apiSettings.injection.npcs = false;
    expect(inject.buildStateInjectionText()).not.toContain('内心好感');
    settings.apiSettings.injection.npcs = true;
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
  });
});

describe('实际摘要入口与跨对话继承', () => {
  it('摘要用旧基线,解析 AI 的单侧更新,下一轮不变则保持', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [base(), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '危急时她选择相救,但仍然嘴硬。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { update: [{ name, affinityInner: 2, affinityNote: '相救表现出更深在意,外在仍冷淡' }] },
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('内心好感:有好感;外在态度:冷淡疏远');
    expect(request).toContain('性格:嘴硬、护短');
    expect(chat[1].extra!.bbs_leaf!.delta.npcs!.update![0].affinityOuter).toBeUndefined();
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1 });
    const third = message(); delete third.extra!.bbs_leaf; chat.push(third);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '一起喝茶。', timeStart: '2026/9/13 10:05', timeEnd: '2026/9/13 10:10' }));
    await summarizeFloor(2);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1, affinityNote: '相救表现出更深在意,外在仍冷淡' });
  });
  it('摘要名册带上别名、知情范围和已锁字段', async () => {
    const first = message({ npcs: { add: [{ ...initial, aliases: ['小红'], visibility: 'private', lock: ['personality'] }] } });
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [first, second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '继续交谈。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('亦称小红');
    expect(request).toContain('[私密]');
    expect(request).toContain('[已锁:personality]');
  });
  it('带数据创建新对话保留窗口前未知/中性和窗口内单侧更新,不改源聊天', async () => {
    settings.apiSettings.keepRecent = 1;
    const chat = [message({ npcs: { add: [{ name, affinityInner: null, affinityOuter: 0, affinityNote: '尚不知内心' }] } }), patch({ affinityOuter: 1 })];
    const source = useChat(chat);
    const before = JSON.stringify(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'affinity-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => {
      vi.mocked(context.getContext).mockReturnValue(target);
      markMemorySessionLoaded();
    });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(JSON.stringify(chat)).toBe(before);
    expect(target.chat[0].extra!.bbs_leaf!.delta.npcs!.add![0]).toMatchObject({ name, affinityInner: null, affinityOuter: 0, affinityNote: '尚不知内心' });
    expect(deriveMemory(target.chat).npcs[0]).toMatchObject({ affinityInner: null, affinityOuter: 1, affinityNote: '尚不知内心' });
  });
});
