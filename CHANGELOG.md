(unreleased)
------------------
* **docs**: phase13.1 Step 4 (テスト) + Step 6 (docs) + Step 7 (knowhow) を完了。`docs/Library.md` に `embedBaseUrl` / `embedConfig` 行追加、`docs/Plugins.md` に `syosetu` セクション + `renderEmbed` interface 説明追加、`docs/SETUP.md` に `/embed` エンドポイント節 (8 層 defense-in-depth + Misskey 側挙動 + library/Fastify 分離) 新設、`README.md` プラグイン一覧に `syosetu` + `sqex` 行追加、`CLAUDE.repo.md` 対応形式表に syosetu 行追加、`docs/knowhow/embed-endpoint-design.md` を新設 (XSS / CSP 設計の汎用化、他プラグイン拡張時の踏み台)。Step 4 テストは pure 関数 (`composeEmbedHtml` / `buildSummaryFromApi` / etc) を 32 ケース網羅 + escape-html / embed エンドポイント基盤 / config-loader 計 31 ケースで実質的に網羅、`summarize` / `renderEmbed` のフルフロー (実 API 経由) は外部 mock infra が現リポに無いため Step 5 dev 手動検証で代替判断。phase13.1 は Step 5 dev 手動 (UI 検証必要のため自動化対象外) のみ残
* **feat**: 小説家になろうプラグインを追加 (phase13.1 Step 3)。`ncode.syosetu.com` (一般) / `novel18.syosetu.com` (R-18 ノクターン・ムーンライト) の作品 URL を識別し、なろう公式 API (`api.syosetu.com/{novelapi|novel18api}/api/`) を直叩きして作品メタを取得。**card style description**: 作者 / ジャンル / 連載中・完結 / R-15・残酷描写・BL・GL マーカー / あらすじ抜粋 (80 文字 clip) を 1 行に整形。**embed (`renderEmbed`)**: `/embed?url=...` で iframe 用の完全な HTML5 ドキュメントを返す (タイトル / 作者 / ジャンル + 状態 / マーカー / タグ上位 5 件 / あらすじ 300 文字 clip)。**XSS 全エスケープ**: composeEmbedHtml で全フィールドを `escapeHtml` 経由で entity 化、CSP `default-src 'none'` + `<script>` sanity check (Step 1 で実装) と二重防御。chapter URL (`/<ncode>/<chapter>/`) は作品レベルの ncode に集約。R-18 ドメインで `sensitive: true` + sitename 切替 (`ノクターンノベルズ / ムーンライトノベルズ`)。ジャンル ID マッピング (`src/utils/syosetu-genres.ts`) で大ジャンル + ジャンル ID → 表示名を変換、未知 ID は 'その他' フォールバック。テスト 32 件追加 (test() URL マッチ + 別パス除外 + ncode 正規表現精度 / pure 関数群 / XSS 攻撃 3 ケース)。**注**: phase13.1 Step 3 では library mode で `summarize()` の player.url=null 固定 (`embedBaseUrl` を `GeneralScrapingOptions` 経由で受け取れない型制約のため、Fastify モード player.url 組み立ては次フェーズの内部 opts 拡張で対応予定)
* **feat**: `/embed` エンドポイント基盤を Fastify モードに新設 (phase13.1 Step 1+2)。プレイヤー iframe として読まれる JS なし HTML+CSS を返す機構の土台を実装。`renderEmbed?: (url, opts) => Promise<EmbedRenderResult>` を `SummalyPlugin` interface に追加 — プラグインが本フィールドを実装すると `/embed?url=<URL>` で当該 HTML が返るようになる。`src/utils/escape-html.ts` に `escapeHtml(s)` / `escapeAttr(s)` の純関数を新 export (5 文字 `& < > " '` を entity 化)。`/embed` ルートは URL https-only 検証 + builtinPlugins から `test() && renderEmbed != null && allowedPlugins.includes(name)` の最初を採用 + 未知クエリ無視 (Misskey transformPlayerUrl 対応) + CSP `default-src 'none'` + `style-src 'unsafe-inline'` + `img-src https:` + `frame-ancestors <config>` ヘッダ + 512KB body cap + `<script>` sanity check (defense-in-depth)。エラー経路は plain text 400 / 404 / 500 (HTML 返さない)。`SummalyOptions` に `embedBaseUrl?: string` (Fastify モードで自身が公開されている URL ベース) と `embedConfig?: { enabled, allowedPlugins, frameAncestors }` を追加。TOML `[server].publicUrl` (https only 検証) + `[embed]` セクション (allowedPlugins 空配列禁止 fail-close、frameAncestors の各要素は `*` / `'self'` / `'none'` / origin-only URL のみ許容、CSP インジェクション防御)。テスト 22 件追加。**注**: 本コミットは embed 基盤のみ。renderEmbed を実装したプラグインはまだ無いため `/embed` を叩いても 404 になる。Step 3 (syosetu プラグイン本体) 以降で実機動作。`config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` の **両方** に `[embed]` セクションのコメント例を追加
* **breaking (internal)**: `GeneralScrapingOptions` から `forceCurlCffiFallback` / `forceProxyFallback` フラグを廃止 (phase14 Step 4)。phase12.5 followup #3 で導入した「1〜3段目スキップして curl_cffi 直行」と phase12.6 で導入した「1〜2段目スキップして proxy 直行」の特殊経路強制フラグを削除。代替経路は phase14 Step 3 で同梱した `data/domain-strategy-bootstrap.jsonl` の bootstrap エントリ (yodobashi.com → curl_cffi、store.jp.square-enix.com → proxy) で `scpaping()` 冒頭の cache hit fast path から各 strategy が直接呼ばれる経路に統合。`src/utils/got.ts` の `fetchResponse` から forceX 分岐を削除、`src/general.ts` の `GeneralScrapingOptions` フィールド削除、`src/plugins/yodobashi.ts` / `src/plugins/sqex.ts` から各 forceX フラグ宣言削除。テスト 8 件 (forceCurlCffiFallback / forceProxyFallback describe 群) 削除。**library 利用者への影響**: `GeneralScrapingOptions` は内部型 (`SummalyOptions` には含まれていない) なので公開 API への影響無し。カスタムプラグインで `forceX` フラグを使っていた場合は bootstrap entry に置き換える必要あり (詳細は `data/README.md` 参照)
* **feat**: 経路学習キャッシュの bootstrap データを npm パッケージに同梱 (phase14 Step 3)。`data/domain-strategy-bootstrap.jsonl` を新設し、yodobashi (TLS 切断) → `curl_cffi`、Square Enix e-STORE (IP block) → `proxy`、Amazon `co.jp/dp` `co.jp/gp` `com/dp` (Vultr Tokyo IP block) → `proxy` の 9 エントリを bundle。`package.json` `files` に `data/` を追加して publish 対象化、`src/utils/domain-strategy-cache.ts` に新 export `getDefaultBootstrapPath()` を追加し、`import.meta.url` を起点に bundled (`built/index.js → ../data/...`) と source dev (`src/utils/X.ts → ../../data/...`) の 2 候補を `statSync` で probe してパス自動解決。Fastify auto-init は `bootstrapPath ?? getDefaultBootstrapPath()` で `[scraping.strategy_cache]` の `bootstrapPath` 未指定時に同梱を自動ロード。**運用上の効果**: 新規環境で summaly を `npm install` した時点で yodobashi / sqex / amazon が「初日から正しい経路で動く」(初回 20 秒空回りを回避)、bootstrap 同梱が phase14 Step 4 (`forceX` フラグ廃止) のブロッカーを解消。詳細は `data/README.md` 参照
* **feat**: Fastify モードで経路学習キャッシュを自動インスタンス化 (phase14 Step 2b-4)。`src/index.ts` の Fastify plugin setup で `options.domainStrategyCache?.enabled === true` のとき `DomainStrategyCache` インスタンスを作成して `setActiveCache(cache)` で登録する。`scpaping()` は singleton 経由で取得して lookup する。`bootstrapPath` / `runtimePath` も全て透過渡し。これで Fastify モードでは `[scraping.strategy_cache]` TOML を書くだけで cache が有効化される (`config.example.toml` の例参照)。テスト 4 件追加 (auto-init / 未指定 / enabled=false / 全オプション伝搬)。**設計**: モジュールレベル singleton (既存 `setAgent` パターン踏襲) で 1 プロセス 1 Fastify 想定、Fastify close 時の cleanup なし
* **feat**: 経路学習キャッシュの記録判定を Summary レイヤに集約 (phase14 Step 2b 後半)。`src/utils/got.ts` の `fetchResponse` から `cache.recordSuccess` / `recordFailure` の直接呼出を全削除し、`opts._cacheRecording` (mutable side-channel、`CacheRecordingState` 型) に context (recordKey / strategy / gateFailedNeutral) を埋める形に refactor。`src/index.ts` の `summaly()` トップレベルで try/catch wrapping + `isThinSummary` 判定に基づき一括して `recordCacheSuccess` / `recordCacheFailure` を呼ぶ。**修正された構造的バグ**: HTTP 200 + Summary thin の振動 (yodobashi/sqex 等の bot-block 200 + 正規 404 ページボディ パターン) で、HTTP 層 recordSuccess → Summary 層 recordFailure → HTTP 層 recordSuccess... の繰り返しで連続失敗カウンタが閾値に達せず invalidate が機能しない問題があった。Summary 層に集約することで bot-block 200+thin パターンも N 回連続で確実に entry 破棄される。テスト 3 件追加 (Summary thin → recordFailure / 連続 thin で閾値到達 invalidate / HTTP throw → recordFailure)。**注**: Fastify モードでの cache 自動インスタンス化は Step 2b-4 (次サイクル) で実装
* **feat**: 経路学習キャッシュの cache miss 経路で cascade tracking + recordSuccess を実装 (phase14 Step 2b 前半)。`src/utils/got.ts` に新 export `StrategyTracker = { value?: DomainStrategy }` を追加。`getResponseWithFallback` / `getResponseWithProxyFallback` / `getResponseWithCurlCffiFallback` に optional `tracker` 引数を追加し、各段成功時に `tracker.value` を該当 strategy にセット。`scpaping()` の `fetchResponse` で cache miss 時に tracker 経由で cascade success の strategy を捕捉、状況別に pathKey を選定して `recordSuccess` 呼出: cache hit が throw で失敗 → `hit.hitKey` 上書き、cache miss → 1-seg pathKey (host のみ URL は host)、cache hit gate-fail → record せず (entry を「config 復帰時の再利用候補」として温存、neutrality 維持)。**設計選択**: tracker は mutable side-channel パターンで既存シグネチャを変えず後方互換性を維持。`fetchResponse` の関数スコープ内で都度作成するので並行リクエスト混線無し。**注**: 本コミットは Step 2b 前半。Summary レイヤでの thin 判定 → recordFailure (cache miss + cascade 失敗で何も記録されない問題の解決) と、Fastify モードでの cache 自動インスタンス化は Step 2b 後半 (次サイクル) で実装。テスト 4 件追加 + Step 2a の 1 件を Step 2b 仕様に更新
* **feat**: 経路学習キャッシュを `scpaping()` に統合 (phase14 Step 2a、cache hit fast path のみ)。`src/utils/domain-strategy-cache.ts` にモジュールレベル singleton (`setActiveCache` / `getActiveCache`、`got.ts` の `agent` と同じパターン) を追加し、`scpaping()` の冒頭で cache lookup → ヒット時は該当 strategy で direct invoke (cascade を完全スキップ)。`'default'` / `'fallback_ua'` は `getResponse` (UA 切替のみ、リトライなし)、`'proxy'` は `viaProxyWorker` 直接、`'curl_cffi'` は `viaCurlCffi` 直接。**ゲート不通過** (config 無効 / allowlist 不一致 / `https:` プロトコル不一致) は `null` を返して通常カスケードに fallthrough し中立扱い (recordFailure 呼ばない)。**fast path 失敗** は `recordFailure` (連続失敗カウント増、N 回到達でエントリ破棄) + cascade fallthrough。**注**: cache miss 時の cascade tracking + recordSuccess、Summary レイヤでの thin 判定 → recordFailure、Fastify モードでの cache 自動インスタンス化は phase14 Step 2b (次サイクル) で実装。テスト 7 ケース追加。`forceCurlCffiFallback` / `forceProxyFallback` 経路は cache 経路より優先で挙動変化なし
* **feat**: 経路学習キャッシュのストレージ層を追加 (phase14 Step 1)。`src/utils/domain-strategy-cache.ts` を新設し、ドメイン (host + path prefix 1〜2 段) ごとに「成功した取得経路」(`default` / `fallback_ua` / `proxy` / `curl_cffi`) を学習・JSONL 永続化するクラス `DomainStrategyCache` を実装。`lookup(url)` は specific → general 順で探索し最初にヒットしたエントリを返す。`recordSuccess(pathKey, strategy)` / `recordFailure(pathKey)` で学習更新。bootstrap JSONL (リポ同梱) を起動時に 1 回ロード後、runtime JSONL (環境ローカル) で上書き。`fs.appendFileSync` で 1 行ずつ追記し、累積行数が `compactionThreshold` を超えたら `setImmediate` 経由で全件書き換え (compaction)。N 連続失敗 (デフォルト 3) で破棄。TOML `[scraping.strategy_cache]` で設定可能 (`enabled` / `bootstrapPath` / `runtimePath` / `maxEntries` / `consecutiveFailureThreshold` / `compactionThreshold`)、`SummalyOptions.domainStrategyCache` にマップ。**注**: 本コミットは Step 1 (ストレージ層 + TOML 設定) のみで、`scpaping()` への統合と `forceX` フラグ廃止は Step 2〜4 で実施するため現時点では設定しても挙動は変わらない (将来互換)
* **feat**: sqex プラグインを追加 + `GeneralScrapingOptions.forceProxyFallback` を新設 (phase12.6)。Square Enix e-STORE (`store.jp.square-enix.com`) はデータセンター IP レンジ全般を CDN 段で広く弾くため、Vultr Tokyo IP から直叩きすると **HTTP/200 + `text/html;charset=utf-8` + 正規 404 ページボディ** が返る (= got レイヤではエラーが何も発生せず、phase12.1 の `getResponseWithProxyFallback` のエラー発火型では救援できない新パターン、skill `/url-preview-check` Phase 3 の fail mode 拡張)。`forceProxyFallback: true` で **1〜2段目 (default UA / fallback UA) をスキップして CF Workers proxy 直行**。`forceCurlCffiFallback` と並列構造で defense-in-depth (domains allowlist + `https:` プロトコル) は維持。短縮 URL `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決可能なので resolveRedirect 段に任せ、プラグインは `skipRedirectResolution` を宣言しない。`[scraping.proxy].domains` と Worker `wrangler.toml` の `ALLOWED_DOMAINS` の両方に `store.jp.square-enix.com` を追加 + Worker 再 deploy が運用要件
* **perf**: `GeneralScrapingOptions.forceCurlCffiFallback` を追加し yodobashi で有効化 (phase12.5 followup #3)。phase12.5 followup #2 で resolveRedirect HEAD probe をスキップしても本番が依然 ~20 秒のままだった原因が「**1段目 scpaping (default UA) が Vultr Tokyo IP からの yodobashi リクエストで `Timeout awaiting 'socket'` (20秒) で空回り**」だったことを特定。`forceCurlCffiFallback: true` を渡すと、1〜3段目 (default UA / fallback UA / CF Worker proxy) を **すべてスキップして curl_cffi を最初から呼ぶ**。defense-in-depth で domains / `https:` の二重防御は維持。yodobashi では「resolveRedirect スキップ + 1〜3段目スキップ + proxy 強制 undefined」の **3 重スキップで無駄リクエストをゼロ化**。本番実測 21 秒 → ~3 秒に短縮見込み
* **perf**: プラグインに `skipRedirectResolution` フラグを追加し yodobashi で有効化 (phase12.5 followup #2)。本番 21 秒の根本原因が「`summaly()` 冒頭の `resolveRedirect` HEAD probe が yodobashi の TLS 切断で 20 秒 timeout 待ち」だったことを特定。プラグインが `skipRedirectResolution = true` を宣言すると、初期 URL がそのプラグインの `test()` にマッチした場合に限り `resolveRedirect` (HEAD/GET probe) を完全スキップする。yodobashi のように **TLS layer で bot 切断 + URL が終端確定** (短縮 URL でない) なサイトに適用。所要時間 21 秒 → 数秒に短縮見込み。短縮 URL を扱うプラグイン (`amazon` の `amzn.asia` / `branchio-deeplinks` 等) は宣言しないこと (resolveRedirect が必須)
* **perf**: yodobashi プラグインで proxy fallback 段を強制スキップ (phase12.5 followup)。本番実証で yodobashi のプレビュー取得が ~21 秒かかっていた原因が「CF Workers proxy 段が ~15-20 秒空回りしてから失敗」だったため、yodobashi では `proxyFallback: undefined` で proxy 段をスキップして curl_cffi に直行する設計に変更。CF Workers fetch も TLS フィンガープリント固定なので yodobashi に対しては構造的に救えない (本来 curl_cffi の libcurl-impersonate が唯一の正解経路)。所要時間 ~3-4 秒に短縮見込み
* **feat**: curl_cffi (TLS layer bot block) フォールバックを Node.js 側に統合 (phase12.5 Step 2)。`src/utils/curl-cffi-fetch.ts` で `child_process.spawn` 経由の透過プロキシブリッジを実装。`SummalyOptions.curlCffiFallback` (or Fastify モードでは `[scraping.curl_cffi]` TOML セクション) で有効化すると、4 段目フォールバック (default UA → fallback UA → CF Worker proxy → curl_cffi) として発火する。`enabled = false` がデフォルトでオプトイン制御。発火条件は `categories` (デフォルト `['timeout', 'connection_dropped', 'bot_blocked']`) + `domains` (suffix-match allowlist 必須) + `https:` プロトコル必須の 3 重 gating。production server 上で `uv sync` 必須。詳細は [docs/SETUP.md](docs/SETUP.md) の curl_cffi セクション参照
* **experimental**: TLS layer bot block 救援用に `tools/curl-cffi-fetcher/` (Python CLI) を追加 (phase12.5 Step 1)。`curl_cffi` (libcurl-impersonate バインディング) で Chrome 120 の TLS フィンガープリント (JA3) と HTTP/2 settings を完全再現し、`got` / Node TLS / CF Workers fetch では弾かれる yodobashi 級の bot block (HTTP/2 INTERNAL_ERROR / 即時切断) を突破できる。**2026-05-06 GO 判定確定** — `https://www.yodobashi.com/product/100000001003176109/` で status 200 + OGP (og:title / og:description / og:image / og:url / og:site_name) 完全取得を確認。本ツールは `package.json` `files` 対象外で **npm publish に含まれない** (production 環境では別途 `cd tools/curl-cffi-fetcher && uv sync` が必要)。Step 2 (Node.js IPC ブリッジ + yodobashi プラグイン統合) は次サイクル
* **feat**: yodobashi プラグインを追加 (phase12.4)。`yodobashi.com` は TLS / HTTP/2 レイヤで bot を能動切断する厳しい WAF を持っており SummalyBot / ブラウザ / SNS bot UA すべてで弾かれる (skill `/url-preview-check` Phase 3 fail mode H)。OGP は整備されているので **proxy fallback の categories を `timeout` / `connection_dropped` も含めるよう拡張**して CF Workers の egress IP / TLS フィンガープリント経由で救援を試みる新パターン。Worker `wrangler.toml` の `ALLOWED_DOMAINS` と summaly `[scraping.proxy].domains` 両側に `yodobashi.com` 追加 + Worker 再 deploy が運用要件
* **feat**: nintendo-store プラグインを追加 (phase12.3)。`store-jp.nintendo.com` 等の My Nintendo Store は Akamai Bot Manager の JS challenge 配下で SummalyBot / ブラウザ UA / Twitterbot / Discordbot だと challenge ページにリダイレクトされるが、`facebookexternalhit/1.1` UA は allowlist されている事実を利用。プラグイン内で UA を固定して `scpaping()` → `parseGeneral()` に流すことで OGP (`og:title` / `og:image` / `og:description` / `og:site_name="My Nintendo Store..."`) が取得できる。skill `/url-preview-check` の Phase 3 fail mode G 「Akamai Bot Manager」のうち SNS bot UA allowlist がある場合の対処パターン
* **fix**: youtube プラグインがライブ配信 URL (`/live/<id>`) にマッチしない問題を修正 (phase12.2)。`PATH_PATTERNS` に `/live/` を追加して oEmbed エンドポイント経由で取得できるようにした。実例: `youtube.com/live/YVjfasn756M` でタイトル / サムネ / iframe player が取れる
* **feat**: Outbound proxy フォールバック (Cloudflare Workers) を追加 (phase12.1):
  * Vultr Tokyo IP からの amazon.co.jp が IP レピュテーション層で 500 を返す問題を救援
  * 3 段リトライ: ① デフォルト UA → ② UA fallback (phase11.9) → ③ **Worker proxy 経由** (新規)
  * `[scraping.proxy]` TOML セクションでオプトイン制御。`secret` は環境変数 `SUMMALY_PROXY_SECRET` 経由を推奨
  * 発火条件: `categories` に含まれるエラーカテゴリ + `domains` allowlist (suffix-match) 一致のみ
  * Worker は `tools/cf-proxy-worker/` にデプロイ。HMAC-SHA256 + タイムスタンプ ±5 分窓 + URL allowlist + HTTPS 限定 + 受信 Body cap (5 MiB) + 透過プロキシ
  * **実証データ**: `https://www.amazon.co.jp/dp/B0C4LRBFX6` を CF Workers 経由で取得 → HTTP 200 / 2.6 MB / 1.81 秒（Vultr 直叩きの 500 と比較してクリアな勝利）
  * Worker は CF Free プラン (100,000 req/day, 10ms CPU/req) で動作。超過しても 429 が返るだけで金額課金は発生しない
  * セキュリティ防衛 8 層 (HTTPS only / HMAC / タイムスタンプ窓 / Worker 側 allowlist / summaly 側 allowlist / 受信 cap / 定数時間比較 / 403 で詳細を返さない)
  * **dev サーバ統合**: `pnpm dev` で `SUMMALY_PROXY_URL` + `SUMMALY_PROXY_SECRET` 環境変数を渡すと UI の checkbox から per-request 切替できる。サンプル URL 「Amazon JP (proxy 経由)」をクリックで `presets.proxy: true` を自動適用。`/api/dev-config` で env 状態を返すが secret は決して露出しない (proxyHost のみ)
  * **E2E 検証成功 (2026-05-05)**: 本番 Worker (`summaly.riinsworkspace.workers.dev`) に対して `node tools/cf-proxy-worker/sign.mjs https://www.amazon.co.jp/dp/B0C4LRBFX6 $WORKER_URL` で透過プロキシ動作確認
  * **followup #1 (2026-05-06)**: Amazon が Vultr Tokyo IP に対して `200 + content-type 欠落` で malformed response を返す bot block 新パターンを発見。`Rejected by type filter undefined` エラーを `unsupported_type` から `bot_blocked` に再分類して proxy fallback で救援できるようにした。proxy categories のデフォルトも `['origin_error']` から `['origin_error', 'bot_blocked']` に変更
  * **followup #2 (2026-05-06)**: 長い query 付き Amazon URL (`/<slug>/dp/<asin>?_encoding=UTF8&pd_rd_w=...&ref_=...`) は CF Workers proxy 経由でも Amazon が 500 を返すケースを発見。`amazon` プラグインに `normalizeAmazonUrl` を追加し、`/dp/<asin>` の canonical 形に正規化（query / fragment / SEO slug を全部削る）してから取得するように変更。referral tracking の query は商品ページの内容に影響しないため副作用なし。**`SummalyResult.url` は変更前と同じ解決済み URL のまま**（正規化は scpaping への送信 URL のみに適用、resolveRedirect の出力には影響しない）
  * **followup #3 (2026-05-06)**: `amazon.co.jp/dp/...` (bare hostname) の URL が amazon プラグインの `test()` でマッチせず general パスに流れて URL 正規化を経由していなかった問題を修正。`test()` を `^(?:www\.)?amazon\.<TLD>$` の anchored 正規表現にして bare / www 両形式をマッチさせる。`normalizeAmazonUrl` も hostname を `www.` 付きの canonical 形に揃えるようにし、Amazon が 301 でリダイレクトする挙動を summaly 側で先回りして潰す。`aws.amazon.com` 等のサブドメインは引き続きマッチしない（テストで担保）
  * **followup #5 (2026-05-06)**: Prime Video URL (`/gp/video/detail/<asin>`) で `title: null` になる問題を修正。Prime Video 専用 HTML は `#title` 要素は存在するが text() が空 (JS で動的に埋まる) かつ og:title も空のため、title 抽出 fallback に `<title>` HTML タグ + `twitter:title` を追加。優先順位は `#title` → `og:title` → `twitter:title` → `<title>` → `''`
  * **followup #4 (2026-05-06)**: `amzn.asia/d/<id>` 等の Amazon 短縮 URL が summaly 本番で薄い preview HTML (og:title="Amazon" / og:image=previewdoh.png) しか取れない問題を修正。原因は Vultr Tokyo IP からの `amzn.asia` GET に Amazon が 301 リダイレクトを返さず 200 + preview HTML を返すため、`resolveRedirect` が `www.amazon.co.jp` に解決できず amazon プラグインへも到達しなかった。修正:
    - `amazon.test()` に `amzn.asia` / `amzn.to` / `a.co` を追加してマッチ可能に
    - `summarize()` に 2 段取得: 短縮 URL は一度 scpaping → final URL から ASIN 抽出 → canonical 形で再 scpaping。final URL も短縮ドメインのままなら preview HTML をそのままパース
    - `parseAmazonHtml` を別関数に切り出し、`#title` / `#productDescription` / `#landingImage` が無い preview HTML でも og:title / og:description / og:image を fallback で見るように補強
    - proxy allowlist に `amzn.asia` / `amzn.to` / `a.co` を追加（Worker と summaly 両側、両方のデプロイ反映が必要）
