# Knowhow Index

> 自動生成。`/addf-knowhow-index reindex` で再生成できる。

## Claude Code 設定・運用

| ファイル | 要約 | キーワード |
|---|---|---|
| [ADDF/claude-md-at-mention.md](ADDF/claude-md-at-mention.md) | CLAUDE.md の @FileName メンション展開の仕組みと使い分け | @展開, メンション, クオート, ネスト展開, CLAUDE.md, インライン展開, ファイル参照, ブートシーケンス |
| [ADDF/ignore-file-strategy.md](ADDF/ignore-file-strategy.md) | .gitignore / .claudeignore / .git/info/exclude の役割分けと運用戦略 | .gitignore, .claudeignore, .git/info/exclude, respectGitignore, settings.json, settings.local.json, Glob, Grep, ファイル除外 |

## JavaScript / TypeScript パターン

| ファイル | 要約 | キーワード |
|---|---|---|
| [object-assign-mutable-target.md](object-assign-mutable-target.md) | `Object.assign(constant, override)` がモジュール定数を mutate するアンチパターンと検出・回帰テスト方法 | Object.assign, mutation, スプレッド構文, デフォルトオプション, 定数, 漏れ, 回帰テスト, シャローコピー |
| [typescript-typecheck-setup.md](typescript-typecheck-setup.md) | bundler / test runner が catch しない型エラー (ts(7016) 等) を検出する `pnpm typecheck` セットアップ。src と test で tsconfig を分割 | typecheck, tsc, noImplicitAny, ts(7016), tsconfig.test.json, @types, 型定義欠如, 品質ゲート |

## summaly プラグイン基盤

| ファイル | 要約 | キーワード |
|---|---|---|
| [plugin-infrastructure-patterns.md](plugin-infrastructure-patterns.md) | プラグイン基盤（getJson / name / BROWSER_UA / KNOWN_SHORT_HOSTS）の設計判断と SSRF 防御パターン | プラグイン, getJson, oEmbed, name 一致テスト, BROWSER_UA, 短縮URL, SSRF, dispatcher, maxRedirects, typeFilter |
| [sanitize-and-agent-patterns.md](sanitize-and-agent-patterns.md) | 結果 URL の sanitize（player リセット・data: バイト長制限）、keep-alive デフォルト agent、useRange / allowedPlugins の設計判断 | sanitize-url, javascript: スキーム, data: URI, keep-alive agent, SUMMALY_FAMILY, useRange, allowedPlugins, isExternalAgentSet, player リセット, encoding-japanese, jschardet |

## summaly Fastify モード（キャッシュ・流量制御）

| ファイル | 要約 | キーワード |
|---|---|---|
| [inflight-dedup-pattern.md](inflight-dedup-pattern.md) | in-flight Map で同 URL の並列リクエストを 1 本化。Promise の resolve 値にエラーを埋め込んで finally / non-null-assertion を回避するパターン、LRU set → inFlight delete の順序、X-Cache: HIT-COALESCED のテスト方法 | in-flight dedup, thundering herd, LRU, Promise, CacheEntry, kind union, X-Cache, HIT-COALESCED, Fastify, Misskey ストリーミング, no-non-null-assertion |

## summaly 開発体験（dev サーバ）

| ファイル | 要約 | キーワード |
|---|---|---|
| [dev-server-tsx-pattern.md](dev-server-tsx-pattern.md) | tsx で TS を直接走らせる dev サーバ構築。tsdown の build-time 定数 `_VERSION_` を side-effect import で globalThis に注入する ESM 評価順テクニック、本番 bundle / typecheck / lint への混入防止、HOST/PORT の defensive validation で SSRF リレーを防ぐ、`SUMMALY_ALLOW_PRIVATE_IP` をプロセス内で限定する | tsx, dev サーバ, _VERSION_, globalThis, side-effect import, ESM 評価順序, depth-first, tsconfig.dev.json, @fastify/static, Vanilla JS, SUMMALY_ALLOW_PRIVATE_IP, HOST バリデーション, SSRF リレー |

## summaly 設定（TOML）

| ファイル | 要約 | キーワード |
|---|---|---|
| [toml-config-loader-pattern.md](toml-config-loader-pattern.md) | fastify-cli `--options config.json` から TOML ベースに移行したときの設計。loader を `bin/` 配下に置いて npm 公開 bundle への混入を防ぐ、smol-toml の選定理由、`host=""` の SSRF リレー対策、未知キーを silently 無視する forward-compat 設計、`parseTomlConfigString` を export してファイル I/O 抜きにテスト、`[plugins.<name>]` placeholder の扱い | TOML, smol-toml, config-loader, fastify-cli 廃止, [server], [summaly.cache], [plugins.allowed], [plugins.<name>] placeholder, expectNonNegativeFiniteNumber, host 空文字, SSRF リレー, breaking change, JSON マイグレーション |

## summaly 観測性 / 運用支援

| ファイル | 要約 | キーワード |
|---|---|---|
| [observability-parse-failure-log.md](observability-parse-failure-log.md) | パース失敗ドメインのログ蓄積（プラグイン候補発見器）。throw / thin の 2 系統、絶対失敗類型 (StatusError 4xx/5xx, timeout, type filter, SSRF, ENOTFOUND 等) を `isFilteredFailure` で除外、host + パス先頭 1〜2 セグメントの集約 key、`record()` 同期関数で event loop 上の原子的完了を担保、エンドポイント公開時の nginx ガード必須、data:/file: スキームの placeholder 処理 | parse failure, plugin candidate, thin summary, isFilteredFailure, Akamai 403, ENOTFOUND, sanitizeUrlForLog, /__diagnostics/parse-failures, [diagnostics], LRU 風 Map, fail-fast register, プライバシー, nginx ガード |
