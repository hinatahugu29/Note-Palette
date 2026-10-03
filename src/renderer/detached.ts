import type { Item, NoteApi, Tab } from '../shared/types.js';
import { uid } from './lib/dom.js';

declare global {
  interface Window {
    noteApi: NoteApi;
  }
}

const api = window.noteApi;
const itemId = new URLSearchParams(location.search).get('itemId') ?? '';
const noteEl = document.getElementById('note')!;
const titleEl = document.getElementById('note-title')!;
const pagesEl = document.getElementById('pages')!;
const editorsEl = document.getElementById('editors')!;
const statusEl = document.getElementById('status')!;
const fontSizeEl = document.getElementById('font-size')!;
const topButton = document.getElementById('always-on-top') as HTMLButtonElement;

let item: Item;
let texts: Record<string, string> = {};
const editors = new Map<string, HTMLTextAreaElement>();
const dirtyPages = new Set<string>();
let itemDirty = false;
let saveTimer: number | undefined;
let saving = false;
let savePromise: Promise<void> | null = null;

function updateStatus(): void {
  statusEl.textContent = saving ? '保存中…' : itemDirty || dirtyPages.size > 0 ? '未保存' : '保存済み';
}

function scheduleSave(): void {
  updateStatus();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 500);
}

function markItemDirty(): void {
  itemDirty = true;
  scheduleSave();
}

function markPageDirty(tabId: string): void {
  dirtyPages.add(tabId);
  scheduleSave();
}

async function saveNow(): Promise<void> {
  window.clearTimeout(saveTimer);
  if (savePromise) {
    await savePromise;
    if (itemDirty || dirtyPages.size > 0) await saveNow();
    return;
  }
  const saveItem = itemDirty;
  const pages = [...dirtyPages];
  if (!saveItem && pages.length === 0) return;
  itemDirty = false;
  pages.forEach((id) => dirtyPages.delete(id));
  savePromise = (async () => {
    saving = true;
    updateStatus();
    try {
      await Promise.all([
        ...(saveItem ? [api.saveDetachedItem(item)] : []),
        ...pages.map((id) => api.saveTab(item.id, id, texts[id] ?? '')),
      ]);
    } catch (error) {
      console.error(error);
      if (saveItem) itemDirty = true;
      pages.forEach((id) => dirtyPages.add(id));
      statusEl.textContent = '保存エラー';
    } finally {
      saving = false;
      savePromise = null;
      updateStatus();
    }
  })();
  await savePromise;
}

function ensureEditor(tab: Tab): HTMLTextAreaElement {
  const existing = editors.get(tab.id);
  if (existing) return existing;
  const area = document.createElement('textarea');
  area.value = texts[tab.id] ?? '';
  area.spellcheck = false;
  area.addEventListener('input', () => {
    texts[tab.id] = area.value;
    markPageDirty(tab.id);
  });
  area.addEventListener('scroll', () => {
    tab.scroll = area.scrollTop;
    markItemDirty();
  });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  });
  editors.set(tab.id, area);
  editorsEl.appendChild(area);
  return area;
}

function activatePage(tabId: string, focus = true): void {
  item.activeTab = tabId;
  markItemDirty();
  for (const page of pagesEl.querySelectorAll<HTMLElement>('.page')) {
    page.classList.toggle('active', page.dataset.tabId === tabId);
  }
  for (const [id, editor] of editors) editor.classList.toggle('active', id === tabId);
  const tab = item.tabs.find((candidate) => candidate.id === tabId)!;
  const editor = editors.get(tabId)!;
  requestAnimationFrame(() => {
    editor.scrollTop = tab.scroll;
    if (focus) editor.focus();
  });
}

function beginRenamePage(tab: Tab, pageEl: HTMLElement): void {
  const input = document.createElement('input');
  input.value = tab.title;
  pageEl.textContent = '';
  pageEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value) {
      tab.title = value;
      markItemDirty();
    }
    renderPages();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
}

