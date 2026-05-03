# Deploy Examples

> **動作保証なし、参考用**。OS / ディストリ / 配置構成に応じた読み替えが必要です。
> nginx / systemd の更新で動かなくなる可能性があるため、本番採用前に十分に検証してください。

## ファイル

- [`summaly.nginx.conf.example`](summaly.nginx.conf.example) — nginx の reverse proxy 設定例
- [`summaly.service.example`](summaly.service.example) — systemd unit 例
- [`summaly-config.example.json`](summaly-config.example.json) — Fastify プラグインに渡す設定例

## 概要

summaly は以下 2 つの形態で利用できます:

1. **ライブラリ**: `summaly(url, opts)` 関数を直接呼ぶ
2. **Fastify プラグイン**: `fastify-cli` 経由でスタンドアロンの HTTP サーバとして動かす

本ディレクトリは 2. のスタンドアロンサーバ運用例です。
