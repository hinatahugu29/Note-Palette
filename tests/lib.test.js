// レンダラーの純粋関数(src/renderer/lib)の単体テスト。
// dist は ESM だが package.json が無く Node が CJS 扱いするため、data: URL 経由で読み込む(lib は import を持たない)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = (name) =>
  import('data:text/javascript;charset=utf-8,' + encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'dist', 'renderer', 'lib', name), 'utf8')));
const bytes = (...b) => Uint8Array.from(b).buffer;

test('decodeTextFile: BOM・UTF-16・Shift_JIS・UTF-8 を判別する', async () => {
  const { decodeTextFile } = await load('text-file.js');
  const utf8 = Buffer.from('こんにちは', 'utf8');
  assert.deepEqual(decodeTextFile(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.length)), { text: 'こんにちは', encoding: 'UTF-8' });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.deepEqual(decodeTextFile(bom.buffer.slice(bom.byteOffset, bom.byteOffset + bom.length)), { text: 'こんにちは', encoding: 'UTF-8 BOM' });
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('あA', 'utf16le')]);
  assert.deepEqual(decodeTextFile(le.buffer.slice(le.byteOffset, le.byteOffset + le.length)), { text: 'あA', encoding: 'UTF-16 LE' });
  const be = Buffer.from([0xfe, 0xff, 0x30, 0x42, 0x00, 0x41]); // あA
  assert.deepEqual(decodeTextFile(be.buffer.slice(be.byteOffset, be.byteOffset + be.length)), { text: 'あA', encoding: 'UTF-16 BE' });
  // 「あ」= 0x82 0xA0 (Shift_JIS)。UTF-8 としては不正なので Shift_JIS にフォールバックする
  assert.deepEqual(decodeTextFile(bytes(0x82, 0xa0)), { text: 'あ', encoding: 'Shift_JIS' });
});

test('formatSize: 単位を切り替える', async () => {
  const { formatSize } = await load('text-file.js');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});

test('isTextFile: MIME または拡張子で判定する', async () => {
  const { isTextFile } = await load('text-file.js');
  assert.equal(isTextFile({ name: 'a.TXT', type: '' }), true);
  assert.equal(isTextFile({ name: 'x', type: 'text/plain' }), true);
  assert.equal(isTextFile({ name: 'a.png', type: 'image/png' }), false);
});

test('snapAxis / clamp: 8px未満で辺に吸着し、範囲に収める', async () => {
  const { snapAxis, clamp } = await load('geometry.js');
  assert.equal(snapAxis(105, 50, [100]), 100); // 先頭辺
  assert.equal(snapAxis(52, 50, [100]), 50); // 末尾辺(52+50=102→100)
  assert.equal(snapAxis(120, 50, [100]), 120); // 遠い
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(500, 0, 100), 100);
  assert.equal(clamp(5, 10, 3), 10); // hi < lo のときは lo
});

test('computeTileRects: 全件を隙間付きで画面内に並べる', async () => {
  const { computeTileRects, TILE_GAP } = await load('geometry.js');
  assert.equal(computeTileRects([], 800, 600).size, 0);
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const rects = computeTileRects(ids, 1000, 600);
  assert.equal(rects.size, 5);
  for (const r of rects.values()) {
    assert.ok(r.x >= TILE_GAP && r.y >= TILE_GAP);
    assert.ok(r.x + r.w <= 1000 - TILE_GAP + 0.001 && r.y + r.h <= 600 - TILE_GAP + 0.001);
  }
  const list = ids.map((id) => rects.get(id));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${ids[i]} と ${ids[j]} が重なっている`);
    }
  }
  assert.deepEqual(computeTileRects(['only'], 400, 300).get('only'), { x: 10, y: 10, w: 380, h: 280 });
});
