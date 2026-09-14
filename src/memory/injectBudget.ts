/**
 * 状态注入预算:超限时按在场 / 随身 / 本轮提及裁剪。
 * 森林压缩史不走这里;只裁结构化状态块。
 */

import type { MemItem, MemNpc } from './types';

function nameMentioned(n: Pick<MemNpc, 'name' | 'aliases'>, text: string): boolean {
  const hay = text.toLowerCase();
  if (!hay) return false;
  return [n.name, ...(n.aliases ?? [])].some(name => !!name && hay.includes(name.toLowerCase()));
}

export type InjectBudgetTier = 'full' | 'tight' | 'core';

export function normalizeBudgetTokens(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 20000);
}

export function estimateUtf8Tokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / 3.35);
}

export function filterNpcsForBudget(
  npcs: MemNpc[],
  opts: {
    tier: InjectBudgetTier;
    mentionText: string;
    presenceOf: (n: MemNpc) => 'present' | 'nearby' | 'absent';
  },
): MemNpc[] {
  if (opts.tier === 'full') return npcs;
  return npcs.filter(n => {
    if (n.important) return true;
    const presence = opts.presenceOf(n);
    if (presence === 'present') return true;
    const mentioned = nameMentioned(n, opts.mentionText);
    if (opts.tier === 'tight') return presence === 'nearby' || mentioned;
    return mentioned;
  });
}

export function filterItemsForBudget(
  items: MemItem[],
  opts: {
    tier: InjectBudgetTier;
    mentionText: string;
    reachable: (item: MemItem) => boolean;
  },
): MemItem[] {
  if (opts.tier === 'full') return items;
  const hay = opts.mentionText.toLowerCase();
  return items.filter(item => {
    if (item.carried !== false || opts.reachable(item)) return true;
    if (opts.tier === 'core') return false;
    return !!item.name && hay.includes(item.name.toLowerCase());
  });
}

export function budgetTiersToTry(budgetTokens: number): InjectBudgetTier[] {
  return budgetTokens > 0 ? ['full', 'tight', 'core'] : ['full'];
}
