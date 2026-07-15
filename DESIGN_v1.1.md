# v1.1 設計仕様

## ステータス
- テンプレート保存 + 正規表現: **実装済み**（2026-07-03、v1.0.7）。下記「Part 1」は実装記録として残す。
- 連番挿入: **実装済み**（2026-07-03、v1.0.8、Ctrl+Alt+I）。下記「Part 2」は実装記録として残す。他の機能案は [[column-select-feature-ideas]] に集約。
- 重複行削除・引用符トグル・文字数カウント: **実装済み**（2026-07-14、v1.0.10、
  Ctrl+Alt+Q / Ctrl+Alt+D）。下記「Part 3」は実装記録として残す。

---

# Part 3: 重複行削除 / 引用符トグル / 文字数カウント（設計・未実装）

対象バージョン: v1.0.10。既存の連番挿入(Ctrl+Alt+I)と同じ3モード判定
（rectSelection / textarea通常選択 / contenteditable通常選択）の枠組みを再利用する。
キー割り当て: `Ctrl+Alt+Q`=引用符トグル、`Ctrl+Alt+D`=重複行削除。
文字数カウントはショートカット不要、選択中は常時バッジ表示。

## 3-A. 引用符「> 」トグル（Ctrl+Alt+Q）

**対象範囲**: rectSelection（各行）/ textarea通常選択（選択にかかる行）/
contenteditable通常選択（選択にかかるブロック=行）の3モード。
`onKeyDown` 内の Ctrl+Alt+I ハンドラ（content.js:1138〜1170）と全く同じ
3分岐ルーティングを流用し、ダイアログを出さず即時実行する。

**判定ロジック(全モード共通)**:
1. 対象行の「行頭2文字」を取得する
2. 対象行**全て**が `"> "` で始まっていれば → 全行から `"> "` を2文字削除（トグルOFF）
3. 1行でも始まっていなければ → 全行の先頭に `"> "` を挿入（トグルON、既に付いている行にも足す。
   部分的な状態は複雑になるため「全部付いているかどうか」の二値判定にする）

**textarea**: 行頭オフセット配列を求める処理は `execInsertSequence` の `ta-sel` 分岐
（content.js:1874〜1895）と同じ実装（`v.lastIndexOf('\n', ...)`。挿入/削除は下から順に
`ta.setSelectionRange` + `document.execCommand('insertText', ...)`。

**contenteditable**: `collectLineStartPoints`（content.js:1779）は挿入位置(collapsed Range)しか
返さないため、削除にはブロック終端までの Range が要る。新しく
`collectLineRanges(root, range)` を書く: `collectLineStartPoints` と同じブロック検出ロジックで、
各ブロックについて「先頭2文字を含むRange」(削除判定・削除実行用)と「挿入用のcollapsed Range」
の両方を返す。削除時は該当Rangeを選択して `execCommand('insertText', false, '')`。

**rectSelection**: 各行のRange/segmentの「行頭」を使う。矩形選択は列単位の切り出しなので、
行頭が矩形の左端と一致しない場合(矩形が行の途中から始まる場合)は行頭ではなく
**矩形の左端位置**に `"> "` を付け外しする(既存の連番挿入と同じ挙動に合わせる)。

## 3-B. 重複行削除（Ctrl+Alt+D）

**対象範囲**: textarea通常選択 / contenteditable通常選択のみ(v1)。
**rectSelectionは対象外**(列単位の切り出しと「行全体の重複」は概念が噛み合わないため、
スコープ外と明記してユーザーにも伝える)。選択がない場合は本文全体を対象にする
(置換ダイアログの「選択なし→全体」と同じ考え方)。

**純粋ロジック(要テスト)**:
```js
// 各行を先頭から見て、初出の行だけ残す。空行は重複除去の対象外(意図的な空行区切りを壊さないため)。
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
```
`tests/logic.test.js` に境界値(空配列・全部同じ行・空行混在・大文字小文字は別扱いか)を追加する。

**textarea**: 選択範囲を行境界まで拡張(`lastIndexOf('\n', selStart-1)+1` 〜
`indexOf('\n', selEnd)` or 末尾)し、その範囲を `split('\n')` → `dedupeLines` → `join('\n')` して
1回の `execCommand('insertText', ...)` で置換(既存のカット処理と同じ「1 undo step」パターン)。
選択がない場合は `textarea.value` 全体が対象。

