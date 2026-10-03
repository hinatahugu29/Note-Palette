import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './storage';
import type { ImageItem, Item, Tab } from '../shared/types';

function resolveDataLocation(): { dir: string; mode: 'portable' | 'documents' | 'custom' } {
  if (process.env.NOTEPALETTE_DATA) return { dir: process.env.NOTEPALETTE_DATA, mode: 'custom' };
  const documentsDir = path.join(app.getPath('documents'), 'NotePalette');
  if (!app.isPackaged) return { dir: documentsDir, mode: 'documents' };

  const portableDir = path.join(path.dirname(app.getPath('exe')), 'NotePaletteData');
  const migratingDir = path.join(path.dirname(portableDir), '.NotePaletteData-migrating');
  try {
    if (!fs.existsSync(portableDir) && fs.existsSync(path.join(documentsDir, 'board.json'))) {
      fs.rmSync(migratingDir, { recursive: true, force: true });
      fs.cpSync(documentsDir, migratingDir, { recursive: true });
      fs.rmSync(path.join(migratingDir, '.session-active'), { force: true });
      fs.renameSync(migratingDir, portableDir);
    }
    fs.mkdirSync(portableDir, { recursive: true });
    fs.accessSync(portableDir, fs.constants.W_OK);
    return { dir: portableDir, mode: 'portable' };
  } catch {
    try {
      fs.rmSync(migratingDir, { recursive: true, force: true });
    } catch {
      // A read-only application folder still falls back to Documents below.
    }
    return { dir: documentsDir, mode: 'documents' };
  }
}

const dataLocation = resolveDataLocation();
const dataDir = dataLocation.dir;
const storage = new Storage(dataDir);
const windowStateFile = path.join(dataDir, 'window.json');
const sessionFile = path.join(dataDir, '.session-active');
let uncleanShutdown = false;
let mainWindow: BrowserWindow | null = null;
let appQuitting = false;
const detachedWindows = new Map<string, BrowserWindow>();

function sendToMain(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}

function markSessionStarted(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  uncleanShutdown = fs.existsSync(sessionFile);
  fs.writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

function markSessionClosed(): void {
  try {
    fs.unlinkSync(sessionFile);
  } catch {
    /* best effort */
  }
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function readWindowState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile, 'utf8')) as WindowState;
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return (
        s.x !== undefined &&
        s.y !== undefined &&
        s.x < b.x + b.width &&
        s.x + s.width > b.x &&
        s.y < b.y + b.height &&
        s.y + s.height > b.y
      );
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1200, height: 780 };
  }
}

function writeWindowState(win: BrowserWindow): void {
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(windowStateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* best effort */
  }
}

function requestRendererFlush(win: BrowserWindow, requestChannel: string, doneChannel: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ipcMain.removeListener(doneChannel, listener);
      resolve();
    };
    const listener = (event: Electron.IpcMainEvent) => {
      if (event.sender === win.webContents) finish();
    };
    ipcMain.on(doneChannel, listener);
    setTimeout(finish, 2000);
    win.webContents.send(requestChannel);
  });
}

async function createDetachedWindow(itemId: string): Promise<boolean> {
  const existing = detachedWindows.get(itemId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }
  const loaded = await storage.loadDetached(itemId);
  if (!loaded) return false;
  const saved = loaded.item.detached;
  const win = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width ?? Math.max(320, loaded.item.w),
    height: saved?.height ?? Math.max(220, loaded.item.h),
    minWidth: 260,
    minHeight: 180,
    title: loaded.item.title,
    icon: path.join(__dirname, '..', '..', 'アイコン.png'),
    backgroundColor: '#fff9c4',
    autoHideMenuBar: true,
    alwaysOnTop: saved?.alwaysOnTop ?? false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  detachedWindows.set(itemId, win);
  win.setMenu(null);
  await win.loadFile(path.join(__dirname, '..', '..', 'static', 'detached.html'), { query: { itemId } });

  let allowClose = false;
  let closing = false;
  win.on('close', (event) => {
    if (allowClose || closing) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      try {
        await requestRendererFlush(win, 'detached-flush-request', 'detached-flush-done');
        const bounds = win.getNormalBounds();
        const detached = { ...bounds, alwaysOnTop: win.isAlwaysOnTop() };
        const mode: Item['mode'] = appQuitting ? 'detached' : 'board';
        const item = await storage.setDetachedState(itemId, mode, detached);
        if (!appQuitting && item) sendToMain('detached-item-updated', item);
        if (!appQuitting) sendToMain('detached-returned', itemId);
      } finally {
        detachedWindows.delete(itemId);
        allowClose = true;
        win.close();
      }
    })();
  });
  return true;
}

function createWindow(): void {
  const state = readWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 480,
    minHeight: 360,
    title: 'NotePalette',
    icon: path.join(__dirname, '..', '..', 'アイコン.png'),
    backgroundColor: '#2b2d31',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !process.env.NOTEPALETTE_SCREENSHOT,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (state.maximized) win.maximize();
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', '..', 'static', 'index.html'));

  // 終了前にレンダラの未保存分を書き出させる
  let flushed = false;
  win.on('close', (e) => {
    writeWindowState(win);
    if (flushed) return;
    e.preventDefault();
    const finish = () => {
      if (flushed) return;
      flushed = true;
      appQuitting = true;
      for (const detached of detachedWindows.values()) detached.close();
      markSessionClosed();
      win.close();
    };
    ipcMain.once('flush-done', finish);
    setTimeout(finish, 2000);
    win.webContents.send('flush-request');
  });

  // 開発用: 任意スクリプト実行後に画面を PNG 保存して終了する(自動確認用)
  const shot = process.env.NOTEPALETTE_SCREENSHOT;
  if (shot) {
    const script = process.env.NOTEPALETTE_SCRIPT;
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        let result: unknown;
        if (script) result = await win.webContents.executeJavaScript(script);
        const resultFile = process.env.NOTEPALETTE_RESULT;
        if (resultFile) fs.writeFileSync(resultFile, JSON.stringify(result ?? null, null, 2));
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shot, img.toPNG());
          win.close();
        }, 700);
      }, 1200);
    });
  }
}

