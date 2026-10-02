// レンダラー内で実行される UI 回帰シナリオ。最後に DOM の要約(ランダムIDを含まない)を返す。
// tests/ui.test.js が NOTEPALETTE_SCRIPT として渡し、tests/ui-expected.json と比較する。
(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  window.confirm = () => true; // 確認ダイアログでスクリプトが止まらないようにする
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));

  // 非同期処理(保存待ちを含む)の完了を固定待ちではなく条件で待つ
  const waitFor = async (cond, label) => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return;
      await w(50);
    }
    throw new Error('timeout waiting for ' + label);
  };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  const panels = () => [...document.querySelectorAll('#board .panel')];
  const panelByTitle = (t) => panels().find((p) => p.querySelector('.item-title').textContent === t);
  const type = (ta, text) => {
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pointer = (target, type, x, y) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
  const drag = async (handle, dx, dy) => {
    const r = handle.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    pointer(handle, 'pointerdown', x, y);
    pointer(window, 'pointermove', x + dx, y + dy);
    pointer(window, 'pointerup', x + dx, y + dy);
    await w(50);
  };
  const clickMenu = async (panel, action) => {
    [...panel.querySelectorAll('.actions button')].find((b) => b.textContent === '⋯').click();
    await w(50);
    document.querySelector(`#panel-menu [data-action="${action}"]`).click();
    await w(150);
  };

  const steps = {};
  const summarize = () =>
    panels().map((p) => {
      const r = p.getBoundingClientRect();
      return {
        title: p.querySelector('.item-title').textContent,
        color: [...p.classList].find((c) => /^c\d+$/.test(c)),
        flags: [...p.classList].filter((c) => !/^c\d+$/.test(c) && c !== 'panel' && c !== 'flash').sort(),
        tabs: [...p.querySelectorAll('.tabs .tab')].map((t) => t.textContent + (t.classList.contains('active') ? '*' : '')),
        fontSize: p.querySelector('.font-value').textContent,
        pinned: p.querySelector('.pin').classList.contains('active'),
        text: [...p.querySelectorAll('textarea')].map((t) => t.value),
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
      };
    });

  try {
    await w(300);
    steps.initial = summarize();

    for (let i = 0; i < 3; i++) {
      document.getElementById('btn-new').click();
      await w(100);
    }
    const initialTitles = panels().map((p) => p.querySelector('.item-title').textContent);
    steps.titles = initialTitles;

    const p2 = panelByTitle(initialTitles[1]);
    const p3 = panelByTitle(initialTitles[2]);
    type(p2.querySelector('textarea'), 'りんご apple\n二行目');
    type(p3.querySelector('textarea'), 'みかん orange');
    await w(100);

    // タブ追加・複製
    p2.querySelector('textarea').focus();
    key('t', { ctrlKey: true });
    await w(150);
    key('d', { ctrlKey: true });
    await waitFor(() => panelByTitle('付箋 2 のコピー'), '付箋の複製');
    await w(100);
    steps.afterTabAndDuplicate = summarize();

    // Ctrl+Tab でタブ巡回(付箋 2 のコピーがアクティブ。タブは メモ / タブ2)
    const activeTabs = () => panelByTitle('付箋 2 のコピー').querySelector('.tab.active').textContent;
    const cycled = [activeTabs()];
    key('Tab', { ctrlKey: true });
    await w(100);
    cycled.push(activeTabs());
    key('Tab', { ctrlKey: true, shiftKey: true });
    await w(100);
    cycled.push(activeTabs());
    key('Tab', { ctrlKey: true, shiftKey: true });
    await w(100);
    cycled.push(activeTabs());
    steps.tabCycle = cycled;

    // 文字サイズ・ピン・色
    const bigger = [...p3.querySelectorAll('.font-control button')].find((b) => b.textContent === 'A+');
    bigger.click();
    bigger.click();
    p3.querySelector('.pin').click();
    await clickMenu(p3, 'color');
    steps.afterFontPinColor = summarize();

    // ドラッグ移動・リサイズ
    await drag(p3.querySelector('.header .spacer'), 120, 160);
    await drag(p3.querySelector('.resize'), 60, 40);
    steps.afterDragResize = summarize();

    // タイル表示と解除
    document.getElementById('btn-layout').click();
    await w(300);
    steps.tile = summarize();
    steps.layoutLabelTile = document.getElementById('btn-layout').textContent;
    document.getElementById('btn-layout').click();
    await w(300);
    steps.freeAgain = summarize();

    // 検索
    const s = document.getElementById('search');
    s.value = 'apple';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await w(300);
    steps.search = {
      info: document.getElementById('search-info').textContent,
      results: [...document.querySelectorAll('#search-results button')].map((b) => b.textContent),
      dimmed: panels().filter((p) => p.classList.contains('dim')).length,
    };
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await w(200);

    // 最大化 → Esc
    p2.querySelector('.max-btn').click();
    await w(150);
    steps.maximized = panels().filter((p) => p.classList.contains('max')).length;
    steps.maxButtonLabels = [p2.querySelector('.max-btn').textContent, panelByTitle('付箋 3').querySelector('.max-btn').textContent];
    key('Escape');
    await w(200);
    steps.afterEscape = panels().filter((p) => p.classList.contains('max')).length;

    // 空の付箋の削除 → ゴミ箱に載る
    const p4 = panelByTitle(initialTitles[0]);
    await clickMenu(p4, 'delete');
    await waitFor(() => panels().length === 4, '付箋の削除');
    steps.afterDelete = panels().length;
    document.getElementById('btn-trash').click();
    await waitFor(() => document.querySelectorAll('#trash-list > *').length > 0, 'ゴミ箱一覧');
    steps.trashEntries = document.querySelectorAll('#trash-list > *').length;
    document.getElementById('trash-close').click();
    await w(100);

    // 保存状態
    await w(900);
    steps.status = document.getElementById('status').textContent;
  } catch (e) {
    errors.push('THROW ' + e.stack);
  }
  steps.errors = errors;
  return steps;
})();
