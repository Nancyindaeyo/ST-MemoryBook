/** 时间标签允许跨行闭合;两个标签写成完整分支,不会交叉配对。 */
export function hideTimeFindRegex(startTag = 'bbs_start', endTag = 'bbs_end'): string {
  const start = `<${startTag}\\b[^>]*>[\\s\\S]*?<\\/${startTag}>`;
  const end = `<${endTag}\\b[^>]*>[\\s\\S]*?<\\/${endTag}>`;
  return `/${start}|${end}/gi`;
}
