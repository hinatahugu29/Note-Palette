import type { Board, ImageItem, Item, NoteApi, Tab } from '../shared/types.js';
import { el, must, uid } from './lib/dom.js';
import { SNAP, clamp, computeTileRects, snapAxis, type Rect } from './lib/geometry.js';
import { formatMetrics } from './lib/metrics.js';
import { decodeTextFile, formatSize, isTextFile } from './lib/text-file.js';

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
const SAVE_DELAY = 500;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const IMG_MAX_W = 320;
const LARGE_TEXT_FILE = 5 * 1024 * 1024;
const HUGE_TEXT_FILE = 50 * 1024 * 1024;
const HUGE_PREVIEW_SIZE = 5 * 1024 * 1024;

/** ボード上に置かれる要素（ノート or 画像） */
type Box = Item | ImageItem;

interface PanelView {
  item: Item;
  el: HTMLElement;
  titleEl: HTMLElement;
  tabsEl: HTMLElement;
  bodyEl: HTMLElement;
  countEl: HTMLElement;
  fontSizeEl: HTMLElement;
  pinBtn: HTMLButtonElement;
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
/** 削除処理中のページ/ノート/画像ID。保存待ちの間に同じ削除が重ねて走るのを防ぐ */
const pendingRemovals = new Set<string>();
let query = '';
let searchCursor = -1;

const boardEl = must<HTMLElement>('board');
const searchEl = must<HTMLInputElement>('search');
const searchInfoEl = must<HTMLElement>('search-info');
const searchResultsEl = must<HTMLElement>('search-results');
const statusEl = must<HTMLElement>('status');
const noticeEl = must<HTMLElement>('notice');
const noticeTextEl = must<HTMLElement>('notice-text');
const noticeActionEl = must<HTMLButtonElement>('notice-action');
const panelMenuEl = must<HTMLElement>('panel-menu');
const trashDialogEl = must<HTMLElement>('trash-dialog');
const trashListEl = must<HTMLElement>('trash-list');
const trashEmptyAllBtn = must<HTMLButtonElement>('trash-empty-all');
const archiveDockEl = must<HTMLElement>('archive-dock');
const archiveListEl = must<HTMLElement>('archive-list');
const archiveBadgeEl = must<HTMLElement>('archive-badge');
const archivePinEl = must<HTMLButtonElement>('archive-pin');
const dataMenuEl = must<HTMLElement>('data-menu');
const backupDialogEl = must<HTMLElement>('backup-dialog');
const backupListEl = must<HTMLElement>('backup-list');
const layoutBtn = must<HTMLButtonElement>('btn-layout');
const zoomBtn = must<HTMLButtonElement>('btn-zoom');
const viewMenu = must<HTMLElement>('view-menu');
const helpMenu = must<HTMLElement>('help-menu');
const uniformFontSelect = must<HTMLSelectElement>('uniform-font-size');
const unifyFontBtn = must<HTMLButtonElement>('btn-unify-font');

let noticeTimer: number | undefined;
let panelMenuItem: Item | null = null;
function showNotice(message: string): void {
  window.clearTimeout(noticeTimer);
  noticeTextEl.textContent = message;
  noticeActionEl.hidden = true;
  noticeActionEl.onclick = null;
  noticeEl.hidden = false;
  noticeTimer = window.setTimeout(() => (noticeEl.hidden = true), 1800);
}

/** undo が文字列を返した場合は、それを結果メッセージとして表示する(戻せなかった理由など) */
function showUndo(message: string, undo: () => Promise<string | void>): void {
  window.clearTimeout(noticeTimer);
  noticeTextEl.textContent = message;
  noticeActionEl.textContent = '元に戻す';
  noticeActionEl.hidden = false;
  noticeActionEl.disabled = false;
  noticeActionEl.onclick = () => {
    noticeActionEl.disabled = true;
    void undo()
      .then((result) => showNotice(result || '元に戻しました'))
      .catch((err) => {
        console.error(err);
        showNotice('元に戻せませんでした');
      });
  };
  noticeEl.hidden = false;
  noticeTimer = window.setTimeout(() => (noticeEl.hidden = true), 6000);
}

function openPanelMenu(item: Item, anchor: HTMLElement): void {
  panelMenuItem = item;
  const activeTab = item.tabs.find((tab) => tab.id === item.activeTab);
  const sourceButton = panelMenuEl.querySelector<HTMLButtonElement>('[data-action="source"]');
  if (sourceButton) sourceButton.hidden = !activeTab?.source;
  const rect = anchor.getBoundingClientRect();
  panelMenuEl.hidden = false;
  const width = panelMenuEl.offsetWidth;
  const height = panelMenuEl.offsetHeight;
  panelMenuEl.style.left = `${clamp(rect.right - width, 6, window.innerWidth - width - 6)}px`;
  panelMenuEl.style.top = `${clamp(rect.bottom + 3, 6, window.innerHeight - height - 6)}px`;
}

async function openTrash(): Promise<void> {
  trashDialogEl.hidden = false;
  trashListEl.textContent = '';
  trashListEl.appendChild(el('div', 'trash-empty', '読み込み中…'));
  const entries = await api.listTrash();
  trashEmptyAllBtn.disabled = entries.length === 0;
  trashListEl.textContent = '';
  if (entries.length === 0) {
    trashListEl.appendChild(el('div', 'trash-empty', '復元できる項目はありません'));
    return;
  }
  const kindLabel = { item: 'ノート', tab: 'ページ', image: '画像' } as const;
  for (const entry of entries) {
    const row = el('div', 'trash-row');
    const info = el('div', 'trash-info');
    info.append(
      el('div', 'trash-name', entry.title),
      el('div', 'trash-meta', `${kindLabel[entry.kind]}・${new Date(entry.deletedAt).toLocaleString('ja-JP')}`),
    );
    const restore = el('button', undefined, '復元');
    restore.addEventListener('click', () => {
      restore.disabled = true;
      void restoreTrashEntry(entry.name).then(() => openTrash());
    });
    row.append(info, restore);
    trashListEl.appendChild(row);
  }
}

function updateArchiveBadge(): void {
  const count = board.items.filter((item) => item.archived).length;
  archiveBadgeEl.textContent = String(count);
  archiveBadgeEl.hidden = count === 0;
}

function renderArchiveDock(): void {
  archiveListEl.textContent = '';
  const archived = board.items.filter((item) => item.archived);
  if (archived.length === 0) {
    archiveListEl.appendChild(el('div', 'archive-empty', '収納中のノートはありません'));
    return;
  }
  for (const item of archived) {
    const chip = el('button', 'archive-chip');
    chip.title = `${item.title}(${item.tabs.length}ページ)クリックでボードへ戻す`;
    chip.append(
      el('span', 'archive-chip-title', item.title),
      el('span', 'archive-chip-meta', `${item.tabs.length} ページ`),
    );
    chip.addEventListener('click', () => {
      item.archived = false;
      item.z = topZ() + 1;
      createView(item);
      layoutAll();
      setActive(item);
      activateTab(item, item.activeTab, true);
      markBoardDirty();
      renderArchiveDock();
      updateArchiveBadge();
      showNotice('ノートをボードへ戻しました');
    });
    archiveListEl.appendChild(chip);
  }
}

function setArchiveDockOpen(open: boolean): void {
  if (open) renderArchiveDock();
  archiveDockEl.classList.toggle('open', open);
}

function toggleArchiveDock(): void {
  setArchiveDockOpen(!archiveDockEl.classList.contains('open'));
}

function toggleArchivePinned(): void {
  board.view.archivePinned = !board.view.archivePinned;
  archivePinEl.setAttribute('aria-pressed', String(board.view.archivePinned));
  markBoardDirty();
  if (board.view.archivePinned) setArchiveDockOpen(true);
}

async function openBackups(): Promise<void> {
  backupDialogEl.hidden = false;
  backupListEl.textContent = '';
  backupListEl.appendChild(el('div', 'trash-empty', '読み込み中…'));
  const backups = await api.listBackups();
  backupListEl.textContent = '';
  if (backups.length === 0) {
    backupListEl.appendChild(el('div', 'trash-empty', '利用できるバックアップはありません'));
    return;
  }
  for (const backup of backups) {
    const row = el('div', 'trash-row');
    const info = el('div', 'trash-info');
    info.append(
      el('div', 'trash-name', new Date(backup.createdAt).toLocaleString('ja-JP')),
      el('div', 'trash-meta', `${backup.itemCount}ノート・${backup.tabCount}ページ`),
    );
    const restore = el('button', undefined, 'この時点へ戻す');
    restore.addEventListener('click', () => {
      if (!confirm('現在の状態を退避して、このバックアップへ戻しますか?')) return;
      restore.disabled = true;
      void saveNow()
        .then((saved) => {
          if (!saved) throw new Error('save before restore failed');
          return api.restoreBackup(backup.name);
        })
        .then((ok) => {
          if (!ok) throw new Error('backup restore failed');
          location.reload();
        })
        .catch((err) => {
          console.error(err);
          restore.disabled = false;
          showNotice('バックアップを復元できませんでした');
        });
    });
    row.append(info, restore);
    backupListEl.appendChild(row);
  }
}

async function runDataAction(action: string): Promise<void> {
  dataMenuEl.hidden = true;
  try {
    if (action === 'backups') {
      await openBackups();
    } else if (action === 'archive-export') {
      if (!(await saveNow())) throw new Error('save before export failed');
      const saved = await api.exportArchive();
      if (saved) showNotice('ZIPバックアップを保存しました');
    } else if (action === 'archive-import') {
      if (!confirm('現在の状態を退避して、ZIPバックアップの内容へ入れ替えますか?')) return;
      if (!(await saveNow())) throw new Error('save before import failed');
      if (await api.importArchive()) location.reload();
    } else if (action === 'text-export') {
      if (!(await saveNow())) throw new Error('save before export failed');
      const folder = await api.exportAllText();
      if (folder) showNotice('全ノートを書き出しました');
    } else if (action === 'open-folder') {
      const error = await api.openDataFolder();
      if (error) throw new Error(error);
    }
  } catch (err) {
    console.error(err);
    showNotice('データ操作に失敗しました');
  }
}

async function restoreTrashEntry(trashName: string): Promise<void> {
  const result = await api.restoreTrash(trashName);
  if (!result) {
    showNotice('復元できませんでした');
    return;
  }
  let message = 'ゴミ箱から復元しました';
  if (result.kind === 'item') {
    if (board.items.some((item) => item.id === result.item.id)) {
      showNotice('同じノートがあるため復元できません');
      return;
    }
    result.item.z = topZ() + 1;
    // 削除済みのノートに開いている別窓は無いので、必ずボード側で扱う
    result.item.mode = 'board';
    board.items.push(result.item);
    Object.assign(texts, result.texts);
    if (result.item.archived) {
      message = `ノート「${result.item.title}」を収納に復元しました`;
    } else {
      createView(result.item);
      layoutAll();
      setActive(result.item);
      activateTab(result.item, result.item.activeTab, true);
    }
  } else if (result.kind === 'tab') {
    let target = board.items.find((candidate) => candidate.id === result.itemId);
    if (target?.mode === 'detached') {
      // 別窓がノートの状態を持っているため、ボード側でページを足しても別窓の保存で上書きされて消える。
      // 取り出したファイルはゴミ箱へ戻し、ボードへ戻してから復元してもらう。
      const retrashed = await api.removeTab(target.id, result.tab).catch(() => null);
      if (retrashed) {
        showNotice('別窓で開いているノートのページです。ボードに戻してから復元してください');
        return;
      }
      // ゴミ箱へ戻せなかった場合は、本文を失わないよう新しいノートとして復元する
      const itemId = uid();
      await api.saveTab(itemId, result.tab.id, result.text);
      result.itemId = itemId;
      target = undefined;
    }
    if (!target) {
      const { w: bw, h: bh } = boardSize();
      const recovered: Item = {
        id: result.itemId,
        kind: 'panel',
        title: `復元: ${result.tab.title}`,
        x: clamp(60, 0, bw - DEFAULT_W),
        y: clamp(50, 0, bh - DEFAULT_H),
        w: DEFAULT_W,
        h: DEFAULT_H,
        z: topZ() + 1,
        color: board.items.length % COLOR_COUNT,
        fontSize: 14,
        archived: false,
        pinned: false,
        tabs: [],
        activeTab: result.tab.id,
        mode: 'board',
      };
      board.items.push(recovered);
      createView(recovered);
      target = recovered;
    }
    const item = target;
    if (!item.tabs.some((tab) => tab.id === result.tab.id)) item.tabs.push(result.tab);
    texts[result.tab.id] = result.text;
    const view = views.get(item.id);
    if (view) {
      ensureArea(view, result.tab);
      renderTabs(view);
      setActive(item);
      activateTab(item, result.tab.id, true);
      layoutAll();
    } else {
      // 収納中のノートは画面に無いので、データだけ戻す(取り出し時に表示される)
      message = `収納中のノート「${item.title}」にページを復元しました`;
    }
  } else {
    if (board.images.some((image) => image.id === result.image.id)) {
      showNotice('同じ画像があるため復元できません');
      return;
    }
    const bytes = await api.readImage(result.image.file);
    if (!bytes) {
      showNotice('画像ファイルを読み込めませんでした');
      return;
    }
    result.image.z = topZ() + 1;
    board.images.push(result.image);
    createImageView(result.image, bytes);
    layoutAll();
  }
  await api.saveBoard(board);
  runSearch(false);
  updateArchiveBadge();
  if (archiveDockEl.classList.contains('open')) renderArchiveDock();
  showNotice(message);
}

// ---------------------------------------------------------------- 保存(自動・デバウンス)

let boardDirty = false;
const dirtyTabs = new Map<string, string>(); // tabId -> itemId
let saveTimer: number | undefined;
let inflight = 0;
let saveError = false;

function updateStatus(): void {
  const pending = boardDirty || dirtyTabs.size > 0 || inflight > 0;
  statusEl.textContent = saveError ? '保存エラー・再試行' : pending ? '保存中…' : '保存済み';
  statusEl.classList.toggle('dirty', pending);
  statusEl.classList.toggle('error', saveError);
  statusEl.title = saveError ? 'クリックして保存を再試行' : '保存状態';
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

async function saveNow(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  const saveBoard = boardDirty;
  const tabs = [...dirtyTabs];
  const jobs: Promise<void>[] = [];
  if (saveBoard) {
    boardDirty = false;
    jobs.push(api.saveBoard(board));
  }
  for (const [tabId, itemId] of tabs) {
    jobs.push(api.saveTab(itemId, tabId, texts[tabId] ?? ''));
    if (dirtyTabs.get(tabId) === itemId) dirtyTabs.delete(tabId);
  }
  inflight += jobs.length;
  updateStatus();
  try {
    await Promise.all(jobs);
    saveError = false;
    return true;
  } catch (err) {
    if (saveBoard) boardDirty = true;
    for (const [tabId, itemId] of tabs) {
      const stillExists = board.items.some((item) => item.id === itemId && item.tabs.some((tab) => tab.id === tabId));
      if (stillExists) dirtyTabs.set(tabId, itemId);
    }
    saveError = true;
    showNotice('保存できませんでした。右上の保存エラーから再試行できます');
    console.error(err);
    return false;
  } finally {
    inflight -= jobs.length;
    if (inflight === 0) updateStatus();
  }
}

// ---------------------------------------------------------------- 配置計算

function allBoxes(): Box[] {
  return [...board.items.filter((item) => !item.archived && item.mode === 'board'), ...board.images];
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
  return computeTileRects(allBoxes().map((box) => box.id), bw, bh);
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
    const maxBtn = el.querySelector('.max-btn');
    if (maxBtn) {
      maxBtn.textContent = isMax ? '⤡' : '⤢';
      maxBtn.setAttribute('title', isMax ? '元に戻す (Esc)' : '最大化 (Esc で戻る)');
    }
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

function updatePanelMetrics(view: PanelView): void {
  const ta = view.areas.get(view.item.activeTab);
  if (!ta) return;
  view.countEl.textContent = formatMetrics(ta.value, ta.selectionStart, ta.selectionEnd);
}

function createView(item: Item): PanelView {
  const root = el('div', `panel c${item.color}`);
  const header = el('div', 'header');
  const titleEl = el('div', 'item-title', item.title);
  titleEl.title = 'ノート名（ダブルクリックで変更）';
  const tabsEl = el('div', 'tabs');
  const addTab = el('button', 'add-tab', '+');
  addTab.title = 'ページを追加';
  const spacer = el('div', 'spacer');
  const actions = el('div', 'actions');
  const fontControl = el('div', 'font-control');
  const fontSizeEl = el('span', 'font-value', String(item.fontSize));
  const bodyEl = el('div', 'body');
  const footerEl = el('div', 'panel-footer');
  const countEl = el('span', 'count-info', '0文字 1行');
  footerEl.appendChild(countEl);
  const resize = el('div', 'resize');

  const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', undefined, label);
    b.title = title;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  const smaller = el('button', undefined, 'A−');
  smaller.title = 'このノートの文字を小さくする';
  smaller.addEventListener('click', (e) => changeFont(item, e.shiftKey ? -2 : -1));
  const larger = el('button', undefined, 'A+');
  larger.title = 'このノートの文字を大きくする';
  larger.addEventListener('click', (e) => changeFont(item, e.shiftKey ? 2 : 1));
  fontSizeEl.title = 'このノートの文字サイズ';
  fontControl.append(smaller, fontSizeEl, larger);
  actions.appendChild(fontControl);
  const pinBtn = btn('📌', '', () => togglePin(item));
  pinBtn.classList.add('pin');
  pinBtn.classList.toggle('active', item.pinned);
  pinBtn.title = item.pinned ? '保護を解除' : 'このノートを閉じないよう保護';
  const copyBtn = btn('⧉', '現在のページの本文をクリップボードへコピー', () => {
    const ta = views.get(item.id)?.areas.get(item.activeTab);
    void api.copyText(ta?.value ?? '').then(() => flashDone(copyBtn));
  });
  copyBtn.classList.add('copy');
  const maxBtn = btn('⤢', '最大化 / 元に戻す (Esc)', () => toggleMax(item));
  maxBtn.classList.add('max-btn');
  const menuBtn = btn('⋯', 'その他の操作', () => openPanelMenu(item, menuBtn));
  menuBtn.classList.add('menu-btn');
  addTab.addEventListener('click', () => addTabTo(item));
  tabsEl.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY !== 0) {
        tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  header.append(titleEl, tabsEl, addTab, spacer, actions);
  root.append(header, bodyEl, footerEl, resize);
  boardEl.appendChild(root);

  const view: PanelView = { item, el: root, titleEl, tabsEl, bodyEl, countEl, fontSizeEl, pinBtn, areas: new Map() };
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
    if (t.closest('button') || t.closest('.tab') || t.closest('.item-title') || t.closest('input')) return;
    toggleMax(item);
  });
  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    beginItemRename(item);
  });

  root.style.setProperty('--fs', String(item.fontSize));
  for (const tab of item.tabs) ensureArea(view, tab);
  renderTabs(view);
  updatePanelMetrics(view);
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
    updatePanelMetrics(view);
  });
  ta.addEventListener('select', () => updatePanelMetrics(view));
  ta.addEventListener('keyup', () => updatePanelMetrics(view));
  ta.addEventListener('pointerup', () => updatePanelMetrics(view));
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

