/**
 * 本文の文字数・行数、選択範囲のフォーマット文字列を生成する
 */
export function formatMetrics(value: string, selStart?: number, selEnd?: number): string {
  if (selStart !== undefined && selEnd !== undefined && selStart !== selEnd) {
    const start = Math.min(selStart, selEnd);
    const end = Math.max(selStart, selEnd);
    const sel = value.slice(start, end);
    const selChars = [...sel].length;
    const selLines = sel.split('\n').length;
    return selLines > 1 ? `選択: ${selChars}文字 (${selLines}行)` : `選択: ${selChars}文字`;
  }
  const chars = [...value].length;
  const lines = value ? value.split('\n').length : 1;
  return `${chars}文字 ${lines}行`;
}
