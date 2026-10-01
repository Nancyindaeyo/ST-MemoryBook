/**
 * 计划时间线只是现有计划的一种看法,不另存。
 * 能解析成公历年月日的,公开接口多给一个 storyDate,供构画以后在轴上点一下。
 */
import type { MemPlan } from './types';
import { parseStoryDate } from './timeRel';

export interface PublicStoryDate {
  year?: number;
  month: number;
  day: number;
}

export interface TimelineGroup {
  key: string;
  label: string;
  /** 越大越靠前;时间不明为最小。 */
  sort: number;
  items: MemPlan[];
}

export function publicStoryDate(text?: string): PublicStoryDate | null {
  const parsed = parseStoryDate(String(text ?? '').trim());
  if (!parsed || parsed.type !== 'standard' || parsed.month == null || parsed.day == null) return null;
  const date: PublicStoryDate = { month: parsed.month, day: parsed.day };
  if (parsed.year) date.year = parsed.year;
  return date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function groupOf(plan: MemPlan): { key: string; label: string; sort: number } {
  const raw = (plan.targetTime || plan.createdTime || '').trim();
  const parsed = parseStoryDate(raw);
  if (parsed?.type === 'standard' && parsed.month != null && parsed.day != null) {
    const year = parsed.year ?? 0;
    const key = `${year}-${pad(parsed.month)}-${pad(parsed.day)}`;
    const label = parsed.year
      ? `${parsed.year}-${parsed.month}-${parsed.day}`
      : `${parsed.month}月${parsed.day}日`;
    return { key, label, sort: year * 10000 + parsed.month * 100 + parsed.day };
  }
  if (parsed?.type === 'fantasy' && parsed.monthId && parsed.day != null) {
    return {
      key: `fantasy:${parsed.monthId}:${parsed.day}`,
      label: `${parsed.monthId}${parsed.day}日`,
      sort: 0,
    };
  }
  return { key: 'undated', label: '时间不明', sort: -1 };
}

export function groupPlans(plans: MemPlan[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const plan of plans) {
    const meta = groupOf(plan);
    let group = groups.get(meta.key);
    if (!group) {
      group = { key: meta.key, label: meta.label, sort: meta.sort, items: [] };
      groups.set(meta.key, group);
    }
    group.items.push(plan);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
  }
  return [...groups.values()].sort((a, b) => b.sort - a.sort || a.label.localeCompare(b.label, 'zh'));
}
