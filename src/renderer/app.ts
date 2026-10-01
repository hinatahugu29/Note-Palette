import type { Board, ImageItem, Item, NoteApi, Tab } from '../shared/types.js';

declare global {
  interface Window {
    noteApi: NoteApi;
  }
}

const api = window.noteApi;

const COLOR_COUNT = 7;
const MIN_W = 180;
const MIN_H = 110;
const DEFAULT_W = 300;
const DEFAULT_H = 200;
const TILE_GAP = 10;
const SAVE_DELAY = 500;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const SNAP = 8;
const IMG_MAX_W = 320;

/** ボード上に置かれる要素(付箋 or 画像) */
type Box = Item | ImageItem;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PanelView {
  item: Item;
  el: HTMLElement;
  tabsEl: HTMLElement;
  bodyEl: HTMLElement;
  fontSizeEl: HTMLElement;
  areas: Map<string, HTMLTextAreaElement>;
}

interface ImageView {
  item: ImageItem;
  el: HTMLElement;
  url: string;
}

// ---------------------------------------------------------------- 状態

let board: Board;
let texts: Record<string, string> = {};
const views = new Map<string, PanelView>();
const imgViews = new Map<string, ImageView>();
let query = '';
let searchCursor = -1;

const boardEl = must<HTMLElement>('board');
const searchEl = must<HTMLInputElement>('search');
const searchInfoEl = must<HTMLElement>('search-info');
const statusEl = must<HTMLElement>('status');
const layoutBtn = must<HTMLButtonElement>('btn-layout');
const zoomBtn = must<HTMLButtonElement>('btn-zoom');
const viewMenu = must<HTMLElement>('view-menu');
const uniformFontSelect = must<HTMLSelectElement>('uniform-font-size');
const unifyFontBtn = must<HTMLButtonElement>('btn-unify-font');

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function uid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- 保存(自動・デバウンス)

let boardDirty = false;
const dirtyTabs = new Map<string, string>(); // tabId -> itemId
let saveTimer: number | undefined;
let inflight = 0;

function updateStatus(): void {
  const pending = boardDirty || dirtyTabs.size > 0 || inflight > 0;
  statusEl.textContent = pending ? '保存中…' : '保存済み';
  statusEl.classList.toggle('dirty', pending);
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), SAVE_DELAY);
  updateStatus();
}

function markBoardDirty(): void {
  boardDirty = true;
  scheduleSave();
}

function markTabDirty(itemId: string, tabId: string): void {
  dirtyTabs.set(tabId, itemId);
  scheduleSave();
}

async function saveNow(): Promise<void> {
  window.clearTimeout(saveTimer);
  const jobs: Promise<void>[] = [];
  if (boardDirty) {
    boardDirty = false;
    jobs.push(api.saveBoard(board));
  }
  for (const [tabId, itemId] of dirtyTabs) {
    jobs.push(api.saveTab(itemId, tabId, texts[tabId] ?? ''));
  }
  dirtyTabs.clear();
  inflight += jobs.length;
  updateStatus();
  try {
    await Promise.all(jobs);
  } catch (err) {
    statusEl.textContent = '保存エラー';
    console.error(err);
  } finally {
    inflight -= jobs.length;
    if (inflight === 0) updateStatus();
  }
}

// ---------------------------------------------------------------- 配置計算

function allBoxes(): Box[] {
  return [...board.items, ...board.images];
}

function elOf(id: string): HTMLElement | undefined {
  return views.get(id)?.el ?? imgViews.get(id)?.el;
}

function boardSize(): { w: number; h: number } {
  return { w: boardEl.clientWidth, h: boardEl.clientHeight };
}

/** 画面に収まるよう表示用に補正した自由配置の矩形 */
function freeRect(item: Box): Rect {
  const { w: bw, h: bh } = boardSize();
  const w = clamp(item.w, MIN_W, bw);
  const h = clamp(item.h, MIN_H, bh);
  return { x: clamp(item.x, 0, bw - w), y: clamp(item.y, 0, bh - h), w, h };
}

