import * as fs from 'fs/promises';
import * as path from 'path';
import type { Board, ImageItem, Item, LoadResult, Tab, TrashEntry, TrashRestoreResult } from '../shared/types';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_KEEP = 30;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const IMAGE_FILE_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]{2,4}$/;
const TRASH_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

type TrashMeta =
  | { kind: 'item'; title: string; deletedAt: string; item: Item }
  | { kind: 'tab'; title: string; deletedAt: string; itemId: string; tab: Tab }
  | { kind: 'image'; title: string; deletedAt: string; image: ImageItem };

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid id: ${id}`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function defaultBoard(): Board {
  return {
    version: 1,
    view: { layout: 'free', maximizedId: null, zoom: 1 },
    images: [],
    items: [
      {
        id: 'welcome',
        kind: 'panel',
        x: 40,
        y: 30,
        w: 340,
        h: 220,
        z: 1,
        color: 0,
        fontSize: 14,
        title: 'ようこそ',
        pinned: false,
        tabs: [{ id: 'welcome-1', title: 'メモ', scroll: 0 }],
        activeTab: 'welcome-1',
        mode: 'board',
      },
    ],
  };
}

const WELCOME_TEXT =
  'NotePalette へようこそ。\n\n' +
  '・ボードの空いている所をダブルクリックで新しい付箋\n' +
  '・タブの + で付箋内にタブを追加 / タブをダブルクリックで名前変更\n' +
  '・付箋のヘッダーをダブルクリックで最大化(Esc で戻る)\n' +
  '・付箋タイトルはダブルクリックで変更、Ctrl+D で付箋を複製\n' +
  '・📌で付箋を閉じないよう保護、Ctrl+S で現在のタブを書き出し\n' +
  '・削除直後は「元に戻す」、後から戻す場合は上部の🗑\n' +
  '・Ctrl+ホイールで全体ズーム、Ctrl+F で検索\n' +
  '・入力は自動で保存されます\n';

export class Storage {
  /** 同一ファイルへの書き込みを直列化する */
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  get dataDir(): string {
    return this.dir;
  }

  private itemDir(itemId: string): string {
    assertId(itemId);
    return path.join(this.dir, 'items', itemId);
  }

  private tabFile(itemId: string, tabId: string): string {
    assertId(tabId);
    return path.join(this.itemDir(itemId), `${tabId}.txt`);
  }

  private enqueue(file: string, job: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(file) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(job);
    this.queues.set(file, next);
    return next;
  }

  /** 一時ファイルへ書いてから置換する(途中で落ちても元ファイルは壊れない) */
  private writeAtomic(file: string, data: string): Promise<void> {
    return this.enqueue(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, file);
    });
  }

  private get boardFile(): string {
    return path.join(this.dir, 'board.json');
  }

  private async readBoardFile(file: string): Promise<Board | null> {
    try {
      const b = JSON.parse(await fs.readFile(file, 'utf8')) as Board;
      if (!b || b.version !== 1 || !Array.isArray(b.items)) return null;
      b.images ??= [];
      for (const item of b.items) {
        item.pinned ??= false;
        item.title ??= item.tabs[0]?.title || '付箋';
      }
      return b;
    } catch {
      return null;
    }
  }

  private async backupBoard(): Promise<void> {
    try {
      const dir = path.join(this.dir, 'backups');
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(this.boardFile, path.join(dir, `board-${stamp()}.json`));
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith('board-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
        await fs.unlink(path.join(dir, f));
      }
    } catch {
      /* バックアップは best effort */
    }
  }

  /** 配置情報と全タブ本文を同じ時点のスナップショットとして保存する */
  async createBackup(): Promise<void> {
    try {
      await fs.access(this.boardFile);
      const root = path.join(this.dir, 'backups');
      const target = path.join(root, `snapshot-${stamp()}`);
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(this.boardFile, path.join(target, 'board.json'));
      try {
        await fs.cp(path.join(this.dir, 'items'), path.join(target, 'items'), { recursive: true });
      } catch {
        /* 本文がまだ無い新規ボード */
      }
      const entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith('snapshot-'))
        .map((e) => e.name)
        .sort();
      for (const name of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) {
        await fs.rm(path.join(root, name), { recursive: true, force: true });
      }
    } catch {
      /* バックアップは best effort */
    }
  }

  async load(): Promise<LoadResult> {
    await fs.mkdir(this.dir, { recursive: true });
    let board = await this.readBoardFile(this.boardFile);
    let isNew = false;

    if (board) {
      await this.createBackup();
      await this.backupBoard();
    } else {
      // board.json が無い/壊れている: 壊れた物を退避し、最新バックアップから復旧を試みる
      try {
        await fs.rename(this.boardFile, path.join(this.dir, `board.corrupt-${stamp()}.json`));
      } catch {
        /* 存在しない */
      }
      try {
        const bdir = path.join(this.dir, 'backups');
        const files = (await fs.readdir(bdir)).filter((f) => f.startsWith('board-')).sort().reverse();
        for (const f of files) {
          board = await this.readBoardFile(path.join(bdir, f));
          if (board) break;
        }
      } catch {
        /* バックアップ無し */
      }
      if (!board) {
        board = defaultBoard();
        isNew = true;
      }
    }

    const texts: Record<string, string> = {};
    for (const item of board.items) {
      for (const tab of item.tabs) {
        try {
          texts[tab.id] = await fs.readFile(this.tabFile(item.id, tab.id), 'utf8');
        } catch {
          texts[tab.id] = '';
        }
      }
    }
    if (isNew) {
      texts['welcome-1'] = WELCOME_TEXT;
      await this.saveBoard(board);
      await this.saveTab('welcome', 'welcome-1', WELCOME_TEXT);
    }
    return { board, texts, dataDir: this.dir };
  }

  saveBoard(board: Board): Promise<void> {
    return this.writeAtomic(this.boardFile, JSON.stringify(board, null, 2));
  }

  saveTab(itemId: string, tabId: string, text: string): Promise<void> {
    return this.writeAtomic(this.tabFile(itemId, tabId), text);
  }

  private trashEntry(trashName: string): string {
    if (!TRASH_NAME_RE.test(trashName)) throw new Error('invalid trash name');
    return path.join(this.dir, 'trash', trashName);
  }

  /** 復元情報と実体を1つのディレクトリへまとめてゴミ箱へ移す */
  private async toTrash(src: string, meta: TrashMeta): Promise<string | null> {
    try {
      await fs.access(src);
    } catch {
      return null;
    }
    const trash = path.join(this.dir, 'trash');
    await fs.mkdir(trash, { recursive: true });
    const trashName = `${stamp()}-${meta.kind}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = this.trashEntry(trashName);
    try {
      await fs.mkdir(entry);
      await fs.writeFile(path.join(entry, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      await fs.rename(src, path.join(entry, 'content'));
      return trashName;
    } catch (err) {
      await fs.rm(entry, { recursive: true, force: true });
      throw err;
    }
  }

  private async fromTrash(trashName: string, dest: string): Promise<boolean> {
    try {
      await fs.access(dest);
      return false;
    } catch {
      /* 復元先が空いている */
    }
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const entry = this.trashEntry(trashName);
      await fs.rename(path.join(entry, 'content'), dest);
      await fs.rm(entry, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async readTrashMeta(trashName: string): Promise<TrashMeta | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.trashEntry(trashName), 'meta.json'), 'utf8')) as TrashMeta;
    } catch {
      return null;
    }
  }

  private imageFile(file: string): string {
    if (!IMAGE_FILE_RE.test(file)) throw new Error(`invalid image file: ${file}`);
    return path.join(this.dir, 'images', file);
  }

  async saveImage(ext: string, data: ArrayBuffer): Promise<string> {
    const e = ext.toLowerCase().replace(/^\./, '');
    if (!IMAGE_EXT.has(e)) throw new Error(`unsupported image type: ${ext}`);
    const file = `${stamp()}-${Math.random().toString(36).slice(2, 8)}.${e}`;
    const full = this.imageFile(file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(data));
    return file;
  }

  async readImage(file: string): Promise<ArrayBuffer | null> {
    try {
      const b = await fs.readFile(this.imageFile(file));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async removeImage(image: ImageItem): Promise<string | null> {
    return this.toTrash(this.imageFile(image.file), {
      kind: 'image',
      title: image.file,
      deletedAt: new Date().toISOString(),
      image,
    });
  }

  restoreImage(trashName: string, file: string): Promise<boolean> {
    return this.fromTrash(trashName, this.imageFile(file));
  }

  async removeItem(item: Item): Promise<string | null> {
    return this.toTrash(this.itemDir(item.id), {
      kind: 'item',
      title: item.title,
      deletedAt: new Date().toISOString(),
      item,
    });
  }

  async removeTab(itemId: string, tab: Tab): Promise<string | null> {
    return this.toTrash(this.tabFile(itemId, tab.id), {
      kind: 'tab',
      title: tab.title,
      deletedAt: new Date().toISOString(),
      itemId,
      tab,
    });
  }

  restoreItem(trashName: string, itemId: string): Promise<boolean> {
    return this.fromTrash(trashName, this.itemDir(itemId));
  }

  restoreTab(trashName: string, itemId: string, tabId: string): Promise<boolean> {
    return this.fromTrash(trashName, this.tabFile(itemId, tabId));
  }

  async listTrash(): Promise<TrashEntry[]> {
    try {
      const names = await fs.readdir(path.join(this.dir, 'trash'));
      const out: TrashEntry[] = [];
      for (const name of names) {
        const meta = await this.readTrashMeta(name);
        if (meta) out.push({ name, kind: meta.kind, title: meta.title, deletedAt: meta.deletedAt });
      }
      return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    } catch {
      return [];
    }
  }

  async restoreTrash(trashName: string): Promise<TrashRestoreResult | null> {
    const meta = await this.readTrashMeta(trashName);
    if (!meta) return null;
    if (meta.kind === 'item') {
      if (!(await this.fromTrash(trashName, this.itemDir(meta.item.id)))) return null;
      const texts: Record<string, string> = {};
      for (const tab of meta.item.tabs) {
        try {
          texts[tab.id] = await fs.readFile(this.tabFile(meta.item.id, tab.id), 'utf8');
        } catch {
          texts[tab.id] = '';
        }
      }
      return { kind: 'item', item: meta.item, texts };
    }
    if (meta.kind === 'tab') {
      if (!(await this.fromTrash(trashName, this.tabFile(meta.itemId, meta.tab.id)))) return null;
      const text = await fs.readFile(this.tabFile(meta.itemId, meta.tab.id), 'utf8').catch(() => '');
      return { kind: 'tab', itemId: meta.itemId, tab: meta.tab, text };
    }
    if (!(await this.fromTrash(trashName, this.imageFile(meta.image.file)))) return null;
    return { kind: 'image', image: meta.image };
  }
}
