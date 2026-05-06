# phase12.5 — curl_cffi (libcurl-impersonate) を使った TLS layer bot block 救援

## 背景

phase12.4 で yodobashi プラグインを追加し、proxy fallback の categories を
`['origin_error', 'bot_blocked', 'timeout', 'connection_dropped']` に拡張したが、
**CF Workers proxy 自体が yodobashi に弾かれる** ケースを完全には救えない可能性が残っている。

理由: yodobashi は **TLS layer での bot detection** (JA3 フィンガープリント / HTTP/2
INTERNAL_ERROR / 即時切断) を使っていると推定される。Node.js の `got` (undici/Node TLS) や
Cloudflare Workers の fetch は TLS フィンガープリントが固定で、ブラウザを偽装できない。

`curl_cffi` (libcurl-impersonate の Python バインディング) は **Chrome / Firefox / Safari
の TLS フィンガープリントを完全再現** できるため、TLS layer bot block を突破できる可能性がある。

## ゴール

1. **Step 1 (実験 / GO/NO-GO 判定)**: `tools/curl-cffi-fetcher/` に CLI ツールを置き、
   yodobashi で 200 + HTML が取れるか確認する
2. **Step 2 (統合)**: GO ならば summaly の Node.js 側から spawn-per-request で呼び出す
   ブリッジを作り、yodobashi プラグインから利用する
3. **Step 3 (運用整備)**: production 環境への uv 配備手順、daemon 化検討、
   許可ドメイン制御

## 完了状況

### Step 1 — 実験 (完了 2026-05-06)

- [x] `tools/curl-cffi-fetcher/pyproject.toml` (curl-cffi>=0.7,<1.0)
- [x] `tools/curl-cffi-fetcher/src/curl_cffi_fetcher/fetch.py` — CLI スクリプト
  - argparse で URL / `--impersonate` / `--timeout` / `--max-bytes` を受け取る
  - `curl_cffi.requests.get(impersonate='chrome120')` で取得
  - stdout に `{status, final_url, content_type, headers, body}` JSON を出力
  - エラーは `{error, category}` で `category: timeout|network|tls|setup|content_too_large|other`
- [x] `tools/curl-cffi-fetcher/README.md` (実験手順 / 撤退条件 / 運用注意)
- [x] yodobashi で **GO 判定確定 (2026-05-06)**:
  - `https://www.yodobashi.com/product/100000001003176109/` で `status: 200`、`text/html;charset=UTF-8`、body 約 300 KB
  - OGP 完全取得確認: `og:title` / `og:description` / `og:image` / `og:url` / `og:site_name`
  - 既存実装 (got + 単純 UA リトライ) では HTTP/2 INTERNAL_ERROR で取得不能だったケース

### Step 2 — Node.js IPC 統合 (完了 2026-05-06)

- [x] `src/utils/curl-cffi-fetch.ts` — `child_process.spawn` で CLI を呼び出し、
  `Got.Response<string>` 互換オブジェクトを返すブリッジ
  - `uvPath` (デフォルト `'uv'`) と `projectDir` (絶対 or cwd 相対) を config 経由で受ける
  - `uv run fetch <url>` を spawn (shell: false で injection 不可能)
  - stdout JSON をパース → `Got.Response<string>` 形に整形 (rawBody / headers / statusCode / url)
  - timeout は `--timeout` (CLI 側) + spawn timer (`timeoutMs`) の二重防御
  - `--max-bytes` は呼出側 `contentLengthLimit` をそのまま伝播
  - 子プロセス timeout で SIGKILL 強制終了
- [x] `getResponseWithCurlCffiFallback` を 4 段目として追加
  - `getResponseWithProxyFallback` の **try ブロック後** に curl_cffi gating を実装
  - 発火条件 3 重 gating: `enabled === true` + categories 一致 + domains 一致 + `https:` プロトコル
  - `scpaping()` から動的 import で呼ぶ (循環参照回避、proxy fallback と同じパターン)
- [x] config TOML `[scraping.curl_cffi]` セクション (`bin/config-loader.ts`)
  - `enabled = false` がデフォルトでオプトイン制御
  - `projectDir` / `domains` 必須、空配列禁止 (allowlist 必須)
  - `categories` の typo 検証 (`VALID_ERROR_CATEGORIES` セット)
  - `uvPath` / `impersonate` / `timeoutMs` は省略可
- [x] yodobashi プラグイン: `curlCffiFallback` を opts 透過で受け流す
  (デフォルトの 4 段カスケードに乗るため、プラグイン側で個別に呼ぶ必要なし)
- [x] テスト 13 本: mock CLI (Node.js script with shebang) を tmp dir に置いて spawn 経由テスト
  - 成功 / status >=400 / エラー JSON / type filter / malformed JSON / ENOENT spawn / final URL
  - gating: enabled=false / domains miss / http://非https / config 未指定
- [x] ドキュメント: `docs/Library.md` (`curlCffiFallback` 行追加)、
  `docs/SETUP.md` (curl_cffi セクション、配備手順、セキュリティ)、
  `config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` (両方)、
  CHANGELOG (Step 2 完了エントリ)

### Step 3 — 運用整備 (Step 2 内で対処済み 2026-05-06)

- [x] `docs/SETUP.md` に uv 配備手順を追記 (Step 2 内で完了 — `[scraping.curl_cffi]` セクション + 「Production 環境への配備」サブセクション)
- [x] `docs/deploy-examples/summaly-config.example.toml` に curl_cffi セクション追加 (Step 2 内で完了)
- [x] 許可ドメイン制御 — `domains` allowlist を required + 空配列禁止に実装 (Step 2 内で完了)
- [ ] daemon 化検討 (将来課題): spawn-per-request は起動コスト ~100ms、頻繁に呼ぶならば
  stdin で URL を連続受信する常駐プロセスに移行。**現状の使用頻度 (yodobashi.com 限定 + bot block 救援の 4 段目発火) ではコスト無視で十分**。実利用で qps が上がってからで OK

## 設計判断 / 留意点

### Python / uv を選んだ理由

- `curl_cffi` は libcurl-impersonate の最もメンテされている Python バインディング
- `uv` でプロジェクト隔離 → summaly 本体の pnpm 環境に Python 依存を持ち込まない
- Node.js 側との通信は **stdio JSON で疎結合** (HTTP / Unix socket より単純)

### 撤退条件 (もし Step 2 で詰まったら)

- Node ↔ Python の spawn コストが許容できない (1 リクエスト 500ms 超える等)
- production 環境で `uv` を入れる運用負担が大きすぎる
- curl_cffi の TLS impersonation が yodobashi に検知され始める (vendor の対策が入る)
- 上記いずれも knowhow に記録して `tools/curl-cffi-fetcher/` を残置 (実験記録として)

### npm 公開対象から外す

- `tools/` 配下は `package.json` の `files: ["built", "LICENSE"]` で **publish 対象外**
- 利用者が `npm install summaly` しても Python ツールは降りない
- production server で別途 `cd tools/curl-cffi-fetcher && uv sync` する設計

## 参照

- libcurl-impersonate: https://github.com/lwthiker/curl-impersonate
- curl_cffi: https://github.com/lexiforest/curl_cffi
- 関連: phase12.1 (CF Workers proxy fallback), phase12.4 (yodobashi プラグイン), phase11.9 (UA リトライ)

## サイズ

M〜L (Step 1 + Step 2 完了。Step 3 運用整備のみ残 — production 配備 / daemon 化 / SETUP.md uv 配備手順は Step 2 で実装済みのため Step 3 はオプショナル)