* **feat**: 迂回候補ログ（ブロック失敗の別系統 JSONL）を追加 (phase11.6):
  * `parseFailureLogBlockedJsonlPath` / `parseFailureLogBlockedJsonlMaxBytes` を追加。`isFilteredFailure` 対象（4xx/5xx, timeout, SSRF block, type filter, network, connection_dropped）の失敗を別ファイルに集約
  * 既存 `parseFailureLogJsonlPath`（プラグイン候補）には引き続き thin + 非フィルタ throw のみ書かれ、シグナル純度を維持
  * 各行に `category` (`SummalyErrorCategory`) と `errorName` を付与。`cat blocked.jsonl | jq -c 'select(.category == "bot_blocked") | .url' | sort -u` で「公開 HTML はブロックだが別 API で同等情報が取れる」迂回候補（npm の registry.npmjs.org が好例）を発見
  * 迂回候補は **in-memory 集約しない**（流量過大によるメモリ消費を避けるため、JSONL 専用）
  * サイズ cap は両系統で独立に効く（流量差を吸収）
  * `ParseFailureLog.record()` に `errorName` / `statusCode` 引数を追加（optional、互換性維持）。内部で `categorizeError` を呼んで振り分け
  * TOML: `[diagnostics]` セクションに `parseFailureLogBlockedJsonlPath` / `parseFailureLogBlockedJsonlMaxBytes` を追加
  * **プライバシー**: blocked ログには失敗 URL の origin+pathname が記録されるため、ファイルパーミッション 600 推奨（plugin-candidate ログと同じ扱い）
