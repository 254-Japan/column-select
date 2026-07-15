/**
 * 矩形選択拡張 (Column Select)
 * Alt + 左ドラッグ で編集エリア内を矩形(カラム)選択し、
 * Ctrl+C / Ctrl+X でその矩形範囲をコピー/カットする。
 *
 * 対応:
 *  - contenteditable / designMode 編集領域 (DOM Range ベース)
 *  - <textarea> プレーンテキスト編集領域 (ミラー要素で文字位置を計算)
 */
(() => {
  const DRAG_OVERLAY_CLASS = '__rect_select_drag_overlay__';
  const HILITE_CLASS = '__rect_select_hilite__';

  // ============================================================
  // 多言語対応 (ブラウザの言語設定に応じて日本語/英語を切り替え)
  // ============================================================
  const UI_LANG = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const I18N = {
    ja: {
      replaceTitle: '置換',
      scopeLabel: '対象範囲:',
      scopeRect: (n) => `矩形選択 ${n} 行`,
      scopeSel: (n) => `テキスト選択 ${n} 文字`,
      scopeAll: '本文全体',
      hintRect: '矩形選択中に開く → 各行の選択列内だけ置換',
      hintSel: 'テキスト選択中に開く → 選択範囲内だけ置換',
      hintAll: '選択なしで開く → 本文全体を置換',
      searchLabel: '検索文字列',
      replaceLabel: '置換後の文字列',
      caseSensitive: '大文字/小文字を区別する',
      regexLabel: '正規表現 (.* など)',
      execButton: 'すべて置換',
      errNoSearch: '検索文字列を入力してください',
      errBadRegex: (msg) => `正規表現が不正です: ${msg}`,
      errRiskyRegex: 'この正規表現は動作が極端に遅くなる可能性があるため実行を中止しました(グループ内の量指定子の入れ子を見直してください)',
      resultReplaced: (n) => `${n} 件置換しました`,
      resultNotFound: '置換対象が見つかりませんでした',
      tmplLabel: '定型:',
      tmplSave: '＋保存',
      seqTitle: '連番を挿入',
      seqStart: '開始値',
      seqStep: '増分',
      seqInsert: '挿入',
    },
    en: {
      replaceTitle: 'Replace',
      scopeLabel: 'Scope:',
      scopeRect: (n) => `Rectangle selection (${n} rows)`,
      scopeSel: (n) => `Text selection (${n} chars)`,
      scopeAll: 'Entire content',
      hintRect: 'Opened with a rectangle selection → replaces only within each selected column',
      hintSel: 'Opened with a text selection → replaces only within the selection',
      hintAll: 'Opened with no selection → replaces across the entire content',
      searchLabel: 'Search for',
      replaceLabel: 'Replace with',
      caseSensitive: 'Match case',
      regexLabel: 'Regex (.* etc.)',
      execButton: 'Replace All',
      errNoSearch: 'Please enter a search string',
      errBadRegex: (msg) => `Invalid regular expression: ${msg}`,
      errRiskyRegex: 'This pattern could run extremely slowly (nested quantifiers inside a group), so it was not run. Please simplify it.',
      resultReplaced: (n) => `${n} replacement(s) made`,
      resultNotFound: 'No matches found',
      tmplLabel: 'Saved:',
      tmplSave: '+ Save',
      seqTitle: 'Insert Sequence',
      seqStart: 'Start',
      seqStep: 'Step',
      seqInsert: 'Insert',
    },
  };
  const t = (key, ...args) => {
    const entry = I18N[UI_LANG][key];
    return typeof entry === 'function' ? entry(...args) : entry;
  };

  // ============================================================
  // 純粋ロジック: 重複行削除 / 文字数カウント (DOM非依存、要テスト)
  // ============================================================
  // 各行を先頭から見て、初出の行だけ残す。空行は重複除去の対象外
  // (意図的な空行区切りを壊さないため)。大文字小文字は区別する(別行扱い)。
  function dedupeLines(lines) {
    const seen = new Set();
    const result = [];
    for (const line of lines) {
      if (line === '') { result.push(line); continue; }
      if (seen.has(line)) continue;
      seen.add(line);
      result.push(line);
    }
    return result;
  }

  function countSelection(lineTexts) {
    const charCount = lineTexts.reduce((sum, s) => sum + s.length, 0);
    const lineCount = lineTexts.length;
    return { charCount, lineCount };
  }

  // ============================================================
  // 置換ダイアログ共通ロジック (textarea版/contenteditable版で共有)
  // ============================================================
  // 破滅的バックトラック(ReDoS)の典型パターン: 量指定子を含むグループに、
  // さらに量指定子が付いている形("(x+)+"、"(x*)*"、"(x+){2,}" など)。
  // これはヒューリスティックであり全パターンを検出できるわけではないが、
  // タブが無期限にフリーズする代表的な形だけでも実行前に弾く目的。
  const RISKY_REGEX_PATTERN = /\([^()]*[+*][^()]*\)[+*]|\([^()]*[+*][^()]*\)\{\d*,/;

  function buildRegex(searchStr, { caseSensitive, useRegex }) {
    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = useRegex
      ? searchStr
      : searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (useRegex && RISKY_REGEX_PATTERN.test(pattern)) {
      return { regex: null, error: null, risky: true };
    }
    try {
      return { regex: new RegExp(pattern, flags), error: null };
    } catch (e) {
      return { regex: null, error: e.message };
    }
  }

  // str.match(regex) と str.replace(regex, replaceStr) を毎回セットで呼ぶと
  // 同じ文字列を2回走査することになるため、1回の replace で件数カウントと
  // 置換を同時に行う。$&, $`, $', $$, $1-$99, $<name> のネイティブ置換構文と
  // 完全に同じ結果になることを scratchpad で13パターン検証済み
  // (通常マッチ・大文字小文字・キャプチャ未マッチ・2桁グループの曖昧解決・
  //  名前付きグループなど)。
  function replaceWithCount(str, regex, replaceStr) {
    let count = 0;
    const result = str.replace(regex, (...args) => {
      count++;
      let a = args;
      let namedGroups = null;
      if (typeof a[a.length - 1] === 'object' && a[a.length - 1] !== null) {
        namedGroups = a[a.length - 1];
        a = a.slice(0, -1);
      }
      const matched = a[0];
      const offset = a[a.length - 2];
      const full = a[a.length - 1];
      const groups = a.slice(1, a.length - 2);
      return expandReplacement(replaceStr, matched, groups, namedGroups, offset, full);
    });
    return { result, count };
  }

  function expandReplacement(template, matched, groups, namedGroups, offset, full) {
    return template.replace(/\$(\$|&|`|'|<[^>]+>|[0-9]{1,2})/g, (m, token) => {
      if (token === '$') return '$';
      if (token === '&') return matched;
      if (token === '`') return full.slice(0, offset);
      if (token === "'") return full.slice(offset + matched.length);
      if (token[0] === '<') {
        const name = token.slice(1, -1);
        if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, name)) {
          return namedGroups[name] ?? '';
        }
        return m;
      }
      // 2桁を優先的にグループ番号として解釈し、無効なら1桁目だけをグループ番号として使い、
      // 2桁目はリテラルとして残す(ネイティブ挙動と同じ曖昧解決)
      if (token.length === 2) {
        const n2 = parseInt(token, 10);
        if (n2 >= 1 && n2 <= groups.length) return groups[n2 - 1] ?? '';
        const n1 = parseInt(token[0], 10);
        if (n1 >= 1 && n1 <= groups.length) return (groups[n1 - 1] ?? '') + token[1];
        return m;
      }
      const n1 = parseInt(token, 10);
      if (n1 >= 1 && n1 <= groups.length) return groups[n1 - 1] ?? '';
      return m;
    });
  }

  const TEMPLATE_STORAGE_KEY = 'csTemplates';
  const TEMPLATE_MAX = 20;

  // 拡張機能が更新/無効化された後の古いタブでは chrome.storage 呼び出しが
  // 「Extension context invalidated」で例外を投げる。フェイルクローズしすぎて
  // ダイアログ自体を壊さないよう、失敗時はコールバックを呼ばず静かに諦める。
  function safeStorageGet(defaults, cb) {
    try {
      chrome.storage.local.get(defaults, cb);
    } catch (e) {
      dbg('storage', 'get失敗(拡張機能コンテキスト無効?)', { error: e.message });
    }
  }
  function safeStorageSet(items, cb) {
    try {
      chrome.storage.local.set(items, cb);
    } catch (e) {
      dbg('storage', 'set失敗(拡張機能コンテキスト無効?)', { error: e.message });
    }
  }

  // read-modify-write: 保存直前に最新値を取り直してからmutateFnで変更し書き込む。
  // 複数タブ/フレームが同時に「＋保存」しても、片方の保存が丸ごと消えないようにする。
  function mutateTemplates(mutateFn, done) {
    safeStorageGet({ [TEMPLATE_STORAGE_KEY]: [] }, (result) => {
      const current = result[TEMPLATE_STORAGE_KEY];
      const next = mutateFn(current);
      if (next === null) { done(current); return; } // 変更なし
      safeStorageSet({ [TEMPLATE_STORAGE_KEY]: next }, () => done(next));
    });
  }

  function renderTemplateChips(container, searchInput) {
    safeStorageGet({ [TEMPLATE_STORAGE_KEY]: [] }, (result) => {
      const templates = result[TEMPLATE_STORAGE_KEY];
      container.innerHTML = '';

      const label = document.createElement('span');
      label.textContent = t('tmplLabel');
      label.style.cssText = 'font-size:11px;color:#666;margin-right:2px';
      container.appendChild(label);

      for (const tmpl of templates) {
        const chip = document.createElement('span');
        chip.style.cssText = `
          display:inline-flex;align-items:center;gap:3px;
          background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;
          padding:2px 4px 2px 8px;font-size:11px;color:#3730a3;cursor:pointer;
        `;
        const textSpan = document.createElement('span');
        textSpan.textContent = tmpl;
        chip.appendChild(textSpan);
        chip.addEventListener('click', () => {
          searchInput.value = tmpl;
          searchInput.focus();
        });

        const delBtn = document.createElement('span');
        delBtn.textContent = '×';
        delBtn.style.cssText = 'padding:0 3px;color:#8888aa;font-weight:bold';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          mutateTemplates(
            (list) => list.filter((x) => x !== tmpl),
            () => renderTemplateChips(container, searchInput)
          );
        });
        chip.appendChild(delBtn);
        container.appendChild(chip);
      }

      const saveBtn = document.createElement('span');
      saveBtn.textContent = t('tmplSave');
      saveBtn.style.cssText = `
        display:inline-block;font-size:11px;color:#1a73e8;cursor:pointer;
        padding:2px 6px;border:1px dashed #a0b8e8;border-radius:12px;
      `;
      saveBtn.addEventListener('click', () => {
        const val = searchInput.value.trim();
        if (!val) return;
        mutateTemplates(
          (list) => list.includes(val) ? null : [...list, val].slice(-TEMPLATE_MAX),
          () => renderTemplateChips(container, searchInput)
        );
      });
      container.appendChild(saveBtn);
    });
  }

  // ============================================================
  // デバッグシステム
  // Alt+Shift+` でON/OFFトグル。コンソール + 画面パネルに出力。
  // ============================================================
  let debugEnabled = false;
  let debugPanel = null;
  let debugLog = [];
  const DEBUG_MAX_LINES = 30;

  function dbg(category, msg, data) {
    if (!debugEnabled) return;
    const line = `[${category}] ${msg}`;
    const dataStr = data !== undefined ? JSON.stringify(data, null, 0) : '';
    console.log(`%c${line}`, 'color:#1a73e8;font-weight:bold', data ?? '');
    debugLog.push({ time: Date.now(), line, dataStr });
    if (debugLog.length > DEBUG_MAX_LINES) debugLog.shift();
    renderDebugPanel();
  }

  function renderDebugPanel() {
    if (!debugPanel) return;

    const kbSummary = !kbState ? 'null' : kbState.mode === 'contenteditable'
      ? `CE  anchorX=${kbState.anchorX?.toFixed(1)} curX=${kbState.curX?.toFixed(1)}`
      : `TA  anchor(${kbState.anchorRow},${kbState.anchorCol}) cur(${kbState.curRow},${kbState.curCol})`;

    const rectSummary = !rectSelection ? 'null'
      : rectSelection.mode === 'contenteditable'
        ? `CE  ${rectSelection.ranges?.length ?? 0} ranges`
        : `TA  ${rectSelection.segments?.length ?? 0} segs`;

    // debugLog にはページ本文の断片(検索文字列・矩形範囲のテキスト等)が含まれるため、
    // innerHTML ではなく textContent で組み立てて任意HTML実行を防ぐ(デバッグモードは
    // 開発者向け機能だが、悪意あるページで自動的にONにされる可能性はゼロではない)。
    debugPanel.textContent = '';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    const title = document.createElement('b');
    title.style.color = '#1a73e8';
    title.textContent = '▦ Column Select DEBUG';
    const closeBtn = document.createElement('span');
    closeBtn.style.cssText = 'cursor:pointer;color:#aaa';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', toggleDebug);
    header.appendChild(title);
    header.appendChild(closeBtn);
    debugPanel.appendChild(header);

    const kbLine = document.createElement('div');
    kbLine.style.cssText = 'margin-bottom:3px;color:#ffd';
    kbLine.innerHTML = '<b>kbState:</b> ';
    kbLine.appendChild(document.createTextNode(kbSummary));
    debugPanel.appendChild(kbLine);

    const rectLine = document.createElement('div');
    rectLine.style.cssText = 'margin-bottom:6px;color:#ffd';
    rectLine.innerHTML = '<b>rectSel:</b> ';
    rectLine.appendChild(document.createTextNode(rectSummary));
    debugPanel.appendChild(rectLine);

    const logContainer = document.createElement('div');
    logContainer.style.cssText = 'font-size:10px;max-height:220px;overflow-y:auto';
    for (const { line, dataStr } of debugLog.slice(-12)) {
      const row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid #333;padding:1px 0;white-space:pre-wrap;word-break:break-all';
      const lineSpan = document.createElement('span');
      lineSpan.style.color = '#aaa';
      lineSpan.textContent = line;
      row.appendChild(lineSpan);
      if (dataStr) {
        const dataSpan = document.createElement('span');
        dataSpan.style.color = '#8f8';
        dataSpan.textContent = ' ' + dataStr;
        row.appendChild(dataSpan);
      }
      logContainer.appendChild(row);
    }
    debugPanel.appendChild(logContainer);
  }

  function toggleDebug() {
    debugEnabled = !debugEnabled;
    if (debugEnabled) {
      debugLog = [];
      debugPanel = document.createElement('div');
      debugPanel.id = '__rect_select_debug__';
      debugPanel.style.cssText = `
        position:fixed;top:8px;left:8px;z-index:2147483647;
        background:rgba(0,0,0,0.88);color:#eee;font:11px/1.4 monospace;
        padding:8px 10px;border-radius:6px;min-width:320px;max-width:480px;
        box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:auto;
      `;
      document.body.appendChild(debugPanel);
      renderDebugPanel();
      dbg('DEBUG', 'デバッグモード ON (Alt+Shift+` でOFF)');
    } else {
      debugPanel?.remove();
      debugPanel = null;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === '`' || e.key === '~' || e.code === 'Backquote')) {
      toggleDebug();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  let dragging = false;
  let dragStart = null; // {x, y}
  let dragMode = null; // 'contenteditable' | 'textarea'
  let dragRoot = null; // editable element / textarea
  let dragOverlayEl = null;
  let dragCache = null; // ドラッグ中に使い回す行モデル(textarea: rows配列 / CE: lineRects配列)
  let hiliteEls = [];
  let rectSelection = null; // {mode, ranges?, textarea?, segments?}
  let kbState = null; // {textarea, anchorRow, anchorCol, curRow, curCol}

  // ============================================================
  // 共通: オーバーレイ
  // ============================================================
  function ensureOverlayStyle() {
    if (document.getElementById('__rect_select_style__')) return;
    const style = document.createElement('style');
    style.id = '__rect_select_style__';
    style.textContent = `
      .${DRAG_OVERLAY_CLASS} {
        position: fixed;
        border: 1px dashed #1a73e8;
        background: rgba(26, 115, 232, 0.15);
        pointer-events: none;
        z-index: 2147483647;
      }
      .${HILITE_CLASS} {
        position: fixed;
        background: rgba(255, 235, 59, 0.5);
        pointer-events: none;
        z-index: 2147483646;
      }
    `;
    document.head.appendChild(style);
  }

  function clearHighlights() {
    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];
    rectSelection = null;
    kbState = null;
    hideCountBadge();
    if (debugEnabled) renderDebugPanel();
  }

  function removeDragOverlay() {
    if (dragOverlayEl) {
      dragOverlayEl.remove();
      dragOverlayEl = null;
    }
  }

  function updateDragOverlay(curX, curY) {
    const left = Math.min(dragStart.x, curX);
    const top = Math.min(dragStart.y, curY);
    const width = Math.abs(curX - dragStart.x);
    const height = Math.abs(curY - dragStart.y);
    dragOverlayEl.style.left = `${left}px`;
    dragOverlayEl.style.top = `${top}px`;
    dragOverlayEl.style.width = `${width}px`;
    dragOverlayEl.style.height = `${height}px`;
  }

  function addHilite(rect) {
    if (rect.width <= 0 || rect.height <= 0) return;
    const hilite = document.createElement('div');
    hilite.className = HILITE_CLASS;
    hilite.style.left = `${rect.left}px`;
    hilite.style.top = `${rect.top}px`;
    hilite.style.width = `${rect.width}px`;
    hilite.style.height = `${rect.height}px`;
    document.body.appendChild(hilite);
    hiliteEls.push(hilite);
  }

  // ============================================================
  // 編集領域の判定
  // ============================================================
  function isEditableTarget(target) {
    if (document.designMode === 'on') return document.body;
    let el = target;
    if (el instanceof Node && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!(el instanceof Element)) return null;
    if (!el.isContentEditable) return null;
    let host = el;
    while (host.parentElement && host.parentElement.isContentEditable) {
      host = host.parentElement;
    }
    return host;
  }

  function caretRangeFromPointSafe(x, y) {
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y);
    }
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function getCollapsedRangeRect(range) {
    const r = range.cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length > 0) return rects[0];
    const br = r.getBoundingClientRect();
    if (br.height > 0) return br;
    return null;
  }

  // カーソル位置のX座標を取得する。collapsed rectが取れない場合は
  // その位置の文字を1文字スパンするRangeから左端を求めるフォールバックを持つ。
  function getRangeX(range) {
    const collapsed = getCollapsedRangeRect(range);
    if (collapsed) return collapsed.left;

    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const len = range.startContainer.length;
      const off = range.startOffset;
      try {
        if (off < len) {
          const cr = document.createRange();
          cr.setStart(range.startContainer, off);
          cr.setEnd(range.startContainer, off + 1);
          const rects = cr.getClientRects();
          if (rects.length > 0) {
            dbg('getRangeX', `collapsed失敗→charFallback`, { off, x: rects[0].left });
            return rects[0].left;
          }
        } else if (off > 0) {
          const cr = document.createRange();
          cr.setStart(range.startContainer, off - 1);
          cr.setEnd(range.startContainer, off);
          const rects = cr.getClientRects();
          if (rects.length > 0) {
            dbg('getRangeX', `collapsed失敗→prevCharFallback`, { off, x: rects[0].right });
            return rects[0].right;
          }
        }
      } catch (_) { /* ignore */ }
    }
    dbg('getRangeX', 'X座標取得失敗(null)', { nodeType: range.startContainer.nodeType, off: range.startOffset });
    return null;
  }

  // ============================================================
  // contenteditable 用: 矩形 -> Range配列
  // ============================================================
  // root配下の行矩形一覧を取得する。ドラッグ中は同じ結果を毎フレーム使い回すため
  // 呼び出し側でキャッシュできるよう単独関数に分離している。
  function computeLineRects(root) {
    const fullRange = document.createRange();
    fullRange.selectNodeContents(root);
    return Array.from(fullRange.getClientRects());
  }

  // precomputedLineRects を渡すと computeLineRects() の再実行(レイアウト計算)を省略できる。
  // ドラッグ中のライブハイライト更新(高頻度)ではキャッシュを使い、mouseup確定時のみ
  // 再計算して最新のDOM状態を反映する。
  function buildContentEditableSelection(root, selLeft, selRight, selTop, selBottom, precomputedLineRects) {
    const lineRects = precomputedLineRects || computeLineRects(root);

    const newRanges = [];
    // GMail等はspan入れ子でgetClientRects()が同一視覚行に複数Rectを返す。
    // midYを2px単位のバケツで管理して1視覚行につき1回だけ処理する。
    const processedRows = new Set();
    const rootBr = root.getBoundingClientRect();
    // caretRangeFromPointSafe が root 外を返さないよう left/right を root 内側にクランプ
    const safeLeft  = Math.max(selLeft,  rootBr.left  + 0.5);
    const safeRight = Math.min(selRight, rootBr.right - 0.5);
    dbg('buildCE', '開始', {
      selLeft: selLeft.toFixed(1), selRight: selRight.toFixed(1),
      safeLeft: safeLeft.toFixed(1), safeRight: safeRight.toFixed(1),
      selTop: selTop.toFixed(1), selBottom: selBottom.toFixed(1),
      totalRects: lineRects.length,
      rootTag: root.tagName, rootId: root.id || '(none)',
      rootClass: root.className?.slice(0,40) || '(none)',
      rootRect: `${rootBr.top.toFixed(0)},${rootBr.left.toFixed(0)},${rootBr.bottom.toFixed(0)},${rootBr.right.toFixed(0)}`,
    });
    if (debugEnabled) {
      const sample = lineRects.slice(0, 5).map(r => `y=${r.top.toFixed(0)}-${r.bottom.toFixed(0)} x=${r.left.toFixed(0)}-${r.right.toFixed(0)}`);
      dbg('buildCE', `lineRects先頭5件`, sample);
    }

    for (const rect of lineRects) {
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.bottom <= selTop || rect.top >= selBottom) continue;

      const midY = (Math.max(rect.top, selTop) + Math.min(rect.bottom, selBottom)) / 2;
      const rowKey = Math.round(midY / 2);
      if (processedRows.has(rowKey)) continue;
      processedRows.add(rowKey);

      const startCaret = caretRangeFromPointSafe(safeLeft, midY);
      const endCaret   = caretRangeFromPointSafe(safeRight, midY);
      if (!startCaret || !endCaret) continue;
      if (!root.contains(startCaret.startContainer) || !root.contains(endCaret.startContainer)) continue;

      const range = document.createRange();
      try {
        range.setStart(startCaret.startContainer, startCaret.startOffset);
        range.setEnd(endCaret.startContainer, endCaret.startOffset);
      } catch (err) {
        continue;
      }

      if (range.collapsed) {
        const swapped = document.createRange();
        swapped.setStart(endCaret.startContainer, endCaret.startOffset);
        swapped.setEnd(startCaret.startContainer, startCaret.startOffset);
        if (swapped.collapsed) {
          // ゼロ幅列: textareaの start===end セグメントと同様に、カーソル位置を
          // 細線ハイライトで示しつつ collapsed range を挿入対象として保持する
          const lineTop    = Math.max(rect.top,    selTop);
          const lineBottom = Math.min(rect.bottom, selBottom);
          const caretX     = getCollapsedRangeRect(startCaret)?.left ?? safeLeft;
          dbg('buildCE', `ゼロ幅列 y=${lineTop.toFixed(0)}-${lineBottom.toFixed(0)} x=${caretX.toFixed(0)}`);
          addHilite({ left: caretX, top: lineTop, width: 2, height: lineBottom - lineTop });
          newRanges.push(range); // collapsed range: カラム挿入の位置として使用
          continue;
        }
        newRanges.push(swapped);
      } else {
        newRanges.push(range);
      }
    }

    // 同一視覚行から複数Rangeが生成された場合に備えてstartPosition基準で重複排除する
    // (大きなコンテナrectが個別行のrectと同じcaret位置に解決されるケースへの対策)
    const deduped = [];
    for (const r of newRanges) {
      const dup = deduped.some(x =>
        x.startContainer === r.startContainer && x.startOffset === r.startOffset
      );
      if (!dup) deduped.push(r);
    }
    if (deduped.length !== newRanges.length) {
      dbg('buildCE', `重複排除: ${newRanges.length}→${deduped.length}行`);
    }
    newRanges.length = 0;
    deduped.forEach(r => newRanges.push(r));

    dbg('buildCE', `完了: ${newRanges.length}行選択`, newRanges.map((r, i) => `[${i}] "${r.toString().slice(0,20)}"`));

    for (const range of newRanges) {
      for (const r of range.getClientRects()) addHilite(r);
    }

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();

    return { mode: 'contenteditable', ranges: newRanges, root };
  }

  // ============================================================
  // textarea 用: 矩形 -> 文字インデックス範囲(行ごと)
  // buildTextareaRows() が構築する行モデル(colLefts)を再利用する。
  // ============================================================
  // 行の colLefts(桁の左端座標。末尾に行末右端を1個追加した配列)から、
  // ピクセル範囲 [selLeft, selRight) に重なる桁範囲を求める。
  // 該当なしなら null。
  function columnRangeFromX(row, selLeft, selRight) {
    let colFrom = -1;
    let colTo = -1;
    for (let i = 0; i < row.length; i++) {
      if (colFrom === -1 && row.colLefts[i + 1] > selLeft) colFrom = i;
      if (row.colLefts[i] < selRight) colTo = i + 1;
    }
    if (colFrom === -1 || colTo === -1 || colTo <= colFrom) return null;
    return { colFrom, colTo };
  }

  // precomputedRows を渡すと buildTextareaRows() の再実行(ミラーDOM再構築)を省略できる。
  // ドラッグ中のライブハイライト更新(高頻度)ではキャッシュを使い、mouseup確定時のみ
  // 再計算して最新のDOM状態を反映する。
  function buildTextareaSelection(textarea, selLeft, selRight, selTop, selBottom, precomputedRows) {
    const rows = precomputedRows || buildTextareaRows(textarea);
    const segments = [];

    for (const row of rows) {
      if (row.bottom <= selTop || row.top >= selBottom) continue;

      // 空行の処理: テキストがなくても挿入対象に含める
      if (row.length === 0) {
        const idx = row.startIdx;
        segments.push({ start: idx, end: idx });
        const x = row.colLefts[0] ?? 0;
        addHilite({ left: x, top: row.top, width: 2, height: row.bottom - row.top });
        continue;
      }

      const range = columnRangeFromX(row, selLeft, selRight);
      if (!range) continue;
      const { colFrom, colTo } = range;

      segments.push({ start: row.startIdx + colFrom, end: row.startIdx + colTo });
      addHilite({
        left: row.colLefts[colFrom],
        top: row.top,
        width: row.colLefts[colTo] - row.colLefts[colFrom],
        height: row.bottom - row.top,
      });
    }

    return { mode: 'textarea', textarea, segments };
  }

  // ============================================================
  // textarea 用: キーボード矩形選択 (Alt+Shift+矢印キー)
  // 各「見た目の行」を行番号(row)・桁(col)で扱うためのモデルを構築する
  // ============================================================
  function buildTextareaRows(textarea) {
    const cs = getComputedStyle(textarea);
    const rect = textarea.getBoundingClientRect();
    const scrollbarW = textarea.offsetWidth - textarea.clientWidth;

    const mirror = document.createElement('div');
    const copyProps = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'lineHeight', 'textIndent', 'textTransform', 'wordSpacing', 'tabSize',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    ];
    for (const p of copyProps) mirror.style[p] = cs[p];
    mirror.style.boxSizing = 'border-box';
    mirror.style.borderStyle = 'solid';
    mirror.style.borderColor = 'transparent';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.position = 'fixed';
    mirror.style.left = `${rect.left}px`;
    mirror.style.top = `${rect.top}px`;
    mirror.style.width = `${rect.width - scrollbarW}px`;
    mirror.style.height = `${rect.height}px`;
    mirror.style.margin = '0';
    mirror.style.overflow = 'hidden';
    mirror.style.visibility = 'hidden';

    const value = textarea.value;
    const lines = value.split('\n');
    const frag = document.createDocumentFragment();
    const allSpans = [];
    let globalIndex = 0;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.length === 0) {
        const span = document.createElement('span');
        span.textContent = '​';
        span.dataset.idx = String(globalIndex);
        span.dataset.empty = '1';
        frag.appendChild(span);
        allSpans.push(span);
      } else {
        for (let ci = 0; ci < line.length; ci++) {
          const span = document.createElement('span');
          span.textContent = line[ci];
          span.dataset.idx = String(globalIndex);
          frag.appendChild(span);
          allSpans.push(span);
          globalIndex++;
        }
      }
      if (li < lines.length - 1) {
        frag.appendChild(document.createTextNode('\n'));
        globalIndex++;
      }
    }

    mirror.appendChild(frag);
    document.body.appendChild(mirror);
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    const rows = [];
    let lastTop = null;
    let current = null;
    for (const span of allSpans) {
      const r = span.getBoundingClientRect();
      if (lastTop === null || Math.abs(r.top - lastTop) > 1) {
        current = {
          top: r.top,
          bottom: r.bottom,
          startIdx: parseInt(span.dataset.idx, 10),
          length: 0,
          colLefts: [],
        };
        rows.push(current);
        lastTop = r.top;
      }
      if (span.dataset.empty) {
        current.colLefts = [r.left];
        current.length = 0;
      } else {
        current.colLefts.push(r.left);
        current.length++;
        current._lastRect = r;
      }
    }
    for (const row of rows) {
      if (row.length > 0) row.colLefts.push(row._lastRect.right);
      delete row._lastRect;
    }

    mirror.remove();
    return rows;
  }

  function rowColFromIndex(rows, idx) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (idx <= row.startIdx + row.length) return { row: i, col: idx - row.startIdx };
    }
    const last = rows[rows.length - 1];
    return { row: rows.length - 1, col: last.length };
  }

  function indexFromRowCol(rows, row, col) {
    const r = rows[Math.max(0, Math.min(row, rows.length - 1))];
    const c = Math.max(0, Math.min(col, r.length));
    return r.startIdx + c;
  }

  function handleKeyboardRectSelect(textarea, key) {
    const rows = buildTextareaRows(textarea);
    if (rows.length === 0) return;

    if (!kbState || kbState.textarea !== textarea) {
      const { row, col } = rowColFromIndex(rows, textarea.selectionStart);
      kbState = { textarea, anchorRow: row, anchorCol: col, curRow: row, curCol: col };
    }

    switch (key) {
      case 'ArrowUp':
        kbState.curRow = Math.max(0, kbState.curRow - 1);
        break;
      case 'ArrowDown':
        kbState.curRow = Math.min(rows.length - 1, kbState.curRow + 1);
        break;
      case 'ArrowLeft':
        kbState.curCol = Math.max(0, kbState.curCol - 1);
        break;
      case 'ArrowRight':
        kbState.curCol = kbState.curCol + 1;
        break;
      default:
        return;
    }

    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];

    const rowFrom = Math.min(kbState.anchorRow, kbState.curRow);
    const rowTo = Math.max(kbState.anchorRow, kbState.curRow);
    const colFrom = Math.min(kbState.anchorCol, kbState.curCol);
    const colTo = Math.max(kbState.anchorCol, kbState.curCol);

    const segments = [];
    for (let ri = rowFrom; ri <= rowTo; ri++) {
      const row = rows[ri];
      const segColFrom = Math.min(colFrom, row.length);
      const segColTo = Math.min(colTo, row.length);
      if (segColTo > segColFrom) {
        segments.push({ start: row.startIdx + segColFrom, end: row.startIdx + segColTo });
        addHilite({
          left: row.colLefts[segColFrom],
          top: row.top,
          width: row.colLefts[segColTo] - row.colLefts[segColFrom],
          height: row.bottom - row.top,
        });
      } else {
        // 空行・行末を超えた仮想列: ゼロ幅セグメントとして挿入対象に含める
        const insertPos = row.startIdx + segColFrom;
        segments.push({ start: insertPos, end: insertPos });
        const markerX = row.colLefts[segColFrom] ?? row.colLefts[row.colLefts.length - 1] ?? 0;
        addHilite({ left: markerX, top: row.top, width: 2, height: row.bottom - row.top });
      }
    }

    rectSelection = segments.length > 0 ? { mode: 'textarea', textarea, segments } : null;
    updateCountBadge();

    const curIdx = indexFromRowCol(rows, kbState.curRow, kbState.curCol);
    textarea.setSelectionRange(curIdx, curIdx);
  }

  // ============================================================
  // contenteditable 用: キーボード矩形選択 (Alt+Shift+矢印キー)
  // ============================================================
  function handleKeyboardRectSelectCE(root, key) {
    // buildContentEditableSelectionがsel.removeAllRanges()するのでここで先にfocusを確保
    root.focus();
    const sel = window.getSelection();

    // kbStateが無効 or rootが変わった or anchorRangeがrootに属さなくなった場合は再初期化
    const needsInit = !kbState
      || kbState.mode !== 'contenteditable'
      || kbState.root !== root
      || !root.contains(kbState.anchorRange.startContainer);

    if (needsInit) {
      if (!sel || sel.rangeCount === 0 || !sel.focusNode) {
        dbg('kbCE', '初期化失敗: sel.focusNode なし');
        return;
      }
      if (!root.contains(sel.focusNode)) {
        dbg('kbCE', '初期化失敗: focusNodeがroot外');
        return;
      }
      const focusRange = document.createRange();
      focusRange.setStart(sel.focusNode, sel.focusOffset);
      focusRange.collapse(true);
      const x = getRangeX(focusRange);
      if (x === null) {
        dbg('kbCE', '初期化失敗: getRangeX null');
        return;
      }
      kbState = {
        mode: 'contenteditable',
        root,
        anchorRange: focusRange.cloneRange(),
        curRange: focusRange.cloneRange(),
        anchorX: x,
        curX: x,
      };
      const rb = root.getBoundingClientRect();
      dbg('kbCE', '初期化', {
        anchorX: x.toFixed(1),
        node: sel.focusNode.nodeValue?.slice(0, 20) ?? `<${sel.focusNode.nodeName}>`,
        off: sel.focusOffset,
        rootTag: root.tagName, rootId: root.id?.slice(0,20) || '(none)',
        rootRect: `t=${rb.top.toFixed(0)} l=${rb.left.toFixed(0)} b=${rb.bottom.toFixed(0)} r=${rb.right.toFixed(0)}`,
      });
    }

    const curRect = getCollapsedRangeRect(kbState.curRange);
    if (!curRect) {
      dbg('kbCE', 'curRect取得失敗→kbStateリセット');
      kbState = null;
      return;
    }

    let newRange = null;

    if (key === 'ArrowUp') {
      newRange = caretRangeFromPointSafe(kbState.curX, curRect.top - curRect.height * 0.6);
      dbg('kbCE', 'Up', { fromY: curRect.top.toFixed(1), toY: (curRect.top - curRect.height * 0.6).toFixed(1), curX: kbState.curX.toFixed(1) });
    } else if (key === 'ArrowDown') {
      newRange = caretRangeFromPointSafe(kbState.curX, curRect.bottom + curRect.height * 0.6);
      dbg('kbCE', 'Down', { fromY: curRect.bottom.toFixed(1), toY: (curRect.bottom + curRect.height * 0.6).toFixed(1), curX: kbState.curX.toFixed(1) });
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      root.focus();
      sel.removeAllRanges();
      sel.addRange(kbState.curRange.cloneRange());
      sel.modify('move', key === 'ArrowLeft' ? 'left' : 'right', 'character');
      if (sel.rangeCount > 0) {
        newRange = sel.getRangeAt(0).cloneRange();
        const x = getRangeX(newRange);
        dbg('kbCE', key, { prevCurX: kbState.curX.toFixed(1), newX: x?.toFixed(1) ?? 'null', node: newRange.startContainer.nodeValue?.slice(0, 20), off: newRange.startOffset });
        if (x !== null) kbState.curX = x;
      }
    }

    if (!newRange || !root.contains(newRange.startContainer)) {
      dbg('kbCE', '移動失敗: newRange無効');
      return;
    }
    kbState.curRange = newRange;

    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];

    const anchorRect = getCollapsedRangeRect(kbState.anchorRange)
      ?? kbState.anchorRange.getBoundingClientRect();
    const newCurRect = getCollapsedRangeRect(kbState.curRange)
      ?? kbState.curRange.getBoundingClientRect();
    if (!anchorRect || !newCurRect || (anchorRect.height === 0 && newCurRect.height === 0)) {
      dbg('kbCE', 'anchorRect/curRect取得失敗');
      return;
    }

    const selLeft  = Math.min(kbState.anchorX, kbState.curX) - 1;
    const selRight = Math.max(kbState.anchorX, kbState.curX) + 1;
    const selTop    = Math.min(anchorRect.top, newCurRect.top);
    const selBottom = Math.max(anchorRect.bottom, newCurRect.bottom);

    dbg('kbCE', '選択範囲確定', {
      anchorX: kbState.anchorX.toFixed(1), curX: kbState.curX.toFixed(1),
      selLeft: selLeft.toFixed(1), selRight: selRight.toFixed(1),
    });

    rectSelection = buildContentEditableSelection(root, selLeft, selRight, selTop, selBottom);
    updateCountBadge();
  }

  // ============================================================
  // マウス操作
  // ============================================================
  function onMouseDown(e) {
    // 自前のダイアログ(置換/連番挿入)内のクリックは選択解除の対象外
    // (mousedownがclickより先に発火しclearHighlights()でrectSelectionが
    //  消えると、ダイアログのボタン処理が「選択なし」と誤判定するため)
    if ((replaceDialog && replaceDialog.contains(e.target)) ||
        (sequenceDialog && sequenceDialog.contains(e.target))) {
      return;
    }
    if (!e.altKey || e.button !== 0) {
      if (rectSelection) clearHighlights();
      return;
    }

    const ceRoot = isEditableTarget(e.target);
    let mode = null;
    let root = null;
    if (ceRoot) {
      mode = 'contenteditable';
      root = ceRoot;
    } else if (e.target instanceof HTMLTextAreaElement) {
      mode = 'textarea';
      root = e.target;
    }

    if (!mode) {
      return;
    }

    ensureOverlayStyle();
    clearHighlights();

    // preventDefaultでフォーカスが当たらない場合があるため明示的にフォーカスする
    if (typeof root.focus === 'function') root.focus();

    dragging = true;
    dragMode = mode;
    dragRoot = root;
    dragStart = { x: e.clientX, y: e.clientY };
    // ドラッグ中は内容が変化しない前提で、行モデルを開始時に1回だけ構築してキャッシュする
    // (mousemoveのたびにミラーDOM/getClientRects()を再計算するのを避けるため)
    dragCache = mode === 'textarea' ? buildTextareaRows(root) : computeLineRects(root);

    dragOverlayEl = document.createElement('div');
    dragOverlayEl.className = DRAG_OVERLAY_CLASS;
    updateDragOverlay(e.clientX, e.clientY);
    document.body.appendChild(dragOverlayEl);

    e.preventDefault();
    e.stopPropagation();
  }

  let rafPending = false;
  let lastMoveEvent = null;

  function onMouseMove(e) {
    if (!dragging) return;
    updateDragOverlay(e.clientX, e.clientY);
    e.preventDefault();

    lastMoveEvent = e;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!dragging || !lastMoveEvent) return;
      updateLiveHighlight(lastMoveEvent.clientX, lastMoveEvent.clientY);
    });
  }

  function updateLiveHighlight(curX, curY) {
    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];

    const selLeft = Math.min(dragStart.x, curX);
    const selRight = Math.max(dragStart.x, curX);
    const selTop = Math.min(dragStart.y, curY);
    const selBottom = Math.max(dragStart.y, curY);

    if (selRight - selLeft < 2 || selBottom - selTop < 2) return;

    // ドラッグ中(mousemove)は開始時にキャッシュした行モデルを再利用し、
    // 毎フレームのミラーDOM再構築/getClientRects()を避ける(体感速度に直結)。
    // 確定(mouseup)時のみ再計算して最新のDOMを反映する。
    if (dragMode === 'contenteditable') {
      // ドラッグ中はネイティブ選択解除とハイライト表示のみ行い、確定はmouseupで行う
      buildContentEditableSelection(dragRoot, selLeft, selRight, selTop, selBottom, dragCache);
      rectSelection = null;
    } else if (dragMode === 'textarea') {
      buildTextareaSelection(dragRoot, selLeft, selRight, selTop, selBottom, dragCache);
    }
  }

  function onMouseUp(e) {
    if (!dragging) return;
    dragging = false;

    const selLeft = Math.min(dragStart.x, e.clientX);
    const selRight = Math.max(dragStart.x, e.clientX);
    const selTop = Math.min(dragStart.y, e.clientY);
    const selBottom = Math.max(dragStart.y, e.clientY);

    removeDragOverlay();
    dragCache = null; // 確定処理は最新DOMで再計算するため、ここでキャッシュを破棄

    if (selRight - selLeft < 2 || selBottom - selTop < 2) {
      dragMode = null;
      dragRoot = null;
      dragStart = null;
      return;
    }

    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];

    // 確定(mouseup)時はキャッシュを使わず再計算し、最新のDOM状態を反映する
    if (dragMode === 'contenteditable') {
      rectSelection = buildContentEditableSelection(dragRoot, selLeft, selRight, selTop, selBottom);
    } else if (dragMode === 'textarea') {
      rectSelection = buildTextareaSelection(dragRoot, selLeft, selRight, selTop, selBottom);
    }

    if (rectSelection && rectSelection.mode === 'textarea' && rectSelection.segments.length === 0) {
      rectSelection = null;
    }
    if (rectSelection && rectSelection.mode === 'contenteditable' && rectSelection.ranges.length === 0) {
      rectSelection = null;
    }
    updateCountBadge();

    dragMode = null;
    dragRoot = null;
    dragStart = null;
    e.preventDefault();
  }

  // ============================================================
  // キーボード操作 (コピー/カット)
  // ============================================================
  function onKeyDown(e) {
    const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const isRectSelectKey = ARROW_KEYS.includes(e.key)
      && e.altKey
      && (e.shiftKey || e.ctrlKey);
    if (isRectSelectKey) {
      dbg('keyDown', `矩形選択キー: ${e.key}`, { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey });
      const ta = e.target instanceof HTMLTextAreaElement
        ? e.target
        : (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
      if (ta) {
        handleKeyboardRectSelect(ta, e.key);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const ceRoot = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
      if (ceRoot) {
        ensureOverlayStyle();
        e.preventDefault();
        e.stopImmediatePropagation();
        handleKeyboardRectSelectCE(ceRoot, e.key);
        return;
      }
      dbg('keyDown', '矩形選択キー: 対象編集領域なし');
    }

    // Ctrl+H: 置換ダイアログ
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
      const ta = e.target instanceof HTMLTextAreaElement
        ? e.target
        : (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
      if (ta) {
        e.preventDefault();
        e.stopPropagation();
        openReplaceDialog(ta);
        return;
      }
      const ceRoot = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
      if (ceRoot) {
        e.preventDefault();
        e.stopPropagation();
        openReplaceDialogCE(ceRoot);
        return;
      }
    }

    // Ctrl+Alt+I: 連番挿入ダイアログ(矩形選択中 or 通常選択中)
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'i' || e.key === 'I')) {
      // 1) 矩形選択中: 各行の選択左端に挿入
      if (rectSelection && (rectSelection.mode === 'textarea' || rectSelection.mode === 'contenteditable')) {
        e.preventDefault();
        e.stopPropagation();
        openSequenceDialog({ mode: 'rect' });
        return;
      }
      // 2) textareaの通常選択: 選択にかかる各行の行頭に挿入
      const seqTa = e.target instanceof HTMLTextAreaElement
        ? e.target
        : (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
      if (seqTa && seqTa.selectionStart < seqTa.selectionEnd) {
        e.preventDefault();
        e.stopPropagation();
        openSequenceDialog({ mode: 'ta-sel', textarea: seqTa, selStart: seqTa.selectionStart, selEnd: seqTa.selectionEnd });
        return;
      }
      // 3) contenteditableの通常選択: 選択にかかる各行(ブロック)の行頭に挿入
      const seqRoot = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
      const seqSel = window.getSelection();
      if (seqRoot && seqSel && !seqSel.isCollapsed && seqRoot.contains(seqSel.focusNode)) {
        // ダイアログにフォーカスが移ると選択が消えるため、行頭挿入点をここで確定して保存する
        const points = collectLineStartPoints(seqRoot, seqSel.getRangeAt(0));
        if (points.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          openSequenceDialog({ mode: 'ce-sel', points });
          return;
        }
      }
    }

    // Ctrl+Alt+Q: 引用符「> 」トグル(矩形選択中 or 通常選択中、ダイアログなしで即実行)
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'q' || e.key === 'Q')) {
      const handled = execToggleQuote(e);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // Ctrl+Alt+D: 重複行削除(textarea/CEの通常選択のみ。矩形選択中はスコープ外・フェイルクローズ)
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
      if (rectSelection) {
        // 列単位の切り出しと「行全体の重複」は概念が噛み合わないためスコープ外。
        // 何もしない(既存のrectSelection操作系へのフォールスルーもさせない)。
        return;
      }
      const handled = execDedupeLines(e);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (replaceDialog) {
        closeReplaceDialog();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (sequenceDialog) {
        closeSequenceDialog();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (rectSelection) {
        clearHighlights();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      return;
    }

    if (!rectSelection) return;

    const isCopy   = (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C');
    const isCut    = (e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X');
    const isPaste  = (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V');
    const isDelete = !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace');
    // 矩形選択中に通常文字を打つ → 各行の選択左端にカラム挿入
    // e.isComposing=true の間はIME変換中なので介入しない
    const isCharInsert = (rectSelection.mode === 'textarea' || rectSelection.mode === 'contenteditable')
      && e.key.length === 1
      && !e.ctrlKey && !e.metaKey && !e.altKey
      && !e.isComposing
      && !replaceDialog  // 置換ダイアログ表示中は無効
      && !sequenceDialog; // 連番ダイアログ表示中は無効

    if (!isCopy && !isCut && !isDelete && !isCharInsert && !isPaste) return;

    if (isPaste) {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.readText().then((text) => {
        if (!text || !rectSelection) return;
        if (rectSelection.mode === 'contenteditable') {
          const ordered = [...rectSelection.ranges].sort((a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top
          );
          const sel = window.getSelection();
          for (const range of ordered) {
            const insertRange = document.createRange();
            insertRange.setStart(range.startContainer, range.startOffset);
            insertRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(insertRange);
            document.execCommand('insertText', false, text);
          }
          hiliteEls.forEach((el) => el.remove());
          hiliteEls = [];
          for (const range of rectSelection.ranges) {
            for (const r of range.getClientRects()) addHilite(r);
          }
        } else if (rectSelection.mode === 'textarea') {
          const ta = rectSelection.textarea;
          const segs = [...rectSelection.segments].sort((a, b) => b.start - a.start);
          ta.focus();
          for (const s of segs) {
            ta.setSelectionRange(s.start, s.start);
            document.execCommand('insertText', false, text);
          }
          rectSelection.segments.forEach((s) => { s.start += text.length; s.end += text.length; });
          if (kbState && kbState.textarea === ta) {
            kbState.anchorCol += text.length;
            kbState.curCol += text.length;
          }
          rebuildHilitesFromSegments(ta, rectSelection.segments);
        }
      }).catch(() => {});
      return;
    }

    if (isCharInsert) {
      e.preventDefault();
      e.stopPropagation();

      if (rectSelection.mode === 'contenteditable') {
        // 下の行から順に挿入（上の行のRange位置がずれないよう）
        const ordered = [...rectSelection.ranges].sort((a, b) =>
          b.getBoundingClientRect().top - a.getBoundingClientRect().top
        );
        const sel = window.getSelection();
        for (const range of ordered) {
          const insertRange = document.createRange();
          insertRange.setStart(range.startContainer, range.startOffset);
          insertRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(insertRange);
          document.execCommand('insertText', false, e.key);
        }
        // Rangeオブジェクトはブラウザが自動更新するため再描画のみ
        hiliteEls.forEach((el) => el.remove());
        hiliteEls = [];
        for (const range of rectSelection.ranges) {
          for (const r of range.getClientRects()) addHilite(r);
        }
        return;
      }

      const ta = rectSelection.textarea;
      // 下の行から順に挿入して上の行のインデックスがずれないようにする
      const segs = [...rectSelection.segments].sort((a, b) => b.start - a.start);
      ta.focus();
      for (const s of segs) {
        ta.setSelectionRange(s.start, s.start);
        document.execCommand('insertText', false, e.key);
      }
      // 各行に1文字挿入されたのでセグメントのインデックスを+1更新
      rectSelection.segments.forEach((s) => { s.start += 1; s.end += 1; });
      // キーボード選択状態のカラム位置も+1更新
      if (kbState && kbState.textarea === ta) {
        kbState.anchorCol += 1;
        kbState.curCol += 1;
      }
      // ハイライトを再描画して選択状態を維持
      rebuildHilitesFromSegments(ta, rectSelection.segments);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (rectSelection.mode === 'contenteditable') {
      const ordered = [...rectSelection.ranges].sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.top - rb.top;
      });

      if (isCopy || isCut) {
        const text = ordered.map((r) => r.toString()).join('\n');
        writeClipboard(text);
      }

      if (isCut || isDelete) {
        const root = rectSelection.root;
        const firstRect = ordered[0].getBoundingClientRect();
        const reversed = [...ordered].reverse();
        const sel = window.getSelection();
        for (const range of reversed) {
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, '');
        }
        // カーソルを削除位置に戻してフォーカスを維持
        root.focus();
        const caretRange = caretRangeFromPointSafe(firstRect.left, firstRect.top + firstRect.height / 2);
        if (caretRange) {
          caretRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(caretRange);
        } else {
          sel.removeAllRanges();
        }
      }
    } else if (rectSelection.mode === 'textarea') {
      const ta = rectSelection.textarea;
      const segs = [...rectSelection.segments].sort((a, b) => a.start - b.start);

      if (isCopy || isCut) {
        const text = segs.map((s) => ta.value.substring(s.start, s.end)).join('\n');
        writeClipboard(text);
      }

      if (isCut || isDelete) {
        // 1undo stepにするため: 削除後の全文を組み立てて全選択→insertTextで一括置換
        const segsDesc = [...segs].sort((a, b) => b.start - a.start);
        let newValue = ta.value;
        for (const s of segsDesc) {
          newValue = newValue.slice(0, s.start) + newValue.slice(s.end);
        }
        ta.focus();
        ta.setSelectionRange(0, ta.value.length);
        document.execCommand('insertText', false, newValue);
        const firstStart = segs[0].start;
        ta.setSelectionRange(firstStart, firstStart);
      }
    }

    clearHighlights();
  }

  // ============================================================
  // カラム挿入: 矩形選択中に通常文字を打つと各行の選択左端に挿入する
  // ============================================================
  function rebuildHilitesFromSegments(ta, segments) {
    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];
    const rows = buildTextareaRows(ta);
    for (const seg of segments) {
      for (const row of rows) {
        const matchEmpty = row.length === 0 && seg.start === row.startIdx;
      const matchNormal = row.length > 0 && seg.start >= row.startIdx && seg.start < row.startIdx + row.length;
      if (!matchEmpty && !matchNormal) continue;
      const colFrom = seg.start - row.startIdx;
      const colTo   = Math.min(row.length, seg.end - row.startIdx);
      if (colTo > colFrom) {
        addHilite({
          left:   row.colLefts[colFrom],
          top:    row.top,
          width:  row.colLefts[colTo] - row.colLefts[colFrom],
          height: row.bottom - row.top,
        });
      } else {
        // 空行: 細い縦線でカーソル位置を表示
        const x = row.colLefts[Math.min(colFrom, row.colLefts.length - 1)] ?? 0;
        addHilite({ left: x, top: row.top, width: 2, height: row.bottom - row.top });
      }
      break;
      }
    }
  }

  // ============================================================
  // 置換ダイアログ (Ctrl+H)
  // 選択範囲(矩形選択/通常選択)がある場合はその中だけ置換。
  // 選択がない場合は本文全体を対象にする。
  // ============================================================
  let replaceDialog = null;
  let dialogHiliteEls = []; // ダイアログ表示中の選択範囲ハイライト

  function getReplaceScope(textarea) {
    if (rectSelection && rectSelection.mode === 'textarea' && rectSelection.textarea === textarea) {
      return { label: t('scopeRect', rectSelection.segments.length), type: 'rect' };
    }
    if (textarea.selectionStart < textarea.selectionEnd) {
      const len = textarea.selectionEnd - textarea.selectionStart;
      return { label: t('scopeSel', len), type: 'sel' };
    }
    return { label: t('scopeAll'), type: 'all' };
  }

  // 通常テキスト選択範囲をオレンジ背景でハイライト(ダイアログ用)
  function showDialogSelectionHighlight(textarea) {
    const selStart = textarea.selectionStart;
    const selEnd   = textarea.selectionEnd;
    if (selStart >= selEnd) return;

    const rows = buildTextareaRows(textarea);
    for (const row of rows) {
      const segColFrom = Math.max(0, selStart - row.startIdx);
      const segColTo   = Math.min(row.length, selEnd - row.startIdx);
      if (segColFrom >= row.length || segColTo <= 0 || segColFrom >= segColTo) continue;

      const el = document.createElement('div');
      el.style.cssText = `
        position: fixed;
        left: ${row.colLefts[segColFrom]}px;
        top: ${row.top}px;
        width: ${row.colLefts[segColTo] - row.colLefts[segColFrom]}px;
        height: ${row.bottom - row.top}px;
        background: rgba(255, 160, 0, 0.35);
        pointer-events: none;
        z-index: 2147483645;
      `;
      document.body.appendChild(el);
      dialogHiliteEls.push(el);
    }
  }

  function clearDialogHighlights() {
    dialogHiliteEls.forEach((el) => el.remove());
    dialogHiliteEls = [];
  }

  function openReplaceDialog(textarea) {
    if (replaceDialog) {
      replaceDialog.querySelector('.rs-search').focus();
      return;
    }

    const scope = getReplaceScope(textarea);
    const scopeColor = scope.type === 'all' ? '#5a5a5a' : '#1a6e2e';
    const scopeIcon  = scope.type === 'rect' ? '▦ ' : scope.type === 'sel' ? '▤ ' : '▬ ';

    // 通常テキスト選択の場合、フォーカスが移っても見えるよう背景色を付ける
    if (scope.type === 'sel') showDialogSelectionHighlight(textarea);

    const dlg = document.createElement('div');
    dlg.style.cssText = `
      position: fixed; top: 80px; right: 24px; z-index: 2147483647;
      background: #fff; border: 1px solid #d0d0d0; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.18); padding: 14px 16px 16px;
      font: 13px/1.5 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1a1a1a; min-width: 300px;
      user-select: none;
    `;

    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <b style="font-size:14px;letter-spacing:0.01em">${t('replaceTitle')}</b>
        <button class="rs-close" style="border:none;background:none;font-size:18px;cursor:pointer;line-height:1;padding:0 2px;color:#555">×</button>
      </div>
      <div style="margin-bottom:6px;padding:5px 8px;background:#f0f0f0;border-radius:5px;font-size:12px;color:${scopeColor}">
        ${t('scopeLabel')} <b>${scopeIcon}${scope.label}</b>
      </div>
      <div style="margin-bottom:10px;padding:6px 8px;background:#fef9e7;border:1px solid #f0d060;border-radius:5px;font-size:12px;color:#5a4a00;line-height:1.6">
        ・${t('hintRect')}<br>
        ・${t('hintSel')}<br>
        ・${t('hintAll')}
      </div>
      <div class="rs-tmpl" style="margin-bottom:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center"></div>
      <div style="margin-bottom:6px">
        <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('searchLabel')}</label>
        <input class="rs-search" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit;outline-offset:2px">
      </div>
      <div style="margin-bottom:8px">
        <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('replaceLabel')}</label>
        <input class="rs-replace" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit;outline-offset:2px">
      </div>
      <div style="margin-bottom:10px;display:flex;gap:14px">
        <label style="font-size:12px;cursor:pointer;color:#333">
          <input class="rs-case" type="checkbox"> ${t('caseSensitive')}
        </label>
        <label style="font-size:12px;cursor:pointer;color:#333">
          <input class="rs-regex" type="checkbox"> ${t('regexLabel')}
        </label>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="rs-exec" style="padding:6px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:500;letter-spacing:0.02em">${t('execButton')}</button>
        <span class="rs-result" style="font-size:12px;color:#444"></span>
      </div>
    `;

    document.body.appendChild(dlg);
    replaceDialog = dlg;

    dlg.querySelector('.rs-close').addEventListener('click', closeReplaceDialog);
    dlg.querySelector('.rs-search').focus();
    renderTemplateChips(dlg.querySelector('.rs-tmpl'), dlg.querySelector('.rs-search'));

    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') execReplace(textarea);
      if (e.key === 'Escape') closeReplaceDialog();
      e.stopPropagation();
    });

    dlg.querySelector('.rs-exec').addEventListener('click', () => execReplace(textarea));
  }

  function closeReplaceDialog() {
    if (replaceDialog) {
      replaceDialog.remove();
      replaceDialog = null;
    }
    clearDialogHighlights();
  }

  function execReplace(textarea) {
    const searchStr = replaceDialog.querySelector('.rs-search').value;
    const replaceStr = replaceDialog.querySelector('.rs-replace').value;
    const caseSensitive = replaceDialog.querySelector('.rs-case').checked;
    const useRegex = replaceDialog.querySelector('.rs-regex').checked;
    const resultEl = replaceDialog.querySelector('.rs-result');

    if (!searchStr) {
      resultEl.textContent = t('errNoSearch');
      return;
    }

    const { regex, error, risky } = buildRegex(searchStr, { caseSensitive, useRegex });
    if (risky) {
      resultEl.style.color = '#c0392b';
      resultEl.textContent = t('errRiskyRegex');
      return;
    }
    if (error) {
      resultEl.style.color = '#c0392b';
      resultEl.textContent = t('errBadRegex', error);
      return;
    }
    resultEl.style.color = '';

    let totalCount = 0;
    let newValue = textarea.value;
    textarea.focus();

    if (rectSelection && rectSelection.mode === 'textarea' && rectSelection.textarea === textarea) {
      // 矩形選択範囲内だけ置換: まずメモリ上で全セグメントを計算してから1回のexecCommandで適用
      const segs = [...rectSelection.segments].sort((a, b) => b.start - a.start);
      for (const seg of segs) {
        const original = newValue.slice(seg.start, seg.end);
        const { result: replaced, count } = replaceWithCount(original, regex, replaceStr);
        totalCount += count;
        newValue = newValue.slice(0, seg.start) + replaced + newValue.slice(seg.end);
      }
      clearHighlights();
    } else {
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;

      if (selStart < selEnd) {
        // 通常のテキスト選択範囲内だけ置換
        const original = newValue.slice(selStart, selEnd);
        const { result: replaced, count } = replaceWithCount(original, regex, replaceStr);
        totalCount = count;
        newValue = newValue.slice(0, selStart) + replaced + newValue.slice(selEnd);
      } else {
        // 選択なし → 本文全体を置換
        const { result: replaced, count } = replaceWithCount(newValue, regex, replaceStr);
        totalCount = count;
        newValue = replaced;
      }
    }

    // 変更があれば1回のexecCommandで一括適用(入力イベントハンドラの割り込みによるインデックスずれを防止)
    if (totalCount > 0) {
      textarea.setSelectionRange(0, textarea.value.length);
      document.execCommand('insertText', false, newValue);
    }

    resultEl.textContent = totalCount > 0
      ? t('resultReplaced', totalCount)
      : t('resultNotFound');
  }

  // ============================================================
  // 置換ダイアログ (contenteditable 用)
  // ============================================================
  function openReplaceDialogCE(root) {
    if (replaceDialog) {
      replaceDialog.querySelector('.rs-search').focus();
      return;
    }

    let scopeLabel, scopeType;
    let savedSelRange = null;
    if (rectSelection && rectSelection.mode === 'contenteditable') {
      scopeType = 'rect';
      scopeLabel = t('scopeRect', rectSelection.ranges.length);
    } else {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && root.contains(sel.focusNode)) {
        scopeType = 'sel';
        scopeLabel = t('scopeSel', sel.toString().length);
        savedSelRange = sel.getRangeAt(0).cloneRange();
      } else {
        scopeType = 'all';
        scopeLabel = t('scopeAll');
      }
    }

    // 通常テキスト選択範囲をオレンジ背景でハイライト(フォーカスが移って選択が消えても見えるように)
    if (scopeType === 'sel' && savedSelRange) {
      for (const r of savedSelRange.getClientRects()) {
        const el = document.createElement('div');
        el.style.cssText = `
          position: fixed;
          left: ${r.left}px;
          top: ${r.top}px;
          width: ${r.width}px;
          height: ${r.height}px;
          background: rgba(255, 160, 0, 0.35);
          pointer-events: none;
          z-index: 2147483645;
        `;
        document.body.appendChild(el);
        dialogHiliteEls.push(el);
      }
    }
    const scopeColor = scopeType === 'all' ? '#5a5a5a' : '#1a6e2e';
    const scopeIcon  = scopeType === 'rect' ? '▦ ' : scopeType === 'sel' ? '▤ ' : '▬ ';

    const dlg = document.createElement('div');
    dlg.style.cssText = `
      position: fixed; top: 80px; right: 24px; z-index: 2147483647;
      background: #fff; border: 1px solid #d0d0d0; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.18); padding: 14px 16px 16px;
      font: 13px/1.5 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1a1a1a; min-width: 300px;
      user-select: none;
    `;
    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <b style="font-size:14px;letter-spacing:0.01em">${t('replaceTitle')}</b>
        <button class="rs-close" style="border:none;background:none;font-size:18px;cursor:pointer;line-height:1;padding:0 2px;color:#555">×</button>
      </div>
      <div style="margin-bottom:6px;padding:5px 8px;background:#f0f0f0;border-radius:5px;font-size:12px;color:${scopeColor}">
        ${t('scopeLabel')} <b>${scopeIcon}${scopeLabel}</b>
      </div>
      <div style="margin-bottom:10px;padding:6px 8px;background:#fef9e7;border:1px solid #f0d060;border-radius:5px;font-size:12px;color:#5a4a00;line-height:1.6">
        ・${t('hintRect')}<br>
        ・${t('hintSel')}<br>
        ・${t('hintAll')}
      </div>
      <div class="rs-tmpl" style="margin-bottom:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center"></div>
      <div style="margin-bottom:6px">
        <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('searchLabel')}</label>
        <input class="rs-search" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit;outline-offset:2px">
      </div>
      <div style="margin-bottom:8px">
        <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('replaceLabel')}</label>
        <input class="rs-replace" type="text" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit;outline-offset:2px">
      </div>
      <div style="margin-bottom:10px;display:flex;gap:14px">
        <label style="font-size:12px;cursor:pointer;color:#333">
          <input class="rs-case" type="checkbox"> ${t('caseSensitive')}
        </label>
        <label style="font-size:12px;cursor:pointer;color:#333">
          <input class="rs-regex" type="checkbox"> ${t('regexLabel')}
        </label>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="rs-exec" style="padding:6px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:500;letter-spacing:0.02em">${t('execButton')}</button>
        <span class="rs-result" style="font-size:12px;color:#444"></span>
      </div>
    `;
    document.body.appendChild(dlg);
    replaceDialog = dlg;

    dlg.querySelector('.rs-close').addEventListener('click', closeReplaceDialog);
    dlg.querySelector('.rs-search').focus();
    renderTemplateChips(dlg.querySelector('.rs-tmpl'), dlg.querySelector('.rs-search'));
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') execReplaceCE(root);
      if (e.key === 'Escape') closeReplaceDialog();
      e.stopPropagation();
    });
    dlg.querySelector('.rs-exec').addEventListener('click', () => execReplaceCE(root));
  }

  function execReplaceCE(root) {
    const searchStr  = replaceDialog.querySelector('.rs-search').value;
    const replaceStr = replaceDialog.querySelector('.rs-replace').value;
    const caseSensitive = replaceDialog.querySelector('.rs-case').checked;
    const useRegex = replaceDialog.querySelector('.rs-regex').checked;
    const resultEl   = replaceDialog.querySelector('.rs-result');

    if (!searchStr) {
      resultEl.textContent = t('errNoSearch');
      return;
    }

    const { regex, error, risky } = buildRegex(searchStr, { caseSensitive, useRegex });
    if (risky) {
      resultEl.style.color = '#c0392b';
      resultEl.textContent = t('errRiskyRegex');
      return;
    }
    if (error) {
      resultEl.style.color = '#c0392b';
      resultEl.textContent = t('errBadRegex', error);
      return;
    }
    resultEl.style.color = '';
    let totalCount = 0;
    const sel = window.getSelection();

    if (rectSelection && rectSelection.mode === 'contenteditable') {
      // 矩形選択範囲内だけ置換(下から順に処理)
      const ordered = [...rectSelection.ranges].sort((a, b) =>
        b.getBoundingClientRect().top - a.getBoundingClientRect().top
      );
      for (const range of ordered) {
        const text = range.toString();
        const { result: replaced, count } = replaceWithCount(text, regex, replaceStr);
        if (count > 0) {
          totalCount += count;
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, replaced);
        }
      }
      clearHighlights();
    } else {
      // テキストノードを走査して全置換(下から処理してインデックスずれを防止)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);

      for (let i = nodes.length - 1; i >= 0; i--) {
        const textNode = nodes[i];
        const original = textNode.nodeValue;
        const { result: replaced, count } = replaceWithCount(original, regex, replaceStr);
        if (count > 0) {
          totalCount += count;
          const range = document.createRange();
          range.selectNode(textNode);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, replaced);
        }
      }
    }

    resultEl.textContent = totalCount > 0
      ? t('resultReplaced', totalCount)
      : t('resultNotFound');
  }

  // ============================================================
  // 連番挿入ダイアログ (Ctrl+Alt+I)
  // 矩形選択中: 各行の選択左端に挿入。
  // 通常選択中: 選択にかかる各行の行頭に挿入。
  // ============================================================
  let sequenceDialog = null;
  let sequenceContext = null; // {mode:'rect'} | {mode:'ta-sel',textarea,selStart,selEnd} | {mode:'ce-sel',points:[Range]}

  // contenteditable内の通常選択から「選択にかかる各行(ブロック)の行頭」の挿入点を集める
  function collectLineStartPoints(root, range) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const blocks = [];
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      // このテキストノードが属する行ブロック(rootの直下または最も近いブロック要素)を特定
      let block = node.parentElement;
      while (block && block !== root) {
        const disp = getComputedStyle(block).display;
        if (disp === 'block' || disp === 'list-item') break;
        block = block.parentElement;
      }
      const key = block || root;
      if (seen.has(key)) continue;
      seen.add(key);
      // 行頭 = そのブロック内の最初のテキストノードの先頭
      const innerWalker = document.createTreeWalker(key === root ? node : key, NodeFilter.SHOW_TEXT);
      const firstText = key === root ? node : innerWalker.nextNode();
      if (!firstText) continue;
      const point = document.createRange();
      point.setStart(firstText, 0);
      point.collapse(true);
      blocks.push(point);
    }
    return blocks;
  }

  // contenteditable内の通常選択から「選択にかかる各行(ブロック)」の情報を文書順(上から下)で集める。
  // 引用符トグル(3-A)/重複行削除(3-B)の両方で使う共通関数。collectLineStartPointsと同じ
  // ブロック検出ロジックを流用しつつ、用途ごとに必要なRangeをまとめて返す:
  //  - blockRange / text: ブロック全体のRangeとtextContent(重複行削除の判定・削除に使用)
  //  - insertPoint: 行頭のcollapsed Range(引用符挿入に使用)
  //  - twoCharRange: 行頭2文字を覆うRange(引用符削除の判定対象特定・削除実行に使用。
  //    ブロックの文字数が2未満の場合は取得できた分だけを覆う)
  function collectLineRanges(root, range) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const blocks = [];
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      let block = node.parentElement;
      while (block && block !== root) {
        const disp = getComputedStyle(block).display;
        if (disp === 'block' || disp === 'list-item') break;
        block = block.parentElement;
      }
      const key = block || root;
      if (seen.has(key)) continue;
      seen.add(key);

      const blockRange = document.createRange();
      if (key === root) {
        // rootの直下(ブロック要素を持たない単一行など): rangeとぶつかったノード自体を対象にする
        blockRange.selectNodeContents(node);
      } else {
        blockRange.selectNodeContents(key);
      }
      const text = blockRange.toString();

      // 行頭 = ブロック内の最初のテキストノードの先頭
      const innerWalker = document.createTreeWalker(key === root ? node : key, NodeFilter.SHOW_TEXT);
      const firstText = key === root ? node : innerWalker.nextNode();

      let insertPoint = null;
      let twoCharRange = null;
      if (firstText) {
        insertPoint = document.createRange();
        insertPoint.setStart(firstText, 0);
        insertPoint.collapse(true);

        twoCharRange = document.createRange();
        twoCharRange.setStart(firstText, 0);
        twoCharRange.setEnd(firstText, Math.min(2, firstText.nodeValue.length));
      }

      blocks.push({ blockRange, text, insertPoint, twoCharRange });
    }
    return blocks;
  }

  // ============================================================
  // 引用符「> 」トグル (Ctrl+Alt+Q): ダイアログなしで即実行
  // 対象行が全て "> " で始まっていればOFF(削除)、1行でも始まっていなければON(挿入)
  // ============================================================
  function execToggleQuote(e) {
    // 1) 矩形選択中: 矩形の左端(各行のRange/segmentの開始位置)に付け外しする
    if (rectSelection && rectSelection.mode === 'textarea') {
      return execToggleQuoteRectTA();
    }
    if (rectSelection && rectSelection.mode === 'contenteditable') {
      return execToggleQuoteRectCE();
    }
    // 2) textareaの通常選択: 選択にかかる各行の行頭
    const qTa = e.target instanceof HTMLTextAreaElement
      ? e.target
      : (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
    if (qTa && qTa.selectionStart < qTa.selectionEnd) {
      return execToggleQuoteTaSel(qTa, qTa.selectionStart, qTa.selectionEnd);
    }
    // 3) contenteditableの通常選択: 選択にかかる各行(ブロック)の行頭
    const qRoot = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
    const qSel = window.getSelection();
    if (qRoot && qSel && !qSel.isCollapsed && qRoot.contains(qSel.focusNode)) {
      const blocks = collectLineRanges(qRoot, qSel.getRangeAt(0));
      return execToggleQuoteCESel(blocks);
    }
    return false;
  }

  function execToggleQuoteRectTA() {
    const ta = rectSelection.textarea;
    const v = ta.value;
    const allQuoted = rectSelection.segments.every((s) => v.slice(s.start, s.start + 2) === '> ');
    const segsDesc = [...rectSelection.segments].sort((a, b) => b.start - a.start);
    ta.focus();
    for (const s of segsDesc) {
      if (allQuoted) {
        ta.setSelectionRange(s.start, s.start + 2);
        document.execCommand('insertText', false, '');
      } else {
        ta.setSelectionRange(s.start, s.start);
        document.execCommand('insertText', false, '> ');
      }
    }
    const delta = allQuoted ? -2 : 2;
    rectSelection.segments.forEach((s) => { s.start += delta; s.end += delta; });
    if (kbState && kbState.textarea === ta) { kbState.anchorCol += delta; kbState.curCol += delta; }
    rebuildHilitesFromSegments(ta, rectSelection.segments);
    updateCountBadge();
    return true;
  }

  function execToggleQuoteRectCE() {
    const readTwo = (range) => range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.nodeValue.slice(range.startOffset, range.startOffset + 2)
      : '';
    const allQuoted = rectSelection.ranges.every((r) => readTwo(r) === '> ');
    const ordered = [...rectSelection.ranges].sort((a, b) =>
      b.getBoundingClientRect().top - a.getBoundingClientRect().top
    );
    const sel = window.getSelection();
    for (const range of ordered) {
      if (allQuoted) {
        if (range.startContainer.nodeType !== Node.TEXT_NODE) continue; // フェイルクローズ: 特定できない行はスキップ
        const delRange = document.createRange();
        delRange.setStart(range.startContainer, range.startOffset);
        delRange.setEnd(range.startContainer, range.startOffset + 2);
        sel.removeAllRanges();
        sel.addRange(delRange);
        document.execCommand('insertText', false, '');
      } else {
        const insertRange = document.createRange();
        insertRange.setStart(range.startContainer, range.startOffset);
        insertRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(insertRange);
        document.execCommand('insertText', false, '> ');
      }
    }
    hiliteEls.forEach((el) => el.remove());
    hiliteEls = [];
    for (const range of rectSelection.ranges) {
      for (const r of range.getClientRects()) addHilite(r);
    }
    updateCountBadge();
    return true;
  }

  function execToggleQuoteTaSel(ta, selStart, selEnd) {
    const v = ta.value;
    const lineStarts = [];
    let lineStart = v.lastIndexOf('\n', selStart - 1) + 1;
    while (lineStart < selEnd) {
      lineStarts.push(lineStart);
      const nl = v.indexOf('\n', lineStart);
      if (nl === -1) break;
      lineStart = nl + 1;
    }
    if (lineStarts.length === 0) return false;
    const allQuoted = lineStarts.every((off) => v.slice(off, off + 2) === '> ');
    ta.focus();
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      const off = lineStarts[i];
      if (allQuoted) {
        ta.setSelectionRange(off, off + 2);
        document.execCommand('insertText', false, '');
      } else {
        ta.setSelectionRange(off, off);
        document.execCommand('insertText', false, '> ');
      }
    }
    return true;
  }

  function execToggleQuoteCESel(blocks) {
    if (blocks.length === 0) return false;
    const allQuoted = blocks.every((b) => b.text.slice(0, 2) === '> ');
    const sel = window.getSelection();
    let acted = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (allQuoted) {
        if (!b.twoCharRange) continue; // フェイルクローズ: 削除対象を特定できない行はスキップ
        sel.removeAllRanges();
        sel.addRange(b.twoCharRange);
        document.execCommand('insertText', false, '');
        acted = true;
      } else {
        if (!b.insertPoint) continue;
        sel.removeAllRanges();
        sel.addRange(b.insertPoint);
        document.execCommand('insertText', false, '> ');
        acted = true;
      }
    }
    return acted;
  }

  // ============================================================
  // 重複行削除 (Ctrl+Alt+D): textarea/CEの通常選択のみ。矩形選択はスコープ外(呼び出し元で除外済み)。
  // 選択がない場合は本文全体が対象。
  // ============================================================
  function execDedupeLines(e) {
    const ta = e.target instanceof HTMLTextAreaElement
      ? e.target
      : (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
    if (ta) {
      execDedupeLinesTA(ta);
      return true;
    }
    const root = isEditableTarget(e.target) || isEditableTarget(document.activeElement);
    if (root) {
      execDedupeLinesCE(root);
      return true;
    }
    return false;
  }

  function execDedupeLinesTA(ta) {
    const v = ta.value;
    let rangeStart = 0;
    let rangeEnd = v.length;
    if (ta.selectionStart < ta.selectionEnd) {
      rangeStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const nlEnd = v.indexOf('\n', ta.selectionEnd);
      rangeEnd = nlEnd === -1 ? v.length : nlEnd;
    }
    const target = v.slice(rangeStart, rangeEnd);
    const deduped = dedupeLines(target.split('\n')).join('\n');
    if (deduped === target) return; // 重複なし: 不要なundoステップを積まない
    ta.focus();
    ta.setSelectionRange(rangeStart, rangeEnd);
    document.execCommand('insertText', false, deduped);
    ta.setSelectionRange(rangeStart, rangeStart + deduped.length);
  }

  function execDedupeLinesCE(root) {
    const winSel = window.getSelection();
    let range;
    if (winSel && !winSel.isCollapsed && root.contains(winSel.focusNode)) {
      range = winSel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(root);
    }
    const blocks = collectLineRanges(root, range);
    const lines = blocks.map((b) => b.text);
    if (dedupeLines(lines).length === lines.length) return; // 重複なし

    // 空行は対象外。2回目以降に出てきた行のブロックだけを削除対象にする
    const seen = new Set();
    const toRemove = [];
    for (const b of blocks) {
      if (b.text === '') continue;
      if (seen.has(b.text)) { toRemove.push(b); continue; }
      seen.add(b.text);
    }
    if (toRemove.length === 0) return;

    // ブロックは文書順(上から下)で並んでいるため、削除は下から順に処理する
    const sel = window.getSelection();
    for (let i = toRemove.length - 1; i >= 0; i--) {
      const b = toRemove[i];
      if (!b.blockRange.startContainer.isConnected) continue; // フェイルクローズ: 失効していたらスキップ
      sel.removeAllRanges();
      sel.addRange(b.blockRange);
      document.execCommand('insertText', false, '');
    }
  }

  function openSequenceDialog(context) {
    if (sequenceDialog) {
      sequenceDialog.querySelector('.seq-start').focus();
      return;
    }
    sequenceContext = context;
    const dlg = document.createElement('div');
    dlg.style.cssText = `
      position: fixed; top: 80px; right: 24px; z-index: 2147483647;
      background: #fff; border: 1px solid #d0d0d0; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.18); padding: 14px 16px 16px;
      font: 13px/1.5 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1a1a1a; min-width: 220px;
      user-select: none;
    `;
    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <b style="font-size:14px;letter-spacing:0.01em">${t('seqTitle')}</b>
        <button class="seq-close" style="border:none;background:none;font-size:18px;cursor:pointer;line-height:1;padding:0 2px;color:#555">×</button>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <div style="flex:1">
          <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('seqStart')}</label>
          <input class="seq-start" type="number" value="1" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit">
        </div>
        <div style="flex:1">
          <label style="display:block;margin-bottom:3px;font-size:12px;color:#444;font-weight:500">${t('seqStep')}</label>
          <input class="seq-step" type="number" value="1" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1.5px solid #b0b0b0;border-radius:5px;font-size:13px;font-family:inherit">
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="seq-exec" style="padding:6px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:500;letter-spacing:0.02em">${t('seqInsert')}</button>
      </div>
    `;
    document.body.appendChild(dlg);
    sequenceDialog = dlg;

    dlg.querySelector('.seq-close').addEventListener('click', closeSequenceDialog);
    dlg.querySelector('.seq-start').focus();
    dlg.querySelector('.seq-start').select();

    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') execInsertSequence();
      if (e.key === 'Escape') closeSequenceDialog();
      e.stopPropagation();
    });
    dlg.querySelector('.seq-exec').addEventListener('click', execInsertSequence);
  }

  function closeSequenceDialog() {
    if (sequenceDialog) {
      sequenceDialog.remove();
      sequenceDialog = null;
    }
    sequenceContext = null;
  }

  function execInsertSequence() {
    const ctx = sequenceContext;
    if (!ctx) { closeSequenceDialog(); return; }

    const start = parseInt(sequenceDialog.querySelector('.seq-start').value, 10);
    const step  = parseInt(sequenceDialog.querySelector('.seq-step').value, 10);
    // 1e21のような巨大値は指数表記("1e+21")のまま挿入されてしまうため、
    // 安全な整数範囲(2^53未満)に収まらない入力は拒否する
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) { closeSequenceDialog(); return; }

    // ── 通常選択 (textarea): 選択にかかる各行の行頭に挿入 ──
    if (ctx.mode === 'ta-sel') {
      const ta = ctx.textarea;
      const v = ta.value;
      // 選択にかかる行の行頭オフセットを上から順に集める
      const lineStarts = [];
      let lineStart = v.lastIndexOf('\n', ctx.selStart - 1) + 1;
      while (lineStart < ctx.selEnd) {
        lineStarts.push(lineStart);
        const nl = v.indexOf('\n', lineStart);
        if (nl === -1) break;
        lineStart = nl + 1;
      }
      const numbered = lineStarts.map((off, i) => ({ off, num: start + i * step }));
      ta.focus();
      for (let i = numbered.length - 1; i >= 0; i--) { // 下から挿入
        ta.setSelectionRange(numbered[i].off, numbered[i].off);
        document.execCommand('insertText', false, String(numbered[i].num));
      }
      closeSequenceDialog();
      return;
    }

    // ── 通常選択 (contenteditable): ダイアログを開いた時点で保存した行頭に挿入 ──
    if (ctx.mode === 'ce-sel') {
      const points = ctx.points; // 文書順(上から下)
      // ダイアログ表示中にDOMが変わっている可能性があるため、
      // 挿入前に全Rangeがまだ文書に属しているか検証する(フェイルクローズ:
      // 1つでも失効していたら本文には一切書き込まない)
      const stale = points.some((p) => !p.startContainer.isConnected);
      if (stale) {
        dbg('seq', '連番挿入中止: 選択位置が無効化されていた');
        closeSequenceDialog();
        return;
      }
      const sel = window.getSelection();
      for (let i = points.length - 1; i >= 0; i--) { // 下から挿入
        const num = start + i * step;
        sel.removeAllRanges();
        sel.addRange(points[i]);
        document.execCommand('insertText', false, String(num));
      }
      closeSequenceDialog();
      return;
    }

    // ── 矩形選択 ──
    if (!rectSelection) { closeSequenceDialog(); return; }

    if (rectSelection.mode === 'contenteditable') {
      // 1. 見た目の上から下の順で番号を割り当てる
      const topDown = [...rectSelection.ranges].sort((a, b) =>
        a.getBoundingClientRect().top - b.getBoundingClientRect().top
      );
      const numbered = topDown.map((range, i) => ({ range, num: start + i * step }));
      // 2. 挿入は下から順(上の行のRange位置がずれないよう)
      const bottomUp = [...numbered].sort((a, b) =>
        b.range.getBoundingClientRect().top - a.range.getBoundingClientRect().top
      );
      const sel = window.getSelection();
      for (const { range, num } of bottomUp) {
        const insertRange = document.createRange();
        insertRange.setStart(range.startContainer, range.startOffset);
        insertRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(insertRange);
        document.execCommand('insertText', false, String(num));
      }
      hiliteEls.forEach((el) => el.remove());
      hiliteEls = [];
      for (const range of rectSelection.ranges) {
        for (const r of range.getClientRects()) addHilite(r);
      }
    } else if (rectSelection.mode === 'textarea') {
      const ta = rectSelection.textarea;
      // segments は上から下の順で並んでいる前提(rectSelection構築時の並びに準拠)
      const topDown = [...rectSelection.segments].sort((a, b) => a.start - b.start);
      const numbered = topDown.map((seg, i) => ({ seg, num: start + i * step }));
      const bottomUp = [...numbered].sort((a, b) => b.seg.start - a.seg.start);

      ta.focus();
      for (const { seg, num } of bottomUp) {
        ta.setSelectionRange(seg.start, seg.start);
        document.execCommand('insertText', false, String(num));
        // 桁数は行によって異なるため、このセグメント以降のstart/endを個別にずらす
        const inserted = String(num).length;
        for (const other of rectSelection.segments) {
          if (other.start >= seg.start) {
            other.start += inserted;
            other.end += inserted;
          }
        }
      }
      if (kbState && kbState.textarea === ta) {
        // カラム位置の厳密な追従は複雑(行ごとに挿入文字数が違う)なため、選択解除で安全側に倒す
        kbState = null;
      }
      rebuildHilitesFromSegments(ta, rectSelection.segments);
    }

    closeSequenceDialog();
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      // ignore
    }
    ta.remove();
  }

  // ============================================================
  // インジケーター: Altキー押下中、画面右下に「矩形選択モード」を表示
  // ============================================================
  let modeBadge = null;
  function showModeBadge() {
    if (modeBadge) return;
    modeBadge = document.createElement('div');
    modeBadge.textContent = 'Col Select';
    modeBadge.style.position = 'fixed';
    modeBadge.style.right = '8px';
    modeBadge.style.bottom = '8px';
    modeBadge.style.background = '#1a73e8';
    modeBadge.style.color = '#fff';
    modeBadge.style.font = '12px sans-serif';
    modeBadge.style.padding = '4px 10px';
    modeBadge.style.borderRadius = '4px';
    modeBadge.style.zIndex = '2147483647';
    modeBadge.style.pointerEvents = 'none';
    document.body.appendChild(modeBadge);
  }
  function hideModeBadge() {
    if (modeBadge) {
      modeBadge.remove();
      modeBadge = null;
    }
  }

  // ============================================================
  // 文字数/行数カウントバッジ: rectSelectionがtruthyな間だけ表示(3-C)
  // ============================================================
  let countBadge = null;
  function showCountBadge() {
    if (countBadge) return;
    countBadge = document.createElement('div');
    countBadge.style.position = 'fixed';
    countBadge.style.right = '8px';
    countBadge.style.bottom = '34px'; // modeBadge(bottom:8px)の少し上
    countBadge.style.background = '#1a73e8';
    countBadge.style.color = '#fff';
    countBadge.style.font = '12px sans-serif';
    countBadge.style.padding = '4px 10px';
    countBadge.style.borderRadius = '4px';
    countBadge.style.zIndex = '2147483647';
    countBadge.style.pointerEvents = 'none';
    document.body.appendChild(countBadge);
  }
  function hideCountBadge() {
    if (countBadge) {
      countBadge.remove();
      countBadge = null;
    }
  }
  function updateCountBadge() {
    if (!rectSelection) { hideCountBadge(); return; }
    let lineTexts;
    if (rectSelection.mode === 'textarea') {
      const ta = rectSelection.textarea;
      lineTexts = rectSelection.segments.map((s) => ta.value.slice(s.start, s.end));
    } else if (rectSelection.mode === 'contenteditable') {
      lineTexts = rectSelection.ranges.map((r) => r.toString());
    } else {
      hideCountBadge();
      return;
    }
    const { charCount, lineCount } = countSelection(lineTexts);
    showCountBadge();
    countBadge.textContent = UI_LANG === 'ja'
      ? `${charCount}文字 / ${lineCount}行`
      : `${charCount} chars / ${lineCount} lines`;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') showModeBadge();
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') hideModeBadge();
  }, true);
  window.addEventListener('blur', hideModeBadge);

  // IME変換確定時(全角文字など)のカラム挿入
  document.addEventListener('compositionend', (e) => {
    if (!rectSelection) return;
    if (replaceDialog) return;

    // ── contenteditable モード ──────────────────────────────
    if (rectSelection.mode === 'contenteditable') {
      const composedText = e.data;
      if (!composedText) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      // compositionend 後、カーソルは挿入テキストの直後にある。
      // focusNode が TEXT_NODE であれば offset を使って挿入範囲を特定できる。
      const focusNode   = sel.focusNode;
      const focusOffset = sel.focusOffset;
      if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return;
      if (focusOffset < composedText.length) return;

      dbg('compositionend', 'CE IME確定', { text: composedText, node: focusNode.nodeValue?.slice(0,20), off: focusOffset });

      // ブラウザが挿入したテキストを削除
      const delRange = document.createRange();
      delRange.setStart(focusNode, focusOffset - composedText.length);
      delRange.setEnd(focusNode, focusOffset);
      sel.removeAllRanges();
      sel.addRange(delRange);
      document.execCommand('insertText', false, '');

      // 各行の選択左端に挿入(下から順に)
      const ordered = [...rectSelection.ranges].sort((a, b) =>
        b.getBoundingClientRect().top - a.getBoundingClientRect().top
      );
      for (const range of ordered) {
        const insertRange = document.createRange();
        insertRange.setStart(range.startContainer, range.startOffset);
        insertRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(insertRange);
        document.execCommand('insertText', false, composedText);
      }

      // ハイライト再描画
      hiliteEls.forEach((el) => el.remove());
      hiliteEls = [];
      for (const range of rectSelection.ranges) {
        for (const r of range.getClientRects()) addHilite(r);
      }
      return;
    }

    // ── textarea モード ──────────────────────────────────────
    if (rectSelection.mode !== 'textarea') return;
    const ta = rectSelection.textarea;
    if (e.target !== ta) return;
    const composedText = e.data;
    if (!composedText) return;

    // IMEがtextareaのカーソル位置に挿入した文字列を取り除く
    const insertedEnd   = ta.selectionStart;
    const insertedStart = insertedEnd - composedText.length;
    if (insertedStart < 0) return;

    ta.setSelectionRange(insertedStart, insertedEnd);
    document.execCommand('delete');

    // カーソル位置がrectのセグメントより前なら補正
    // (削除によって後ろのセグメントは影響なし, 前なら+削除分ずれている)
    const deletedAt = insertedStart;
    rectSelection.segments.forEach((s) => {
      if (s.start > deletedAt) { s.start -= composedText.length; s.end -= composedText.length; }
    });

    // 各行の選択左端にIME確定テキストを挿入(下から順に)
    const segs = [...rectSelection.segments].sort((a, b) => b.start - a.start);
    ta.focus();
    for (const s of segs) {
      ta.setSelectionRange(s.start, s.start);
      document.execCommand('insertText', false, composedText);
    }
    rectSelection.segments.forEach((s) => { s.start += composedText.length; s.end += composedText.length; });
    if (kbState && kbState.textarea === ta) {
      kbState.anchorCol += composedText.length;
      kbState.curCol    += composedText.length;
    }
    rebuildHilitesFromSegments(ta, rectSelection.segments);
  }, true);

  ensureOverlayStyle();

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  // bubble フェーズでも Escape を止める（Gmail が capture フェーズに先行リスナーを持つ場合の対策）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (replaceDialog || rectSelection) {
      e.stopImmediatePropagation();
    }
  }, false);

  // テスト用: Node.js (tests/ 配下) から純粋関数だけを直接呼べるようにする。
  // ブラウザ実行時は `module` が存在しないため、この分岐は完全に無視される。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildRegex, replaceWithCount, columnRangeFromX, dedupeLines, countSelection };
  }
})();