function tileRects(): Map<string, Rect> {
  const { w: bw, h: bh } = boardSize();
  const items = allBoxes();
  const n = items.length;
  const out = new Map<string, Rect>();
  if (n === 0) return out;
  const aspect = (bw - TILE_GAP) / Math.max(1, bh - TILE_GAP);
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect))));
  const rows = Math.ceil(n / cols);
  const cw = (bw - TILE_GAP * (cols + 1)) / cols;
  const ch = (bh - TILE_GAP * (rows + 1)) / rows;
  items.forEach((it, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.set(it.id, { x: TILE_GAP + c * (cw + TILE_GAP), y: TILE_GAP + r * (ch + TILE_GAP), w: cw, h: ch });
  });
  return out;
}

function layoutAll(): void {
  const { w: bw, h: bh } = boardSize();
  const tiles = board.view.layout === 'tile' ? tileRects() : null;
  const maxId = board.view.maximizedId;
  for (const box of allBoxes()) {
    const el = elOf(box.id);
    if (!el) continue;
    const isMax = box.id === maxId;
    const r: Rect = isMax ? { x: 0, y: 0, w: bw, h: bh } : (tiles?.get(box.id) ?? freeRect(box));
    const s = el.style;
    s.left = `${Math.round(r.x)}px`;
    s.top = `${Math.round(r.y)}px`;
    s.width = `${Math.round(r.w)}px`;
    s.height = `${Math.round(r.h)}px`;
    s.zIndex = isMax ? '100000' : String(box.z);
    el.classList.toggle('max', isMax);
    el.classList.toggle('gone', maxId !== null && !isMax);
    el.classList.toggle('tile', tiles !== null);
  }
  layoutBtn.textContent = board.view.layout === 'tile' ? 'タイル' : '自由配置';
  boardEl.style.setProperty('--zoom', String(board.view.zoom));
  zoomBtn.textContent = `表示 ${Math.round(board.view.zoom * 100)}%`;
}

function topZ(): number {
  return Math.max(0, ...allBoxes().map((i) => i.z));
}

function bringToFront(item: Box): void {
  const top = topZ();
  if (item.z === top && allBoxes().filter((i) => i.z === top).length === 1) return;
  item.z = top + 1;
  const el = elOf(item.id);
  if (el) el.style.zIndex = String(item.z);
  markBoardDirty();
}

// ---------------------------------------------------------------- パネル生成・描画

function createView(item: Item): PanelView {
  const root = el('div', `panel c${item.color}`);
  const header = el('div', 'header');
  const tabsEl = el('div', 'tabs');
  const addTab = el('button', 'add-tab', '+');
  addTab.title = 'タブを追加';
  const spacer = el('div', 'spacer');
  const actions = el('div', 'actions');
  const fontControl = el('div', 'font-control');
  const fontSizeEl = el('span', 'font-value', String(item.fontSize));
  const bodyEl = el('div', 'body');
  const resize = el('div', 'resize');

  const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', undefined, label);
    b.title = title;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  const smaller = el('button', undefined, 'A−');
  smaller.title = 'この付箋の文字を小さくする';
  smaller.addEventListener('click', (e) => changeFont(item, e.shiftKey ? -2 : -1));
  const larger = el('button', undefined, 'A+');
  larger.title = 'この付箋の文字を大きくする';
  larger.addEventListener('click', (e) => changeFont(item, e.shiftKey ? 2 : 1));
  fontSizeEl.title = 'この付箋の文字サイズ';
  fontControl.append(smaller, fontSizeEl, larger);
  actions.appendChild(fontControl);
  btn('●', '色を変更', () => cycleColor(item));
  const copyBtn = btn('⧉', 'アクティブなタブの本文をクリップボードへコピー', () => {
    const ta = views.get(item.id)?.areas.get(item.activeTab);
    void api.copyText(ta?.value ?? '').then(() => flashDone(copyBtn));
  });
  btn('⤢', '最大化 / 元に戻す (Esc)', () => toggleMax(item));
  btn('×', 'この付箋を削除(ゴミ箱フォルダへ移動)', () => void removePanel(item));

  addTab.addEventListener('click', () => addTabTo(item));
  header.append(tabsEl, addTab, spacer, actions);
  root.append(header, bodyEl, resize);
  boardEl.appendChild(root);

  const view: PanelView = { item, el: root, tabsEl, bodyEl, fontSizeEl, areas: new Map() };
  views.set(item.id, view);

  root.addEventListener(
    'pointerdown',
    () => {
      setActive(item);
      bringToFront(item);
    },
    true,
  );
  root.addEventListener('focusin', () => setActive(item));
  setupDrag(item, root, header);
  setupResize(item, resize);
  header.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button') || t.closest('.tab') || t.closest('input')) return;
    toggleMax(item);
  });

  root.style.setProperty('--fs', String(item.fontSize));
  for (const tab of item.tabs) ensureArea(view, tab);
  renderTabs(view);
  return view;
}

