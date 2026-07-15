# テスト

純粋関数(DOM非依存)のみを対象にした回帰テスト。

```
node tests/logic.test.js
```

対象: `buildRegex` / `replaceWithCount` / `expandReplacement`(内部) / `columnRangeFromX`。
`content.js` 本体を `require` して実行するため、実装と乖離しない(コピペ複製ではない)。
DOM操作を伴う関数(矩形選択の座標計算そのものなど)はスコープ外。