function renderPages(): void {
  pagesEl.textContent = '';
  for (const tab of item.tabs) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.tabId = tab.id;
    page.title = 'ダブルクリックでページ名を変更';
    page.classList.toggle('active', tab.id === item.activeTab);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tab.title;
    page.appendChild(name);
    if (item.tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        void removePage(tab);
      });
      page.appendChild(close);
    }
    page.addEventListener('click', () => activatePage(tab.id));
    page.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      beginRenamePage(tab, page);
    });
    pagesEl.appendChild(page);
  }
}

async function removePage(tab: Tab): Promise<void> {
  if (item.tabs.length <= 1) return;
  if ((texts[tab.id] ?? '').trim() && !confirm(`ページ「${tab.title}」を削除しますか？`)) return;
  await saveNow();
  await api.removeTab(item.id, tab);
  const index = item.tabs.indexOf(tab);
  item.tabs.splice(index, 1);
  delete texts[tab.id];
  editors.get(tab.id)?.remove();
  editors.delete(tab.id);
  if (item.activeTab === tab.id) item.activeTab = item.tabs[Math.min(index, item.tabs.length - 1)].id;
  renderPages();
  activatePage(item.activeTab, false);
  markItemDirty();
}

function beginRenameNote(): void {
  const input = document.createElement('input');
  input.value = item.title;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value) {
      item.title = value;
      markItemDirty();
    }
    titleEl.textContent = item.title;
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
}

function changeFont(delta: number): void {
  item.fontSize = Math.max(8, Math.min(72, item.fontSize + delta));
  noteEl.style.setProperty('--fs', `${item.fontSize}px`);
  fontSizeEl.textContent = String(item.fontSize);
  markItemDirty();
}

async function main(): Promise<void> {
  const loaded = await api.loadDetached(itemId);
  if (!loaded) {
    statusEl.textContent = 'ノートを読み込めませんでした';
    return;
  }
  item = loaded.item;
  texts = loaded.texts;
  noteEl.className = `c${item.color}`;
  noteEl.style.setProperty('--fs', `${item.fontSize}px`);
  titleEl.textContent = item.title;
  fontSizeEl.textContent = String(item.fontSize);
  topButton.classList.toggle('active', item.detached?.alwaysOnTop ?? false);
  for (const tab of item.tabs) ensureEditor(tab);
  renderPages();
  activatePage(item.activeTab, false);
  itemDirty = false;
  dirtyPages.clear();
  updateStatus();

  titleEl.addEventListener('dblclick', beginRenameNote);
  document.getElementById('add-page')!.addEventListener('click', () => {
    const tab: Tab = { id: uid(), title: `ページ${item.tabs.length + 1}`, scroll: 0 };
    item.tabs.push(tab);
    texts[tab.id] = '';
    ensureEditor(tab);
    renderPages();
    activatePage(tab.id);
    markPageDirty(tab.id);
  });
  document.getElementById('font-down')!.addEventListener('click', () => changeFont(-1));
  document.getElementById('font-up')!.addEventListener('click', () => changeFont(1));
  document.getElementById('copy')!.addEventListener('click', () => void api.copyText(texts[item.activeTab] ?? ''));
  topButton.addEventListener('click', () => {
    const value = !(item.detached?.alwaysOnTop ?? false);
    item.detached ??= { width: innerWidth, height: innerHeight, alwaysOnTop: value };
    item.detached.alwaysOnTop = value;
    topButton.classList.toggle('active', value);
    void api.setDetachedAlwaysOnTop(item.id, value);
    markItemDirty();
  });
  document.getElementById('return-board')!.addEventListener('click', () => {
    void saveNow().then(() => api.returnDetached(item.id));
  });
  statusEl.addEventListener('click', () => void saveNow());
  api.onDetachedFlushRequest(saveNow);
}

void main();
