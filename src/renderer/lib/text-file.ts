export const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'json', 'jsonl', 'xml', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'sql', 'py', 'java', 'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh',
  'ps1', 'bat', 'cmd', 'vue', 'svelte', 'svg', 'rtf',
]);

export function isTextFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('text/') || TEXT_EXT.has(ext);
}

export function decodeTextFile(bytes: ArrayBuffer): { text: string; encoding: string } {
  const data = new Uint8Array(bytes);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(data.subarray(3)), encoding: 'UTF-8 BOM' };
  }
  if (data[0] === 0xff && data[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(data.subarray(2)), encoding: 'UTF-16 LE' };
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(data.subarray(2)), encoding: 'UTF-16 BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(data), encoding: 'Shift_JIS' };
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
