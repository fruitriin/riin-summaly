# curl-cffi-fetcher (phase12.5 実験)

summaly の TLS layer bot block 救援用 CLI fetcher。
`curl_cffi` (https://github.com/lexiforest/curl_cffi) は libcurl-impersonate
バインディングで、Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を
完全再現する。yodobashi 級の TLS layer bot block (HTTP/2 INTERNAL_ERROR / 即時切断) を
回避できる可能性がある。

## なぜ Python / uv

- `curl_cffi` は libcurl-impersonate の最もメンテされている Python バインディング
- `uv` でプロジェクト隔離 (summaly 本体の pnpm 環境に Python 依存を持ち込まない)
- Node.js 側との通信は **stdio JSON で疎結合**

## 使い方

```sh
cd tools/curl-cffi-fetcher
uv sync                                          # 初回のみ
uv run fetch https://www.yodobashi.com/product/100000001003176109/ | jq .status
```

stdout に JSON 出力:

```json
{
  "status": 200,
  "final_url": "https://www.yodobashi.com/product/100000001003176109/",
  "content_type": "text/html; charset=UTF-8",
  "headers": {...},
  "body": "<html>..."
}
```

エラー時:

```json
{"error": "...", "category": "timeout|network|tls|setup|content_too_large|other"}
```

## オプション

- `--impersonate <target>` (default: `chrome120`)。`firefox120` / `safari17_0` 等
- `--timeout <sec>` (default: 20)
- `--max-bytes <n>` (default: 5 MiB)

## 実験フロー (Step 1.3 GO/NO-GO)

1. `uv sync` で依存解決
2. yodobashi で 200 + HTML が取れるか確認
   ```sh
   uv run fetch https://www.yodobashi.com/product/100000001003176109/ | jq '{status, content_type, body_len: (.body | length)}'
   ```
3. **GO 条件**: `status == 200` かつ `content_type` に `text/html` が含まれる
4. **NO-GO 条件**: TLS/network エラーで取得不能、または status >= 400 が続く
5. GO なら summaly の yodobashi プラグインから spawn-per-request で呼ぶ統合フェーズへ。
   NO-GO なら本ディレクトリは破棄し、ノウハウだけ `docs/knowhow/` に残す

## 運用上の注意

- 本ツールは **summaly 本体の npm publish 対象外** (`tools/` 配下、`package.json` `files`
  にも含まれない)。利用者は production server 上で別途 `uv` を入れて `uv sync` する必要あり
- spawn-per-request は起動コスト (~100ms) が乗る。GO なら長期駐留型 (stdin で URL を連続受信
  する daemon) に拡張可能
- `curl_cffi` は **OGP 取得目的** に限定し、ログイン・購入などの自動化用途では使わない
  (利用規約抵触の可能性)
