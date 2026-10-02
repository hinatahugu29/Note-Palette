// UI 回帰テスト: 実際の Electron を一時データで起動し、tests/ui-scenario.js の結果を
// tests/ui-expected.json と比較する。期待値の更新: UPDATE_UI_EXPECTED=1 npm run test:ui
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const expectedFile = path.join(__dirname, 'ui-expected.json');

test('UIシナリオの結果が期待値と一致する', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notepalette-ui-'));
  const resultFile = path.join(tmp, 'result.json');
  try {
    const electron = require('electron');
    const run = spawnSync(electron, ['.'], {
      cwd: root,
      timeout: 90000,
      env: {
        ...process.env,
        NOTEPALETTE_DATA: path.join(tmp, 'data'),
        NOTEPALETTE_SCREENSHOT: path.join(tmp, 'shot.png'),
        NOTEPALETTE_RESULT: resultFile,
        NOTEPALETTE_SCRIPT: fs.readFileSync(path.join(__dirname, 'ui-scenario.js'), 'utf8'),
      },
    });
    assert.ok(fs.existsSync(resultFile), `結果が出力されなかった (exit ${run.status})`);
    const actual = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.deepEqual(actual.errors, [], 'レンダラーでエラーが発生した');
    if (process.env.UPDATE_UI_EXPECTED) {
      fs.writeFileSync(expectedFile, JSON.stringify(actual, null, 2) + '\n');
      return;
    }
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(expectedFile, 'utf8')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
