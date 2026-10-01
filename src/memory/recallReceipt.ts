/**
 * 本轮召回回执挂在触发它的那条用户消息上。
 * 续写、重生、翻页直接复用;失败不写入。改了这条用户消息,哈希对不上,下一次会重算。
 */
import { apiSettings, engineActiveHere } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';
import { writeLlmPickInjection, clearLlmPickInjection } from './inject';
import { scheduleLeafFlush } from './store';
import { normalizeRecallInjectionDepth } from './vector/depth';
import { applyVectorRecallText, clearRecallInjection, type RecallLine, type RecallRunResult } from './vector/recall';
import { reactive } from 'vue';

export type { RecallLine, RecallRunResult };

export interface RecallReceipt {
  v: 1;
  userHash: string;
  vectorText: string;
  pickText: string;
  lines: RecallLine[];
}

export const recallReceiptSignal = reactive({ rev: 0 });

export function userTextHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function latestUserMessage(chat: STMessage[]): STMessage | undefined {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.is_user) return chat[i];
  }
  return undefined;
}

export function readRecallReceipt(message: STMessage | undefined): RecallReceipt | null {
  const raw = message?.extra?.bbs_recall;
  if (!raw || raw.v !== 1) return null;
  if (raw.userHash !== userTextHash(message?.mes ?? '')) return null;
  if (typeof raw.vectorText !== 'string' || typeof raw.pickText !== 'string' || !Array.isArray(raw.lines)) return null;
  return raw;
}

function clipLine(line: RecallLine): RecallLine {
  return {
    source: String(line.source ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
    preview: String(line.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}

export function captureRecallReceipt(vector: RecallRunResult, pick: RecallRunResult): void {
  if (!engineActiveHere() || !vector.ok || !pick.ok) return;
  const user = latestUserMessage(getContext()?.chat ?? []);
  if (!user) return;
  user.extra = {
    ...(user.extra ?? {}),
    bbs_recall: {
      v: 1,
      userHash: userTextHash(user.mes ?? ''),
      vectorText: vector.text,
      pickText: pick.text,
      lines: [...vector.lines, ...pick.lines].slice(0, 16).map(clipLine).filter(line => line.preview || line.source),
    },
  };
  recallReceiptSignal.rev++;
  scheduleLeafFlush();
}

/** 续写/重生/翻页命中回执时写回注入槽,不再打检索。插件关掉时不复用。 */
export function reuseRecallReceipt(): boolean {
  if (!engineActiveHere()) return false;
  const receipt = readRecallReceipt(latestUserMessage(getContext()?.chat ?? []));
  if (!receipt) return false;
  if (apiSettings.vector.enabled) applyVectorRecallText(receipt.vectorText);
  else clearRecallInjection();
  if (apiSettings.summaryOnlyMode) clearLlmPickInjection();
  else writeLlmPickInjection(receipt.pickText, normalizeRecallInjectionDepth(apiSettings.vector.recall.injectionDepth));
  return true;
}

export function forgetRecallReceipt(message: STMessage | undefined): void {
  if (!message?.extra?.bbs_recall) return;
  const extra = { ...message.extra };
  delete extra.bbs_recall;
  message.extra = extra;
  recallReceiptSignal.rev++;
  scheduleLeafFlush();
}

export function userMessageBefore(chat: STMessage[], floor: number): STMessage | undefined {
  for (let i = floor - 1; i >= 0; i--) {
    if (chat[i]?.is_user) return chat[i];
  }
  return undefined;
}
