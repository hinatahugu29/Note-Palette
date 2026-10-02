export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SNAP = 8;
export const TILE_GAP = 10;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** 端・他要素の辺への吸着 */
export function snapAxis(pos: number, size: number, edges: number[]): number {
  for (const e of edges) {
    if (Math.abs(pos - e) < SNAP) return e; // 先頭辺
    if (Math.abs(pos + size - e) < SNAP) return e - size; // 末尾辺
  }
  return pos;
}

/** 画面内に隙間なく並べるタイル配置(ids の順に左上から) */
export function computeTileRects(ids: string[], bw: number, bh: number): Map<string, Rect> {
  const n = ids.length;
  const out = new Map<string, Rect>();
  if (n === 0) return out;
  const aspect = (bw - TILE_GAP) / Math.max(1, bh - TILE_GAP);
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect))));
  const rows = Math.ceil(n / cols);
  const cw = (bw - TILE_GAP * (cols + 1)) / cols;
  const ch = (bh - TILE_GAP * (rows + 1)) / rows;
  ids.forEach((id, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.set(id, { x: TILE_GAP + c * (cw + TILE_GAP), y: TILE_GAP + r * (ch + TILE_GAP), w: cw, h: ch });
  });
  return out;
}
