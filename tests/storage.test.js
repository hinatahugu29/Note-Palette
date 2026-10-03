const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Storage, defaultBoard } = require('../dist/main/storage.js');

async function tempStorage(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notepalette-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, storage: new Storage(dir) };
}

test('初回起動データを作り、本文を再読み込みできる', async (t) => {
  const { storage } = await tempStorage(t);
  const first = await storage.load();
  assert.equal(first.board.items.length, 1);
  assert.match(first.texts['welcome-1'], /NotePalette/);

  await storage.saveTab('welcome', 'welcome-1', '再起動後の本文');
  const second = await storage.load();
  assert.equal(second.texts['welcome-1'], '再起動後の本文');
});

test('配置と全本文を同じスナップショットへ保存する', async (t) => {
  const { dir, storage } = await tempStorage(t);
  const board = defaultBoard();
  await storage.saveBoard(board);
  await storage.saveTab('welcome', 'welcome-1', 'バックアップ本文');
  await storage.createBackup();

  const snapshots = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('snapshot-'));
  assert.equal(snapshots.length, 1);
  const snapshot = path.join(dir, 'backups', snapshots[0]);
  assert.equal(await fs.readFile(path.join(snapshot, 'items', 'welcome', 'welcome-1.txt'), 'utf8'), 'バックアップ本文');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(snapshot, 'board.json'), 'utf8')), board);
});

test('独立ウィンドウのノートをボード側の保存で上書きしない', async (t) => {
  const { storage } = await tempStorage(t);
  const board = defaultBoard();
  const item = board.items[0];
  item.mode = 'detached';
  await storage.saveBoard(board);
  await storage.saveTab(item.id, item.tabs[0].id, '独立ウィンドウ本文');

  const detached = await storage.loadDetached(item.id);
  detached.item.title = '外で編集したノート';
  await storage.saveDetachedItem(detached.item);

  const staleBoard = structuredClone(board);
  staleBoard.items[0].title = '古いタイトル';
  await storage.saveBoardFromBoardWindow(staleBoard);

  const after = await storage.loadDetached(item.id);
  assert.equal(after.item.title, '外で編集したノート');
  assert.equal(after.texts[item.tabs[0].id], '独立ウィンドウ本文');
  const returned = await storage.setDetachedState(item.id, 'board', {
    x: 10, y: 20, width: 320, height: 220, alwaysOnTop: true,
  });
  assert.equal(returned.mode, 'board');
  assert.equal(returned.detached.alwaysOnTop, true);
});

test('削除した付箋をタイトルと本文ごとゴミ箱から復元する', async (t) => {
  const { storage } = await tempStorage(t);
  const board = defaultBoard();
  const item = board.items[0];
  await storage.saveBoard(board);
  await storage.saveTab(item.id, item.tabs[0].id, '復元対象の本文');

  const token = await storage.removeItem(item);
  assert.ok(token);
  const entries = await storage.listTrash();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'ようこそ');

  const restored = await storage.restoreTrash(token);
  assert.equal(restored.kind, 'item');
  assert.equal(restored.texts['welcome-1'], '復元対象の本文');
  assert.equal((await storage.listTrash()).length, 0);
});

test('削除したタブと画像を内容を変えずに復元する', async (t) => {
  const { storage } = await tempStorage(t);
  const board = defaultBoard();
  const item = board.items[0];
  const tab = item.tabs[0];
  await storage.saveTab(item.id, tab.id, 'タブ本文');
  const tabToken = await storage.removeTab(item.id, tab);
  const restoredTab = await storage.restoreTrash(tabToken);
  assert.equal(restoredTab.kind, 'tab');
  assert.equal(restoredTab.text, 'タブ本文');

  const source = Buffer.from('0102030405', 'hex');
  const file = await storage.saveImage('png', source);
  const image = { id: 'image-test', x: 0, y: 0, w: 180, h: 110, z: 1, file };
  const imageToken = await storage.removeImage(image);
  const restoredImage = await storage.restoreTrash(imageToken);
  assert.equal(restoredImage.kind, 'image');
  assert.deepEqual(Buffer.from(await storage.readImage(file)), source);
});

test('本文を変更した後でもバックアップ時点へ戻せる', async (t) => {
  const { storage } = await tempStorage(t);
  const board = defaultBoard();
  await storage.saveBoard(board);
  await storage.saveTab('welcome', 'welcome-1', 'バックアップ時点');
  const imageBytes = Buffer.from('aabbcc', 'hex');
  const imageFile = await storage.saveImage('png', imageBytes);
  board.images.push({ id: 'backup-image', x: 0, y: 0, w: 180, h: 110, z: 2, file: imageFile });
  await storage.saveBoard(board);
  await storage.createBackup();
  const snapshot = (await storage.listBackups())[0];

  board.items[0].title = '変更後';
  await storage.saveBoard(board);
  await storage.saveTab('welcome', 'welcome-1', '変更後の本文');
  await storage.removeImage(board.images[0]);
  assert.equal(await storage.restoreBackup(snapshot.name), true);

  const restored = await storage.load();
  assert.equal(restored.board.items[0].title, 'ようこそ');
  assert.equal(restored.texts['welcome-1'], 'バックアップ時点');
  assert.deepEqual(Buffer.from(await storage.readImage(imageFile)), imageBytes);
});

test('ZIPバックアップを別の保存先へ完全に読み戻せる', async (t) => {
  const source = await tempStorage(t);
  const destination = await tempStorage(t);
  const board = defaultBoard();
  board.items[0].title = 'ZIPテスト';
  await source.storage.saveBoard(board);
  await source.storage.saveTab('welcome', 'welcome-1', 'ZIP内の本文');
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imageFile = await source.storage.saveImage('png', imageBytes);
  board.images.push({ id: 'zip-image', x: 10, y: 10, w: 180, h: 110, z: 2, file: imageFile });
  await source.storage.saveBoard(board);

  const zipFile = path.join(source.dir, 'transfer.zip');
  await source.storage.exportArchive(zipFile);
  await destination.storage.importArchive(zipFile);
  const restored = await destination.storage.load();

  assert.equal(restored.board.items[0].title, 'ZIPテスト');
  assert.equal(restored.texts['welcome-1'], 'ZIP内の本文');
  assert.deepEqual(Buffer.from(await destination.storage.readImage(imageFile)), imageBytes);
});

test('全付箋を一般的なTXTと画像フォルダへ書き出す', async (t) => {
  const { dir, storage } = await tempStorage(t);
  const board = defaultBoard();
  board.items[0].title = '企画:メモ';
  board.items[0].tabs[0].title = '本文/案';
  await storage.saveBoard(board);
  await storage.saveTab('welcome', 'welcome-1', '外部で読める本文');
  const imageFile = await storage.saveImage('png', Buffer.from('0102', 'hex'));
  const parent = path.join(dir, 'exports');
  await fs.mkdir(parent);
  const exported = await storage.exportAllText(parent);

  const folders = await fs.readdir(exported);
  const noteFolder = folders.find((name) => name.startsWith('001-'));
  assert.ok(noteFolder);
  const files = await fs.readdir(path.join(exported, noteFolder));
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(exported, noteFolder, files[0]), 'utf8'), '外部で読める本文');
  assert.deepEqual(await fs.readFile(path.join(exported, 'images', imageFile)), Buffer.from('0102', 'hex'));
});
