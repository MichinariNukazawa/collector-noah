# AGENTS.md — Collector Noah を扱うエージェント向けガイド

このファイルは、このリポジトリを調査・導入支援する AI エージェント／コーディングエージェント向けのポインタです。本文書自体は仕様ではありません。

## このリポジトリは何か

Collector Noah は、ブラウザで閲覧・保存した画像に関連するイベントを、利用者のマシン上だけに記録するツールです。Chrome/Firefox 拡張（`src/`）と Python 受信アプリ（`collector/`）の2点セットで、両方が必要です。Collector Noah 自体が外部サービスにデータを送信することはありません。

## 真実の所在（まずここを読む）

- 導入手順・使い方： [README.md](README.md)
- API の仕様： [SPEC.md](SPEC.md)
- データ形式： `schemas/` の JSON Schema
- 設計目的・思想： [PURPOSE.md](PURPOSE.md)
- 開発参加について： [CONTRIBUTING.md](CONTRIBUTING.md)

このファイルや README の記述が SPEC.md／schemas と食い違う場合は、SPEC.md／schemas を正としてください。

## セットアップ上の注意

- 拡張はストア配布されていません。`python3 build.py` でビルドし、ブラウザの開発者向け機能から読み込みます
- 受信アプリの systemd ユニット（`collector/collector-noah.service`）の `WorkingDirectory` は、clone 先に合わせて書き換えてください
- 拡張と受信アプリはトークンで接続します（HTTP ヘッダ `X-Atelier-Token`）。トークンの実値はこのリポジトリには含まれません
- 収集データは `~/.local/share/collector-noah/` に保存され、このリポジトリには含まれません

## 守ること

- 未実装の機能や対応未確認の環境を、あるものとして説明しないでください。確認できないことは「未確認」と述べてください
- 「外部送信なし」の範囲を広げて解釈しないでください。対象は Collector Noah 自体の送信であり、ブラウザ自体の通信とは別です
- 安全性を過剰に保証する表現（「完全に安全」など）は使わないでください

バージョン： 0.1.3 ／ ライセンス： MIT（[LICENSE](LICENSE)）