let draggingTabInfo: { itemId: string; tabId: string } | null = null;

function renderTabs(view: PanelView): void {
  const { item, tabsEl } = view;
  tabsEl.textContent = '';
  for (const tab of item.tabs) {
    const t = el('div', 'tab');
    t.dataset.tabId = tab.id;
    t.title = 'ページ名（ダブルクリックで変更、ドラッグで並び替え）';
    t.classList.toggle('active', tab.id === item.activeTab);
    t.classList.toggle('hit', tabMatches(tab));
    t.appendChild(el('span', 'title', tab.title));
    if (item.tabs.length > 1) {
      const close = el('span', 'close', '×');
      close.title = 'このページを削除（ゴミ箱へ移動）';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        void removeTab(item, tab);
      });
      t.appendChild(close);
    }
    // draggable を常時 true にすると、素早い連続クリックの2回目を
    // ブラウザがドラッグ開始と誤認し、dblclick が届かなくなる。
    // mousedown から一定時間経ってから初めて draggable にすることで、
    // ダブルクリックは奪われず、長押し後の移動だけドラッグとして扱う。
    t.draggable = false;
    let armTimer: number | undefined;
    const disarmDrag = () => {
      window.clearTimeout(armTimer);
      t.draggable = false;
    };
    t.addEventListener('mousedown', () => {
      armTimer = window.setTimeout(() => (t.draggable = true), 150);
    });
    t.addEventListener('mouseup', disarmDrag);
    t.addEventListener('mouseleave', disarmDrag);
    t.addEventListener('dragstart', (e) => {
      draggingTabInfo = { itemId: item.id, tabId: tab.id };
      e.dataTransfer?.setData('text/plain', tab.id);
      t.classList.add('dragging');
    });
    t.addEventListener('dragend', () => {
      disarmDrag();
      draggingTabInfo = null;
      t.classList.remove('dragging');
      tabsEl.querySelectorAll('.tab.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    t.addEventListener('dragover', (e) => {
      if (draggingTabInfo?.itemId === item.id && draggingTabInfo.tabId !== tab.id) {
        e.preventDefault();
        t.classList.add('drag-over');
      }
    });
    t.addEventListener('dragleave', () => {
      t.classList.remove('drag-over');
    });
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      t.classList.remove('drag-over');
      if (!draggingTabInfo || draggingTabInfo.itemId !== item.id || draggingTabInfo.tabId === tab.id) return;
      const fromIdx = item.tabs.findIndex((candidate) => candidate.id === draggingTabInfo!.tabId);
      const toIdx = item.tabs.indexOf(tab);
      if (fromIdx >= 0 && toIdx >= 0) {
        const [moved] = item.tabs.splice(fromIdx, 1);
        item.tabs.splice(toIdx, 0, moved);
        renderTabs(view);
        markBoardDirty();
      }
    });
    // 環境によっては draggable 要素への素早い連続クリックで、ブラウザ標準の
    // dblclick が発生しないことがある。タイムスタンプ差による自前判定にして、
    // ネイティブ dblclick の成立有無に左右されないようにする。
    let lastClickAt = 0;
    t.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - lastClickAt < 400) {
        lastClickAt = 0;
        e.stopPropagation();
        beginRename(item, tab, t);
        return;
      }
      lastClickAt = now;
      activateTab(item, tab.id, true);
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
  // どのノートが「今触っているノート」かは、後続の操作（Ctrl+Dやショートカット）が
  // 同期的に参照するため、ここで即時に確定させる。rAF 内まで遅らせると、別の
  // クリックで既に確定した setActive を古いコールバックが後から上書きしてしまう。
  if (focus) setActive(item);
  // クリックのたびにページDOMを作り直すと、1回目と2回目のクリック対象が
  // 別要素になり dblclick が成立しない。選択状態だけを更新する。
  let activeTabEl: HTMLElement | undefined;
  for (const tabEl of view.tabsEl.querySelectorAll<HTMLElement>('.tab')) {
    tabEl.classList.toggle('active', tabEl.dataset.tabId === tabId);
    if (tabEl.dataset.tabId === tabId) activeTabEl = tabEl;
  }
  for (const [id, area] of view.areas) area.classList.toggle('active', id === tabId);
  const ta = view.areas.get(tabId)!;
  const tab = item.tabs.find((t) => t.id === tabId)!;
  // ta.focus() を rAF まで遅らせると、フォーカスに連動する setActive（root の
  // focusin ハンドラ）が後から発火し、その間に行われた別の操作の setActive を
  // 上書きしてしまうことがある。フォーカス移動はレイアウト計測に依存しないため
  // 同期的に行う。スクロール位置の調整だけ、計測が必要な rAF 側に残す。
  if (focus) ta.focus();
  requestAnimationFrame(() => {
    if (activeTabEl) {
      const tabsRect = view.tabsEl.getBoundingClientRect();
      const activeRect = activeTabEl.getBoundingClientRect();
      if (activeRect.left < tabsRect.left) view.tabsEl.scrollLeft -= tabsRect.left - activeRect.left;
      else if (activeRect.right > tabsRect.right) view.tabsEl.scrollLeft += activeRect.right - tabsRect.right;
    }
    ta.scrollTop = tab.scroll;
    updatePanelMetrics(view);
  });
}

