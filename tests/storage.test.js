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
