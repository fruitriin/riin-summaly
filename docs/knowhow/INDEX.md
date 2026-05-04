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
