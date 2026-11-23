# Collector Noah（ローカル受信アプリ）

Collector Noah 拡張からイベントと収集の警告を受け取り、JSONL と画像を保存する。
Python 標準ライブラリのみ。Windows / macOS / Linux で動く。

拡張との契約（HTTP API）とディスク上のデータ形式は、このディレクトリの実装が正。仕様は [../SPEC.md](../SPEC.md)、データ形式は [../schemas/](../schemas/)。

## 起動（手動）

```bash
# リポジトリのルートで
python3 -m collector.server --no-download
```

オプション:

```bash
python3 -m collector.server --port 8765 --data-dir /path/to/data --token-file /path/to/token
python3 -m collector.server --download      # 保存・いいね等の画像を取得元へ要求する
python3 -m collector.server --download-all  # click / open も含めて取得元へ要求する
```

既定は `--no-download`（取得元へ画像を要求しない）。既定のデータ先は `~/.local/share/collector-noah/`。受信用 Token は初回起動時に自動生成され、同じディレクトリの `token` ファイルに保存される（権限は 600 が設定される）。拡張のオプション画面には、このファイルの中身を入れる。

## systemd ユーザサービス（collector-noah.service）

ユニットファイルは `collector/collector-noah.service`。`~/.config/systemd/user/` に置いて使う。ユニットの `WorkingDirectory` は clone 先に合わせて書き換えること。

```bash
mkdir -p ~/.config/systemd/user
cp collector/collector-noah.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now collector-noah.service   # 有効化して起動
systemctl --user is-enabled collector-noah.service     # 有効か確認
systemctl --user is-active collector-noah.service      # 稼働中か確認
systemctl --user status collector-noah.service         # 状態と直近のログ
systemctl --user restart collector-noah.service        # 再起動
systemctl --user stop collector-noah.service           # 停止
systemctl --user disable --now collector-noah.service  # 自動起動を解除して停止
rm ~/.config/systemd/user/collector-noah.service       # ユニットを除去（その後 daemon-reload）
```

ログイン時の自動起動が基本。ログイン前（起動プロセスの一部として）から起動したい場合は linger を別途設定する:

```bash
loginctl enable-linger "$USER"
```

## エンドポイント

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| GET | `/api/health` | なし | 稼働確認 |
| POST | `/api/collect` | `X-Atelier-Token` | イベント受信 |
| POST | `/api/inventory` | `X-Atelier-Token` | 棚卸し（操作要素の種類・属性・件数）受信。本文は受け取らない |
| GET | `/api/events` | `X-Atelier-Token` | イベント取得。任意の `since`、`until`、`limit`、`offset` を指定可。200 `{ok, events, total}`。 |
| GET | `/api/diagnostics` | `X-Atelier-Token` | 状態・直近イベント・保存中の警告件数と最新10件（拡張の完全版診断用） |
| POST | `/api/gaps` | `X-Atelier-Token` | 収集の警告を最大4 KiBのJSONで1件受信。同一内容の同一IDは保持期間内に再送可能。 |

- `since` は開始時刻を含み、`until` は終了時刻を含みません。片方だけでも指定でき、`created_at` が対象です。日時は UTC の ISO 8601（例 `2026-11-18T00:00:00Z`）で指定します。`+00:00` の `+` は URL 上で `%2B` とします。
- `limit` の既定は50、上限は期間指定時10,000件、それ以外は500件です。整数の下限は1に丸めます。`offset` は末尾側から飛ばす件数（既定0）です。各ページ内は保存順で、`total` はページング前の一致件数です。
- 不正な日時、開始が終了より後の範囲、整数に変換できない `limit` または `offset`、負の `offset` は 400 `{ok: false, error}` を返します。

```bash
curl -s http://127.0.0.1:8765/api/health
curl -s -H "X-Atelier-Token: $(cat ~/.local/share/collector-noah/token)" \
  "http://127.0.0.1:8765/api/events?limit=5"
curl -s -H "X-Atelier-Token: $(cat ~/.local/share/collector-noah/token)" \
  "http://127.0.0.1:8765/api/events?since=2026-11-18T00:00:00Z&until=2026-11-19T00:00:00Z&limit=10000"
```

## 保存先

```
~/.local/share/collector-noah/
  token
  events.jsonl
  inventory.jsonl
  gaps/records.jsonl
  images/{sha256}.{ext}
```

- 画像URLは公開http(s)のみ。localhost/私設IPは拒否する
- 拡張からの画像付きイベントは POST 全体で最大 1,000,000 バイト。受信した画像はハッシュでイベントにひもづく。ダウンロード経路（`--download` 系）では1枚あたり最大50MB
- ダウンロードに失敗してもイベントは残る（`download_error`）
- 同じ画像はSHA256で同じファイル名になる
- 収集の警告は、受信から30日未満で、新しい順に最大1,000件、合計192 KiBまで保持する

## 他のツールから使う

保存されたイベントは `/api/events` で取得できる。データファイル（JSONL と画像）を直接読んでもよい。読み取りは自由だが、このディレクトリのファイル形式を変える場合は [../schemas/](../schemas/) と実装を正とすること。

## セキュリティ

- 既定で `127.0.0.1` にだけバインド。ループバック以外を `--host` に指定すると起動時にエラーになる
- `X-Atelier-Token` 必須（healthを除く）。トークンの値は起動表示やログに出力しない
- ページ本文・Cookieは受け取らない
- CORSは拡張からのPOST用に許可。トークンが実質の認証

## テスト

`tests/` の Python テスト一式:

```bash
# リポジトリのルートで
python3 -B -m unittest discover -s tests -p "test_*.py"
```

`curl` でイベントを送れる。

```bash
TOKEN=$(cat ~/.local/share/collector-noah/token)
curl -s -X POST http://127.0.0.1:8765/api/collect \
  -H "Content-Type: application/json" \
  -H "X-Atelier-Token: $TOKEN" \
  -d '{"source":"other","action":"save","image_url":"https://example.com/a.webp","page_url":"https://example.com/"}'
```
