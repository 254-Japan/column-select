// content.js は Chrome拡張のcontent scriptとして書かれており、読み込まれた瞬間に
// document.addEventListener 等をトップレベルで実行する。Node.js から require するには
// 最小限のDOM/ブラウザAPIスタブが要る。ここで用意するのは「読み込み時に例外を投げない」
// 程度の最小実装で、DOM操作を伴う関数(座標計算・矩形選択など)自体はテスト対象外。
// テスト対象は純粋関数(buildRegex, replaceWithCount, columnRangeFromX)のみ。

function makeFakeElement() {
  return {
    style: {},
    dataset: {},
    children: [],
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    querySelector: () => null,
    addEventListener: () => {},
  };
}

global.document = {
  designMode: 'off',
  getElementById: () => null,
  createElement: () => makeFakeElement(),
  createTextNode: () => ({}),
  createRange: () => ({
    selectNodeContents() {},
    setStart() {},
    setEnd() {},
    collapse() {},
    cloneRange() { return this; },
    getClientRects: () => [],
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener: () => {},
  caretRangeFromPoint: () => null,
};

global.navigator = {
  language: 'en-US',
  clipboard: { writeText: async () => {}, readText: async () => '' },
};

global.window = {
  addEventListener: () => {},
  getSelection: () => null,
  requestAnimationFrame: (fn) => fn(),
};

global.chrome = {
  storage: { local: { get: (_, cb) => cb && cb({}), set: (_, cb) => cb && cb() } },
  runtime: { getURL: (p) => p },
};

global.getComputedStyle = () => ({});