function ensureArea(view: PanelView, tab: Tab): HTMLTextAreaElement {
  let ta = view.areas.get(tab.id);
  if (ta) return ta;
  ta = el('textarea');
  ta.spellcheck = false;
  ta.value = texts[tab.id] ?? '';
  ta.addEventListener('input', () => {
    texts[tab.id] = ta!.value;
    markTabDirty(view.item.id, tab.id);
    if (query) runSearch(false);
  });
  ta.addEventListener('scroll', () => {
    if (tab.scroll !== ta!.scrollTop) {
      tab.scroll = ta!.scrollTop;
      markBoardDirty();
    }
  });
  ta.addEventListener('keydown', (e) => {
    // Notepad++ のように Tab で字下げ(フォーカス移動はしない)
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  });
  view.areas.set(tab.id, ta);
  view.bodyEl.appendChild(ta);
  return ta;
}

function tabMatches(tab: Tab): boolean {
  if (!query) return false;
  return tab.title.toLowerCase().includes(query) || (texts[tab.id] ?? '').toLowerCase().includes(query);
}

function renderTabs(view: PanelView): void {
  const { item, tabsEl } = view;
  tabsEl.textContent = '';
  for (const tab of item.tabs) {
    const t = el('div', 'tab');
    t.classList.toggle('active', tab.id === item.activeTab);
    t.classList.toggle('hit', tabMatches(tab));
    t.appendChild(el('span', 'title', tab.title));
    if (item.tabs.length > 1) {
      const close = el('span', 'close', '×');
      close.title = 'このタブを削除(ゴミ箱フォルダへ移動)';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        void removeTab(item, tab);
      });
      t.appendChild(close);
    }
    t.addEventListener('click', () => activateTab(item, tab.id, true));
    t.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      beginRename(item, tab, t);
    });
    tabsEl.appendChild(t);
  }
  for (const [id, ta] of view.areas) ta.classList.toggle('active', id === item.activeTab);
}

function activateTab(item: Item, tabId: string, focus: boolean): void {
  const view = views.get(item.id)!;
  if (item.activeTab !== tabId) {
    item.activeTab = tabId;
    markBoardDirty();
  }
  renderTabs(view);
  const ta = view.areas.get(tabId)!;
  const tab = item.tabs.find((t) => t.id === tabId)!;
  requestAnimationFrame(() => {
    ta.scrollTop = tab.scroll;
    if (focus) ta.focus();
  });
}

function beginRename(item: Item, tab: Tab, tabEl: HTMLElement): void {
  const input = el('input');
  input.value = tab.title;
  tabEl.textContent = '';
  tabEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== tab.title) {
      tab.title = v;
      markBoardDirty();
    }
    renderTabs(views.get(item.id)!);
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------- 操作(ドラッグ・リサイズ)

