/**
 * 摘要/总结喂给模型的正文选择。覆盖窗口、状态重放、世界书扫描仍用完整楼段;
 * 这里只决定哪些楼的正文进入 summary/resummary 提示词。
 */

export function filterSummaryFeedIndices<T extends { is_user?: boolean }>(
  chat: T[],
  indices: number[],
  aiOnly: boolean,
): number[] {
  if (!aiOnly) return indices;
  return indices.filter(i => {
    const message = chat[i];
    return !!message && message.is_user !== true;
  });
}

export function summaryFeedNote(aiOnly: boolean): string {
  return aiOnly
    ? '【说明】以下正文只含 AI 输出。用户行动已反映在上方已知状态中，不要补写或推断用户台词。\n\n'
    : '';
}
