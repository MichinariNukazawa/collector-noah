# Contributing

> **人間用（コントリビュータ向け）。**

Collector Noah は「閲覧画像をローカルに送る」小さな拡張です。
サイト追加は **`sites.json` に1エントリ足す**のが基本です。

## サイトを追加する

1. `sites.json` にエントリを追加する

```json
{
  "example": {
    "label": "Example",
    "hosts": ["example.com", "cdn.example.com"],
    "matches": ["*://*.example.com/*"],
    "actions": [
      {
        "action": "like",
        "selectors": ["[data-testid=\"like\"]"],
        "texts": ["いいね", "Like"]
      }
    ],
    "containerSelectors": ["article", "main"],
    "imageSelector": "img",
    "maxImages": 1
  }
}
```

2. `python3 build.py` を実行する
   - `dist/chrome` / `dist/firefox` が作られる
   - `sites.generated.js`、manifestのmatches、オプション画面が自動更新される
3. Chrome/Firefoxで読み込み、実際に動かす
4. 収集結果を `collector` の `/api/events` で確認する

## セレクタのコツ

- `data-testid`、`title`、`aria-label` など、意味のある属性を優先する
- 生成されたclass名（`sc-xxxx`、`css-xxxx`）はすぐ変わるので避ける
- どうしても属性がない場合だけ `texts` を使う
- 画像は `naturalWidth`/`naturalHeight` があるものを選ぶ
- 複数画像の投稿は `maxImages` を増やす

## サイト別API

サイトがDOMに出さない画像URLを持つ場合、`pageApi` を追加できる。
例: Pixiv は `/ajax/illust/{id}` の `urls.original` を使う。
APIを使う場合も、取得するのは画像URLとメタデータだけ。

## やってはいけないこと

- ページ本文、Cookie、フォーム、スクリーンショットを送る
- `<all_urls>` を要求する
- リモートからコードやアダプタを読み込む
- ユーザーにサイト追加/セレクタ編集/プラグイン導入をさせる
- すべての表示画像を自動収集する
- APIキーや認証情報を保存する

## 問題の報告

サイトのボタンが動かなくなったら、ポップアップの **「問題を報告」** を押す。
Markdownがコピーされるので、そのままAIかGitHub Issueに貼る。

レポートには、期待セレクタの一致数、候補ボタン、前回成功時のDOM指紋、
`sites.json` の該当エントリ、Collector状態、直近イベントが入る。
DevToolsを開かせない。

## テスト

- 画像クリック
- 別タブで開く
- いいね / 保存
- 右クリック「この画像を送る」
- 右クリック「ページの画像をまとめて送る」
- Collector停止 → キュー → 再開
- 一時停止
- Token誤り

## AIで貢献する場合

この文書と [SPEC.md](SPEC.md) に従ってください。`sites.json` と `build.py` の範囲で完結させるのが基本です。
UIを増やさないでください。
