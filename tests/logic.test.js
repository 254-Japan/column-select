// content.js の純粋関数(DOM非依存)を検証する。
// 実行: node tests/logic.test.js
// (プロジェクトにテストランナーは入れていないため、Node標準のassertで
//  自前判定し、失敗時は非ゼロ終了コードでCIやpre-commitから検知できるようにする)

require('./dom-stub.js');
const assert = require('assert');
const { buildRegex, replaceWithCount, columnRangeFromX, dedupeLines, countSelection } = require('../content.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.message}`);
  }
}

console.log('buildRegex');
test('通常モードは特殊文字をリテラル一致させる', () => {
  const { regex } = buildRegex('a.b', { caseSensitive: false, useRegex: false });
  assert.strictEqual('xaxb'.replace(regex, 'Z'), 'xaxb');
  assert.strictEqual('a.b'.replace(regex, 'Z'), 'Z');
});
test('正規表現モードでキャプチャグループが使える', () => {
  const { regex } = buildRegex('(\\d+)円', { caseSensitive: false, useRegex: true });
  assert.strictEqual('100円'.replace(regex, '$1 yen'), '100 yen');
});
test('不正な正規表現はエラーを返し例外を投げない', () => {
  const { regex, error } = buildRegex('[', { caseSensitive: false, useRegex: true });
  assert.strictEqual(regex, null);
  assert.ok(error);
});
test('破滅的バックトラックの典型形は risky で弾かれる', () => {
  const { regex, risky } = buildRegex('(a+)+', { caseSensitive: false, useRegex: true });
  assert.strictEqual(regex, null);
  assert.strictEqual(risky, true);
});
test('大文字小文字の区別が効く', () => {
  const sensitive = buildRegex('ABC', { caseSensitive: true, useRegex: false });
  assert.strictEqual('abc'.replace(sensitive.regex, 'Z'), 'abc');
  const insensitive = buildRegex('ABC', { caseSensitive: false, useRegex: false });
  assert.strictEqual('abc'.replace(insensitive.regex, 'Z'), 'Z');
});

console.log('replaceWithCount (ネイティブreplace+matchと同じ結果になること)');
function assertMatchesNative(searchStr, replaceStr, text, opts) {
  const { regex: r1 } = buildRegex(searchStr, opts);
  const nativeResult = text.replace(r1, replaceStr);
  const nativeCount = (text.match(r1) || []).length;
  const { regex: r2 } = buildRegex(searchStr, opts);
  const { result, count } = replaceWithCount(text, r2, replaceStr);
  assert.strictEqual(result, nativeResult, `result mismatch for ${JSON.stringify({searchStr, replaceStr, text})}`);
  assert.strictEqual(count, nativeCount, `count mismatch for ${JSON.stringify({searchStr, replaceStr, text})}`);
}
test('通常の複数一致', () => assertMatchesNative('abc', 'XYZ', 'abcabcabc', { caseSensitive: false, useRegex: false }));
test('一致なし', () => assertMatchesNative('x', 'y', 'no match here', { caseSensitive: false, useRegex: false }));
test('$&(マッチ全体)', () => assertMatchesNative('a', '$&$&', 'xax', { caseSensitive: false, useRegex: false }));
test('$$(リテラル$)', () => assertMatchesNative('a', '$$', 'aaa', { caseSensitive: false, useRegex: false }));
test('未マッチのオプショナルグループは空文字になる', () =>
  assertMatchesNative('(a)(b)?', '[$1|$2]', 'a ab a', { caseSensitive: false, useRegex: true }));
test('2桁のグループ参照が無効なら1桁+リテラルにフォールバックする', () =>
  assertMatchesNative('(a)', '$10', 'a', { caseSensitive: false, useRegex: true }));
test('存在しないグループ参照はそのまま残る', () =>
  assertMatchesNative('(a)(b)', '$1$2$3', 'ab', { caseSensitive: false, useRegex: true }));
test('名前付きグループ', () =>
  assertMatchesNative('(?<name>\\w+)@(?<domain>\\w+)', '$<domain>#$<name>', 'user@host and foo@bar',
    { caseSensitive: false, useRegex: true }));

console.log('columnRangeFromX (textareaミラー行モデルからの桁範囲計算)');
function makeRow(charWidths) {
  // charWidths: 各文字の幅(px)配列。colLeftsは累積座標+末尾に行末右端を追加した配列。
  const colLefts = [0];
  let x = 0;
  for (const w of charWidths) { x += w; colLefts.push(x); }
  return { length: charWidths.length, colLefts };
}
test('範囲の一部に重なる列を正しく特定する', () => {
  const row = makeRow(Array(10).fill(10)); // 0,10,...,90 幅10ずつ、行末100
  const r = columnRangeFromX(row, 15, 45);
  assert.deepStrictEqual(r, { colFrom: 1, colTo: 5 });
});
test('範囲外なら null', () => {
  const row = makeRow(Array(10).fill(10));
  assert.strictEqual(columnRangeFromX(row, 200, 300), null);
});
test('行全体を覆う範囲', () => {
  const row = makeRow(Array(10).fill(10));
  assert.deepStrictEqual(columnRangeFromX(row, 0, 100), { colFrom: 0, colTo: 10 });
});

console.log('dedupeLines (重複行削除)');
test('空配列はそのまま空配列', () => {
  assert.deepStrictEqual(dedupeLines([]), []);
});
test('全部同じ行は初出だけ残る', () => {
  assert.deepStrictEqual(dedupeLines(['a', 'a', 'a']), ['a']);
});
test('重複がなければ全行残る', () => {
  assert.deepStrictEqual(dedupeLines(['a', 'b', 'c']), ['a', 'b', 'c']);
});
test('空行は重複除去の対象外(全て残る)', () => {
  assert.deepStrictEqual(dedupeLines(['a', '', 'a', '', '']), ['a', '', '', '']);
});
test('大文字小文字は別行として扱われる', () => {
  assert.deepStrictEqual(dedupeLines(['Abc', 'abc', 'ABC', 'abc']), ['Abc', 'abc', 'ABC']);
});
test('離れた位置の重複も除去される', () => {
  assert.deepStrictEqual(dedupeLines(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

console.log('countSelection (文字数/行数カウント)');
test('空配列は0文字0行', () => {
  assert.deepStrictEqual(countSelection([]), { charCount: 0, lineCount: 0 });
});
test('複数行の文字数と行数を合算する', () => {
  assert.deepStrictEqual(countSelection(['abc', 'de', '']), { charCount: 5, lineCount: 3 });
});
test('1行のみ', () => {
  assert.deepStrictEqual(countSelection(['hello']), { charCount: 5, lineCount: 1 });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
