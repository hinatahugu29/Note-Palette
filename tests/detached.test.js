const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('ノートを独立ウィンドウへ出し、次回起動用の状態を保存する', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notepalette-detached-'));
  const resultFile = path.join(tmp, 'result.json');
  try {
    const electron = require('electron');
    const script = `
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const panel = document.querySelector('.panel');
        [...panel.querySelectorAll('button')].find((button) => button.textContent === '⋯').click();
        await wait(50);
        document.querySelector('[data-action="detach"]').click();
        await wait(800);
        return { panelCount: document.querySelectorAll('.panel').length };
      })()
    `;
    const run = spawnSync(electron, ['.'], {
      cwd: root,
      timeout: 90000,
      env: {
        ...process.env,
        NOTEPALETTE_DATA: path.join(tmp, 'data'),
        NOTEPALETTE_SCREENSHOT: path.join(tmp, 'shot.png'),
        NOTEPALETTE_RESULT: resultFile,
        NOTEPALETTE_SCRIPT: script,
      },
    });
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), { panelCount: 0 });
    const board = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'board.json'), 'utf8'));
    assert.equal(board.items[0].mode, 'detached');
    assert.ok(board.items[0].detached.width >= 260);
    assert.ok(board.items[0].detached.height >= 180);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
