/**
 * 补充召回:前情原文抽段 + 可选的 LLM 选材(窗口外叶子)。
 * 与向量召回并列;任何失败只清空本槽,绝不阻断正文生成。
 * 保留窗口直接复用引擎口径，避免系统楼在两条召回链路里被算成不同结果。
 */

import type { ChatMsg } from '@/api/client';
import { mainApiAvailable, requestCompletion, requestViaMainApi } from '@/api/client';
import { apiSettings, engineActiveHere, getChannelForTask } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';
import { resolveKeepStart } from './engine';
import { clearLlmPickInjection, writeLlmPickInjection } from './inject';
import { extractJsonObject } from './json';
import {
  buildLeafCatalog,
  CATALOG_PREVIEW_CHARS,
  fitPrequelIndexesToBudget,
  parseOneBasedIndexes,
  pickPrequelByKeywords,
  splitPrequelChunks,
  type LeafCatalogItem,
} from './prequel';
import { npcNameList } from './npcIdentity';
import { MEMORY_BRIEFING_END, MEMORY_BRIEFING_NOTE } from './prompts';
import { derivedMeta, memory } from './store';
import { normalizeRecallInjectionDepth } from './vector/depth';
import { beginMemorySessionOperation, isStaleMemorySessionError } from './session';

const CATALOG_CAP = 40;
const TEXT_CAP = 280;
const PREQUEL_TOKEN_BUDGET = 1200;

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function pickDepth(): number {
  return normalizeRecallInjectionDepth(apiSettings.vector.recall.injectionDepth);
}

function windowLeafIds(chat: STMessage[]): Set<string> {
  const keepStart = resolveKeepStart(chat);
  const ids = new Set<string>();
  for (const leaf of derivedMeta.leaves) {
    if (!leaf.stale && leaf.msgIndex >= keepStart) ids.add(leaf.id);
  }
  return ids;
}

function recentHaystack(chat: STMessage[]): string {
  const recent: string[] = [];
  for (let i = chat.length - 1, seen = 0; i >= 0 && seen < 4; i--) {
    const m = chat[i];
    const text = typeof m?.mes === 'string' ? m.mes.replace(/\s+/g, ' ').trim() : '';
    if (!text || m?.extra?.bbs_omit) continue;
    recent.push(text.slice(0, 240));
    seen++;
  }
  const hay = recent.join('\n');
  const extra: string[] = [];
  if (memory.state.time) extra.push(memory.state.time);
  if (memory.state.location) extra.push(memory.state.location);
  if (memory.state.sceneFocus?.situation) extra.push(memory.state.sceneFocus.situation);
  for (const n of memory.npcs) {
    const names = npcNameList(n);
    if (names.some(name => hay.includes(name))) extra.push(names.join(' '));
  }
  return [hay, ...extra].filter(Boolean).join('\n');
}

function resolveSender(signal: AbortSignal): { send: (messages: ChatMsg[]) => Promise<string> } | null {
  const channel = getChannelForTask('summary');
  if (channel) return { send: messages => requestCompletion(channel, messages, { signal }) };
  if (mainApiAvailable()) return { send: messages => requestViaMainApi(messages, { signal }) };
  return null;
}

function clip(s: string, max = TEXT_CAP): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function composeInjection(leaves: LeafCatalogItem[], chunks: string[], prequelIdx: number[]): string {
  const parts: string[] = [];
  if (leaves.length) {
    parts.push(leaves.map((leaf, i) => {
      const where = leaf.floor != null ? `#${leaf.floor}` : '';
      const when = leaf.time ? ` ${leaf.time}` : '';
      return `${i + 1}. ${where}${when} ${clip(leaf.text)}`.replace(/\s+/g, ' ').trim();
    }).join('\n'));
  }
  if (prequelIdx.length && chunks.length) {
    const body = prequelIdx
      .filter(i => i >= 0 && i < chunks.length)
      .map((i, n) => `${n + 1}. ${clip(chunks[i], 360)}`)
      .join('\n');
    if (body) parts.push(`前情原文摘录:\n${body}`);
  }
  if (!parts.length) return '';
  return `${MEMORY_BRIEFING_NOTE}\n[选材召回]\n${parts.join('\n\n')}\n${MEMORY_BRIEFING_END}`;
}