function trackPointer(e: PointerEvent, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    onMove(dx, dy);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (moved) onEnd();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** 端・他要素の辺への吸着 */
function snapAxis(pos: number, size: number, edges: number[]): number {
  for (const e of edges) {
    if (Math.abs(pos - e) < SNAP) return e; // 先頭辺
    if (Math.abs(pos + size - e) < SNAP) return e - size; // 末尾辺
  }
  return pos;
}

function edgesOf(self: Box, axis: 'x' | 'y'): number[] {
  const { w: bw, h: bh } = boardSize();
  const out = [0, axis === 'x' ? bw : bh];
  for (const b of allBoxes()) {
    if (b === self) continue;
    const r = freeRect(b);
    out.push(axis === 'x' ? r.x : r.y, axis === 'x' ? r.x + r.w : r.y + r.h);
  }
  return out;
}

function setupDrag(item: Box, el: HTMLElement, header: HTMLElement): void {
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || board.view.maximizedId) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    if (board.view.layout === 'tile') {
      startTileReorder(e, item, el);
      return;
    }
    const r = freeRect(item);
    Object.assign(item, { x: r.x, y: r.y, w: r.w, h: r.h });
    const { w: bw, h: bh } = boardSize();
    const ex = edgesOf(item, 'x');
    const ey = edgesOf(item, 'y');
    trackPointer(
      e,
      (dx, dy) => {
        item.x = clamp(snapAxis(r.x + dx, item.w, ex), 0, bw - item.w);
        item.y = clamp(snapAxis(r.y + dy, item.h, ey), 0, bh - item.h);
        layoutAll();
      },
      markBoardDirty,
    );
  });
}

/** タイル表示中: 付箋を別のタイルへドロップして並べ替える */
function startTileReorder(e: PointerEvent, item: Box, el: HTMLElement): void {
  const tiles = tileRects();
  const boardRect = boardEl.getBoundingClientRect();
  let target: Box | null = null;
  const targetAt = (cx: number, cy: number): Box | null => {
    const x = cx - boardRect.left;
    const y = cy - boardRect.top;
    for (const b of allBoxes()) {
      const r = tiles.get(b.id);
      if (b !== item && r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return b;
    }
    return null;
  };
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    moved = true;
    el.classList.add('dragging');
    if (target) elOf(target.id)?.classList.remove('drop');
    target = targetAt(ev.clientX, ev.clientY);
    if (target) elOf(target.id)?.classList.add('drop');
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
    if (target) elOf(target.id)?.classList.remove('drop');
    if (moved && target) reorder(item, target);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** タイル配置の順(付箋→画像)を、from を to の位置へ移動して更新する */
function reorder(from: Box, to: Box): void {
  const list = allBoxes();
  const fi = list.indexOf(from);
  const ti = list.indexOf(to);
  if (fi < 0 || ti < 0 || fi === ti) return;
  list.splice(fi, 1);
  list.splice(ti, 0, from);
  board.items = list.filter((b): b is Item => 'tabs' in b);
  board.images = list.filter((b): b is ImageItem => 'file' in b);
  layoutAll();
  markBoardDirty();
}

function setupResize(item: Box, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = freeRect(item);
    Object.assign(item, { x: r.x, y: r.y, w: r.w, h: r.h });
    const { w: bw, h: bh } = boardSize();
    const ex = edgesOf(item, 'x');
    const ey = edgesOf(item, 'y');
    const snapEnd = (end: number, edges: number[]) => edges.find((v) => Math.abs(end - v) < SNAP) ?? end;
    trackPointer(
      e,
      (dx, dy) => {
        const right = snapEnd(item.x + r.w + dx, ex);
        const bottom = snapEnd(item.y + r.h + dy, ey);
        item.w = clamp(right - item.x, MIN_W, bw - item.x);
        item.h = clamp(bottom - item.y, MIN_H, bh - item.y);
        layoutAll();
      },
      markBoardDirty,
    );
  });
}

// ---------------------------------------------------------------- 付箋・タブの操作

function newTab(title: string): Tab {
  return { id: uid(), title, scroll: 0 };
}

function addPanel(x?: number, y?: number): void {
  const { w: bw, h: bh } = boardSize();
  const n = board.items.length;
  const top = topZ();
  const tab = newTab('メモ');
  const item: Item = {
    id: uid(),
    kind: 'panel',
    x: clamp(x ?? 40 + (n % 8) * 28, 0, bw - DEFAULT_W),
    y: clamp(y ?? 30 + (n % 8) * 28, 0, bh - DEFAULT_H),
    w: DEFAULT_W,
    h: DEFAULT_H,
    z: top + 1,
    color: n % COLOR_COUNT,
    fontSize: 14,
    tabs: [tab],
    activeTab: tab.id,
    mode: 'board',
  };
  texts[tab.id] = '';
  board.items.push(item);
  if (board.view.maximizedId) board.view.maximizedId = null;
  createView(item);
  layoutAll();
  markBoardDirty();
  markTabDirty(item.id, tab.id);
  activateTab(item, tab.id, true);
}

