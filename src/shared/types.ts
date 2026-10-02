export interface Tab {
  id: string;
  title: string;
  scroll: number;
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
  /** 誤操作によるタブ・付箋の削除を防ぐ */
  pinned: boolean;
  tabs: Tab[];
  activeTab: string;
  /** v3: 独立ウィンドウ化に備えた状態 */
  mode: 'board' | 'detached';
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
}

export interface NoteApi {
  load(): Promise<LoadResult>;
  saveBoard(board: Board): Promise<void>;
  saveTab(itemId: string, tabId: string, text: string): Promise<void>;
  removeItem(itemId: string): Promise<string | null>;
  removeTab(itemId: string, tabId: string): Promise<string | null>;
  restoreItem(trashName: string, itemId: string): Promise<boolean>;
  restoreTab(trashName: string, itemId: string, tabId: string): Promise<boolean>;
  /** board.json と全タブ本文の世代バックアップを作る */
  createBackup(): Promise<void>;
  /** 画像を images/ に保存し、保存名を返す */
  saveImage(ext: string, data: ArrayBuffer): Promise<string>;
  readImage(file: string): Promise<ArrayBuffer | null>;
  removeImage(file: string): Promise<string | null>;
  /** クリップボードの先頭へ置く */
  copyText(text: string): Promise<void>;
  /** 保存済み画像をクリップボードへ。失敗時 false */
  copyImage(file: string): Promise<boolean>;
  /** アクティブなタブを任意の場所へUTF-8テキストとして書き出す。キャンセル時は null */
  exportText(title: string, text: string): Promise<string | null>;
  /** 終了前に未保存分を書き出す要求を受ける。cb 完了後に自動で完了通知する */
  onFlushRequest(cb: () => Promise<void>): void;
}
