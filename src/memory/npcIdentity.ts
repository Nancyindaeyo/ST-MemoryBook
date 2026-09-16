/**
 * NPC 身份:按规范化名 + 别名查找,合并裂开的同一人。
 * 纯函数,重放与测试共用;不碰 store。
 */

import type { KnowledgeScope, MemNpc, NpcDelta, NpcMerge } from './types';
import { applyNpcAffinity } from './npcRelations';

function isLocked(locked: string[] | undefined, field: string): boolean {
  return !!locked?.includes(field);
}

function applyLockPatch(
  current: string[] | undefined,
  patch: { lock?: string[]; unlock?: string[]; lockedFields?: string[] },
): string[] | undefined {
  let next = [...(current ?? [])];
  if (patch.lockedFields) next = [...patch.lockedFields];
  if (patch.lock?.length) {
    const seen = new Set(next);
    for (const field of patch.lock) {
      if (!field || seen.has(field)) continue;
      seen.add(field);
      next.push(field);
    }
  }
  if (patch.unlock?.length) {
    const drop = new Set(patch.unlock);
    next = next.filter(field => !drop.has(field));
  }
  return next.length ? next : undefined;
}

export function normNpcName(name: string): string {
  return name.trim().toLowerCase();
}

export function npcId(name: string): string {
  return `npc:${normNpcName(name)}`;
}

export type NpcIdentity = Pick<MemNpc, 'id' | 'name' | 'aliases'>;

export function npcNameList(n: Pick<MemNpc, 'name' | 'aliases'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [n.name, ...(n.aliases ?? [])]) {
    const name = raw?.trim();
    if (!name) continue;
    const key = normNpcName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function mergeAliasList(current: string[] | undefined, incoming: string[] | undefined, canonical?: string): string[] | undefined {
  const skip = canonical ? normNpcName(canonical) : '';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(current ?? []), ...(incoming ?? [])]) {
    const name = raw?.trim();
    if (!name) continue;
    const key = normNpcName(name);
    if (key === skip || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length ? out : undefined;
}

export function findNpc<T extends NpcIdentity>(npcs: T[], name: string): T | undefined {
  const key = normNpcName(name);
  if (!key) return undefined;
  const byId = npcs.find(n => n.id === npcId(name));
  if (byId) return byId;
  return npcs.find(n => normNpcName(n.name) === key || (n.aliases ?? []).some(alias => normNpcName(alias) === key));
}

/** 同叶先 update 后 merge 时,改名后的补丁仍写在新名上,回溯到尚未改名的原记录。 */
function findNpcViaPendingMerges(npcs: MemNpc[], name: string, merges: NpcMerge[]): MemNpc | undefined {
  const seen = new Set<string>();
  let current = name.trim();
  while (current) {
    const key = normNpcName(current);
    if (!key || seen.has(key)) return undefined;
    seen.add(key);
    const hit = findNpc(npcs, current);
    if (hit) return hit;
    const step = merges.find(m => normNpcName(m.into) === key);
    if (!step?.from?.trim()) return undefined;
    current = step.from.trim();
  }
  return undefined;
}

export function cleanKnowledgeScope(raw: unknown): KnowledgeScope | undefined {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === 'private' || text === '私密' || text === '秘密') return 'private';
  if (text === 'observable' || text === '可见' || text === '公开可见') return 'observable';
  if (text === 'shared' || text === '已知' || text === '共享') return 'shared';
  return undefined;
}

export function visibilityLabel(scope: KnowledgeScope | undefined): string {
  if (scope === 'private') return '私密';
  if (scope === 'observable') return '可见';
  return '';
}

export function visibilityInjectTag(scope: KnowledgeScope | undefined): string {
  if (scope === 'private') return '【私密·勿在公开场合点破】';
  if (scope === 'observable') return '【可见】';
  return '';
}

export function npcMentioned(n: Pick<MemNpc, 'name' | 'aliases'>, text: string): boolean {
  const hay = text.toLowerCase();
  if (!hay) return false;
  return npcNameList(n).some(name => hay.includes(name.toLowerCase()));
}

function applyAge(n: { age?: string; ageTime?: string }, src: { age?: string; ageTime?: string }, storyTime: string): void {
  if (typeof src.age === 'string') {
    const age = src.age.trim();
    n.age = age || undefined;
    n.ageTime = age ? (src.ageTime?.trim() || storyTime || undefined) : undefined;
  } else if (typeof src.ageTime === 'string') {
    n.ageTime = src.ageTime.trim() || undefined;
  }
}

