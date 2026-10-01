import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeImage, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './storage';

const dataDir = process.env.NOTEPALETTE_DATA ?? path.join(app.getPath('documents'), 'NotePalette');
const storage = new Storage(dataDir);
const windowStateFile = path.join(dataDir, 'window.json');

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
    },
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
        if (script) await win.webContents.executeJavaScript(script);
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shot, img.toPNG());
          win.close();
        }, 700);
      }, 1200);
    });
  }
}

ipcMain.handle('load', () => storage.load());
ipcMain.handle('save-board', (_e, board) => storage.saveBoard(board));
ipcMain.handle('save-tab', (_e, itemId: string, tabId: string, text: string) => storage.saveTab(itemId, tabId, text));
ipcMain.handle('remove-item', (_e, itemId: string) => storage.removeItem(itemId));
ipcMain.handle('remove-tab', (_e, itemId: string, tabId: string) => storage.removeTab(itemId, tabId));
ipcMain.handle('save-image', (_e, ext: string, data: ArrayBuffer) => storage.saveImage(ext, data));
ipcMain.handle('read-image', (_e, file: string) => storage.readImage(file));
ipcMain.handle('remove-image', (_e, file: string) => storage.removeImage(file));
ipcMain.handle('copy-text', (_e, text: string) => clipboard.writeText(String(text)));
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