ipcMain.handle('load', async () => ({ ...(await storage.load()), uncleanShutdown, dataMode: dataLocation.mode }));
ipcMain.handle('save-board', (_e, board) => storage.saveBoardFromBoardWindow(board));
ipcMain.handle('save-tab', (_e, itemId: string, tabId: string, text: string) => storage.saveTab(itemId, tabId, text));
ipcMain.handle('remove-item', (_e, item: Item) => storage.removeItem(item));
ipcMain.handle('remove-tab', (_e, itemId: string, tab: Tab) => storage.removeTab(itemId, tab));
ipcMain.handle('restore-item', (_e, trashName: string, itemId: string) => storage.restoreItem(trashName, itemId));
ipcMain.handle('restore-tab', (_e, trashName: string, itemId: string, tabId: string) => storage.restoreTab(trashName, itemId, tabId));
ipcMain.handle('create-backup', () => storage.createBackup());
ipcMain.handle('save-image', (_e, ext: string, data: ArrayBuffer) => storage.saveImage(ext, data));
ipcMain.handle('read-image', (_e, file: string) => storage.readImage(file));
ipcMain.handle('remove-image', (_e, image: ImageItem) => storage.removeImage(image));
ipcMain.handle('restore-image', (_e, trashName: string, file: string) => storage.restoreImage(trashName, file));
ipcMain.handle('list-trash', () => storage.listTrash());
ipcMain.handle('empty-trash', () => storage.emptyTrash());
ipcMain.handle('restore-trash', (_e, trashName: string) => storage.restoreTrash(trashName));
ipcMain.handle('list-backups', () => storage.listBackups());
ipcMain.handle('restore-backup', (_e, name: string) => storage.restoreBackup(name));
ipcMain.handle('export-archive', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const date = new Date().toISOString().slice(0, 10);
  const options: SaveDialogOptions = {
    title: 'NotePalette全体をバックアップ',
    defaultPath: path.join(app.getPath('documents'), `NotePalette-backup-${date}.zip`),
    filters: [{ name: 'ZIPバックアップ', extensions: ['zip'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await storage.exportArchive(result.filePath);
  return result.filePath;
});
ipcMain.handle('import-archive', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const options: OpenDialogOptions = {
    title: 'NotePaletteバックアップを読み込む',
    properties: ['openFile'],
    filters: [{ name: 'ZIPバックアップ', extensions: ['zip'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return false;
  await storage.importArchive(result.filePaths[0]);
  return true;
});
ipcMain.handle('export-all-text', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const options: OpenDialogOptions = { title: '全ノートの書き出し先', properties: ['openDirectory', 'createDirectory'] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return storage.exportAllText(result.filePaths[0]);
});
ipcMain.handle('open-data-folder', () => shell.openPath(dataDir));
ipcMain.handle('open-manual', () => {
  const manualPath = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'NotePalette-manual.html')
    : path.join(app.getAppPath(), 'docs', 'NotePalette-manual.html');
  return shell.openPath(manualPath);
});
ipcMain.handle('copy-text', (_e, text: string) => clipboard.writeText(String(text)));
ipcMain.handle('export-text', async (e, title: string, text: string) => {
  const safeTitle = String(title || 'ページ').replace(/[\\/:*?"<>|]/g, '_').trim() || 'ページ';
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const options = {
    title: 'ページをテキストとして保存',
    defaultPath: `${safeTitle}.txt`,
    filters: [
      { name: 'テキストファイル', extensions: ['txt'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, String(text), 'utf8');
  return result.filePath;
});
ipcMain.handle('copy-image', async (_e, file: string) => {
  const bytes = await storage.readImage(file);
  if (!bytes) return false;
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return false;
  // クリップボードには PNG として置く(gif/webp/bmp でも貼り付け先で扱える)
  const png = new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return true;
});
ipcMain.handle('open-detached', (_e, itemId: string) => createDetachedWindow(itemId));
ipcMain.handle('load-detached', (_e, itemId: string) => storage.loadDetached(itemId));
ipcMain.handle('save-detached-item', async (_e, item: Item) => {
  await storage.saveDetachedItem(item);
  const win = detachedWindows.get(item.id);
  if (win && !win.isDestroyed()) win.setTitle(item.title);
  sendToMain('detached-item-updated', item);
});
ipcMain.handle('return-detached', (_e, itemId: string) => {
  detachedWindows.get(itemId)?.close();
});
ipcMain.handle('set-detached-always-on-top', async (_e, itemId: string, value: boolean) => {
  const win = detachedWindows.get(itemId);
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(value);
  const loaded = await storage.loadDetached(itemId);
  if (!loaded) return;
  loaded.item.detached = {
    ...(loaded.item.detached ?? { width: win.getBounds().width, height: win.getBounds().height }),
    alwaysOnTop: value,
  };
  await storage.saveDetachedItem(loaded.item);
  sendToMain('detached-item-updated', loaded.item);
});

// 自動UIテストは利用中の配布版と別データで起動するため、多重起動制限の対象外にする。
if (!process.env.NOTEPALETTE_SCREENSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(() => {
    markSessionStarted();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