function applyNpcPlacement(n: MemNpc, src: NpcDelta): void {
  if (typeof src.follow === 'boolean') {
    n.follow = src.follow;
    if (src.follow) n.location = undefined;
  }
  if (typeof src.location === 'string') {
    const loc = src.location.trim();
    if (loc) {
      n.location = loc;
      if (n.follow === undefined) n.follow = false;
    } else {
      // 空字符串=所在不明:清掉旧地点,避免继续判在场。
      // 不改 follow:模型认为「随行就不必填 location」而顺手写空串时,
      // 不能因此把随行同伴取消掉(要离队必须显式 follow:false)。
      n.location = undefined;
    }
  }
}

function applyNpcState(n: MemNpc, src: NpcDelta): void {
  if (typeof src.outfit === 'string') n.outfit = src.outfit.trim() || undefined;
  if (typeof src.condition === 'string') n.condition = src.condition.trim() || undefined;
  if (typeof src.important === 'boolean') n.important = src.important || undefined;
}

function applyNpcArchives(n: MemNpc, src: NpcDelta, mode: 'fill' | 'overwrite'): void {
  for (const key of ['gender', 'relation', 'ties', 'title', 'desc', 'personality'] as const) {
    const value = src[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (mode === 'fill' && n[key]) continue;
    n[key] = value.trim();
  }
}

function applyNpcFields(n: MemNpc, src: NpcDelta, storyTime: string, mode: 'fill' | 'overwrite'): void {
  // 同一操作里“解锁并修改”时，新值必须立即生效；新增锁在本次写入后生效。
  const unlocking = new Set(src.unlock ?? []);
  const locked = (n.lockedFields ?? []).filter(field => !unlocking.has(field));
  const allow = (field: string): boolean => !isLocked(locked, field);

  if (allow('gender') || allow('relation') || allow('ties') || allow('title') || allow('desc') || allow('personality')) {
    const filtered: NpcDelta = { name: src.name };
    for (const key of ['gender', 'relation', 'ties', 'title', 'desc', 'personality'] as const) {
      if (allow(key) && src[key] !== undefined) filtered[key] = src[key];
    }
    applyNpcArchives(n, filtered, mode);
  }
  if (allow('age') && !(mode === 'fill' && n.age)) applyAge(n, src, storyTime);

  const stateSrc: NpcDelta = { name: src.name };
  if (allow('outfit') && src.outfit !== undefined) stateSrc.outfit = src.outfit;
  if (allow('condition') && src.condition !== undefined) stateSrc.condition = src.condition;
  if (allow('important') && src.important !== undefined) stateSrc.important = src.important;
  applyNpcState(n, stateSrc);

  const placeSrc: NpcDelta = { name: src.name };
  if (allow('follow') && src.follow !== undefined) placeSrc.follow = src.follow;
  if (allow('location') && src.location !== undefined) placeSrc.location = src.location;
  applyNpcPlacement(n, placeSrc);

  if (src.aliases?.length) n.aliases = mergeAliasList(n.aliases, src.aliases, n.name);
  if (src.visibility && allow('visibility')) n.visibility = src.visibility;
  if (allow('affinityInner') || allow('affinityOuter') || allow('affinityNote')) {
    applyNpcAffinity(n, {
      affinityInner: allow('affinityInner') ? src.affinityInner : undefined,
      affinityOuter: allow('affinityOuter') ? src.affinityOuter : undefined,
      affinityNote: allow('affinityNote') ? src.affinityNote : undefined,
    }, mode === 'fill');
  }
  n.lockedFields = applyLockPatch(n.lockedFields, src);
}

function fillEmptyFrom(into: MemNpc, from: MemNpc): void {
  const locked = into.lockedFields ?? [];
  const allow = (field: string) => !isLocked(locked, field);
  for (const key of ['gender', 'relation', 'ties', 'title', 'desc', 'personality', 'outfit', 'condition', 'age', 'ageTime', 'location'] as const) {
    if (!allow(key === 'ageTime' ? 'age' : key)) continue;
    if (!into[key] && from[key]) into[key] = from[key];
  }
  if (allow('important') && into.important === undefined && from.important) into.important = from.important;
  if (allow('follow') && into.follow === undefined && from.follow) into.follow = from.follow;
  if (allow('visibility') && !into.visibility && from.visibility) into.visibility = from.visibility;
  if (allow('affinityInner') || allow('affinityOuter') || allow('affinityNote')) {
    applyNpcAffinity(into, {
      affinityInner: allow('affinityInner') ? from.affinityInner : undefined,
      affinityOuter: allow('affinityOuter') ? from.affinityOuter : undefined,
      affinityNote: allow('affinityNote') ? from.affinityNote : undefined,
    }, true);
  }
}

export function applyNpcMerge(npcs: MemNpc[], fromName: string, intoName: string, t: number): void {
  const fromKey = fromName.trim();
  const intoKey = intoName.trim();
  if (!fromKey || !intoKey) return;

  const from = findNpc(npcs, fromKey);
  const into = findNpc(npcs, intoKey);
  if (from && into && from.id === into.id) {
    if (normNpcName(intoKey) !== normNpcName(into.name)) {
      const oldName = into.name;
      into.name = intoKey;
      into.aliases = mergeAliasList(into.aliases, [oldName, fromKey], into.name);
    } else if (normNpcName(fromKey) !== normNpcName(into.name)) {
      into.aliases = mergeAliasList(into.aliases, [fromKey], into.name);
    }
    into.updatedAt = t;
    return;
  }

  if (from && into) {
    fillEmptyFrom(into, from);
    into.aliases = mergeAliasList(into.aliases, [from.name, ...(from.aliases ?? []), fromKey], into.name);
    into.lockedFields = applyLockPatch(into.lockedFields, { lock: from.lockedFields });
    if (!into.visibility && from.visibility) into.visibility = from.visibility;
    into.updatedAt = t;
    const idx = npcs.indexOf(from);
    if (idx >= 0) npcs.splice(idx, 1);
    return;
  }

  if (into && !from) {
    into.aliases = mergeAliasList(into.aliases, [fromKey], into.name);
    into.updatedAt = t;
    return;
  }

  if (from && !into) {
    const oldName = from.name;
    from.name = intoKey;
    from.aliases = mergeAliasList(from.aliases, [oldName, fromKey], from.name);
    from.updatedAt = t;
  }
}

export interface NpcBookDelta {
  add?: NpcDelta[];
  update?: NpcDelta[];
  remove?: string[];
  merge?: NpcMerge[];
}

/**
 * 重放一叶子的 NPC 指令。顺序:add → update → merge → remove。
 * add 若命中已有名/别名,按「档案填空、即时覆盖」叠上去,不另开 id。
 */
export function applyNpcBook(npcs: MemNpc[], d: NpcBookDelta, ctx: { t: number; storyTime: string }): void {
  const { t, storyTime } = ctx;

  for (const add of d.add ?? []) {
    if (!add?.name?.trim()) continue;
    const ex = findNpc(npcs, add.name);
    if (ex) {
      if (normNpcName(add.name) !== normNpcName(ex.name)) {
        ex.aliases = mergeAliasList(ex.aliases, [add.name], ex.name);
      }
      applyNpcFields(ex, add, storyTime, 'fill');
      ex.updatedAt = t;
      continue;
    }
    const npc: MemNpc = {
      id: npcId(add.name),
      name: add.name.trim(),
      createdAt: t,
      updatedAt: t,
    };
    applyNpcFields(npc, add, storyTime, 'overwrite');
    npcs.push(npc);
  }

  for (const upd of d.update ?? []) {
    if (!upd?.name?.trim()) continue;
    let n = findNpc(npcs, upd.name) ?? findNpcViaPendingMerges(npcs, upd.name, d.merge ?? []);
    if (!n) {
      n = {
        id: npcId(upd.name),
        name: upd.name.trim(),
        createdAt: t,
        updatedAt: t,
      };
      npcs.push(n);
    } else if (normNpcName(upd.name) !== normNpcName(n.name)) {
      n.aliases = mergeAliasList(n.aliases, [upd.name], n.name);
    }
    applyNpcFields(n, upd, storyTime, 'overwrite');
    n.updatedAt = t;
  }

  for (const merge of d.merge ?? []) {
    if (!merge?.from?.trim() || !merge?.into?.trim()) continue;
    applyNpcMerge(npcs, merge.from, merge.into, t);
  }

  for (const name of d.remove ?? []) {
    if (!name?.trim()) continue;
    const n = findNpc(npcs, name);
    if (!n) continue;
    // 主名/id 命中才整人退场;只命中别名则摘掉那个别名
    if (normNpcName(n.name) === normNpcName(name) || n.id === npcId(name)) {
      const idx = npcs.indexOf(n);
      if (idx >= 0) npcs.splice(idx, 1);
    } else {
      n.aliases = mergeAliasList(
        (n.aliases ?? []).filter(alias => normNpcName(alias) !== normNpcName(name)),
        [],
        n.name,
      );
    }
  }
}

export function stripManualNpcLocks(n: NpcDelta): NpcDelta {
  const { lock: _lock, unlock: _unlock, lockedFields: _lockedFields, ...rest } = n;
  return rest;
}