**contenteditable**: `collectLineStartPoints` のブロック検出ロジックを拡張した
`collectLineRanges`(3-Aと共通化できる)で各行のブロック全体Rangeと `textContent` を取得し、
`dedupeLines` 相当の判定で「2回目以降に出てきた行のブロック」を**下から順に削除**
(`execCommand('insertText', false, '')`)。空行(textContent === '')は削除対象外。

## 3-C. 文字数/単語数/行数カウント（常時バッジ、ショートカット不要）

**表示条件**: `rectSelection` が truthy な間だけ表示。矩形選択解除で自動的に消える。
既存の `modeBadge`（content.js内、Altキー押下中に出る「Col Select」バッジ）と同じ
`position:fixed` バッジパターンを流用し、`modeBadge` の少し上に配置する。

**表示内容**: `{文字数}文字 / {行数}行`（単語数は日本語では概念が曖昧なため v1 は見送り。
英語UIでは半角スペース区切りの単語数も併記してよいが必須ではない）。

**更新タイミング**: `rectSelection` を代入している箇所全て(`onMouseUp`,
`handleKeyboardRectSelect`, `handleKeyboardRectSelectCE`)の直後に `updateCountBadge()` を呼ぶ。
`clearHighlights()` で `hideCountBadge()` を呼ぶ。

**集計ロジック(純粋関数、要テスト)**:
```js
// segments: [{start,end}] または ranges の text配列のどちらでも使えるよう、
// 呼び出し側で文字列配列(各行のテキスト)にしてから渡す
function countSelection(lineTexts) {
  const charCount = lineTexts.reduce((sum, s) => sum + s.length, 0);
  const lineCount = lineTexts.length;
  return { charCount, lineCount };
}
```

## 完成判定(3機能共通、CLAUDE.md「異常系込み」) — 2026-07-14 コードレビューで確認済み
- [x] 引用符トグル: 全行に "> " が付いている状態でON→OFFが一発で効く(`allQuoted`判定で全削除)
- [x] 引用符トグル: 1行だけ "> " が無い状態でトグル→全行に付与される(二値判定を確認)
- [x] 引用符トグル: textarea/CE両方、rectSelection/通常選択両方(4関数全て実装確認)
- [x] 重複行削除: 空行はそのまま残る、大文字小文字は別行として扱われる(テスト6件で明文化・パス)
- [x] 重複行削除: 選択なしで実行→本文全体が対象になる(`execDedupeLinesTA`/`CE`で確認)
- [x] 重複行削除: rectSelection中に実行しても何も起きない(onKeyDownで早期return確認)
- [x] 文字数バッジ: 矩形選択中だけ表示され、解除で消える(`clearHighlights`→`hideCountBadge`確認)
- [x] 全機能: Ctrl+Zで一発Undoできる(全箇所execCommand('insertText')経由を確認)
- [x] `node tests/logic.test.js` が全件パスする(25件中25件パス)
- [x] `node --check content.js` が通る
- [x] version 1.0.9 → 1.0.10、CHANGELOG追記済み(サブエージェントが記入)

## 影響ファイル
- content.js（3機能の実装一式、`collectLineRanges`共通関数、I18N追記、count badge追加）
- tests/logic.test.js（dedupeLines, countSelectionのテスト追加）
- manifest.json（version bump）
- CHANGELOG.md

---

# Part 1: テンプレート保存 + 正規表現（実装済み・記録用）

対象: `content.js` の置換ダイアログ（Ctrl+H）。

## 確定した判断
- テンプレート保存の中身: **検索語だけのリスト**（複数保存、クリックで検索欄へ）
- 同期範囲: **このPCだけ = `chrome.storage.local`**
- 正規表現: チェックボックスで切替、`$1` キャプチャ参照はネイティブ対応で追加コード不要

---

## 手順0（前提・最優先）: 置換ロジックの共通化 DRY

現状 `execReplace`（textarea, content.js:1313〜）と `execReplaceCE`（contenteditable, content.js:1468〜）に
**同じ正規表現生成コードが重複**している（content.js:1325 / content.js:1480）。
機能追加の前に純粋関数へ切り出す。CLAUDE.md「同じコードを2か所に書かない」。