function addTabTo(item: Item): void {
  const tab = newTab(`タブ${item.tabs.length + 1}`);
  texts[tab.id] = '';
  item.tabs.push(tab);
  ensureArea(views.get(item.id)!, tab);
  markBoardDirty();
  markTabDirty(item.id, tab.id);
  activateTab(item, tab.id, true);
}

function hasText(tabs: Tab[]): boolean {
  return tabs.some((t) => (texts[t.id] ?? '').trim() !== '');
}

let activeId: string | null = null;

function setActive(item: Item): void {
  if (activeId === item.id) return;
  activeId = item.id;
  for (const v of views.values()) v.el.classList.toggle('current', v.item.id === activeId);
}

/** ショートカットの対象。最後に触った付箋、無ければ最前面の付箋 */
function activeItem(): Item | undefined {
  return (
    board.items.find((i) => i.id === activeId) ??
    [...board.items].sort((a, b) => b.z - a.z)[0]
  );
}

function newTabInActive(): void {
  const item = activeItem();
  if (item) addTabTo(item);
}

/** アクティブなタブを閉じる。最後の1つなら付箋ごと閉じる(中身があれば確認、trash に退避) */
function closeActiveTab(): void {
  const item = activeItem();
  if (!item) return;
  if (item.tabs.length <= 1) {
    void removePanel(item);
    return;
  }
  const tab = item.tabs.find((t) => t.id === item.activeTab);
  if (tab) void removeTab(item, tab);
}

function flashDone(b: HTMLButtonElement, mark = '✓'): void {
  const label = b.textContent;
  b.textContent = mark;
  window.setTimeout(() => (b.textContent = label), 900);
}

async function removeTab(item: Item, tab: Tab): Promise<void> {
  if (item.tabs.length <= 1) return;
  if (hasText([tab]) && !confirm(`タブ「${tab.title}」を削除しますか?\n(本文は保存フォルダ内の trash に移動されます)`)) return;
  await saveNow();
  const view = views.get(item.id)!;
  const idx = item.tabs.indexOf(tab);
  item.tabs.splice(idx, 1);
  view.areas.get(tab.id)?.remove();
  view.areas.delete(tab.id);
  delete texts[tab.id];
  dirtyTabs.delete(tab.id);
  if (item.activeTab === tab.id) item.activeTab = item.tabs[Math.min(idx, item.tabs.length - 1)].id;
  boardDirty = false;
  await api.saveBoard(board);
  await api.removeTab(item.id, tab.id);
  activateTab(item, item.activeTab, false);
}

async function removePanel(item: Item): Promise<void> {
  if (hasText(item.tabs) && !confirm('この付箋を削除しますか?\n(本文は保存フォルダ内の trash に移動されます)')) return;
  await saveNow();
  const view = views.get(item.id)!;
  view.el.remove();
  views.delete(item.id);
  board.items = board.items.filter((i) => i !== item);
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  for (const t of item.tabs) {
    delete texts[t.id];
    dirtyTabs.delete(t.id);
  }
  boardDirty = false;
  await api.saveBoard(board);
  await api.removeItem(item.id);
  layoutAll();
  runSearch(false);
}

function changeFont(item: Item, delta: number): void {
  item.fontSize = clamp(item.fontSize + delta, 8, 72);
  const view = views.get(item.id)!;
  view.el.style.setProperty('--fs', String(item.fontSize));
  view.fontSizeEl.textContent = String(item.fontSize);
  markBoardDirty();
}

function unifyFontSize(size: number): void {
  if (board.items.length === 0) return;
  for (const item of board.items) {
    item.fontSize = size;
    const view = views.get(item.id);
    view?.el.style.setProperty('--fs', String(size));
    if (view) view.fontSizeEl.textContent = String(size);
  }
  markBoardDirty();
  viewMenu.hidden = true;
}

function cycleColor(item: Item): void {
  item.color = (item.color + 1) % COLOR_COUNT;
  views.get(item.id)!.el.className = `panel c${item.color}`;
  layoutAll();
  markBoardDirty();
}