function buildPickPrompt(
  haystack: string,
  catalog: LeafCatalogItem[],
  chunks: string[],
  maxLeaves: number,
  maxPrequel: number,
): string {
  const cat = catalog.map((item, i) => {
    const where = item.floor != null ? `#${item.floor}` : '';
    const when = item.time ? ` ${item.time}` : '';
    return `C${i + 1} ${where}${when} ${clip(item.text, CATALOG_PREVIEW_CHARS)}`.replace(/\s+/g, ' ').trim();
  }).join('\n');
  const pre = chunks.map((c, i) => `P${i + 1} ${clip(c, 220)}`).join('\n');
  return [
    '你是选材助手。根据【近况】从候选里挑出本轮续写真正用得上的旧记忆。',
    '只返回 JSON,不要解释。格式:{"c":[1,3],"p":[2]}',
    `c 是候选编号 C1…(最多 ${maxLeaves} 个),p 是前情段落编号 P1…(最多 ${maxPrequel} 个)。无关就空数组。`,
    `【近况】\n${clip(haystack, 900)}`,
    catalog.length ? `【候选叶子】\n${cat}` : '',
    chunks.length ? `【前情原文】\n${pre}` : '',
  ].filter(Boolean).join('\n\n');
}

async function askLlmPick(
  catalog: LeafCatalogItem[],
  chunks: string[],
  haystack: string,
  maxLeaves: number,
  maxPrequel: number,
  signal: AbortSignal,
): Promise<{ leaves: LeafCatalogItem[]; prequel: number[] } | null> {
  if (!catalog.length && !chunks.length) return null;
  const sender = resolveSender(signal);
  if (!sender) return null;
  const raw = await sender.send([{ role: 'user', content: buildPickPrompt(haystack, catalog, chunks, maxLeaves, maxPrequel) }]);
  const d = extractJsonObject<{ c?: unknown; p?: unknown; leaves?: unknown; prequels?: unknown }>(raw);
  if (!d) return null;
  const cIdx = parseOneBasedIndexes(d.c ?? d.leaves, catalog.length);
  const pIdx = parseOneBasedIndexes(d.p ?? d.prequels, chunks.length);
  return {
    leaves: cIdx.slice(0, maxLeaves).map(i => catalog[i]).filter(Boolean),
    prequel: pIdx.slice(0, maxPrequel),
  };
}

/**
 * 生成前补充召回。关键词抽段始终可用;LLM 选题受设置开关控制。
 * 失败只清槽。
 */
export async function runSupplementalRecall(): Promise<void> {
  let operation: ReturnType<typeof beginMemorySessionOperation> | null = null;
  try {
    if (!engineActiveHere() || apiSettings.summaryOnlyMode) {
      clearLlmPickInjection();
      return;
    }
    operation = beginMemorySessionOperation();
    operation.assertCurrent();
    const ctx = getContext();
    const chat = ctx?.chat ?? [];
    const prequelText = memory.rawPrequel?.text?.trim() ?? '';
    const chunks = splitPrequelChunks(prequelText);
    const cfg = apiSettings.llmPick;
    const maxLeaves = clamp(cfg.maxLeaves, 1, 12, 4);
    const maxPrequel = clamp(cfg.maxPrequelChunks, 1, 8, 3);
    const haystack = recentHaystack(chat);
    let prequelIdx = fitPrequelIndexesToBudget(
      chunks,
      pickPrequelByKeywords(chunks, haystack, maxPrequel),
      PREQUEL_TOKEN_BUDGET,
    );
    let pickedLeaves: LeafCatalogItem[] = [];

    if (cfg.enabled) {
      const catalog = buildLeafCatalog(derivedMeta.leaves, windowLeafIds(chat), CATALOG_CAP);
      try {
        const llm = await askLlmPick(catalog, chunks, haystack, maxLeaves, maxPrequel, operation.signal);
        operation.assertCurrent();
        if (llm) {
          pickedLeaves = llm.leaves;
          // 合法空数组表示模型明确判定“无相关前情”，不能回退到关键词误命中。
          prequelIdx = fitPrequelIndexesToBudget(chunks, llm.prequel, PREQUEL_TOKEN_BUDGET);
        }
      } catch (e) {
        if (isStaleMemorySessionError(e) || operation.signal.aborted) throw e;
        console.warn('[柏宝书] LLM 选材失败(保留关键词前情,放行生成):', e);
      }
    }

    operation.assertCurrent();
    writeLlmPickInjection(composeInjection(pickedLeaves, chunks, prequelIdx), pickDepth());
  } catch (e) {
    if (isStaleMemorySessionError(e) || operation?.signal.aborted) return;
    console.warn('[柏宝书] 选材召回失败(清空槽,放行生成):', e);
    clearLlmPickInjection();
  } finally {
    operation?.dispose();
  }
}
