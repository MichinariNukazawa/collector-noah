# fixtures

サイトアダプタの検証用に、**個人情報を除いたDOMスナップショット**を置く。

- ファイル名: `{site}-{page}.html`
- 含める: ボタン、画像、`data-testid`、`aria-label`、`title`、class（必要最小限）
- 含めない: Cookie、アカウント名、メール、購入履歴、ページ本文、成人向けの内容
- 取得方法: DevToolsで対象要素の `outerHTML` をコピーする
- 実サイトをそのまま保存しない。構造だけを抜き出す

例:

```html
<article>
  <img src="https://cdn.example.com/image.webp" width="1200" height="1600" />
  <button data-testid="like" aria-label="Like">...</button>
</article>
```