function toggleMax(item: Box): void {
  board.view.maximizedId = board.view.maximizedId === item.id ? null : item.id;
  layoutAll();
  markBoardDirty();
  if ('tabs' in item) views.get(item.id)?.areas.get(item.activeTab)?.focus();
}

// ---------------------------------------------------------------- 画像(ボードへ貼る)

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function createImageView(item: ImageItem, bytes: ArrayBuffer): void {
  const ext = item.file.split('.').pop() ?? 'png';
  const mime = Object.keys(MIME_EXT).find((m) => MIME_EXT[m] === ext) ?? 'image/png';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const root = el('div', 'imgitem');
  const header = el('div', 'header');
  const spacer = el('div', 'spacer');
  const actions = el('div', 'actions');
  const img = el('img');
  img.src = url;
  img.draggable = false;
  const resize = el('div', 'resize');

  const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', undefined, label);
    b.title = title;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  const copyBtn = btn('⧉', '画像をクリップボードへコピー', () => {
    void api.copyImage(item.file).then((ok) => (ok ? flashDone(copyBtn) : flashDone(copyBtn, '✗')));
  });
  btn('⤢', '最大化 / 元に戻す (Esc)', () => toggleMax(item));
  btn('×', 'この画像を削除(ゴミ箱フォルダへ移動)', () => void removeImage(item));
  header.append(spacer, actions);
  root.append(header, img, resize);
  boardEl.appendChild(root);
  imgViews.set(item.id, { item, el: root, url });

  root.addEventListener('pointerdown', () => bringToFront(item), true);
  setupDrag(item, root, header);
  setupResize(item, resize);
  header.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement).closest('button')) toggleMax(item);
  });
}

async function addImage(blob: Blob, ext: string, cx?: number, cy?: number): Promise<void> {
  const bytes = await blob.arrayBuffer();
  const bmp = await createImageBitmap(blob);
  const file = await api.saveImage(ext, bytes);
  const { w: bw, h: bh } = boardSize();
  const scale = Math.min(1, IMG_MAX_W / bmp.width, (bh - 40) / bmp.height);
  const w = Math.max(MIN_W, Math.round(bmp.width * scale));
  const h = Math.max(MIN_H, Math.round(bmp.height * scale) + 28);
  bmp.close();
  const item: ImageItem = {
    id: uid(),
    x: clamp(cx ?? 60 + board.images.length * 24, 0, bw - w),
    y: clamp(cy ?? 60 + board.images.length * 24, 0, bh - h),
    w,
    h,
    z: topZ() + 1,
    file,
  };
  board.images.push(item);
  if (board.view.maximizedId) board.view.maximizedId = null;
  createImageView(item, bytes);
  layoutAll();
  markBoardDirty();
}

async function removeImage(item: ImageItem): Promise<void> {
  const view = imgViews.get(item.id);
  if (!view) return;
  await saveNow();
  view.el.remove();
  URL.revokeObjectURL(view.url);
  imgViews.delete(item.id);
  board.images = board.images.filter((i) => i !== item);
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  boardDirty = false;
  await api.saveBoard(board);
  await api.removeImage(item.file);
  layoutAll();
}

function imageFilesOf(list: DataTransferItemList | FileList | null): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const it of Array.from(list as ArrayLike<DataTransferItem | File>)) {
    const f = it instanceof File ? it : it.kind === 'file' ? it.getAsFile() : null;
    if (f && MIME_EXT[f.type]) files.push(f);
  }
  return files;
}

