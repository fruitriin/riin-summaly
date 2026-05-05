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
| [plugin-infrastructure-patterns.md](plugin-infrastructure-patterns.md) | プラグイン基盤（getJson / name / BROWSER_UA / KNOWN_SHORT_HOSTS）の設計判断と SSRF 防御パターン。**Cloudflare 配下サイトの公式 JSON API 直叩きパターン**（npmjs プラグインで採用、registry.npmjs.org / 適用判断チェックリスト / scope エンコード `pkg.replace('/', '%2F')` / アイコン陳腐化対策） | プラグイン, getJson, oEmbed, name 一致テスト, BROWSER_UA, 短縮URL, SSRF, dispatcher, maxRedirects, typeFilter, Cloudflare Bot Management, registry.npmjs.org, npmjs, JSON API 直叩き, scope エンコード |
| [bot-block-ua-retry.md](bot-block-ua-retry.md) | Bot block 対策の複合 UA + フォールバック UA リトライ (phase11.9)。`SummalyBot` 文字列で WAF 弾く WAF（playing-games.com 等）への救援、`socket hang up` シグニチャと `connection_dropped` カテゴリ、`facebookexternalhit/1.1` を default fallback UA に採用した倫理判断、IP block (rawchili 系) は射程外、`followRedirects: false` を使うテスト戦略 | bot block, WAF, socket hang up, connection_dropped, facebookexternalhit, fallback UA, getResponseWithFallback, Mozilla プレフィックス複合 UA, ECONNRESET 再分類, IP block 射程外 |
| [cf-workers-outbound-proxy.md](cf-workers-outbound-proxy.md) | Cloudflare Workers Free を outbound proxy として使うパターン (phase12.1)。Vultr Tokyo IP からの amazon.co.jp 500 を AS13335 経由で救援、HMAC-SHA256 (Web Crypto ↔ Node std crypto 相互運用)、redirect 後の allowlist 再検証 (Critical 修正)、suffix-match 境界文字 `'.'`、定数時間比較の length 均一化、動的 import で循環参照回避、`Got.Response<string>` 形式への透過プロキシ整形、SUMMALY_PROXY_SECRET 環境変数優先、Free プラン 100k req/day 上限 + 超過時 429 のみで金額課金なし | CF Workers, outbound proxy, IP レピュテーション, AS13335, HMAC-SHA256, Web Crypto, redirect 再検証, suffix-match, 定数時間比較, 動的 import 循環回避, SUMMALY_PROXY_SECRET, Free プラン, 100k req/day, open proxy 防止 8 層 |
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
| [observability-parse-failure-log.md](observability-parse-failure-log.md) | パース失敗ドメインのログ蓄積（プラグイン候補発見器）。throw / thin の 2 系統、絶対失敗類型 (StatusError 4xx/5xx, timeout, type filter, SSRF, ENOTFOUND 等) を `isFilteredFailure` で除外、host + パス先頭 1〜2 セグメントの集約 key、`record()` 同期関数で event loop 上の原子的完了を担保、data:/file: スキームの placeholder 処理。**phase11.5 で HTTP エンドポイント廃止 → JSONL ファイル + `cat \| jq` 経由のみに変更**（プライバシーリスクの構造的撤去） | parse failure, plugin candidate, thin summary, isFilteredFailure, Akamai 403, ENOTFOUND, sanitizeUrlForLog, [diagnostics], LRU 風 Map, JSONL, ファイル経由レビュー, プライバシー |
| [fastify-plugin-error-logging.md](fastify-plugin-error-logging.md) | Fastify プラグイン内で try/catch して return している非 throw エラーは `setErrorHandler` に飛ばないため、`req.log` を catch ブロックで明示的に呼ぶ必要がある落とし穴。pino の `{ err }` セリアライザで自動構造化、URL は sanitizeUrlForLog で PII 除去、ログレベル 3 段 (info/warn/error) を category 由来で派生、cache HIT 再ログなし spam 抑制、mock pino のテスト実装 | req.log, setErrorHandler, pino, err シリアライザ, chooseLogLevel, sanitizeUrlForLog, journalctl --priority=warning, loggerInstance mock, cache HIT 再ログなし, セーフティネット |
| [outbound-ip-reputation.md](outbound-ip-reputation.md) | 「ローカルで再現しないが本番で再現する」型のスクレイピング失敗の典型パターン。Vultr Tokyo IP からの amazon.co.jp が一貫して 500 になる事例で、Amazon の **UA × IP 複合判定**（住宅 IP からは `SummalyBot` 通すが `facebookexternalhit` は 500、Vultr IP からはどの UA でも 500）を実証。IP レピュテーション差を疑う検証手順（whois → 本番直叩き → UA × IP マトリクス → Node バージョン）と、phase11.9 の UA レイヤでは救えない射程外案件としての整理。対処選択肢（outbound proxy / 公式 API / OGP-as-a-service / 諦める / AWS 移行）と個人運用の推奨判断 | outbound IP, IP レピュテーション, Vultr, datacenter IP, UA × IP 複合判定, 本番再現 ローカル非再現, JA3 fingerprint, residential proxy, Amazon PA-API, OGP-as-a-service, ifconfig.me, whois |