* **enhance**: 汎用パスで OG 画像が無い場合 favicon を thumbnail に採用 (phase11.7, [riin-summaly#3](https://github.com/fruitriin/riin-summaly/issues/3)):
  * `parseGeneral` の thumbnail 解決を `og:image` → `twitter:image` → `image_src` → `apple-touch-icon` → **`favicon` (新規)** の順に拡張
  * 「タイトルだけのスカスカプレビュー」が「サイトアイコン入りの最低限の見た目」に格上げされる
  * favicon は `getIcon()` で HEAD 検証済みの URL のみ採用するため、リンク切れや `data:` URI のケースは安全にフォールバックしない（既存挙動維持）
  * `isThinSummary` を補正: `thumbnail === icon` のとき thin 候補として継続判定する。プラグイン化候補のシグナル品質は phase10.1 と同等を維持
* **feat**: Bot block 対策のフォールバック UA リトライを追加 (phase11.9):
  * `SummalyBot` 文字列を WAF が検知して TCP/TLS 確立後に HTTP 応答前で切断する（`socket hang up`）サイトに対する救援機構。`config.toml` の `[scraping.fallback]` でデフォルト ON
  * 1 回目失敗 + `categorizeError` 結果がリトライ対象カテゴリ（デフォルト `bot_blocked` / `connection_dropped`）なら、UA を `facebookexternalhit/1.1` 等に差し替えて 1 回だけ再試行
  * 実証データ: `playing-games.com` / `wacoca.com` のように WAF が `SummalyBot` 文字列で弾くサイト 2/3 を救援できる（残り 1/3 は IP block で射程外）
  * 倫理的配慮: フォールバック UA は `[scraping.fallback].userAgent` で差し替え可能。`facebookexternalhit/1.1` をデフォルトにしたのは、share link を公開するサイトの多くが OGP 取得用途として明示的に許可しているため
  * 副作用: bot block されるサイトは worst case リクエスト数が 1 → 2 に増える。LRU キャッシュ HIT で 2 度目以降は 0 リクエスト、in-flight dedup により並列でも先頭の 1 ユーザーだけが 2 リクエスト払う
  * ライブラリ利用者向け: `summaly()` の `opts.fallbackUserAgent` / `opts.fallbackRetryCategories` で同等のリトライを指定可能
* **enhance**: デフォルト UA を Mozilla プレフィックス付きの複合 UA に変更 (phase11.9):
  * 旧: `SummalyBot/<version>`
  * 新: `Mozilla/5.0 (compatible; SummalyBot/<version>; +https://github.com/fruitriin/riin-summaly)`
  * 自己同定（`SummalyBot/<version>` + URL）は維持。「Mozilla プレフィックス必須」タイプの WAF を底上げで通すための変更
  * 自己説明 URL は riin-summaly fork のリポジトリを指す
* **enhance**: `categorizeError` に `connection_dropped` カテゴリを追加 (phase11.9):
  * 「TCP/TLS は通ったが HTTP 応答を返さず切断」シグニチャ（`socket hang up` / `EPIPE` / `ECONNRESET` / `Empty reply`）を `network_error` から分離
  * **`ECONNRESET` の再分類**: 既存 `network_error` 配下から `connection_dropped` 側に移動（意味的に `socket hang up` とほぼ同じため）。`network_error` で監視している運用者は `connection_dropped` も見るように追加してください
  * pino ログレベルは `warn`（既存 `network_error` と同等）
* **feat**: npmjs.com プラグインを追加 (phase11.4):
  * `https://www.npmjs.com/package/<pkg>` および scoped `/package/@scope/name` で Cloudflare 配下の HTML スクレイプを諦め、Registry API (`https://registry.npmjs.org/<pkg>`) を直叩きして Summary を組み立てる
  * `dist-tags.latest` の `name` / `description` を最優先、無ければ `versions[latest].description` にフォールバック
  * バージョン指定パス (`/v/<ver>`) や `/tutorial` 等のサブパスでも latest の Summary を返す
  * `sitename: 'npm'` 固定、icon/thumbnail は npm の固定 PNG (`static-production.npmjs.com/...`)
  * `allowedPlugins` で `'npmjs'` を指定/除外可能
  * 背景: npm は Cloudflare Bot Management で正規 bot UA も含めて 403 を返すが、Registry API は素通しで `application/json` を返してくれる。X / Discord が npm の OG カードを表示できているのは verified bot の IP allowlist 経由であり、HTTP レイヤでの突破は不可能
* **BREAKING**: `parseFailureLogEndpoint` オプションと `GET /__diagnostics/parse-failures` HTTP エンドポイントを削除しました (phase11.5):
  * プライバシーリスク（過去 preview 試行 URL が前段 nginx の設定ミスで外部漏洩）を恒久排除するため、診断は **`parseFailureLogJsonlPath` で書き出される JSONL ファイル経由で実施** してください
  * 月次レビュー / プラグイン化候補発見の用途は `cat /var/log/summaly/parse-failures.jsonl | jq -r '.key' | sort | uniq -c | sort -rn | head -20` で代替可能
  * 既存の `config.toml` に `parseFailureLogEndpoint = true` が残っていても **smol-toml が unknown key を silent ignore する** ため起動失敗にはならない（移行猶予）。エンドポイントが mount されないだけ
  * `ParseFailureLog` クラス本体（`record()` / `snapshot()` / JSONL 永続化）は維持。`parseFailureLog: true` + `parseFailureLogJsonlPath` の組み合わせは引き続き動作する
* **enhance**: Fastify モードで `summaly()` が throw したとき pino ログを 1 行出力するように (phase11.8):
  * これまでは 500 をクライアントに返すだけでサーバ側ログは無音だったため、本番のエラー原因切り分けが不可能だった
  * `req.log[level]({ err, url, lang, statusCode }, 'summaly error')` を `fetchEntry` catch ブロックで呼ぶ
  * ログレベルは `error.category` 由来で 3 段: `info` (4xx), `warn` (5xx/timeout/SSRF/型 reject 等), `error` (想定外)
  * URL は `sanitizeUrlForLog` で query/fragment/auth 除去（PII 保護）
  * LRU キャッシュ HIT / dedup HIT 時は再ログしない (spam 抑制)
  * `bin/summaly-server.ts` に `setErrorHandler` セーフティネット追加（404 ハンドラ未マッチ等）
  * `journalctl -u summaly --priority=warning -f` で気にすべき分だけ追える運用に

* **Fastify モードのエラーレスポンスをカテゴリ化** (phase11.2, [riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)):
  * 失敗時のレスポンスに `error.category` フィールドを追加 (`SummalyErrorCategory` 型)
  * カテゴリ: `timeout` / `bot_blocked` / `not_found` / `origin_error` / `unsupported_type` / `content_too_large` / `ssrf_blocked` / `network_error` / `parse_error` / `unknown`
  * `StatusError` のときは `error.statusCode` も同梱（HTTP 由来エラーの上流コードが分かる）
  * 既存フィールド (`message` / `name`) は維持して後方互換
  * 利用側 (Misskey 等) で「プレビューできませんでした」を「タイムアウト」「bot block」「リンク切れ」等に細分化表示できる。Misskey 側の対応は本 fork 連携 Plan に記録
  * `categorizeError(message, name, statusCode)` を `src/utils/parse-failure-log.ts` から export し、`isFilteredFailure` (phase10.1) もこの関数ベースに refactor

* **バージョン確認エンドポイント** `GET /v` を追加:
  * 返却 JSON: `{ version, commit, message }`（package.json のバージョン + git の HEAD コミット short hash + コミットメッセージの 1 行目）
  * `Cache-Control: no-store` でキャッシュ無効化（再起動毎に値が変わるため）
  * ビルド時 (`tsdown` / `vitest`) の `define` で baked、tsx 経由 (`bin/summaly-server.ts` / `pnpm dev`) では `setup-version.ts` で globalThis に注入
  * `.git` が無い環境では git 情報は `'unknown'` フォールバックで build を止めない
  * 用途: 「いま動いているデプロイは何のコミットか」を運用者が即確認できる（特に bug fix 後のロールアウト確認）
* **バグ修正**: Fastify モードで `amazon.co.jp/dp/<ASIN>` 等のリダイレクトする URL がプレビュー失敗していた問題を修正 (phase11.3, [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1)):
  * `summaly()` の `followRedirects: false` フラグが scrape 本体 (`scpaping()` 内の got リクエスト) の `followRedirect` に伝播しており、HTTP リダイレクト中間レスポンス (content-type 無し) が typeFilter で reject されて `Rejected by type filter undefined` で死んでいた
  * `followRedirects` の責務を **summaly() の初期 HEAD 解決限定** に再定義し、scpaping レイヤには伝播させないように修正
  * scrape 本体は got のデフォルト挙動 (リダイレクト follow) に任せる。SSRF チェイン抑制は `maxRedirects: 5` + プライベート IP ガードで継続担保
  * 影響: `summaly(url, { followRedirects: false })` を直呼びしていて「scrape 中もリダイレクト追跡を完全停止したい」依存があった場合、挙動が変わる。Fastify モード利用者には改善方向のみ

* Fastify モードに **パース失敗ドメインのログ蓄積** を追加 (phase10.1):
  * `parseFailureLog: true` で「汎用パスでスカスカ（OG/Twitter Card/`<title>` のいずれも取れない）になった URL」をホスト + パス先頭 1〜2 セグメント単位で集約する。プラグイン化候補のドメイン発見器
  * 「絶対失敗する類型」（HTTP 4xx/5xx の `StatusError`、timeout、非 HTML の type filter reject、SSRF block）は自動で除外され、ノイズが乗らない
  * `parseFailureLogEndpoint: true` で `GET /__diagnostics/parse-failures` を mount。**公開時は nginx 等のネットワーク層でアクセス制限が必須**（過去の preview 試行 URL がプライバシー漏洩する）
  * サンプルに保存する URL は `${origin}${pathname}` のみ（query / fragment / basic auth を捨てる）
  * 上限: グループ数 1000、サンプル数 5/group。同 URL の重複追加は抑制
  * デフォルト無効、`SummalyOptions.parseFailureLog` / TOML の `[diagnostics]` セクションでオプトイン
  * **JSONL ファイル永続化** (`parseFailureLogJsonlPath`): record 毎に 1 行 append。`parseFailureLogJsonlMaxBytes`（デフォルト 10 MiB）を超えたら以降 append を停止する（ローテーションはしない、`logrotate` 等で運用者が rm/mv 想定）。書き込み失敗はサイレントスキップ + stderr に 1 回警告
* 短縮 URL の HEAD 失敗時に GET fallback でリダイレクトを解決するように変更 (phase9.1):
  * `amzn.asia` のように HEAD に 404 を返すが GET には 301 でリダイレクトを返す短縮ホストが解決できるようになる
  * GET fallback には `Range: bytes=0-0` を付けて body 受信量を最小化（リダイレクトされる場合は body 自体無く、最終ターゲットが Range を尊重すれば 1 バイトで済む）
  * HEAD が成功する短縮 URL（`spotify.link` 等）の挙動は変わらない
  * HEAD も GET も失敗した場合は元の URL のまま続行（既存挙動互換）
* twitter (X) プラグインを追加 (phase6.1):
  * `(twitter|x).com/<user>/status/<id>` をハンドル
  * `cdn.syndication.twimg.com/tweet-result` から JSON を取得して description / thumbnail / sensitive / `medias[]`（複数画像対応）を組み立てる
  * `player` は **常に null**（Misskey 側に「ポストを展開する」機能があり、summaly が iframe player を返すと表示が二重化するため／mei23 オリジナル準拠）
  * **メンテナンス上の警告**: X 内部 CDN と独自 token 算出ロジックを利用しているため、X 側仕様変更で予告なく壊れる。デフォルト有効だがリスクを承知で運用すること。動作不要なら `allowedPlugins` から `twitter` を除外する
  * 元実装: mei23 fork
* **Breaking**: スタンドアロン Fastify サーバの起動方式を **TOML 設定ファイル** に移行 (phase8.1):
  * 旧: `fastify start ./built/index.js --options summaly-config.json`
  * 新: `pnpm serve config.toml`（または `tsx bin/summaly-server.ts /path/to/config.toml`）
  * `config.example.toml` をリポジトリルートに同梱。`[server]` / `[summaly]` / `[summaly.cache]` / `[summaly.pdf]` / `[plugins]` セクションでコメント付き設定が書ける
  * 不正値（型違い・負数・ポート範囲外等）は起動時に early fail し、メッセージで該当キーが分かる
  * ライブラリ用途（`summaly()` 関数 / `fastify.register(Summaly, opts)`）は変更なし
  * 旧 `summaly-config.example.json` は DEPRECATED として 1 リリース残置、マイグレーション手順は `docs/deploy-examples/README.md` を参照
  * 環境変数 `SUMMALY_CONFIG_PATH` で設定ファイルパスを上書き可能（CLI 引数 > env > `./config.toml`）
* `summaly()` の連続呼び出しで前回の opts が次回呼び出しに漏れるバグを修正 (`Object.assign(summalyDefaultOptions, options)` が `summalyDefaultOptions` を mutate していた)
  * 利用者が異なる opts で連続呼び出ししても、前回の値が混入しなくなります
  * 「前回の `summaly()` 呼び出し後に `summalyDefaultOptions` が変化していること」に依存するコードがあれば動作が変わりますが、想定されない使用方法のため Breaking Change と見做していません
* プラグイン基盤を整備:
  * `getJson(url, referer?, opts?)` ヘルパを追加（プラグインが oEmbed / 外部 JSON API を叩く際の共通入口、SSRF ガード継承）
  * `SummalyPlugin.name` を導入（`allowedPlugins` 等のキー用）、組み込み 4 プラグインに付与
  * `BROWSER_UA` 定数を追加（プラグインからブラウザ UA を上書きする用途）
  * `KNOWN_SHORT_HOSTS` を導入し Fastify モード（`followRedirects: false`）でも公式短縮 URL は HEAD で解決される
* mei23 fork から非プラグイン機能を取り込み:
  * `Summary.medias?: string[]` を追加（マルチ写真対応・利用側は medias 優先 / 無ければ thumbnail）
  * `SummalyOptions.useRange` を追加（`Range: bytes=0-N-1` で帯域節約、サーバ未対応時はフルボディフォールバック）
  * `SummalyOptions.allowedPlugins` を追加（オプトイン許可リスト、空配列で組み込み全 disable）
  * `sanitizeUrl()` で結果 URL のプロトコルフィルタ（`https:` / `http:` / `data:` 10KB 以下のみ通す）
  * keep-alive デフォルト agent を導入（高頻度プレビューでの遅延削減、`setAgent` で外部 agent 注入時はそちらを優先）
  * `SUMMALY_FAMILY=4` / `=6` で IP family を強制可能
  * 文字コード判定を `chardet` → `jschardet` + `encoding-japanese` に置き換え（[issue #39](https://github.com/misskey-dev/summaly/issues/39): ISO-2022-JP の文字化けを修正）
* `docs/deploy-examples/` に nginx / systemd / 設定 JSON の参考例を追加
* PDF レスポンス対応をオプトインで追加:
  * `enablePdf: true` または環境変数 `SUMMALY_ENABLE_PDF=true` で PDF からタイトル取得が有効化される（デフォルトは無効、既存挙動と互換）
  * `pdf-parse@2` の `getInfo()` で document-level metadata だけを読み、本文ページ解析は走らない
  * 5 秒で hard timeout、`contentLengthLimit` で受信前にサイズ制限、`useRange` 併用で先頭領域だけ取得など多段防衛
  * Title が無い / パース失敗 / timeout 時は hostname を title に、固定の SVG PDF アイコン (`data:image/svg+xml;base64,...`) を icon に返す
  * `enablePdf: false` を明示すると環境変数より優先される（呼出側の意思を尊重）
* Fastify モードに **インメモリ LRU キャッシュ** をオプトインで追加 (issue #27):
  * `inMemoryCache: true` で同一 URL リクエストをサーバ内 LRU キャッシュから返す。`Cache-Control` を解釈しない HTTP クライアント（Misskey の Got / node-fetch 等）でも summaly サーバ単独で重複アクセスを抑制可能
  * 成功 / エラーともキャッシュ。それぞれ `cacheMaxAge` / `cacheErrorMaxAge` を TTL として流用
  * `inMemoryCacheMaxEntries` (デフォルト 1000) でエントリ数上限
  * レスポンスに `X-Cache: HIT` / `MISS` を付与（無効時は付かない）
  * キャッシュキーは URL（フラグメント除去）+ `lang`。プロセス再起動でキャッシュは消える
* Fastify モードに **in-flight リクエスト dedup** を追加（thundering herd 緩和）:
  * `inFlightDedup: true`（**デフォルト有効**）で、同一 URL の並列リクエストを先頭リクエストの結果に集約し、origin への同時アクセスを 1 本化する
  * Misskey のユーザーストリーミング機能で同一リンクが多数のクライアントから同時に引かれるケースで origin が DDoS のように見える問題を抑制
  * `inMemoryCache` とは独立に効くため、キャッシュ無効でも並列の集中だけは抑えられる（両方有効が推奨）
  * `X-Cache: HIT-COALESCED` ヘッダで dedup 効果を可視化（並列待ちで取得したリクエストに付く）
  * 完全に従来挙動に戻すには `inFlightDedup: false` を明示（`X-Cache` ヘッダの追加だけが純粋な互換性影響だが、改善方向のため Breaking Change と見做していない）
* DOM 後処理系プラグインを追加（dlsite / iwara / komiflo / nijie）:
  * `dlsite`: `www.dlsite.com`。`/announce/` ↔ `/work/` で 404 のときに自動再取得、結果パスのカテゴリで `sensitive` を判定
  * `iwara`: `(www|ecchi).iwara.tv`。description を `.field-type-text-with-summary` から、thumbnail を `#video-player[poster]` 等から補完。`ecchi.` ホストで `sensitive`
  * `komiflo`: `komiflo.com/comics/<id>`。thumbnail がデフォルト画像 (`favicon`/`ogp_logo`) にフォールバックしている場合のみ `api.komiflo.com` から `346_mobile` variant を取得して `sensitive`
  * `nijie`: `nijie.info/view.php`。`<script type="application/ld+json">` の `ImageObject` から description / thumbnail を補完。`view.php` 着地で `sensitive`
  * これらは性的コンテンツを含むサイトを扱います。デフォルト無効で運用したい場合は `allowedPlugins` から除外してください
* oEmbed 系プラグインを追加（youtube / spotify）:
  * `youtube`: `*.youtube.com/{watch,v,playlist,shorts}` および `youtu.be/<id>` をハンドル。`https://www.youtube.com/oembed` を 1 リクエストで叩く高速化パス
  * `spotify`: `open.spotify.com` をハンドル。`https://open.spotify.com/oembed` 経由
  * 既存の汎用 `general()` 経由（HTML 取得 → oEmbed フォールバック）に比べてリクエスト数が削減される
  * **挙動変更**: oEmbed には description フィールドが無いため、上記サイトでは `description: null` になります（従来は OG メタの description を返していました）

5.3.0 / 2026/05/02
------------------
* summalyをバンドルしてビルドするように
  * パスを参照してsummalyの特定のファイルをインポートしている場合はそれらが使用できなくなりますが、想定されている使用方法ではないためBreaking Changeと見做していません。
* 依存関係の見直し
* `SummalyResult`型をexportするように
* summalyを別のプロジェクトにバンドルして使用できない問題を修正
* 依存関係の更新

5.2.5 / 2025/10/22
------------------
* 依存関係の更新

5.2.4 / 2025/10/01
------------------
* 依存関係の更新

5.2.3 / 2025/07/19
------------------
* パッケージが使用できない問題を修正

5.2.2 / 2025/07/06
------------------
* 最初のHEADリクエストにUAが反映されない問題を修正
* 依存関係の更新
* テストスイートをVitestに変更

5.2.1 / 2025/04/28
------------------
* セキュリティに関する修正

5.2.0 / 2025/02/05
------------------
* センシティブフラグの判定を `<meta property="rating">` および `rating` ヘッダでも行うように
* Bluesky（bsky.app）のプレビューに対応
* `fediverse:creator` のパースに対応
* 依存関係の更新
* eslintの設定を更新

5.1.0 / 2024-03-18
------------------
* GETリクエストよりも前にHEADリクエストを送信し、その結果を使用して検証するように (#22)
* 下記のパラメータを`summaly`メソッドのオプションに追加
  - userAgent
  - responseTimeout
  - operationTimeout
  - contentLengthLimit
  - contentLengthRequired

5.0.3 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.2 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.1 / 2023-12-30
------------------
* Fix .github/workflows/npm-publish.yml

5.0.0 / 2023-12-30
------------------
* support `<link rel="alternate" type="application/activitypub+json" href="{href}">` https://github.com/misskey-dev/summaly/pull/10, https://github.com/misskey-dev/summaly/pull/11
  * 結果の`activityPub`プロパティでherfの内容を取得できます
* branch.ioを用いたディープリンク（spotify.link）などでパースに失敗する問題を修正 https://github.com/misskey-dev/summaly/pull/13
* Twitter Cardが読めていない問題を修正 https://github.com/misskey-dev/summaly/pull/15
* 'mixi:content-rating'をsensitive判定で見ることで、dlsiteなどでセンシティブ情報を得れるように https://github.com/misskey-dev/summaly/pull/16
* sitenameをURLから生成する場合、ポートを含むように (URL.hostname → URL.host)
* `Summary`型に`url`プロパティを追加した`SummalyResult`型をexportするように
* `IPlugin`インターフェースを`SummalyPlugin`に改称

4.0.2 / 2023-04-20
------------------
* YouTubeをフルスクリーンにできない問題を修正

4.0.1 / 2023-03-16
------------------
* oEmbedの読み込みでエラーが発生した際は、エラーにせずplayerの中身をnullにするように

4.0.0 / 2023-03-14
------------------
* oEmbed type=richの制限的なサポート
* プラグインの引数がWHATWG URLになりました

3.0.4 / 2023-02-12
------------------
* 不要な依存関係を除去

3.0.3 / 2023-02-12
------------------
* agentが指定されている（もしくはagentが空のオブジェクトの）場合はプライベートIPのリクエストを許可

3.0.2 / 2023-02-12
------------------
* Fastifyのルーティングを'/url'から'/'に

3.0.1 / 2023-02-12
------------------
* ES Moduleになりました
  - `import { summaly } from 'summaly';`で関数をインポートします
  - デフォルトエクスポートはFastifyプラグインになります
* https/http agents options
* サーバーのコマンドはnpm run serveになりました

2.7.0 / 2022-07-09
------------------
* accept XHTML
* update got to 11.8.5

2.6.0 / 2022-06-18
------------------
* Improve player detection

2.5.0 / 2021-12-17
------------------
* プライベートIPアドレス等は拒否するように
* Update dependencies

2.3.1 / 2019-09-02
------------------
* Fix amazon support
* Update dependencies

2.3.0 / 2019-06-18
------------------
* Lang support

2.2.0 / 2018-08-29
------------------
* Add standalone server

2.1.4 / 2018-08-22
------------------
* Fix bug

2.1.3 / 2018-08-16
------------------
* Fix bug

2.1.2 / 2018-08-11
------------------
* Fix bug

2.1.1 / 2018-08-10
------------------
* Fix bug

2.1.0 / 2018-08-09
------------------
* Add twitter:player support
* Dependency updates

2.0.6 / 2018-05-18
------------------
* Fix bug

2.0.5 / 2018-05-18
------------------
* Fix bug

2.0.4 / 2018-04-18
------------------
* Dependencies update

2.0.3 / 2017-05-06
------------------
* Improve title cleanuping

2.0.2 / 2017-05-04
------------------
* Support more favicon cases #64
* Update some dependencies
* Bug fix

2.0.1 / 2017-03-11
------------------
* Update some dependencies
* Some refactors

2.0.0 / 2017-02-08
------------------
* **[BREAKING CHANGE] Renamed: Plugins: Method `summary` is now `summarize`**
* Some refactors

1.6.1 / 2017-02-06
------------------
* Fix the incorrect type definition

1.6.0 / 2017-02-05
------------------
* Add user-defined plugin support #22
* Add `followRedirects` option #16
* Add `url` property to result #15

1.5.0 / 2017-01-31
------------------
* Improve: Check favicon exist #7
* [Plugin:Wikipedia] Improve: Clip description #11
* Fix: Import the missing function

1.4.1 / 2017-01-30
------------------
* [Plugin:Wikipedia] Fix bug

1.4.0 / 2017-01-30
------------------
* Follow redirects #5

1.3.0 / 2017-01-15
------------------
* Improve: Better Wikipedia support #2
* Remove babel completely

1.2.7 / 2016-12-11
------------------
* iroiro
* Remove babel

1.2.6 / 2016-10-23
------------------
* Bug fix

1.2.5 / 2016-10-23
------------------
* Fix type definitions problem

1.2.4 / 2016-09-22
------------------
* Fix: Add missing dependency

1.2.3 / 2016-09-15
------------------
* Improvement

1.2.2 / 2016-09-15
------------------
* Bug fix

1.2.1 / 2016-09-15
------------------
* Some improvements
* Some bug fixes

1.2.0 / 2016-09-15
------------------
* Amazon support

1.1.3 / 2016-09-15
------------------
* [Plugin:Wikipedia] Bug fix

1.1.2 / 2016-09-15
------------------
* Bug fix

1.1.1 / 2016-09-15
------------------
* Bug fix

1.1.0 / 2016-09-15
------------------
* Some improvements

1.0.0 / 2016-09-15
------------------
**[BREAKING CHANGE] なんかもうめっちゃ変えた**

0.0.1 / 2016-09-13
------------------
* :bug: Some bug fixes
  * https://github.com/syuilo/summaly/commit/65de5ae1fbf6a0f4dacccc12f2a2e027142ae4b0
  * https://github.com/syuilo/summaly/commit/33132b2ba2744835c52b72da4c4c8b854b0d2045

0.0.0 / 2016-09-13
------------------
Initial release