function setZoom(z: number): void {
  board.view.zoom = Math.round(clamp(z, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  layoutAll();
  markBoardDirty();
}

// ---------------------------------------------------------------- 検索

function matchingItems(): Item[] {
  return board.items.filter((it) => it.tabs.some(tabMatches));
}

function runSearch(resetCursor: boolean): void {
  query = searchEl.value.trim().toLowerCase();
  if (resetCursor) searchCursor = -1;
  const hits = matchingItems();
  for (const v of views.values()) {
    v.el.classList.toggle('dim', query !== '' && !v.item.tabs.some(tabMatches));
    renderTabs(v);
  }
  searchInfoEl.textContent = query ? `${hits.length} 件の付箋` : '';
}

function jumpToNextHit(): void {
  const hits = matchingItems();
  if (hits.length === 0) return;
  searchCursor = (searchCursor + 1) % hits.length;
  const item = hits[searchCursor];
  const view = views.get(item.id)!;
  const tab = item.tabs.find(tabMatches)!;
  if (board.view.maximizedId && board.view.maximizedId !== item.id) {
    board.view.maximizedId = null;
    layoutAll();
  }
  bringToFront(item);
  activateTab(item, tab.id, false);
  view.el.classList.add('flash');
  window.setTimeout(() => view.el.classList.remove('flash'), 900);
  const ta = view.areas.get(tab.id)!;
  const pos = ta.value.toLowerCase().indexOf(query);
  if (pos >= 0) {
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos + query.length);
    });
  }
}

// ---------------------------------------------------------------- 起動

function bindGlobalEvents(): void {
  must('btn-new').addEventListener('click', () => addPanel());
  layoutBtn.addEventListener('click', () => {
    board.view.layout = board.view.layout === 'tile' ? 'free' : 'tile';
    layoutAll();
    markBoardDirty();
  });
  zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    viewMenu.hidden = !viewMenu.hidden;
  });
  must('zoom-out').addEventListener('click', () => setZoom(board.view.zoom / 1.1));
  must('zoom-reset').addEventListener('click', () => setZoom(1));
  must('zoom-in').addEventListener('click', () => setZoom(board.view.zoom * 1.1));
  viewMenu.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((button) => {
    button.addEventListener('click', () => setZoom(Number(button.dataset.zoom)));
  });
  uniformFontSelect.addEventListener('change', () => {
    unifyFontBtn.textContent = `すべてを${uniformFontSelect.value}pxに統一`;
  });
  unifyFontBtn.addEventListener('click', () => unifyFontSize(Number(uniformFontSelect.value)));
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#view-menu-wrap')) viewMenu.hidden = true;
  });

  boardEl.addEventListener('dblclick', (e) => {
    if (e.target !== boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    addPanel(e.clientX - rect.left - DEFAULT_W / 2, e.clientY - rect.top - 14);
  });

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(board.view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );
  window.addEventListener('resize', layoutAll);

  searchEl.addEventListener('input', () => runSearch(true));
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToNextHit();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      newTabInActive();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeActiveTab();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      addPanel();
    } else if (e.ctrlKey && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (e.key === 'Escape') {
      if (!viewMenu.hidden) {
        viewMenu.hidden = true;
      } else if (document.activeElement === searchEl || query) {
        searchEl.value = '';
        runSearch(true);
        searchEl.blur();
      } else if (board.view.maximizedId) {
        board.view.maximizedId = null;
        layoutAll();
        markBoardDirty();
      }
    }
  });

  // 画像: クリップボード貼り付け / ファイルのドロップ
  window.addEventListener('paste', (e) => {
    const files = imageFilesOf(e.clipboardData?.items ?? null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void addImage(f, MIME_EXT[f.type]);
  });
  boardEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  boardEl.addEventListener('drop', (e) => {
    const files = imageFilesOf(e.dataTransfer?.files ?? null);
    if (files.length === 0) return;
    e.preventDefault();
    const rect = boardEl.getBoundingClientRect();
    files.forEach((f, i) =>
      void addImage(f, MIME_EXT[f.type], e.clientX - rect.left - 100 + i * 24, e.clientY - rect.top - 14 + i * 24),
    );
  });

  api.onFlushRequest(saveNow);
}

async function main(): Promise<void> {
  const res = await api.load();
  board = res.board;
  texts = res.texts;
  bindGlobalEvents();
  for (const item of [...board.items].sort((a, b) => a.z - b.z)) createView(item);
  for (const img of [...board.images].sort((a, b) => a.z - b.z)) {
    const bytes = await api.readImage(img.file);
    if (bytes) createImageView(img, bytes);
  }
  layoutAll();
  for (const item of board.items) activateTab(item, item.activeTab, false);
  updateStatus();
  statusEl.textContent = '保存済み';
}

void main();