```js
// 追加する純粋関数（単体テスト可能な形）
function buildRegex(searchStr, { caseSensitive, useRegex }) {
  const flags = caseSensitive ? 'g' : 'gi';
  const pattern = useRegex
    ? searchStr
    : searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return { regex: new RegExp(pattern, flags), error: null };
  } catch (e) {
    return { regex: null, error: e.message };
  }
}
```
`execReplace` / `execReplaceCE` 両方の regex 生成をこの呼び出しに置き換える。

---

## 機能A: 正規表現対応（先に実装・簡単）

### UI
チェックボックス行（content.js:1281 と 1447 の `rs-case` 行）に2つ目を追加:
```
□ 大文字/小文字を区別する    □ 正規表現 (.* など)
```
class は `rs-regex`。

### ロジック
- `execReplace` / `execReplaceCE` で `const useRegex = replaceDialog.querySelector('.rs-regex').checked;`
- `buildRegex(searchStr, { caseSensitive, useRegex })` を呼ぶ
- `error` が返ったら結果欄に赤字表示して return（フェイルクローズ。壊れたパターンで走らせない）
- `$1` 等のキャプチャ参照は `String.replace()` がそのまま処理するので追加不要

### i18n（I18N 辞書 ja/en 両方に追加）
- `regexLabel`: ja「正規表現 (.* など)」/ en「Regex (.* etc.)」
- `errBadRegex`: ja「正規表現が不正です」/ en「Invalid regular expression」

---

## 機能B: 検索語テンプレート保存

### 権限
manifest.json に追加:
```json
"permissions": ["storage"]
```
※ storage はインストール時に警告を出さないサイレント権限。ホスト権限は増えないので「怖い権限なし」の売りは維持。

### データ構造
```js
// chrome.storage.local
{ csTemplates: ["●●", "▲▲", "案件名"] }  // 検索語の配列。最大 20 件程度で頭打ち
```

### UI（検索欄の“上”に chip 行を差し込む）
```
定型: [ ●● ×] [ ▲▲ ×] [ 案件名 ×]   [＋保存]
検索文字列
[ ●●                          ]
```
- chip クリック → `.rs-search` にその文字列を入れて focus
- chip の × → その要素を配列から削除して storage 更新 + 再描画
- 「＋保存」→ 現在の `.rs-search` の値を配列末尾に追加（空・重複は無視）

### 非同期の扱い
storage は async。ダイアログ本体は同期生成のまま、chip 行だけ後追いで描画する:
```js
function renderTemplateChips(container) {
  chrome.storage.local.get({ csTemplates: [] }, ({ csTemplates }) => {
    // container.innerHTML を組み立て、クリック/削除ハンドラを付与
  });
}
```
`openReplaceDialog` と `openReplaceDialogCE` の両方から呼ぶ（chip 行の生成関数も共通化）。

### i18n
- `tmplLabel`: ja「定型:」/ en「Saved:」
- `tmplSave`: ja「＋保存」/ en「+ Save」

---

## 完成判定（CLAUDE.md「異常系込み」）
- [ ] 正規表現 OFF で `.` がリテラル一致する（従来動作維持）
- [ ] 正規表現 ON で `(\d+)` → `$1` が機能
- [ ] 不正な正規表現 `[` でエラー表示され、本文が壊れない
- [ ] テンプレート保存 → ダイアログ閉じ再オープンで chip が残る
- [ ] Gmail で保存した chip が Yahoo メールでも出る（local が全 origin 共通なことの確認）
- [ ] textarea と contenteditable の両モードで A/B とも動作
- [ ] version を 1.0.7 へ、CHANGELOG 追記

## 影響ファイル
- content.js（`buildRegex` 追加、両 execReplace 改修、両 openReplaceDialog に chip 行、I18N 追記）
- manifest.json（`permissions: ["storage"]`、version bump）
- CHANGELOG.md

---

# Part 2: 連番挿入（設計のみ・未着手）

矩形選択した各行に `1, 2, 3…` を同時挿入する機能。[[column-select-feature-ideas]] の候補①。
「列に対して一括で何かする」という本拡張の世界観に最も合致し、実装コストが低い。

