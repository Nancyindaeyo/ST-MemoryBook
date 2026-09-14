/**
 * 人工锁:用户改过的字段,后续摘要重放跳过。
 * 锁集合本身也落在叶子 delta 上,删叶子即回退。
 */

export const NPC_LOCKABLE_FIELDS = [
  'gender',
  'age',
  'relation',
  'ties',
  'title',
  'desc',
  'personality',
  'outfit',
  'condition',
  'important',
  'follow',
  'location',
  'visibility',
] as const;

export const PROTAGONIST_LOCKABLE_FIELDS = [
  'gender',
  'age',
  'identity',
  'appearance',
  'outfit',
  'condition',
] as const;

export type NpcLockableField = (typeof NPC_LOCKABLE_FIELDS)[number];
export type ProtagonistLockableField = (typeof PROTAGONIST_LOCKABLE_FIELDS)[number];

const NPC_LOCK_SET = new Set<string>(NPC_LOCKABLE_FIELDS);
const PROTAGONIST_LOCK_SET = new Set<string>(PROTAGONIST_LOCKABLE_FIELDS);

const NPC_LOCK_LABELS: Record<string, string> = {
  gender: '性别',
  age: '年龄',
  relation: '关系',
  ties: '人际',
  title: '身份',
  desc: '外貌',
  personality: '性格',
  outfit: '着装',
  condition: '状态',
  important: '主要角色',
  follow: '随行',
  location: '所在',
  visibility: '知情',
};

const PROTAGONIST_LOCK_LABELS: Record<string, string> = {
  gender: '性别',
  age: '年龄',
  identity: '身份',
  appearance: '外貌',
  outfit: '着装',
  condition: '状态',
};

export function isLocked(locked: string[] | undefined, field: string): boolean {
  return !!locked?.includes(field);
}

/** 清洗锁字段列表;allowed 为空则只做去空白去重。 */
export function cleanLockFields(raw: unknown, allowed?: ReadonlySet<string>): string[] {
  const src = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[/／、,，;；\s]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of src) {
    const key = String(item ?? '').trim();
    if (!key || seen.has(key)) continue;
    if (allowed && !allowed.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function cleanNpcLockFields(raw: unknown): string[] {
  return cleanLockFields(raw, NPC_LOCK_SET);
}

export function cleanProtagonistLockFields(raw: unknown): string[] {
  return cleanLockFields(raw, PROTAGONIST_LOCK_SET);
}

export interface LockPatch {
  lock?: string[];
  unlock?: string[];
  lockedFields?: string[];
}

/**
 * 把一次锁补丁叠到已有锁集合上。
 *  - lockedFields:整表替换
 *  - lock:追加
 *  - unlock:去掉
 * 返回 undefined 表示结果为空(没锁)。
 */
export function applyLockPatch(current: string[] | undefined, patch: LockPatch): string[] | undefined {
  let next = [...(current ?? [])];
  if (patch.lockedFields) {
    next = [...patch.lockedFields];
  }
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

export function lockFieldLabels(fields: string[] | undefined, kind: 'npc' | 'protagonist' = 'npc'): string {
  if (!fields?.length) return '';
  const map = kind === 'protagonist' ? PROTAGONIST_LOCK_LABELS : NPC_LOCK_LABELS;
  return fields.map(field => map[field] ?? field).join(' / ');
}

function normText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

/** 对比新旧值,收集这次被用户改过、应当自动上锁的字段。 */
export function changedLockableFields<T extends Record<string, unknown>>(
  prev: T | undefined,
  next: Partial<T>,
  fields: readonly string[],
): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
    const a = prev?.[field];
    const b = next[field];
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (Boolean(a) !== Boolean(b)) out.push(field);
      continue;
    }
    if (normText(a) !== normText(b)) out.push(field);
  }
  return out;
}
