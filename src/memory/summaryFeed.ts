/**
 * 摘要/总结喂给模型的正文选择。覆盖窗口、状态重放、世界书扫描仍用完整楼段;
 * 这里只决定哪些楼的正文进入 summary/resummary 提示词。
 */

export function filterSummaryFeedIndices<T extends {
  is_user?: boolean;
  is_system?: boolean;
  extra?: { type?: string; bbs_hidden?: boolean };
}>(
  chat: T[],
  indices: number[],
  aiOnly: boolean,
): number[] {
  if (!aiOnly) return indices;
  return indices.filter(i => isSummaryAiOutput(chat[i]));
}

/** 只总结 AI 输出时排除用户楼、旁白/系统楼;被隐藏的旧 AI 楼仍算正文。 */
function isSummaryAiOutput(message: {
  is_user?: boolean;
  is_system?: boolean;
  extra?: { type?: string; bbs_hidden?: boolean };
} | undefined): boolean {
  if (!message || message.is_user === true) return false;
  if (message.extra?.bbs_hidden) return true;
  if (message.is_system && message.extra?.type) return false;
  return true;
}

export function summaryFeedNote(aiOnly: boolean): string {
  return aiOnly
    ? '【说明】以下正文只含 AI 输出。用户行动已反映在上方已知状态中，不要补写或推断用户台词。\n\n'
    : '';
}
