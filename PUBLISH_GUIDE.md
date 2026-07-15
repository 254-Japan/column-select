# 公開手順ガイド

## ステップ 1 — GitHubにリポジトリを作る

1. https://github.com/new を開く
2. Repository name: `column-select`
3. Public を選ぶ
4. **「Add a README file」にチェックを入れる**
5. 「Create repository」をクリック

---

## ステップ 2 — ファイルをアップロードする

GitHubのリポジトリページで「Add file」→「Upload files」をクリックし、
`browser_column_select` フォルダの中身を**すべて**アップロードする。

アップロードするファイル一覧:
- `content.js`
- `manifest.json`
- `icon16.png` / `icon48.png` / `icon128.png`
- `privacy_policy.html`
- `はじめにお読みください.md`
- `仕様書.md`
- `STORE_LISTING.md`

---

## ステップ 3 — GitHub Pages でプライバシーポリシーを公開する

1. リポジトリの「Settings」タブを開く
2. 左メニューの「Pages」をクリック
3. Source: 「Deploy from a branch」
4. Branch: `main` / `(root)` を選んで「Save」
5. 数分後、以下のURLでアクセスできるようになる:

```
https://あなたのユーザー名.github.io/column-select/privacy_policy.html
```

このURLをメモしておく（Chrome Web Store に登録するときに使う）。

---

## ステップ 4 — Chrome Web Store デベロッパー登録

1. https://chrome.google.com/webstore/devconsole を開く
2. Googleアカウントでログイン
3. 初回のみ **$5 の登録料** をクレジットカードで支払う

---

## ステップ 5 — ZIPを作る

`browser_column_select` フォルダを右クリック →「圧縮」→ `browser_column_select.zip` を作成。

> ⚠️ フォルダごと圧縮すること（フォルダの中身だけではなく）。

---

## ステップ 6 — 新しいアイテムを登録する

1. Developer Dashboard で「新しいアイテム」をクリック
2. ZIPをアップロード
3. 以下の情報を入力する（`STORE_LISTING.md` からコピペ）:

| 項目 | 内容 |
|---|---|
| 名前 | Column Select — Rectangular Selection |
| 説明（短） | `STORE_LISTING.md` の Short description をコピー |
| 説明（詳細） | `STORE_LISTING.md` の Detailed description をコピー |
| カテゴリ | Productivity |
| 言語 | English |
| プライバシーポリシーURL | ステップ3で取得したURL |

---

## ステップ 7 — スクリーンショットを撮る

1. `screenshot_preview.html` をChromeで開く
2. ブラウザのウィンドウを **1280×800px** にリサイズする
   （デベロッパーツール → デバイスツールバーで幅1280・高さ800に設定するのが楽）
3. スクリーンショットを撮る（Windowsキー + Shift + S）
4. Developer Dashboard の「スクリーンショット」にアップロード

> 最低1枚必要。複数枚あるとストアでの見栄えが良くなる。

---

## ステップ 8 — 審査に提出

「審査のために提出」ボタンを押す。

通常 **数日〜1週間** で結果のメールが届く。

### 却下された場合

メールに理由が書いてある。よくある原因:
- スクリーンショットの解像度が足りない → 1280×800 で撮り直す
- プライバシーポリシーURLが開けない → GitHub Pages が有効か確認する
- 説明文が短すぎる → 詳細説明をもう少し充実させる

修正してZIPを再アップロード → 再提出。

---

## 公開後

ストアのURLは以下の形式になる:
```
https://chromewebstore.google.com/detail/column-select/拡張機能ID
```

このURLをGitHubのREADMEに貼っておくと見つけてもらいやすくなる。