function beginActivePageRename(item: Item): void {
  const tab = item.tabs.find((candidate) => candidate.id === item.activeTab);
  const view = views.get(item.id);
  const tabEl = view
    ? Array.from(view.tabsEl.querySelectorAll<HTMLElement>('.tab')).find(
        (candidate) => candidate.dataset.tabId === tab?.id,
      )
    : undefined;
  if (tab && tabEl) beginRename(item, tab, tabEl);
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

function beginItemRename(item: Item): void {
  const view = views.get(item.id)!;
  const input = el('input');
  input.value = item.title;
  view.titleEl.textContent = '';
  view.titleEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value && value !== item.title) {
      item.title = value;
      markBoardDirty();
      if (query) runSearch(false);
    }
    view.titleEl.textContent = item.title;
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
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

/** タイル表示中: ノートを別のタイルへドロップして並べ替える */
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

/** タイル配置の順（ノート→画像）を、from を to の位置へ移動して更新する */
function reorder(from: Box, to: Box): void {
  const list = allBoxes();
  const archived = board.items.filter((item) => item.archived);
  const fi = list.indexOf(from);
  const ti = list.indexOf(to);
  if (fi < 0 || ti < 0 || fi === ti) return;
  list.splice(fi, 1);
  list.splice(ti, 0, from);
  board.items = [...list.filter((b): b is Item => 'tabs' in b), ...archived];
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

// ---------------------------------------------------------------- ノート・ページの操作

function newTab(title: string, source?: Tab['source']): Tab {
  return { id: uid(), title, scroll: 0, source };
}

function addPanel(x?: number, y?: number): void {
  const { w: bw, h: bh } = boardSize();
  const n = board.items.length;
  const top = topZ();
  const tab = newTab('ページ1');
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
    title: `ノート ${n + 1}`,
    archived: false,
    pinned: false,
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
  const tab = newTab(`ページ${item.tabs.length + 1}`);
  texts[tab.id] = '';
  item.tabs.push(tab);
  const view = views.get(item.id)!;
  ensureArea(view, tab);
  renderTabs(view);
  markBoardDirty();
  markTabDirty(item.id, tab.id);
  setActive(item);
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

/** ショートカットの対象。最後に触ったノート、無ければ最前面のノート */
function activeItem(): Item | undefined {
  return (
    board.items.find((i) => !i.archived && i.mode === 'board' && i.id === activeId) ??
    [...board.items].filter((item) => !item.archived && item.mode === 'board').sort((a, b) => b.z - a.z)[0]
  );
}

/** アクティブなノートのページを前後に巡回する（端では反対側へ） */
function cycleTabInActive(step: 1 | -1): void {
  const item = activeItem();
  if (!item || item.tabs.length < 2) return;
  const index = item.tabs.findIndex((tab) => tab.id === item.activeTab);
  const next = item.tabs[(index + step + item.tabs.length) % item.tabs.length];
  activateTab(item, next.id, true);
}

function newTabInActive(): void {
  const item = activeItem();
  if (item) addTabTo(item);
}

function duplicateActiveItem(): void {
  const source = activeItem();
  if (!source) return;
  const { w: bw, h: bh } = boardSize();
  const tabs = source.tabs.map((tab) => ({ ...tab, id: uid(), scroll: 0 }));
  const copy: Item = {
    ...source,
    id: uid(),
    title: `${source.title} のコピー`,
    x: clamp(source.x + 24, 0, bw - source.w),
    y: clamp(source.y + 24, 0, bh - source.h),
    z: topZ() + 1,
    archived: false,
    pinned: false,
    tabs,
    activeTab: tabs[source.tabs.findIndex((tab) => tab.id === source.activeTab)]?.id ?? tabs[0].id,
  };
  source.tabs.forEach((tab, index) => {
    texts[tabs[index].id] = texts[tab.id] ?? '';
    markTabDirty(copy.id, tabs[index].id);
  });
  board.items.push(copy);
  if (board.view.maximizedId) board.view.maximizedId = null;
  createView(copy);
  layoutAll();
  setActive(copy);
  markBoardDirty();
  showNotice('ノートを複製しました');
}

/** アクティブなページを閉じる。最後の1つならノートごと閉じる（中身があれば確認、trash に退避） */
function closeActiveTab(): void {
  const item = activeItem();
  if (!item) return;
  if (item.pinned) {
    showNotice('ピン留め中のため閉じません');
    return;
  }
  if (item.tabs.length <= 1) {
    void removePanel(item);
    return;
  }
  const tab = item.tabs.find((t) => t.id === item.activeTab);
  if (tab) void removeTab(item, tab);
}

function togglePin(item: Item): void {
  item.pinned = !item.pinned;
  const view = views.get(item.id)!;
  view.pinBtn.classList.toggle('active', item.pinned);
  view.pinBtn.title = item.pinned ? '保護を解除' : 'このノートを閉じないよう保護';
  showNotice(item.pinned ? 'このノートをピン留めしました' : 'ピン留めを解除しました');
  markBoardDirty();
}

async function exportActiveTab(item = activeItem()): Promise<void> {
  if (!item) return;
  const tab = item.tabs.find((t) => t.id === item.activeTab);
  if (!tab) return;
  const savedPath = await api.exportText(tab.title, texts[tab.id] ?? '');
  if (savedPath) showNotice(`${savedPath.split(/[\\/]/).pop()} に書き出しました`);
}

function flashDone(b: HTMLButtonElement, mark = '✓'): void {
  const label = b.textContent;
  b.textContent = mark;
  window.setTimeout(() => (b.textContent = label), 900);
}

async function removeTab(item: Item, tab: Tab): Promise<void> {
  if (item.tabs.length <= 1 || pendingRemovals.has(tab.id)) return;
  if (
    (item.pinned || hasText([tab])) &&
    !confirm(`ページ「${tab.title}」を削除しますか?\n(本文は保存フォルダ内の trash に移動されます)`)
  ) return;
  // 保存待ちの間に Ctrl+W の連打などで同じページの削除がもう一度走ると、
  // indexOf が -1 になり別のページを消してしまうため、処理中は受け付けない
  pendingRemovals.add(tab.id);
  try {
    if (!(await saveNow())) return;
    // 待ちの間にノートが削除・収納・別窓化されていないか確かめる
    const view = views.get(item.id);
    const idx = item.tabs.indexOf(tab);
    if (!view || idx < 0 || item.tabs.length <= 1 || !board.items.includes(item)) return;
    const deletedText = texts[tab.id] ?? '';
    item.tabs.splice(idx, 1);
    view.areas.get(tab.id)?.remove();
    view.areas.delete(tab.id);
    delete texts[tab.id];
    dirtyTabs.delete(tab.id);
    if (item.activeTab === tab.id) item.activeTab = item.tabs[Math.min(idx, item.tabs.length - 1)].id;
    // activateTab は選択状態の切り替えのみなので、見出しDOMはここで作り直す
    renderTabs(view);
    activateTab(item, item.activeTab, false);
    boardDirty = false;
    await api.saveBoard(board);
    const trashName = await api.removeTab(item.id, tab);
    showUndo(`ページ「${tab.title}」を削除しました`, () =>
      undoRemoveTab(item.id, tab, idx, deletedText, trashName),
    );
  } finally {
    pendingRemovals.delete(tab.id);
  }
}

/** ページ削除の取り消し。削除後にノートの状態が変わっていることがあるので、押された時点で確かめ直す */
async function undoRemoveTab(
  itemId: string,
  tab: Tab,
  idx: number,
  deletedText: string,
  trashName: string | null,
): Promise<string | void> {
  const item = board.items.find((candidate) => candidate.id === itemId);
  if (!item) return 'ノートが削除されているため元に戻せませんでした';
  if (item.mode === 'detached') return '別窓で開いているため元に戻せません。ボードに戻してからゴミ箱で復元してください';
  if (item.tabs.some((candidate) => candidate.id === tab.id)) return 'このページはすでに復元されています';
  item.tabs.splice(Math.min(idx, item.tabs.length), 0, tab);
  texts[tab.id] = deletedText;
  const view = views.get(item.id);
  if (view) {
    ensureArea(view, tab);
    renderTabs(view);
    activateTab(item, tab.id, true);
  }
  if (!trashName || !(await api.restoreTab(trashName, item.id, tab.id))) {
    await api.saveTab(item.id, tab.id, deletedText);
  }
  await api.saveBoard(board);
  if (!view) return `収納中のノート「${item.title}」にページを戻しました`;
}

async function removePanel(item: Item): Promise<void> {
  if (pendingRemovals.has(item.id)) return;
  if (
    (item.pinned || hasText(item.tabs)) &&
    !confirm('このノートを削除しますか?\n(本文は保存フォルダ内の trash に移動されます)')
  ) return;
  pendingRemovals.add(item.id);
  try {
    await removePanelNow(item);
  } finally {
    pendingRemovals.delete(item.id);
  }
}

async function removePanelNow(item: Item): Promise<void> {
  if (!(await saveNow())) return;
  const itemIndex = board.items.indexOf(item);
  const view = views.get(item.id);
  if (!view || itemIndex < 0) return;
  const deletedTexts = Object.fromEntries(item.tabs.map((tab) => [tab.id, texts[tab.id] ?? '']));
  view.el.remove();
  views.delete(item.id);
  board.items = board.items.filter((i) => i !== item);
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  if (activeId === item.id) activeId = null;
  for (const t of item.tabs) {
    delete texts[t.id];
    dirtyTabs.delete(t.id);
  }
  layoutAll();
  runSearch(false);
  boardDirty = false;
  await api.saveBoard(board);
  const trashName = await api.removeItem(item);
  showUndo('ノートを削除しました', async () => {
    // ゴミ箱ダイアログから先に復元されていると二重になる
    if (board.items.some((candidate) => candidate.id === item.id)) return 'このノートはすでに復元されています';
    board.items.splice(Math.min(itemIndex, board.items.length), 0, item);
    Object.assign(texts, deletedTexts);
    if (!trashName || !(await api.restoreItem(trashName, item.id))) {
      await Promise.all(item.tabs.map((tab) => api.saveTab(item.id, tab.id, deletedTexts[tab.id])));
    }
    createView(item);
    layoutAll();
    await api.saveBoard(board);
    setActive(item);
    activateTab(item, item.activeTab, true);
  });
}

function archiveItem(item: Item): void {
  const view = views.get(item.id);
  if (!view) return;
  item.archived = true;
  view.el.remove();
  views.delete(item.id);
  if (activeId === item.id) activeId = null;
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  layoutAll();
  runSearch(false);
  markBoardDirty();
  updateArchiveBadge();
  if (archiveDockEl.classList.contains('open')) renderArchiveDock();
  showNotice('ノートを収納しました');
}

async function detachItem(item: Item): Promise<void> {
  if (!(await saveNow())) return;
  const view = views.get(item.id);
  if (!view) return;
  item.mode = 'detached';
  item.detached ??= { width: Math.max(320, item.w), height: Math.max(220, item.h), alwaysOnTop: false };
  view.el.remove();
  views.delete(item.id);
  if (activeId === item.id) activeId = null;
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  await api.saveBoard(board);
  layoutAll();
  runSearch(false);
  if (!(await api.openDetached(item.id))) {
    item.mode = 'board';
    createView(item);
    layoutAll();
    await api.saveBoard(board);
    showNotice('ノートをウィンドウに出せませんでした');
  }
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
  for (const item of board.items.filter((candidate) => !candidate.archived && candidate.mode === 'board')) {
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
  const root = views.get(item.id)!.el;
  for (let i = 0; i < COLOR_COUNT; i++) root.classList.remove(`c${i}`);
  root.classList.add(`c${item.color}`);
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
  btn('⤢', '最大化 / 元に戻す (Esc)', () => toggleMax(item)).classList.add('max-btn');
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
  if (pendingRemovals.has(item.id)) return;
  pendingRemovals.add(item.id);
  try {
    await removeImageNow(item);
  } finally {
    pendingRemovals.delete(item.id);
  }
}

async function removeImageNow(item: ImageItem): Promise<void> {
  if (!imgViews.has(item.id)) return;
  if (!(await saveNow())) return;
  const bytes = await api.readImage(item.file);
  // 待ちの間に状態が変わっていないか確かめる
  const view = imgViews.get(item.id);
  const imageIndex = board.images.indexOf(item);
  if (!view || imageIndex < 0) return;
  view.el.remove();
  URL.revokeObjectURL(view.url);
  imgViews.delete(item.id);
  board.images = board.images.filter((i) => i !== item);
  if (board.view.maximizedId === item.id) board.view.maximizedId = null;
  layoutAll();
  boardDirty = false;
  await api.saveBoard(board);
  const trashName = await api.removeImage(item);
  showUndo('画像を削除しました', async () => {
    if (board.images.some((image) => image.id === item.id)) return 'この画像はすでに復元されています';
    let restored = Boolean(trashName && (await api.restoreImage(trashName, item.file)));
    let restoredBytes = bytes;
    if (!restored && bytes) {
      const ext = item.file.split('.').pop() ?? 'png';
      item.file = await api.saveImage(ext, bytes);
      restored = true;
    }
    if (!restoredBytes && restored) restoredBytes = await api.readImage(item.file);
    if (!restored || !restoredBytes) throw new Error('image restore failed');
    board.images.splice(Math.min(imageIndex, board.images.length), 0, item);
    createImageView(item, restoredBytes);
    layoutAll();
    await api.saveBoard(board);
  });
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

async function addTextFiles(files: File[], cx?: number, cy?: number): Promise<void> {
  if (files.length === 0) return;
  const huge = files.filter((file) => file.size > HUGE_TEXT_FILE);
  if (
    huge.length > 0 &&
    !confirm(
      `${huge.map((file) => `${file.name} (${formatSize(file.size)})`).join('\n')}\n\n` +
      '非常に大きなファイルです。OKを押すと先頭5MBだけをプレビューとして取り込みます。',
    )
  ) return;
  const large = files.filter((file) => file.size > LARGE_TEXT_FILE && file.size <= HUGE_TEXT_FILE);
  if (
    large.length > 0 &&
    !confirm(
      `${large.map((file) => `${file.name} (${formatSize(file.size)})`).join('\n')}\n\n` +
      '大きなファイルです。表示・検索・自動保存が重くなる可能性があります。読み込みますか?',
    )
  ) return;

  try {
    const imported = await Promise.all(
      files.map(async (file) => {
        const truncated = file.size > HUGE_TEXT_FILE;
        const decoded = decodeTextFile(await (truncated ? file.slice(0, HUGE_PREVIEW_SIZE) : file).arrayBuffer());
        return {
          name: truncated ? `${file.name} (先頭5MB)` : file.name,
          text: truncated ? `${decoded.text}\n\n[NotePalette: 先頭5MBのみ表示しています]` : decoded.text,
          source: {
            fileName: file.name,
            size: file.size,
            encoding: decoded.encoding,
            importedAt: new Date().toISOString(),
            truncated,
          },
        };
      }),
    );
    const { w: bw, h: bh } = boardSize();
    const w = Math.min(420, bw);
    const h = Math.min(300, bh);
    const tabs = imported.map(({ name, source }) => newTab(name, source));
    const item: Item = {
      id: uid(),
      kind: 'panel',
      title: imported.length === 1 ? imported[0].name : `${imported[0].name} ほか${imported.length - 1}件`,
      x: clamp(cx ?? 60, 0, bw - w),
      y: clamp(cy ?? 50, 0, bh - h),
      w,
      h,
      z: topZ() + 1,
      color: board.items.length % COLOR_COUNT,
      fontSize: 14,
      archived: false,
      pinned: false,
      tabs,
      activeTab: tabs[0].id,
      mode: 'board',
    };
    imported.forEach(({ text }, index) => {
      texts[tabs[index].id] = text;
      markTabDirty(item.id, tabs[index].id);
    });
    board.items.push(item);
    board.view.maximizedId = null;
    createView(item);
    layoutAll();
    setActive(item);
    activateTab(item, item.activeTab, true);
    markBoardDirty();
    showNotice(`${files.length}個のテキストファイルを取り込みました`);
  } catch (err) {
    console.error(err);
    showNotice('テキストファイルを読み込めませんでした');
  }
}

function setZoom(z: number): void {
  board.view.zoom = Math.round(clamp(z, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  layoutAll();
  markBoardDirty();
}

// ---------------------------------------------------------------- 検索

interface SearchHit {
  item: Item;
  tab: Tab;
}

function searchHits(): SearchHit[] {
  if (!query) return [];
  const hits: SearchHit[] = [];
  for (const item of board.items.filter((candidate) => !candidate.archived)) {
    const tabHits = item.tabs.filter(tabMatches);
    if (tabHits.length > 0) {
      tabHits.forEach((tab) => hits.push({ item, tab }));
    } else if (item.title.toLowerCase().includes(query)) {
      const tab = item.tabs.find((t) => t.id === item.activeTab) ?? item.tabs[0];
      if (tab) hits.push({ item, tab });
    }
  }
  return hits;
}

function resultSnippet(tab: Tab): string {
  const text = (texts[tab.id] ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '本文なし';
  const pos = text.toLowerCase().indexOf(query);
  return text.slice(Math.max(0, pos - 24), Math.max(0, pos - 24) + 72);
}

function jumpToHit({ item, tab }: SearchHit): void {
  const view = views.get(item.id)!;
  if (board.view.maximizedId && board.view.maximizedId !== item.id) {
    board.view.maximizedId = null;
    layoutAll();
  }
  bringToFront(item);
  setActive(item);
  activateTab(item, tab.id, false);
  view.el.classList.add('flash');
  window.setTimeout(() => view.el.classList.remove('flash'), 900);
  searchResultsEl.hidden = true;
  const ta = view.areas.get(tab.id)!;
  const pos = ta.value.toLowerCase().indexOf(query);
  requestAnimationFrame(() => {
    ta.focus();
    if (pos >= 0) {
      ta.setSelectionRange(pos, pos + query.length);
      const lineIndex = ta.value.slice(0, pos).split('\n').length - 1;
      const approxLineHeight = Math.max(16, item.fontSize * 1.4);
      ta.scrollTop = Math.max(0, lineIndex * approxLineHeight - ta.clientHeight / 3);
    }
  });
}

function renderSearchResults(hits: SearchHit[]): void {
  searchResultsEl.textContent = '';
  searchResultsEl.hidden = !query;
  for (const hit of hits.slice(0, 50)) {
    const button = el('button');
    button.append(
      el('span', 'result-title', `${hit.item.title} › ${hit.tab.title}`),
      el('span', 'result-snippet', resultSnippet(hit.tab)),
    );
    button.addEventListener('click', () => jumpToHit(hit));
    searchResultsEl.appendChild(button);
  }
  if (query && hits.length === 0) searchResultsEl.appendChild(el('div', 'result-snippet', '一致するページはありません'));
}

function runSearch(resetCursor: boolean): void {
  query = searchEl.value.trim().toLowerCase();
  if (resetCursor) searchCursor = -1;
  const hits = searchHits();
  const hitIds = new Set(hits.map((hit) => hit.item.id));
  for (const v of views.values()) {
    v.el.classList.toggle('dim', query !== '' && !hitIds.has(v.item.id));
    renderTabs(v);
  }
  searchInfoEl.textContent = query ? `${hits.length} 件` : '';
  renderSearchResults(hits);
}

function jumpToNextHit(): void {
  const hits = searchHits();
  if (hits.length === 0) return;
  searchCursor = (searchCursor + 1) % hits.length;
  jumpToHit(hits[searchCursor]);
}

// ---------------------------------------------------------------- 起動

function bindGlobalEvents(): void {
  statusEl.addEventListener('click', () => {
    if (saveError) void saveNow();
  });
  must('btn-new').addEventListener('click', () => addPanel());
  must('btn-archive').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleArchiveDock();
  });
  must('archive-close').addEventListener('click', () => setArchiveDockOpen(false));
  archivePinEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleArchivePinned();
  });
  must('btn-data').addEventListener('click', (e) => {
    e.stopPropagation();
    dataMenuEl.hidden = !dataMenuEl.hidden;
  });
  dataMenuEl.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-data-action]')?.dataset.dataAction;
    if (action) void runDataAction(action);
  });
  must('backup-close').addEventListener('click', () => (backupDialogEl.hidden = true));
  backupDialogEl.addEventListener('click', (e) => {
    if (e.target === backupDialogEl) backupDialogEl.hidden = true;
  });
  must('btn-trash').addEventListener('click', () => void openTrash());
  trashEmptyAllBtn.addEventListener('click', async () => {
    if (!confirm('ゴミ箱内のすべての項目を完全に削除しますか？\n（この操作は取り消せません）')) return;
    trashEmptyAllBtn.disabled = true;
    const count = await api.emptyTrash();
    showNotice(`ゴミ箱から ${count} 件の項目を完全に削除しました`);
    void openTrash();
  });
  must('trash-close').addEventListener('click', () => (trashDialogEl.hidden = true));
  trashDialogEl.addEventListener('click', (e) => {
    if (e.target === trashDialogEl) trashDialogEl.hidden = true;
  });
  layoutBtn.addEventListener('click', () => {
    board.view.layout = board.view.layout === 'tile' ? 'free' : 'tile';
    layoutAll();
    markBoardDirty();
  });
  zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    viewMenu.hidden = !viewMenu.hidden;
  });
  must('btn-help').addEventListener('click', (e) => {
    e.stopPropagation();
    helpMenu.hidden = !helpMenu.hidden;
  });
  must('btn-manual').addEventListener('click', () => void api.openManual());
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
    if (!(e.target as HTMLElement).closest('#help-wrap')) helpMenu.hidden = true;
    if (!(e.target as HTMLElement).closest('#data-wrap')) dataMenuEl.hidden = true;
    if (!(e.target as HTMLElement).closest('#search-wrap')) searchResultsEl.hidden = true;
    if (!(e.target as HTMLElement).closest('#panel-menu, .actions')) panelMenuEl.hidden = true;
    if (!board.view.archivePinned && !(e.target as HTMLElement).closest('#archive-dock, #btn-archive')) {
      setArchiveDockOpen(false);
    }
  });
  panelMenuEl.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')?.dataset.action;
    const item = panelMenuItem;
    if (!action || !item) return;
    panelMenuEl.hidden = true;
    if (action === 'color') cycleColor(item);
    else if (action === 'rename-note') beginItemRename(item);
    else if (action === 'rename-page') beginActivePageRename(item);
    else if (action === 'detach') void detachItem(item);
    else if (action === 'export') void exportActiveTab(item);
    else if (action === 'source') {
      const tab = item.tabs.find((candidate) => candidate.id === item.activeTab);
      if (tab?.source) {
        alert(
          `元ファイル: ${tab.source.fileName}\n` +
          `容量: ${formatSize(tab.source.size)}\n` +
          `文字コード: ${tab.source.encoding}\n` +
          `取り込み日時: ${new Date(tab.source.importedAt).toLocaleString('ja-JP')}\n` +
          `${tab.source.truncated ? '先頭5MBのみ取り込み\n' : ''}\n元ファイルとは連携していません。`,
        );
      }
    }
    else if (action === 'duplicate') {
      setActive(item);
      duplicateActiveItem();
    } else if (action === 'maximize') toggleMax(item);
    else if (action === 'archive') archiveItem(item);
    else if (action === 'delete') void removePanel(item);
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
    } else if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      cycleTabInActive(e.shiftKey ? -1 : 1);
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      newTabInActive();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      // 押しっぱなしのキーリピートで次々にページを閉じないようにする
      if (!e.repeat) closeActiveTab();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void exportActiveTab();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateActiveItem();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const item = activeItem();
      if (item) archiveItem(item);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      addPanel();
    } else if (e.ctrlKey && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (e.key === 'Escape') {
      if (!backupDialogEl.hidden) {
        backupDialogEl.hidden = true;
      } else if (!board.view.archivePinned && archiveDockEl.classList.contains('open')) {
        setArchiveDockOpen(false);
      } else if (!trashDialogEl.hidden) {
        trashDialogEl.hidden = true;
      } else if (!helpMenu.hidden) {
        helpMenu.hidden = true;
      } else if (!viewMenu.hidden) {
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

  // 画像: クリップボード貼り付け。外部ファイルは画像またはテキストとして取り込む
  window.addEventListener('paste', (e) => {
    const files = imageFilesOf(e.clipboardData?.items ?? null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void addImage(f, MIME_EXT[f.type]);
  });
  let fileDragDepth = 0;
  boardEl.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    fileDragDepth += 1;
    boardEl.classList.add('file-drag');
  });
  boardEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  boardEl.addEventListener('dragleave', () => {
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) boardEl.classList.remove('file-drag');
  });
  boardEl.addEventListener('drop', (e) => {
    fileDragDepth = 0;
    boardEl.classList.remove('file-drag');
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    const images = dropped.filter((file) => Boolean(MIME_EXT[file.type]));
    const textFiles = dropped.filter((file) => !MIME_EXT[file.type] && isTextFile(file));
    if (images.length === 0 && textFiles.length === 0) {
      if (dropped.length > 0) showNotice('対応しているテキストまたは画像ファイルではありません');
      return;
    }
    e.preventDefault();
    const rect = boardEl.getBoundingClientRect();
    images.forEach((f, i) =>
      void addImage(f, MIME_EXT[f.type], e.clientX - rect.left - 100 + i * 24, e.clientY - rect.top - 14 + i * 24),
    );
    void addTextFiles(textFiles, e.clientX - rect.left - 120, e.clientY - rect.top - 18);
  });

  api.onFlushRequest(async () => {
    await saveNow();
  });
  api.onDetachedItemUpdated((updated) => {
    const item = board.items.find((candidate) => candidate.id === updated.id);
    if (item) Object.assign(item, updated);
  });
  api.onDetachedReturned((itemId) => {
    void (async () => {
      const loaded = await api.loadDetached(itemId);
      if (!loaded) return;
      const item = board.items.find((candidate) => candidate.id === itemId);
      if (!item || views.has(itemId)) return;
      Object.assign(item, loaded.item, { mode: 'board' });
      Object.assign(texts, loaded.texts);
      createView(item);
      layoutAll();
      setActive(item);
      activateTab(item, item.activeTab, true);
      runSearch(false);
    })();
  });
}

