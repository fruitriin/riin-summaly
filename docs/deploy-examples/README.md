# Deploy Examples

> **動作保証なし、参考用**。OS / ディストリ / 配置構成に応じた読み替えが必要です。
> nginx / systemd の更新で動かなくなる可能性があるため、本番採用前に十分に検証してください。

## ファイル

- [`summaly.nginx.conf.example`](summaly.nginx.conf.example) — nginx の reverse proxy 設定例
- [`summaly.service.example`](summaly.service.example) — systemd unit 例（TOML 設定 + `bin/summaly-server.ts`）
- [`summaly-config.example.toml`](summaly-config.example.toml) — **推奨**: TOML 設定例
- [`summaly-config.example.json`](summaly-config.example.json) — DEPRECATED: 旧 fastify-cli `--options` 用 JSON。リリース 1 サイクル後に削除予定

## 概要

summaly は以下 2 つの形態で利用できます:

1. **ライブラリ**: `summaly(url, opts)` 関数を直接呼ぶ
2. **スタンドアロンサーバ**: `pnpm serve /path/to/config.toml` で TOML 設定を読んで HTTP サーバを起動

本ディレクトリは 2. の運用例です。phase8.1 (リリース 5.4) で `fastify-cli --options ...json` から TOML ベースに移行しました。

## マイグレーション (JSON → TOML)

旧設定:

```json
{
	"useRange": true,
	"allowedPlugins": ["amazon", "bluesky"],
	"cacheMaxAge": 604800
}
```

新設定 (`config.toml`):

```toml
[summaly]
useRange = true

[summaly.cache]
maxAge = 604800

[plugins]
allowed = ["amazon", "bluesky"]
```

主な変更点:
- `cacheMaxAge` / `cacheErrorMaxAge` → `[summaly.cache] maxAge` / `errorMaxAge`
- `inMemoryCache` / `inMemoryCacheMaxEntries` → `[summaly.cache] inMemory` / `inMemoryMaxEntries`
- `inFlightDedup` → `[summaly.cache] inFlightDedup`
- `enablePdf` → `[summaly.pdf] enabled`
- `allowedPlugins` → `[plugins] allowed`
- `[server] host` / `port` セクションが追加（旧 fastify-cli の `--address` / `--port` 引数を置き換える）
- 旧 `--options` JSON は **対応しない**（コメント書きたい・セクション分割したいニーズに応えるため）

systemd / nginx 設定例は本ディレクトリの `summaly.service.example` / `summaly.nginx.conf.example` を参照。
