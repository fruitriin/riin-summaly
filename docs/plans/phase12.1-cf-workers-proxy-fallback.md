# Phase 12.1 — Cloudflare Workers proxy フォールバック（Amazon class IP block 救援）

> 状態: **完了 (2026-05-06) — followup #1〜#4 まで本番動作確認済み**
>
> Step 5 (pino `proxyAttempted/Succeeded` フィールド) のみ phase11.6 deferral と合流予定。
>
> **本番実証** (2026-05-06):
> - `dp/B0C4LRBFX6` (canonical) → 200 / 2.6 MB / 1.8 秒
> - `dp/B0FRSGC73Z?_encoding=...&ref_=...` (長 query) → 200 (followup #2 の URL 正規化で救援)
> - `amazon.co.jp/dp/B0GFN8129G/ref=...` (bare hostname) → 200 (followup #3 の test() 拡張で救援)
> - `amzn.asia/d/0faScmAn` (短縮 URL) → 200 + 商品ページの正しいタイトル/サムネ (followup #4 の 2 段取得で救援)
>
> ### followup 履歴
> - **#1** (2026-05-06): `Rejected by type filter undefined` を `bot_blocked` に再分類 + proxy categories デフォルト拡張
> - **#2** (2026-05-06): `normalizeAmazonUrl` で `/dp/<ASIN>` canonical 化 (long query が CF Workers 経由でも 500 を返すため)
> - **#3** (2026-05-06): bare hostname (`amazon.co.jp`) を `test()` でマッチ + `www.` 付きに正規化
> - **#4** (2026-05-06): `amzn.asia` 等の短縮 URL を `test()` に追加 + 2 段取得 (final URL から ASIN 抽出 → canonical 再 scpaping)
> 種別: 機能改善 / IP レピュテーション層への対処
> サイズ: **M〜L**
> 依存: phase11.9（`getResponseWithFallback` を 3 段に拡張、または並列に追加）、phase8.1（TOML 設定）、phase4.1（LRU キャッシュ）
> 関連: phase11.6（迂回候補ログ — proxy で救えた／救えなかった統計を蓄積）、[knowhow/outbound-ip-reputation.md](../knowhow/outbound-ip-reputation.md)
> 並列可: phase11.6 / 11.7 と独立

## 目的・背景

[knowhow/outbound-ip-reputation.md](../knowhow/outbound-ip-reputation.md) で確定したように、**Vultr Tokyo の outbound IP では amazon.co.jp が UA に関係なく 500 を返す**。phase11.9 の UA フォールバック (`facebookexternalhit/1.1` 等) では救えない、IP レピュテーション層の遮断。

対処案として knowhow に挙げた選択肢:

1. Outbound proxy 経由 ←──── **本フェーズで採用**
2. Amazon Product Advertising API（要件厳しすぎ）
3. OGP-as-a-service（コスト + 責務外）
4. 諦める
5. AWS / Cloudflare に移す（改修コスト大）

「**1 を最小スコープで試す**」のが本フェーズ。Cloudflare Workers Free で薄い outbound proxy を立て、summaly から HMAC 認証付きで投げて Amazon の HTML を取得する経路を作る。Workers の egress IP は Cloudflare 帯（AS13335 等）で、Vultr よりは Amazon を通る期待がある（確証はないため **Step 1 の実験で判定** する）。

## 設計方針

### 1. ハイブリッド構成（summaly 本体は Node.js のまま）

summaly の主処理は引き続き Vultr の Node.js プロセスで動かし、**特定エラーカテゴリ + 特定ドメインのときだけ** Worker proxy にフォールバック:

```
通常: Misskey → summaly(Vultr) → upstream
                              └ 直叩き OK なら成功
                              └ UA 切替 (phase11.9) で救えるならそれ
                              └ それでも 5xx 等が出る IP block 類型 → ↓
救援: summaly(Vultr) → Cloudflare Worker (proxy) → upstream
```

3 段のリトライ:
1. デフォルト UA で `getResponse()`
2. 失敗 + UA レイヤで救えるカテゴリなら **fallback UA** で再試行（phase11.9）
3. それでも 5xx / `origin_error` で失敗 + ドメインが proxy allowlist に含まれるなら **CF Worker proxy** 経由で再試行

### 2. Worker proxy の責務（最小化）

```
tools/cf-proxy-worker/
├── wrangler.toml
├── package.json     (workers-types のみ)
├── src/
│   └── index.ts    (~150 行)
├── test/
│   └── proxy.test.ts (Miniflare or vitest-environment-miniflare)
└── README.md       (deploy 手順)
```

Worker のやること（**可能な限り薄く**）:

1. **HMAC 検証**: `X-Summaly-Sig` ヘッダで `target_url + timestamp` の HMAC-SHA256 を検証。`SHARED_SECRET` を Workers env vars で保持
2. **タイムスタンプ検証**: replay 攻撃対策で 5 分以内のタイムスタンプのみ受理
3. **target URL 検証**:
   - HTTPS のみ
   - hostname が **summaly 側の allowlist にあるドメインだけ**（`amazon.*` / 後で追加）
   - private IP 系は弾く（Workers の `fetch()` が DNS 解決するので、host 名段階での簡易チェック + Cloudflare の `connect()` が private IP に解決した場合は CF 側でブロックされる挙動に依存）
4. **Range / Content-Length 制限**: 受信ボディは 5 MiB 上限（OGP 取得用途として十分、massive ファイルを引っ張らせない）
5. **fetch して body をそのまま透過**: `fetch(targetUrl, { headers: { 'user-agent': forwardedUA }, redirect: 'follow' })` で透過プロキシとして動作

**やらないこと**:
- HTML パース（summaly 側が cheerio でやる）
- 認証 / レート制限 (CF Workers の組み込み機能で十分)
- ログ蓄積（CF の Logpush に任せる）
- キャッシュ（summaly 側の LRU で十分、Workers 側で Cache API を使うのは Stage 2 以降）

### 3. summaly 側の組み込み

phase11.9 の `getResponseWithFallback` を **3 段化** するか、もしくは `proxyFallback()` という別関数として並列に追加。後者の方がレイヤを混ぜずに済む。

```ts
// src/utils/proxy-fallback.ts (新設)
export async function getResponseWithProxyFallback(
    args: GetResponseArgs,
    proxyConfig: ProxyConfig | undefined,
): Promise<Got.Response<string>> {
    try {
        return await getResponseWithFallback(args, proxyConfig?.uaFallback);
    } catch (e) {
        if (proxyConfig == null || !proxyConfig.enabled) throw e;
        const category = categorizeError(/* ... */);
        if (!proxyConfig.categories.includes(category)) throw e;
        const targetUrl = new URL(args.url);
        if (!proxyConfig.domains.some(d => matchesDomain(targetUrl.hostname, d))) throw e;

        // Worker proxy 経由でリトライ
        return await viaProxyWorker(args, proxyConfig);
    }
}
```

`viaProxyWorker()` は:
1. HMAC 署名を生成（`SHARED_SECRET` + `targetUrl + timestamp`）
2. Worker の URL に `?url=<encoded>` で投げる
3. レスポンスを `Got.Response<string>` 形式に整形して返す（型整合のため）

### 4. 設定スキーマ（TOML）

```toml
[scraping.proxy]
# Outbound proxy 経由の救援を有効化するか (phase12.1)
enabled = false                       # デフォルト false (要明示オプトイン)

# Cloudflare Workers にデプロイした proxy の URL
url = "https://summaly-proxy.<your>.workers.dev"

# HMAC 共有シークレット (Workers env vars と一致させる)
# SUMMALY_PROXY_SECRET 環境変数からも読める (config.toml に書きたくない場合)
# secret = "..."

# どのカテゴリで proxy フォールバックを発火するか (followup #1 で bot_blocked も追加)
categories = ["origin_error", "bot_blocked"]

# Proxy 経由で叩くドメイン allowlist。**suffix-match** (`amazon.co.jp` を書くと `*.amazon.co.jp` も通す)。
# 完全な glob `amazon.*` はサポートしないため TLD ごとに列挙する。
# Amazon 短縮 URL も含める (followup #4)。
domains = [
  "amazon.com", "amazon.co.jp", "amazon.co.uk", "amazon.de", "amazon.fr",
  "amazon.it", "amazon.es", "amazon.ca", "amazon.com.au", "amazon.com.br",
  "amazon.com.mx", "amazon.in",
  "amzn.asia", "amzn.to", "a.co",
]

# Proxy リクエストのタイムアウト (ミリ秒)
# 通常の operationTimeout より短くする (proxy 経由なので余分なホップがある)
timeoutMs = 30000
```

`secret` の TOML 直書きは避けたいので、`SUMMALY_PROXY_SECRET` 環境変数を優先する読み込み順:
1. `process.env.SUMMALY_PROXY_SECRET`
2. `config.toml` の `[scraping.proxy].secret`
3. どちらも無ければ proxy 機能を `enabled = false` 扱いにして警告ログ

### 5. SSRF / オープンプロキシ化の防止

**最重要**。proxy worker は外部からアクセス可能な URL を持つので、HMAC 認証が破られると open proxy としてスパマーに利用される。

防衛層:
1. **HMAC-SHA256 + 共有シークレット**: target_url + timestamp に署名。シークレットを知らないと有効なリクエストを作れない
2. **タイムスタンプの検証窓**: ±5 分以内のみ受理。replay 攻撃を 5 分の窓に限定
3. **ドメイン allowlist**: Worker 側でも summaly 側でも独立して allowlist を持つ。両方で deny されないと通らない
4. **HTTPS のみ**: `http://`、`file://`、`data:` 等を全部弾く
5. **Cloudflare 自体の DDoS 保護**: 過剰なアクセスは CF が遮断
6. **Workers Analytics で監視**: 異常なリクエスト数の急増を検知できるよう Logpush を設定

これでも完璧ではないが、**個人運用の summaly のリスクモデル**としては許容範囲。商用運用なら追加で IP allowlist 等の措置が必要。

### 6. レイテンシ・コスト

- **レイテンシ**: Vultr Tokyo → CF edge → Amazon の 3 hop。CF edge は東京 PoP なので追加レイテンシは ~50ms 程度（subrequest が並列で走るので体感 100ms 以下）
- **CF Workers Free 上限**: **100,000 req/day**。Amazon 失敗の頻度（1 日数十〜数百件と推定）から見て **無料枠で十分**
- **CPU 時間**: Free プランは 10ms CPU/req。subrequest 待ち時間は CPU 時間にカウントされないので、Amazon の応答が遅くてもセーフ
- **Workers 帯域**: 上限なし、ただし subrequest 単位で 50/req（Free）
- **見えるコストの心配点**: 万一 HMAC 突破で proxy 悪用された場合の超過課金。Workers Free は **超過すると 429 を返すだけで課金されない** 設計なので**金額面のリスクはほぼゼロ**（リクエスト無効化されるだけ）。Paid プランに切り替える前は安心して試せる

### 7. 撤退条件（実験フェーズで判定）

Step 1 の実験で **Amazon が CF Workers 経由でも 500 を返す**なら、本フェーズは撤退する。代替案:
- AWS Lambda + API Gateway 経由（Amazon 自社 IP の方が緩い説）
- 自宅サーバ proxy（住宅 IP）
- 諦めて Misskey 側 UI fallback

撤退時は Worker のデプロイは破棄、コードは `tools/cf-proxy-worker/` ごと削除（実験コストは数十分）。

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す（worker 部分は `pnpm --filter cf-proxy-worker test` 等で別管理）。

### Step 1 — 実験フェーズ（撤退判定付き、最初の最小投資）

- [x] **1.1 Worker のミニマル実装** (`tools/cf-proxy-worker/`) — 2026-05-05 実装
  - `wrangler.toml` で free プラン用設定 (ALLOWED_DOMAINS / MAX_BODY_BYTES / TIMESTAMP_WINDOW_MS env vars)
  - `src/index.ts` ~150 行のスケルトン: HMAC 検証 + タイムスタンプ窓 + URL allowlist + HTTPS 限定 + Body cap + fetch 透過
  - `package.json` / `tsconfig.json` を独立管理（main package には影響しない、`files: ["built", "LICENSE"]` で npm publish からも除外）
  - eslint config に `tools` を ignore に追加（Worker 側は workers-types で型解決するため main eslint と非互換）
- [x] **1.2 手元 curl で疎通確認** — 署名ヘルパ実装、検証は Step 1.3 と一体化
  - HMAC 署名を生成する Node スクリプト (`tools/cf-proxy-worker/sign.mjs`) — Node std `crypto.createHmac` で SHA-256 (Worker 側 Web Crypto API と相互運用)
  - `node sign.mjs <target_url> <worker_base_url>` で **コピペ実行可能な curl コマンド** を生成する形にした
- [x] **1.3 ★Amazon 動作確認★** (本フェーズの GO/NO-GO ポイント) — **2026-05-05 GO 確定**
  - 実証コマンド: `curl -H "x-summaly-token: <token>" "https://summaly.riinsworkspace.workers.dev/?url=https%3A%2F%2Fwww.amazon.co.jp%2Fdp%2FB0C4LRBFX6"`
  - 結果: `HTTP 200 / 2,609,877 bytes / 1.81 秒` ← フル商品ページ
  - **比較**: Vultr 直叩き (`SummalyBot/5.3.0`) は同 URL で **HTTP 500** で完全失敗していた。CF Workers 経由なら通る = IP レピュテーション差を proxy で乗り越えられることが実証された
  - 注: 実験用の **簡易トークン認証版 (`worker.js`、現状未コミット)** で実証。本実装フェーズでは `src/index.ts` の HMAC 認証版にデプロイ差し替える
  - `https://www.amazon.co.jp/dp/B0C4LRBFX6` を Worker 経由で取りに行く
  - **200 + HTML が返れば**: Step 2 以降に進む
  - **500 / 503 / Amazon の bot ページが返れば**: 本フェーズ撤退、knowhow に「CF Workers でも Amazon は通らない」を追記して Plan は完了状態に（実装フェーズなしで closure）
  - 撤退時は worker をすぐ破棄（`npx wrangler delete`）
  - 詳細手順は [tools/cf-proxy-worker/README.md](../../tools/cf-proxy-worker/README.md) の「Step 1.3 — GO/NO-GO 実験手順」を参照
- [ ] **1.4 (撤退時) knowhow 更新**
  - [knowhow/outbound-ip-reputation.md](../knowhow/outbound-ip-reputation.md) に「CF Workers Free 経由でも Amazon は ~~通る／通らない~~」の実証結果を追記

### Step 2 — Worker 本実装（実験成功時のみ）

- [ ] **2.1 Worker のセキュリティ強化**
  - HMAC 検証 (`crypto.subtle.verify` を Web Crypto API で実装、Node の crypto と互換性のあるアルゴリズム選定)
  - タイムスタンプ検証 (5 分窓、`Date.now()` ベース)
  - ドメイン allowlist (Worker 側のハードコード + 環境変数で上書き可能)
  - Content-Length / 受信サイズ上限 (5 MiB)
  - HTTPS のみ
- [ ] **2.2 Worker のテスト**
  - `tools/cf-proxy-worker/test/proxy.test.ts` を `vitest-environment-miniflare` で書く
  - HMAC 不正 → 403
  - タイムスタンプ古い → 403
  - allowlist 外 hostname → 403
  - http:// → 403
  - 正常リクエスト → 200 + 透過 body
- [ ] **2.3 Worker のデプロイ手順ドキュメント**
  - `tools/cf-proxy-worker/README.md` に
    - Cloudflare アカウント作成手順
    - `wrangler login` → `wrangler deploy` の手順
    - `wrangler secret put SHARED_SECRET` でシークレット設定
    - `wrangler logs` で動作確認

### Step 3 — summaly 側組み込み

- [x] **3.1 `proxy-fallback.ts` 新設**
  - [src/utils/proxy-fallback.ts](../../src/utils/proxy-fallback.ts) を新規作成
  - `getResponseWithProxyFallback()` 関数
  - HMAC 署名生成 (`crypto.createHmac` Node std)
  - `viaProxyWorker()` で Worker に投げて `Got.Response<string>` 形式で返す
- [x] **3.2 `scpaping()` の組み込み**
  - [src/utils/got.ts](../../src/utils/got.ts) の `scpaping()` を `getResponseWithProxyFallback` 経由に変更
  - phase11.9 の `getResponseWithFallback` の **後段** として配置
- [x] **3.3 `SummalyOptions` API 拡張**
  - [src/index.ts](../../src/index.ts) の `SummalyOptions` に `proxyFallback?: ProxyConfig` を追加
  - 関数経路でも proxy fallback を使える形にする (オプトイン)
- [x] **3.4 Fastify モード config 統合**
  - [bin/config-loader.ts](../../bin/config-loader.ts) に `[scraping.proxy]` セクションのパース追加
  - 環境変数 `SUMMALY_PROXY_SECRET` の優先読み込み
  - `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` 両方に proxy セクションのコメントアウト例を追加（CLAUDE.md ステップ 4.5）

### Step 4 — テスト

- [x] **4.1 ユニットテスト** (`test/proxy-fallback.test.ts`)
  - 通常リクエスト成功時 → proxy 呼ばれない
  - phase11.9 fallback でリトライ成功 → proxy 呼ばれない
  - 両方失敗 + category 一致 + ドメイン一致 → proxy 呼ばれる
  - 両方失敗 + category 一致 + ドメイン **不一致** → proxy 呼ばれない、元のエラーが throw
  - HMAC 署名が正しい (mock worker 側で検証)
- [x] **4.2 統合テスト**
  - mock proxy worker (`http.createServer` で簡易実装) を立てて、Vultr→mock proxy→mock origin の経路をテスト
- [x] **4.3 E2E (手動)** — 2026-05-05 オーナー検証成功
  - 本番 Worker (`summaly.riinsworkspace.workers.dev`) に対して `node tools/cf-proxy-worker/sign.mjs "https://www.amazon.co.jp/dp/B0C4LRBFX6" "$WORKER_URL" | bash` で透過プロキシ動作確認 (`SHARED_SECRET` env 渡し)
  - **追加**: dev サーバ (`pnpm dev`) でも proxy fallback を手元再現できる UI 統合を追加 (`SUMMALY_PROXY_URL` + `SUMMALY_PROXY_SECRET` 環境変数で有効化、`?proxy=1` クエリで per-request 切替)
  - parse-failure-log の Step 5 (pino `proxyAttempted`/`proxySucceeded`) は別途 phase11.6 deferral と合流予定

### Step 5 — pino ログ拡張

- [ ] **5.1** `req.log` に `proxyAttempted` / `proxySucceeded` を追加（phase11.9 の `fallbackAttempted` / `fallbackSucceeded` と同型）
  - 救援成功: `req.log.info({ url, proxySucceeded: true }, 'summaly proxy rescued')`
  - proxy も失敗: error ログに proxy 試行の事実を含める

### Step 6 — ドキュメント

- [x] **6.1** `docs/SETUP.md` に「outbound proxy セクション」追加
  - CF Workers のデプロイ手順 (`tools/cf-proxy-worker/README.md` への参照)
  - `[scraping.proxy]` の運用説明
  - HMAC シークレットの管理方法 (env vars 推奨)
  - Free プランの 100k req/day 上限と監視方法
- [x] **6.2** `docs/Library.md` に `proxyFallback` オプション追記
- [x] **6.3** `CHANGELOG.md` unreleased に
  - `feat: outbound proxy フォールバック (Cloudflare Workers) を追加。Amazon class の IP block を救援する用途 ([scraping.proxy] でオプトイン)`

### Step 7 — knowhow 記録

- [x] **7.1** `docs/knowhow/cf-workers-outbound-proxy.md` 新設
  - Worker のミニマル実装パターン (HMAC + allowlist + fetch 透過)
  - Web Crypto API での HMAC-SHA256 (Node std crypto と相互運用)
  - Free プランで実用ラインに乗る判断材料 (req 数・CPU 時間・帯域の目安)
  - 撤退条件と判定の実例
- [ ] **7.2** [knowhow/outbound-ip-reputation.md](../knowhow/outbound-ip-reputation.md) を更新
  - 「対処選択肢: 案 1 (outbound proxy)」のセクションに「実装例: phase12.1 で Cloudflare Workers Free 経由のフォールバックを採用」を追記

### Step 8 — 品質ゲート

- [ ] `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
- [ ] `bash .claude/tests/run-all.sh`
- [ ] `addf-code-review-agent` でレビュー（特に SSRF / open proxy リスクを重点）
- [ ] `addf-contribution-agent`（`tools/cf-proxy-worker/` は新規ディレクトリで ADDF 影響なし、スキップ可）

## 完了条件 (Definition of Done)

実験成功時:
- `tools/cf-proxy-worker/` に Worker のソース・テスト・デプロイ手順が揃っている
- summaly Fastify モードで `[scraping.proxy].enabled = true` にすると、`origin_error` + allowlist ドメインのときだけ Worker 経由でリトライされる
- Amazon URL を summaly に投げると、proxy 経由で 200 + OGP が返る (本番動作確認)
- pino ログに proxy 救援の成否が記録される
- ドキュメント (SETUP.md / Library.md / CHANGELOG.md / knowhow) が同期されている
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- `test/config-example-plugins.test.ts` の親類として、`[scraping.proxy]` の config example 同期テストも追加されている (Stretch goal)

実験失敗時 (Step 1.3 で NO-GO):
- knowhow に「CF Workers でも Amazon は通らない」実証データが記録される
- Plan ファイルに「撤退判定: <日付> CF Workers 経由でも 500 が返ったため撤退」と明記
- Worker は wrangler delete で破棄、リポには何も commit しない
- 別代替案（AWS Lambda / 自宅 proxy / 諦め）を `Feedback.md` または新規 phase 候補としてメモ

## リスク・注意点

1. **オープンプロキシ化リスク**: HMAC 認証 + ドメイン allowlist + 5 分タイムスタンプ窓の 3 重防御。シークレットは env vars 管理。漏洩した場合は Worker の `wrangler secret put` で即時更新可能（Worker ホットスワップ）
2. **無料枠超過**: Free プラン 100k req/day を超えると 429 が返る。**金額課金は発生しない**（Paid プランに自動切替されない設計）。summaly 側で 429 を受けたらフォールバックなしで原エラーを返す、フォールバック自体を一時無効化する等の挙動を実装。実運用で超過しそうなら別途 Plan
3. **実験で Amazon が通らない可能性 (50/50)**: その場合は Step 1 で撤退。実装コストは worker 側の 50 行のみで sunk cost は最小
4. **Cloudflare アカウントの紐付き**: Worker は CF アカウントに紐づくため、運用者の管理範囲が増える。CF 側の障害・規約変更等への dependency が発生（弱いリスク）
5. **CF Workers の TLS fingerprint**: Workers fetch は Cloudflare 独自 TLS 実装で、Amazon の JA3 フィルタを通る可能性が **Vultr Node より高い** という仮説に乗っている。実証は Step 1.3 で
6. **ドメイン allowlist のメンテナンス**: 新たに IP block されるサイトが見つかるたびに allowlist 更新が必要。`parse-failure-log` の `origin_error` カテゴリを定期レビューして候補を発見する運用 (phase11.6 と協調)
7. **`http.Agent` 互換の壁**: summaly 側の `Got.Response<string>` 型に変換するときに、Worker からのレスポンスをどこまで再現するかの設計判断。最低限 `body`、`statusCode`、`headers`、`url` だけ揃えれば cheerio 入力としては動くはず。`request.options.url` 等は別途モック
8. **proxy 経由のリダイレクト**: Worker の `fetch(target, { redirect: 'follow' })` で Amazon 内部のリダイレクトは Worker で解決される。最終 URL を summaly 側に返すか考える必要あり (`X-Summaly-Final-Url` レスポンスヘッダ等で)
9. **Worker のデプロイ管理**: `tools/cf-proxy-worker/` はメインの npm package には含まれない。`pnpm publish` の対象から確実に除外する (`.npmignore` か `package.json` の `files`)
10. **テストの mock 戦略**: Vitest で proxy worker をモックするには `http.createServer` ベースが楽。Miniflare でフルスタックテストするのは Stage 2 以降の選択肢