async function main(): Promise<void> {
  const res = await api.load();
  board = res.board;
  texts = res.texts;
  bindGlobalEvents();
  for (const item of [...board.items].filter((candidate) => !candidate.archived && candidate.mode === 'board').sort((a, b) => a.z - b.z)) createView(item);
  for (const img of [...board.images].sort((a, b) => a.z - b.z)) {
    const bytes = await api.readImage(img.file);
    if (bytes) createImageView(img, bytes);
  }
  layoutAll();
  updateArchiveBadge();
  archivePinEl.setAttribute('aria-pressed', String(board.view.archivePinned));
  if (board.view.archivePinned) setArchiveDockOpen(true);
  for (const item of board.items.filter((candidate) => !candidate.archived && candidate.mode === 'board')) activateTab(item, item.activeTab, false);
  for (const item of board.items.filter((candidate) => !candidate.archived && candidate.mode === 'detached')) {
    void api.openDetached(item.id);
  }
  updateStatus();
  statusEl.textContent = '保存済み';
  if (res.uncleanShutdown) {
    window.setTimeout(() => showNotice('前回は正常に終了しませんでした。自動保存データから復帰しました'), 250);
  }
  window.setInterval(() => {
    void saveNow().then(() => api.createBackup());
  }, 60 * 60 * 1000);
}

void main();
