const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const appDir = path.join(releaseRoot, 'NotePalette-win32-x64');
const dataDir = path.join(appDir, 'NotePaletteData');
const preservedDir = path.join(releaseRoot, '.NotePaletteData-preserved');

function assertInsideRelease(target) {
  const relative = path.relative(releaseRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe release path: ${target}`);
}

function moveIfPresent(from, to) {
  assertInsideRelease(from);
  assertInsideRelease(to);
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) throw new Error(`preserve target already exists: ${to}`);
  fs.renameSync(from, to);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

fs.mkdirSync(releaseRoot, { recursive: true });
moveIfPresent(dataDir, preservedDir);
try {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', 'tsconfig.main.json']);
  run(process.execPath, [tsc, '-p', 'tsconfig.renderer.json']);
  const packager = path.join(root, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs');
  run(process.execPath, [packager,
    '.', 'NotePalette', '--platform=win32', '--arch=x64', '--out=release', '--overwrite', '--prune=true',
    '--icon=icon.ico', '--ignore=^/(src|release|scripts|tests|docs|tsconfig.*|HANDOVER.md|.gitignore)',
  ]);
  // Chromium の言語パックは日本語と英語(フォールバック)だけ残す。UI文言はアプリ側で持つため影響しない
  const localesDir = path.join(appDir, 'locales');
  for (const name of fs.readdirSync(localesDir)) {
    if (!['ja.pak', 'en-US.pak'].includes(name)) fs.rmSync(path.join(localesDir, name));
  }
  fs.copyFileSync(path.join(root, 'docs', 'NotePalette-manual.html'), path.join(appDir, 'NotePalette-manual.html'));
  fs.writeFileSync(
    path.join(appDir, 'portable.txt'),
    'NotePalette ポータブル版\r\nメモや設定は、このファイルと同じ場所の NotePaletteData フォルダに保存されます。\r\n配布・移動するときは NotePalette-win32-x64 フォルダごとコピーしてください。\r\n',
  );
} finally {
  if (fs.existsSync(preservedDir)) {
    assertInsideRelease(dataDir);
    fs.mkdirSync(appDir, { recursive: true });
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    fs.renameSync(preservedDir, dataDir);
  }
}
