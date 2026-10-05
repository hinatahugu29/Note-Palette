export interface Tab {
  id: string;
  title: string;
  scroll: number;
  source?: {
    fileName: string;
    size: number;
    encoding: string;
    importedAt: string;
    truncated?: boolean;
  };
}

/** ボード上の要素。v1 はパネルのみ。将来 kind: 'image' などを追加する。 */
export interface Item {
  id: string;
  kind: 'panel';
  /** 自由配置時の座標(タイル表示中も保持される) */
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: number;
  fontSize: number;
  title: string;
  /** 削除せずボードから一時的に隠す */
  archived: boolean;
  /** 誤操作によるページ・ノートの削除を防ぐ */
  pinned: boolean;
  tabs: Tab[];
  activeTab: string;
  /** v3: 独立ウィンドウ化に備えた状態 */
  mode: 'board' | 'detached';
  /** 独立ウィンドウの位置・サイズと最前面表示 */
  detached?: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    alwaysOnTop: boolean;
  };
}

/** ボードに直接貼る画像。実体は images/ フォルダのファイル */
export interface ImageItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  file: string;
}

export interface View {
  layout: 'free' | 'tile';
  maximizedId: string | null;
  zoom: number;
  archivePinned: boolean;
}

export interface Board {
  version: 1;
  items: Item[];
  images: ImageItem[];
  view: View;
}

export interface LoadResult {
  board: Board;
  /** tabId -> 本文 */
  texts: Record<string, string>;
  dataDir: string;
  /** 前回セッションが終了処理を通らず終わった場合 true */
  uncleanShutdown?: boolean;
  dataMode?: 'portable' | 'documents' | 'custom';
}

export interface DetachedLoadResult {
  item: Item;
  texts: Record<string, string>;
}

export interface TrashEntry {
  name: string;
  kind: 'item' | 'tab' | 'image';
  title: string;
  deletedAt: string;
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  itemCount: number;
  tabCount: number;
}

export type TrashRestoreResult =
  | { kind: 'item'; item: Item; texts: Record<string, string> }
  | { kind: 'tab'; itemId: string; tab: Tab; text: string }
  | { kind: 'image'; image: ImageItem };

export interface NoteApi {
  load(): Promise<LoadResult>;
  saveBoard(board: Board): Promise<void>;
  saveTab(itemId: string, tabId: string, text: string): Promise<void>;
  removeItem(item: Item): Promise<string | null>;
  removeTab(itemId: string, tab: Tab): Promise<string | null>;
  restoreItem(trashName: string, itemId: string): Promise<boolean>;
  restoreTab(trashName: string, itemId: string, tabId: string): Promise<boolean>;
  /** board.json と全ページ本文の世代バックアップを作る */
  createBackup(): Promise<void>;
  /** 画像を images/ に保存し、保存名を返す */
  saveImage(ext: string, data: ArrayBuffer): Promise<string>;
  readImage(file: string): Promise<ArrayBuffer | null>;
  removeImage(image: ImageItem): Promise<string | null>;
  restoreImage(trashName: string, file: string): Promise<boolean>;
  listTrash(): Promise<TrashEntry[]>;
  emptyTrash(): Promise<number>;
  restoreTrash(trashName: string): Promise<TrashRestoreResult | null>;
  listBackups(): Promise<BackupInfo[]>;
  restoreBackup(name: string): Promise<boolean>;
  exportArchive(): Promise<string | null>;
  importArchive(): Promise<boolean>;
  exportAllText(): Promise<string | null>;
  openDataFolder(): Promise<string>;
  openManual(): Promise<string>;
  /** クリップボードの先頭へ置く */
  copyText(text: string): Promise<void>;
  /** 保存済み画像をクリップボードへ。失敗時 false */
  copyImage(file: string): Promise<boolean>;
  /** アクティブなページを任意の場所へUTF-8テキストとして書き出す。キャンセル時は null */
  exportText(title: string, text: string): Promise<string | null>;
  openDetached(itemId: string): Promise<boolean>;
  loadDetached(itemId: string): Promise<DetachedLoadResult | null>;
  saveDetachedItem(item: Item): Promise<void>;
  returnDetached(itemId: string): Promise<void>;
  setDetachedAlwaysOnTop(itemId: string, value: boolean): Promise<void>;
  onDetachedItemUpdated(cb: (item: Item) => void): void;
  onDetachedReturned(cb: (itemId: string) => void): void;
  onDetachedFlushRequest(cb: () => Promise<void>): void;
  /** 終了前に未保存分を書き出す要求を受ける。cb 完了後に自動で完了通知する */
  onFlushRequest(cb: () => Promise<void>): void;
}
