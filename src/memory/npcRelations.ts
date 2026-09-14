import type { MemNpc } from './types';

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function relationKey(value: string): string {
  return value.toLowerCase().replace(/[；;]/g, ';').replace(/\s+/g, ' ').trim();
}

/**
 * 渲染不受在场分档影响的 NPC 长期关系图。
 *
 * 正常派生状态里 NPC 名字唯一；这里仍按规范化名字聚合，以兼容旧数据或异常导入造成的
 * 重名记录。完全相同的关系只输出一次，不同关系全部保留，避免静默缺漏。
 */
export function fmtNpcTiesContext(npcs: Pick<MemNpc, 'name' | 'ties'>[]): string {
  const grouped = new Map<string, { name: string; ties: string[]; seen: Set<string> }>();
  for (const npc of npcs) {
    const name = oneLine(npc.name);
    const ties = oneLine(npc.ties);
    if (!name || !ties) continue;

    const nameKey = name.toLowerCase();
    let entry = grouped.get(nameKey);
    if (!entry) {
      entry = { name, ties: [], seen: new Set<string>() };
      grouped.set(nameKey, entry);
    }
    // ties 的约定格式是分号并列。逐项合并可处理异常旧数据里同名 NPC 的关系集合有交叠，
    // 既不会整行重复，也不会因为简单“保留第一条”而丢掉后续独有关系。
    for (const tie of ties.split(/[；;]/).map(one => one.trim()).filter(Boolean)) {
      const tieKey = relationKey(tie);
      if (entry.seen.has(tieKey)) continue;
      entry.seen.add(tieKey);
      entry.ties.push(tie);
    }
  }

  const rows = [...grouped.values()].map(entry => `  - ${entry.name}:${entry.ties.join(';')}`);
  return rows.length ? `角色长期关系(血缘/婚姻/主仆/宿敌等，不因是否在场而失效):\n${rows.join('\n')}` : '';
}

export interface NpcSummaryView {
  name: string;
  gender?: string;
  age?: string;
  ageTime?: string;
  relation?: string;
  ties?: string;
  title?: string;
  important?: boolean;
  outfit?: string;
  condition?: string;
  follow?: boolean;
  location?: string;
  aliases?: string[];
  visibility?: 'private' | 'shared' | 'observable';
  lockedFields?: string[];
}

/** 给摘要模型的已登场 NPC 名册。长期关系必须随既有状态一起给模型，才能做整体覆盖更新。 */
export function fmtNpcSummaryList(npcs: NpcSummaryView[]): string {
  if (!npcs.length) return '  (无)';
  return npcs
    .map(n => {
      const star = n.important ? '★ ' : '';
      const inBracket: string[] = [];
      if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
      if (oneLine(n.age)) inBracket.push(`${oneLine(n.age)}${n.ageTime ? `·记于${oneLine(n.ageTime)}` : ''}`);
      const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
      const place = n.follow ? ' [随行]' : oneLine(n.location) ? ` [在:${oneLine(n.location)}]` : '';
      const tail: string[] = [];
      if (oneLine(n.title)) tail.push(oneLine(n.title));
      if (oneLine(n.relation)) tail.push(`与主角:${oneLine(n.relation)}`);
      if (oneLine(n.ties)) tail.push(`人际:${oneLine(n.ties)}`);
      const title = tail.length ? ` —— ${tail.join(';')}` : '';
      const state: string[] = [];
      if (oneLine(n.outfit)) state.push(`着装:${oneLine(n.outfit)}`);
      if (oneLine(n.condition)) state.push(`状态:${oneLine(n.condition)}`);
      const stateStr = state.length ? ` 〔${state.join(';')}〕` : '';
      const aliases = (n.aliases ?? []).map(oneLine).filter(Boolean);
      const aka = aliases.length ? `(亦称${aliases.join('、')})` : '';
      const vis = n.visibility === 'private' ? ' [私密]' : n.visibility === 'observable' ? ' [可见]' : '';
      const locked = n.lockedFields?.length ? ` [已锁:${n.lockedFields.join('/')}]` : '';
      return `  - ${star}${oneLine(n.name)}${aka}${bracket}${place}${title}${stateStr}${vis}${locked}`;
    })
    .join('\n');
}