## 既存コードとの関係
`content.js` の `isCharInsert` ブロック（1126行目付近）と Ctrl+V ペースト処理（1084行目付近）が
「矩形選択の各行に何かを挿入する」というほぼ同じ構造をすでに持っている。これを流用する。

**重要な違い**: 通常の一括挿入/ペーストは全行に**同じ文字列**を入れるが、連番挿入は行ごとに**違う値**を
入れる必要がある。挿入自体は下の行から順に処理する（上の行の Range/インデックスをずらさないため、
既存の `isCharInsert` と同じ理由）が、**採番は見た目の上から下の順**で行う必要がある。
→ 「上から順に番号を振った配列を先に作り、その配列を下から順に挿入で使う」という2段構えにする。

## トリガー
- ショートカット案: `Ctrl+Alt+I`（Insert numberの意）。矢印キー系（Alt+Shift+矢印）や既存ショートカットと衝突しないことを確認する
- 矩形選択中でないと発動しない（`rectSelection` が null なら無視）

## UI
軽量ダイアログ（置換ダイアログと似た見た目・位置）を出し、開始値と増分を聞く:
```
連番を挿入
開始値 [ 1 ]   増分 [ 1 ]
[挿入]
```
- デフォルトは開始値1・増分1。Enterで即挿入できるようにする
- 桁揃え（`01, 02, 03`）はv1では対象外。将来案として残すのみ

## ロジック（擬似コード）
```js
function execInsertSequence(start, step) {
  if (rectSelection.mode === 'contenteditable') {
    // 1. 見た目の上から下の順で並べる（top-to-bottom）
    const topDown = [...rectSelection.ranges].sort((a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top
    );
    // 2. 上から順に番号を割り当てる
    const numbered = topDown.map((range, i) => ({ range, num: start + i * step }));
    // 3. 挿入は下から順に処理(既存のisCharInsertと同じ理由でインデックスのずれを防ぐ)
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
    // 4. ハイライト再描画(既存パターンを踏襲)
  } else if (rectSelection.mode === 'textarea') {
    // segments は既に上から下の順で並んでいる前提を確認してから採番
    const numbered = rectSelection.segments.map((seg, i) => ({ seg, num: start + i * step }));
    const bottomUp = [...numbered].sort((a, b) => b.seg.start - a.seg.start);
    const ta = rectSelection.textarea;
    ta.focus();
    for (const { seg, num } of bottomUp) {
      ta.setSelectionRange(seg.start, seg.start);
      document.execCommand('insertText', false, String(num));
    }
    // 挿入した文字数は行ごとに違う(1桁/2桁/3桁)ので、
    // 既存の "segments.forEach(s => s.start += 1)" は使えない。
    // 各セグメントの挿入文字数ぶんだけ、そのセグメント自身と
    // それより後ろのセグメントのstart/endを個別にずらす必要がある。
  }
}
```

## 注意点（既存コードと異なり複雑になる箇所）
- **桁数が行によって違う**（1〜9行は1桁、10行目以降は2桁）ため、`isCharInsert` のような
  「全行+1文字」という単純なインデックス更新が使えない。挿入後のセグメント位置再計算が必要
  → 実装時は挿入後に `rebuildHilitesFromSegments` 相当を呼ぶ前提で、
    セグメントの再計算ロジックを慎重に書く（ここが唯一の複雑ポイント）
- 矩形選択が解除された後にキーを押した場合は何もしない（フェイルクローズ）
- Undo（Ctrl+Z）は `execCommand('insertText', ...)` を使う限り自動対応する（既存機能と同じ仕組み）

## i18n
- `seqTitle`: ja「連番を挿入」/ en「Insert Sequence」
- `seqStart`: ja「開始値」/ en「Start」
- `seqStep`: ja「増分」/ en「Step」
- `seqInsert`: ja「挿入」/ en「Insert」

## 完成判定
- [ ] 矩形選択5行に対して開始1・増分1 → `1,2,3,4,5` が各行に入る
- [ ] 開始10・増分5 → `10,15,20,25,30`
- [ ] 10行以上選択して桁が変わる境界（9→10）でズレが起きないこと
- [ ] textarea/contenteditable 両方
- [ ] Ctrl+Z で一発Undoできること
- [ ] 矩形選択なしでショートカットを押しても何も起きないこと
