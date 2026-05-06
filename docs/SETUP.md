SETUP.md — Misskey 管理人向けセットアップガイド
================================================================

summaly を Misskey 等のフロントエンドから利用するために、**スタンドアロンの HTTP サーバ（Fastify モード）として運用する** 場合のガイドです。

ライブラリとしてアプリ内で `summaly()` 関数を直接呼ぶだけなら [README.md](../README.md) で十分です。

目次
----------------------------------------------------------------

- [全体像](#全体像)
- [最小起動](#最小起動)
- [Fastify モード固有のオプション](#fastify-モード固有のオプション)
- [キャッシュ戦略](#キャッシュ戦略)
- [Bot block フォールバック UA リトライ (phase11.9)](#bot-block-フォールバック-ua-リトライ-phase119)
- [Outbound proxy フォールバック (phase12.1)](#outbound-proxy-フォールバック-phase121)
- [パース失敗ドメインのログ蓄積 (phase10.1)](#パース失敗ドメインのログ蓄積-phase101)
- [バージョン確認エンドポイント `GET /v`](#バージョン確認エンドポイント-get-v)
- [エラーレスポンスのカテゴリ (phase11.2)](#エラーレスポンスのカテゴリ-phase112)
- [エラー観測ログ (phase11.8)](#エラー観測ログ-phase118)
- [PDF 対応](#pdf-対応)
- [プラグインの絞り込み](#プラグインの絞り込み)
- [HTTP エージェント / プロキシ / IP family](#http-エージェント--プロキシ--ip-family)
- [本番デプロイ例（nginx + systemd）](#本番デプロイ例nginx--systemd)
- [SSRF / セキュリティ既定値](#ssrf--セキュリティ既定値)
- [運用上の注意点](#運用上の注意点)

全体像
----------------------------------------------------------------

```
[Misskey API] ──HTTP──> [nginx (任意)] ──proxy_pass──> [summaly Fastify (port 3000)] ──HTTPS──> [対象サイト]
```

- summaly Fastify は `GET /?url=<エンコードされた URL>&lang=<lang>` を受け、`Cache-Control` 付きの JSON を返す
- Misskey 側は `summaly` の URL をプレビュー解決のエンドポイントとして設定する
- nginx を前段に置くと `proxy_cache` が効き、CDN を被せるとさらに広範囲でキャッシュできる

最小起動
----------------------------------------------------------------

```bash
git clone https://github.com/fruitriin/summaly.git
cd summaly
pnpm install --frozen-lockfile
pnpm build
cp config.example.toml config.toml   # 設定をコピーして編集する
pnpm serve config.toml               # = tsx bin/summaly-server.ts config.toml
```

`pnpm serve` は引数として TOML 設定ファイルのパスを受け取る。引数省略時は環境変数 `SUMMALY_CONFIG_PATH` → `./config.toml` の順にフォールバックする:

```bash
SUMMALY_CONFIG_PATH=/etc/summaly/config.toml pnpm serve
```

ポート / バインドアドレスは TOML の `[server]` セクションで指定する:

```toml
[server]
host = "127.0.0.1"
port = 3000
```

設定例: [config.example.toml](../config.example.toml) または [docs/deploy-examples/summaly-config.example.toml](deploy-examples/summaly-config.example.toml)。

> **Migration note (phase8.1 / 5.4)**: 旧 fastify-cli `--options summaly-config.json` ベースは廃止しました。マイグレーション手順は [docs/deploy-examples/README.md](deploy-examples/README.md) を参照してください。

Fastify モード固有のオプション
----------------------------------------------------------------

`fastify.register(Summaly, opts)` で渡せる関数オプション、または `config.toml` の `[summaly]` 系セクションに対応する設定。ライブラリ共通のオプション（`lang` / `userAgent` / `responseTimeout` / `operationTimeout` / `contentLengthLimit` / `agent` 等）は [README.md](../README.md) を参照。

| プロパティ (関数) | TOML キー | 型 | 説明 | デフォルト |
|:--|:--|:--|:--|:--|
| **cacheMaxAge** | `[summaly.cache] maxAge` | *number* | 成功レスポンスの `Cache-Control: public, max-age=<秒>`。`0` で `no-store` | `604800` (1 週間) |
| **cacheErrorMaxAge** | `[summaly.cache] errorMaxAge` | *number* | エラーレスポンスの `Cache-Control` | `3600` (1 時間) |
| **inMemoryCache** | `[summaly.cache] inMemory` | *boolean* | プロセス内 LRU キャッシュを有効化 | `false` |
| **inMemoryCacheMaxEntries** | `[summaly.cache] inMemoryMaxEntries` | *number* | LRU の最大エントリ数 | `1000` |
| **inFlightDedup** | `[summaly.cache] inFlightDedup` | *boolean* | 同一 URL の並列リクエストを 1 本化（thundering herd 緩和） | `true` |
| **useRange** | `[summaly] useRange` | *boolean* | `Range: bytes=0-N-1` で先頭領域だけ取得（帯域節約） | `false` |
| **allowedPlugins** | `[plugins] allowed` | *string[]* | 利用許可するプラグイン名の配列 | `undefined` (全有効) |
| **enablePdf** | `[summaly.pdf] enabled` | *boolean* | PDF レスポンスのタイトル取得を有効化 | `false` |

`SUMMALY_ALLOW_PRIVATE_IP` / `SUMMALY_FAMILY` には対応する TOML キーが**ない**（環境変数のみ）。`SUMMALY_ENABLE_PDF` は `[summaly.pdf] enabled` 未指定時のフォールバックとして読まれる（明示すれば TOML が優先）。

`SUMMALY_FAMILY` / `SUMMALY_ENABLE_PDF` / `SUMMALY_ALLOW_PRIVATE_IP` の詳細は後述。

キャッシュ戦略
----------------------------------------------------------------

summaly のキャッシュ・流量制御は **4 段重ね** で考えるのが運用の基本:

1. **`Cache-Control` ヘッダ（自動）** — 全レスポンスに `public, max-age=<cacheMaxAge>` が付く。前段の nginx `proxy_cache` / Cloudflare 等が尊重して再リクエストを減らす
2. **in-flight dedup（`inFlightDedup: true` がデフォルト）** — 同一 URL に並列で来たリクエストを先頭リクエストの結果に集約し、origin への同時アクセスを 1 本化する（thundering herd 緩和）
3. **インメモリ LRU キャッシュ（`inMemoryCache: true` でオプトイン）** — `Cache-Control` を解釈しない HTTP クライアント（Misskey の Got / node-fetch 等）でも summaly サーバ単独で重複アクセスを抑える
4. **前段プロキシ / CDN（運用者が用意）** — nginx の `proxy_cache_path` + `proxy_cache_valid` で `Cache-Control` を尊重した永続キャッシュ

### `Cache-Control`

すべてのレスポンスに付く（[phase1.1](plans/phase1.1-fastify-cache-control.md)）:

- 200: `Cache-Control: public, max-age=604800`
- 400 / 500: `Cache-Control: public, max-age=3600`

エラーも短くキャッシュするのは、壊れた URL への連続リクエストを増幅させないため（[Mastodon link-preview DDoS issue](https://github.com/mastodon/mastodon/issues/23662) 関連）。

`cacheMaxAge: 0` / `cacheErrorMaxAge: 0` で `Cache-Control: no-store` に切り替え、ヘッダによるキャッシュを無効化できます。

### インメモリ LRU キャッシュ

```jsonc
{
  "inMemoryCache": true,
  "inMemoryCacheMaxEntries": 1000,
  "cacheMaxAge": 604800,
  "cacheErrorMaxAge": 3600
}
```

`inMemoryCache: true` でプロセス内に `lru-cache` ベースのキャッシュを持ちます。Misskey の Got / node-fetch は `Cache-Control` を解釈しないので、**前段プロキシなしの構成では事実上必須の設定** です。

- **キャッシュキー**: URL（フラグメント `#...` を除去）+ NULL byte + `lang` クエリ値。`ja` と `en` は別エントリ
- **TTL**: 成功は `cacheMaxAge`、エラーは `cacheErrorMaxAge`
- **エントリ上限**: `inMemoryCacheMaxEntries`（デフォルト 1000）。1 エントリは数 KB だが、長い `description` や `data:` thumbnail で大きくなる可能性あり
- **`X-Cache` ヘッダ**: `HIT` / `MISS` / `HIT-COALESCED` が付く（dedup・LRU 共に無効時は付かない）

#### 注意点

- **5xx エラーもキャッシュされる**: 上流が一時障害から復旧しても `cacheErrorMaxAge` までエラーが返り続けます。プロセス再起動するか `cacheErrorMaxAge` を短く設定して緩和
- **プロセス再起動でキャッシュは消えます**。永続キャッシュは別実装（要望次第で Redis 等を将来検討）

### in-flight dedup

`inFlightDedup: true`（デフォルト）で、**同一 URL の進行中リクエストの結果** を後続の並列リクエストにも共有し、origin への同時アクセスを 1 本化します。Misskey のユーザーストリーミング機能で 1 本の URL が同時に多数のクライアントから引かれるケースで発生する thundering herd を抑える機構です。

- **動作**: 先頭リクエストが origin にスクレイピング中、後続の同 URL リクエストは Promise を共有して待機。完了時に全 waiter が同じ結果を受け取る
- **`inMemoryCache` とは独立**: dedup だけ有効・キャッシュ無効でも「並列の集中」は止まる。両方有効が推奨（最初の集中は dedup、後続の重複は LRU で吸収）
- **キャッシュキー**: LRU キャッシュと同一（URL（フラグメント除去）+ `lang`）
- **エラー時**: 先頭リクエストの error が全 waiter に伝搬し、各 waiter が同じ `errorPayload` をレスポンスする
- **`X-Cache: HIT-COALESCED`**: 並列待ちで取得したリクエストにこのヘッダが付き、dedup 効果を可視化できる
- **完全に従来挙動に戻すには `inFlightDedup: false`**: dedup と LRU 両方を無効化したい場合は両方 `false` を明示

| 状態 | X-Cache | 意味 |
|---|---|---|
| LRU HIT | `HIT` | キャッシュから返した |
| in-flight 待ちで完了 | `HIT-COALESCED` | 並列リクエストの先頭結果を共有した（dedup 効果あり） |
| 完全な MISS | `MISS` | 自分が origin に行った |
| dedup・LRU 共に無効 | （ヘッダなし） | 既存挙動 |

異なる URL の並列数に上限はかけません（dedup は同 URL のみ）。Fastify 全体のリクエストキューイングは上位レイヤ（nginx の `limit_conn` 等）の責務です。

Bot block フォールバック UA リトライ (phase11.9)
----------------------------------------------------------------

`SummalyBot` 文字列を WAF が検知して TCP/TLS 確立後に HTTP 応答前で切断する（`socket hang up` シグニチャ）サイトに対して、別 UA で 1 回だけリトライする救援機構です。

### デフォルト UA の複合化

phase11.9 から **デフォルト UA は `Mozilla/5.0` プレフィックス付きの複合 UA** になりました:

```
Mozilla/5.0 (compatible; SummalyBot/<version>; +https://github.com/fruitriin/riin-summaly)
```

これで「Mozilla プレフィックスを期待する WAF」は通るようになります。一方「`SummalyBot` 文字列を含むと弾く WAF」（`playing-games.com` 等で実証）には依然として届かないため、後述のフォールバック UA リトライで救援します。

### フォールバック UA リトライ

`config.toml`:

```toml
[scraping.fallback]
enabled = true
userAgent = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
categories = ["bot_blocked", "connection_dropped"]
```

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `enabled` | フォールバックリトライを有効化 | `true`（セクションがあれば） |
| `userAgent` | リトライ時の UA。`SummalyBot` 文字列を含まないものを指定する | （指定必須） |
| `categories` | リトライ発火対象のエラーカテゴリ | `["bot_blocked", "connection_dropped"]` |

### 動作

1. **1 回目**: 通常の UA（デフォルトは複合 UA）でリクエスト
2. 失敗したら `categorizeError` でカテゴリ判定し、`categories` に含まれていれば
3. **2 回目**: UA を `userAgent` に差し替えて再試行
4. 2 回目も失敗したら **2 回目（最後）のエラー** を throw

リトライ回数は常に最大 1 回（合計 2 回試行）。指数バックオフは入れません。

### `facebookexternalhit/1.1` を採用した理由

`facebookexternalhit/1.1` を share link 公開しているサイトの多くが OGP 取得用途として明示的に許可しています（fb / Twitter / Discord / Slack 等の正規 bot UA）。一方で「`SummalyBot` 文字列で WAF が弾く」サイトの多くは、これら正規 bot UA を allow リストに入れていることが実証されました（`playing-games.com` で 200 を返す等）。

倫理的に気になる場合は中立的な `Mozilla/5.0 (compatible; LinkPreviewBot/1.0)` 等に差し替え可能です（ただし WAF を通る保証は減る）。

### IP block は救えない

UA を切り替えても 100% の沈黙を返すサイト（`rawchili.com` 等、Linode 互いの IP レンジを丸ごと弾いているケース）は本機構の射程外です。専用プロキシ経由でのリトライは別 phase の検討課題。

### 観測

`req.log` の pino 出力で `error.category` を見れば「フォールバックを試みる対象だったか」がわかります:

```bash
# bot block / connection_dropped で失敗した URL（フォールバックで救えなかった分）を抽出
sudo journalctl -u summaly -o cat | jq -c 'select(.err.category == "bot_blocked" or .err.category == "connection_dropped")'
```

リトライで救えた分はログに出ません（成功扱いのため）。救援統計を取りたい場合は phase11.6（迂回候補ログ）で別 JSONL に書き出す設計を予定しています。

Outbound proxy フォールバック (phase12.1)
----------------------------------------------------------------

UA fallback (phase11.9) でも救えない **IP レピュテーション層の遮断** （Vultr Tokyo IP からの amazon.co.jp 等で UA に関わらず 500 が返る問題、[knowhow/outbound-ip-reputation.md](../docs/knowhow/outbound-ip-reputation.md)）に対し、Cloudflare Workers Free を outbound proxy として経由してリトライする救援機構です。

### 実証データ

- 対象: `https://www.amazon.co.jp/dp/B0C4LRBFX6` (Vultr 直叩きで 500)
- CF Workers 経由: **HTTP 200 / 2.6 MB / 1.81 秒** ← フル商品ページ取得成功
- 確認日: 2026-05-05 (Step 1.3 GO 判定)

### 3 段リトライ構成

```
1. デフォルト UA で getResponse()
2. 失敗 + UA レイヤで救えるカテゴリ → fallback UA で再試行 (phase11.9)
3. それでも 5xx (origin_error) で失敗 + ドメインが proxy allowlist 一致 → CF Worker proxy 経由
```

### 設定 (`config.toml`)

```toml
[scraping.proxy]
enabled = true
url = "https://summaly-proxy.<your>.workers.dev"
# secret は環境変数 SUMMALY_PROXY_SECRET 経由が推奨 (TOML 直書きを避ける)
categories = ["origin_error", "bot_blocked"]
domains = [
  "amazon.co.jp", "amazon.com",       # Amazon 商品ページ
  "amzn.asia", "amzn.to", "a.co",     # Amazon 短縮 URL (resolveRedirect 失敗時の fallback)
]
timeoutMs = 30000
```

> ⚠️ **`domains` は Worker 側 `wrangler.toml` の `ALLOWED_DOMAINS` と同期して更新すること**。Worker 側でも独立に持っているので、片方だけ追加すると proxy 発火と実際の Worker 側許可で食い違って混乱する。

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `enabled` | Proxy フォールバックを有効化 | `false` |
| `url` | Worker のエンドポイント URL | （指定必須） |
| `secret` | HMAC 共有シークレット。env `SUMMALY_PROXY_SECRET` が優先 | （指定必須、env 経由可） |
| `categories` | リトライ発火対象のエラーカテゴリ。`bot_blocked` には Amazon の `200 + content-type 欠落` (= `Rejected by type filter undefined`) も含まれる | `["origin_error", "bot_blocked"]` |
| `domains` | Proxy 対象ドメイン (suffix-match)。空配列禁止 | （指定必須） |
| `timeoutMs` | Proxy リクエストのタイムアウト | `30000` |

### Worker のデプロイ

`tools/cf-proxy-worker/` 配下に Cloudflare Workers 用のソースが入っています。デプロイ手順は [tools/cf-proxy-worker/README.md](../tools/cf-proxy-worker/README.md) 参照。

```bash
cd tools/cf-proxy-worker
npm install
npx wrangler login                          # 初回のみ
SECRET=$(openssl rand -hex 32)
echo "$SECRET" | npx wrangler secret put SHARED_SECRET
npx wrangler deploy
```

summaly 側にも同じシークレットを渡す:

```bash
export SUMMALY_PROXY_SECRET="<上で生成した SECRET>"
pnpm serve config.toml
```

dev サーバ (`pnpm dev`) でも proxy 経由を手元再現できます:

```bash
export SUMMALY_PROXY_URL="https://summaly-proxy.<your>.workers.dev"
export SUMMALY_PROXY_SECRET="<同じ SECRET>"
pnpm dev
# → http://127.0.0.1:3000 のオプション内に proxy fallback checkbox 出現
# → サンプル URL 「Amazon JP (proxy 経由 — IP block 救援)」をクリックで自動 ON
```

> ⚠️ dev サーバは `SUMMALY_ALLOW_PRIVATE_IP=true` をプロセス内で固定セットしています。proxy 機能を使う場合は **デフォルト `HOST=127.0.0.1` を変更しない** ことを推奨します。`HOST=0.0.0.0` で起動すると LAN 内の別ホストから `?proxy=1` 経由で Worker を叩かれる可能性があります（Worker 側 allowlist で守られていますが、二重防御として）。

### コスト・上限

- **Free プラン**: 100,000 req/day。Amazon 失敗の頻度（1 日数十〜数百件と推定）から見て十分
- **CPU 時間**: Free プランは 10ms CPU/req。subrequest 待ち時間は CPU 時間にカウントされない
- **超過時の挙動**: 429 が返るだけ。**金額課金は発生しない**（Paid プランへの自動切替は無い設計）

### セキュリティ

オープンプロキシ化を防ぐため、以下を多層で適用:

1. **HTTPS 限定** — Worker 側で `target.protocol !== 'https:'` は 403
2. **HMAC-SHA256 + 共有シークレット** — `target_url\ntimestamp` を署名 (Node std crypto と Worker Web Crypto API で相互運用)
3. **タイムスタンプ窓 ±5 分** — replay 攻撃の有効期間を 5 分に限定
4. **ドメイン allowlist (Worker 側)** — `wrangler.toml` の `ALLOWED_DOMAINS` env var
5. **ドメイン allowlist (summaly 側)** — `[scraping.proxy].domains` で独立に持つ。両方で許可されないと通らない
6. **受信ボディ上限** — Worker 側 5 MiB、summaly 側 `contentLengthLimit`
7. **定数時間比較** — HMAC 検証でタイミング攻撃を防ぐ
8. **redirect 後の allowlist 再検証** — Worker が `redirect: 'follow'` した最終 URL を再度 allowlist 照合

### 観測

`req.log` の pino 出力で proxy 救援の成否を見れます (phase11.8 の機構を流用、`error.category === "origin_error"` のリクエストを追跡):

```bash
# proxy で救援できなかったケースを抽出 (proxy も失敗 or 設定無効)
# followup #1 で bot_blocked も proxy 発火対象になったので両方見る
sudo journalctl -u summaly -o cat | jq -c 'select(.err.category == "origin_error" or .err.category == "bot_blocked")'
```

パース失敗ドメインのログ蓄積 (phase10.1)
----------------------------------------------------------------

`parseFailureLog: true` で「**汎用パスでスカスカ（OG/Twitter Card/`<title>` のいずれも取れず）になった URL**」をホスト + パス先頭 1〜2 セグメント単位で集約してプロセス内に保持します。**プラグイン化候補のドメイン発見器** として運用する想定です。

```toml
[diagnostics]
parseFailureLog = true
parseFailureLogMaxGroups = 1000
parseFailureLogSamplesPerGroup = 5
parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"
```

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `parseFailureLog` | 集約を有効化 | `false` |
| `parseFailureLogMaxGroups` | グループ数上限（超過時 LRU 風に最古から削除） | `1000` |
| `parseFailureLogSamplesPerGroup` | 1 グループあたりの直近サンプル数 | `5` |

> **phase11.5 で `/__diagnostics/parse-failures` HTTP エンドポイントは廃止されました**。プライバシーリスク（過去 preview 試行 URL の漏洩）を恒久排除するため、診断は **`parseFailureLogJsonlPath` で書き出される JSONL ファイル経由のみ** となっています。`parseFailureLogEndpoint` オプションは存在しません（TOML に残っていても silent ignore）。

### 「絶対失敗する類型」は自動除外

プラグインを書いても救えない以下のケースは **記録されません**（ノイズ削減）:

- HTTP 4xx / 5xx ステータス (`StatusError`、Akamai/Cloudflare の bot block 含む)
- タイムアウト / abort
- 非 HTML レスポンス（`Rejected by type filter`）
- SSRF ガードによるプライベート IP 拒否

### グループ key の粒度

- `https://qiita.com/UserA/items/abc?token=...` → `qiita.com/UserA/items`
- `https://note.com/foo/n/abc` → `note.com/foo/n`
- `https://example.com/` → `example.com/`

ユーザー＋投稿カテゴリ単位の粒度で「サイト全体の構造」を把握しやすくしています。

### プライバシー保護

サンプルに保存される `url` は **`${origin}${pathname}` のみ**（query / fragment / basic auth は捨てる）。session ID / API token がクエリに乗っているケースをある程度防ぎます。それでも path 自体に機密が含まれる URL は記録されるため、JSONL ファイルへのアクセス権限はサーバ運用者のみに限定してください（`chmod 600` 推奨）。

### JSONL ファイル経由のレビュー（推奨運用）

プロセス再起動で in-memory ログは消えるため、月次レビュー等で過去ログを残す場合は JSONL ファイルへの append を有効化します。phase11.5 以降、集約データの参照は **JSONL を `cat | jq` するファイルベースの運用が唯一の経路** です。

```toml
[diagnostics]
parseFailureLog = true
parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"
parseFailureLogJsonlMaxBytes = 10485760   # 10 MiB（デフォルト）
```

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `parseFailureLogJsonlPath` | 永続化先 JSONL パス | `undefined`（永続化なし） |
| `parseFailureLogJsonlMaxBytes` | これを超えたら以降の append を停止（**ローテーションはしない**） | `10485760`（10 MiB） |

挙動:
- `record()` 1 回ごとに `{"key":"...","url":"...","ts":...,"reason":"thin|throw","errorMessage":"..."}` を 1 行 append
- 起動時に既存ファイルサイズを読んで cap 判定の起点にする
- 書き込み権限エラー / ディレクトリ未存在は **サイレントに失敗**（リクエスト処理を止めない）。stderr に 1 度だけ警告を出力
- cap 越え後の挙動は「以降の append を**停止**」のみ。**ファイルローテーションはしない**ため、運用者は `logrotate` や cron で `mv` / `rm` する想定

集約データの参照例:

```bash
# 月次レビュー: 頻出グループ key を集計してプラグイン化候補を発見
cat /var/log/summaly/parse-failures.jsonl | jq -r '.key' | sort | uniq -c | sort -rn | head -20

# tail -f でリアルタイム観察
tail -f /var/log/summaly/parse-failures.jsonl | jq -c '.'

# thin だけに絞る（throw は除外）
cat /var/log/summaly/parse-failures.jsonl | jq -c 'select(.reason == "thin")'
```

ローテーションを `logrotate` で組むなら:

```
/var/log/summaly/parse-failures.jsonl {
    monthly
    rotate 6
    missingok
    notifempty
    nocreate
    copytruncate
}
```

`copytruncate` を使うと summaly プロセスを再起動せずローテートできますが、in-memory のサイズキャッシュとファイル実体に齟齬が出るため、ローテート後は `summaly serve` を再起動するのが確実です。

### 迂回候補ログ（phase11.6）

`parseFailureLogJsonlPath`（プラグイン候補）とは別ファイルに、**4xx/5xx・timeout・SSRF block・type filter 等で記録対象外になった失敗**を集約できます:

```toml
[diagnostics]
parseFailureLog = true
parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"          # プラグイン候補
parseFailureLogBlockedJsonlPath = "/var/log/summaly/parse-failures-blocked.jsonl"  # 迂回候補
parseFailureLogBlockedJsonlMaxBytes = 10485760  # 10 MiB（デフォルト）
```

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `parseFailureLogBlockedJsonlPath` | 迂回候補 JSONL パス | `undefined`（永続化なし） |
| `parseFailureLogBlockedJsonlMaxBytes` | 迂回候補 JSONL の cap | `10485760`（10 MiB） |

各行に `category` (`SummalyErrorCategory`) と `errorName` が含まれるため、jq で細分フィルタが可能:

```bash
# bot block (4xx) されたサイトを集計 → 別 API がある SaaS の発見
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "bot_blocked") | .url' | sort -u | head -20

# connection_dropped (WAF 黙殺) を抽出 → phase11.9 のフォールバック UA で救えなかった残り
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "connection_dropped") | .url' | sort -u

# timeout 多発サイトを発見 → 別 CDN ホスト or モバイル版を探す候補
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "timeout") | .url' | sort | uniq -c | sort -rn
```

#### プラグイン候補ログとの違い

| 比較軸 | `parseFailureLogJsonlPath` (phase10.1) | `parseFailureLogBlockedJsonlPath` (phase11.6) |
|:--|:--|:--|
| 記録対象 | thin Summary + 非フィルタ throw（プラグインで救える候補） | フィルタ対象 throw（4xx/5xx, timeout, SSRF, type filter, network, connection_dropped） |
| 用途 | プラグイン化候補の発見 | 迂回候補（別 API ホスト・別エンドポイント）の発見 |
| in-memory 集約 | あり (1000 group × 5 sample) | **なし**（流量過大によるメモリ消費を避ける） |
| 流量 | 少 | 多（4xx/5xx 全部が来うる） |
| 行のフィールド | `key, url, ts, reason, errorMessage?` | `key, url, ts, reason, errorMessage?, errorName?, category` |

#### プライバシー注意

迂回候補ログには **失敗した URL の origin+pathname** が記録されます。プラグイン候補ログと同様、ファイルパーミッションを 600 に絞ること推奨:

```bash
chmod 600 /var/log/summaly/parse-failures-blocked.jsonl
```

バージョン確認エンドポイント `GET /v`
----------------------------------------------------------------

`GET /v` で「いま動いているデプロイのバージョン情報」を返します。設定不要・常時 mount。

```bash
$ curl https://summaly.example.com/v
{
  "version": "5.3.0",
  "commit": "c68296b",
  "message": "fix: Fastify モードで scpaping のリダイレクト follow が無効化されていたバグを修正 (phase11.3)"
}
```

| フィールド | 説明 |
|:--|:--|
| `version` | `package.json` の `version` |
| `commit` | git HEAD の short hash（`git rev-parse --short HEAD`）。`.git` が無いと `unknown` |
| `message` | git HEAD のコミットメッセージ 1 行目（`git log -1 --pretty=%s`）。`.git` が無いと `unknown` |

レスポンスは `Cache-Control: no-store`。値はビルド時 (`tsdown` / `vitest`) または起動時 (`tsx bin/summaly-server.ts`) の git 情報で確定するため、再起動するまで動的には変わりません。

**用途**:
- bug fix 後のロールアウト確認（「`amzn.asia` の HEAD→GET fallback はもう入ったか?」）
- 監視ツール (uptime check 等) でサーバ生存確認 + バージョン記録
- 開発時に「dev サーバが古いままじゃないか」のサニティチェック

エラーレスポンスのカテゴリ (phase11.2)
----------------------------------------------------------------

Fastify モードで `summaly()` が throw した場合、500 ステータス + JSON ボディに `error.category` フィールドが乗ります。Misskey 等のクライアントが「プレビューできませんでした」を細分化表示する用途。

```jsonc
{
  "error": {
    "category": "not_found",
    "message": "404 Not Found",
    "name": "StatusError",
    "statusCode": 404
  }
}
```

| `error.category` | 推奨ユーザー向けメッセージ例 | 対応すべきか |
|:--|:--|:--|
| `timeout` | サーバが応答しません（タイムアウト） | 一時的なら再試行を案内 |
| `bot_blocked` | このサイトはプレビュー取得をブロックしています | サイト側ポリシー、対応不可 |
| `not_found` | ページが見つかりません (404) | リンク切れ確認 |
| `origin_error` | サイト側でエラーが起きています (5xx) | 一時的なら再試行を案内 |
| `unsupported_type` | このコンテンツタイプはプレビュー対象外（PDF 等） | `enablePdf` 設定の見直し |
| `content_too_large` | ページが大きすぎてプレビュー対象外 | `useRange: true` で先頭領域取得を検討 |
| `ssrf_blocked` | プライベート IP はプレビュー禁止 | URL を確認 |
| `network_error` | サーバに到達できません | URL のホスト名を確認 |
| `connection_dropped` | サーバが応答せず切断されました | WAF 黙殺の典型。`[scraping.fallback]` の対象 |
| `parse_error` | プレビューが取得できませんでした | プラグイン化候補（パース失敗ログで追跡） |
| `unknown` | 不明なエラー | ログを確認 |

`StatusError` のときは `error.statusCode` も同梱されるため、Misskey 側で `URL_PREVIEW_NOT_FOUND` (404) と `URL_PREVIEW_BOT_BLOCKED` (403/429 等) を分けて API エラーコードを返すことができます。

**後方互換**: 既存の `error.message` / `error.name` は維持されます。`category` を見ない既存実装は影響を受けません。

エラー観測ログ (phase11.8)
----------------------------------------------------------------

Fastify モードで `summaly()` が throw したとき、`req.log` 経由で **pino ログが 1 行出力**されます。これまではクライアントに 500 を返すだけでサーバ側ログは無音だったため、本番のエラー原因切り分けが不可能でした (例: `https://summaly.riinswork.space/?url=https://amzn.asia/d/...` が 500 になるが原因不明)。

### ログレベル

`error.category` 由来で 3 段階に分けて出力します:

| level | category | 例 |
|:--|:--|:--|
| `info` | `not_found` / `bot_blocked` | upstream 404, 403, 429 (普通の bot block) |
| `warn` | `origin_error` / `timeout` / `unsupported_type` / `content_too_large` / `ssrf_blocked` / `network_error` | upstream 障害・遅延・SSRF ガード発動・型 reject など気にすべき分 |
| `error` | `parse_error` / `unknown` | プラグインのバグ・cheerio 失敗・想定外（必ず確認） |

journalctl で気にすべき分だけ追う例:

```bash
journalctl -u summaly --priority=warning -f
```

### ログ出力例 (pino JSON)

```json
{
  "level": 30,
  "time": 1700000000000,
  "msg": "summaly error",
  "url": "https://www.amazon.co.jp/dp/B0989HTQ32",
  "lang": "ja-JP",
  "statusCode": 500,
  "err": { "type": "StatusError", "name": "StatusError", "message": "500 Internal Server Error", "stack": "...", "statusCode": 500 }
}
```

### ログのフィルタ (jq + journalctl)

```bash
# error / fatal だけ (アプリバグ系)
sudo journalctl -u summaly -o cat | jq -c --unbuffered 'select(.level >= 50)'

# warn 以上 (運用上気にすべき分)
sudo journalctl -u summaly -o cat | jq -c --unbuffered 'select(.level >= 40)'

# tail (リアルタイム)
sudo journalctl -u summaly -f -o cat | jq -c --unbuffered 'select(.msg == "summaly error")'

# 特定 Error クラス
sudo journalctl -u summaly -o cat | jq -c 'select(.err.type == "StatusError" and .err.statusCode >= 500)'
```

`-o cat` で MESSAGE フィールド (= pino JSON) のみ抜き出し jq に渡す。`--priority=err` (syslog priority) は pino の level と対応しないため使えないので、JSON の `level` を JSON 側で見るのが確実。

pino のレベル値: `trace=10, debug=20, info=30, warn=40, error=50, fatal=60`

### スパム抑制

- LRU キャッシュ HIT 時は再ログしない (`errorMaxAge` 中の同 URL は最初の MISS で 1 回だけ)
- in-flight dedup HIT 時も再ログしない (先頭リクエストの結果共有)
- `info` レベルに落とした 4xx 系は priority filter で簡単に切れる

### URL の PII 保護

ログに出力される `url` は `${origin}${pathname}` のみ（query / fragment / basic auth は除去）。session ID / API token がクエリに乗っていても漏れない設計。

### 想定外エラーのセーフティネット

`bin/summaly-server.ts` で `app.setErrorHandler` を仕掛けてあり、summaly プラグイン外で発生した throw（404 ハンドラ未マッチ等）も `unhandled fastify error` として error レベルで残ります。

PDF 対応
----------------------------------------------------------------

`enablePdf: true` または環境変数 `SUMMALY_ENABLE_PDF=true` で `application/pdf` レスポンスからタイトル取得が有効化されます（デフォルト無効）。**関数オプションが環境変数より優先** されます（`enablePdf: false` を明示すれば環境変数 `true` を上書き可能）。

挙動:
- `pdf-parse` v2 の `getInfo()` で document-level metadata だけを読みます（本文ページ解析は走りません）
- 5 秒で hard timeout、`contentLengthLimit`（10 MiB デフォルト）で受信前にサイズ制限
- `useRange: true` と組み合わせると先頭領域のみ取得して帯域節約
- タイトル取得失敗 / timeout / 破損 PDF はホスト名にフォールバック + 固定の SVG PDF アイコン

デフォルト無効の理由:
- `pdf-parse` は内部に `pdfjs-dist`（約 30 MB）を抱えるため初回 PDF リクエストに数十ミリ秒の追加レイテンシが乗る
- PDF パースは CPU / メモリを消費するため運用者が「PDF を扱う／扱わない」を意識的に選ぶ設計

プラグインの絞り込み
----------------------------------------------------------------

`allowedPlugins` で組み込みプラグインをオプトイン許可リストで絞り込めます。

```jsonc
{
  // 全プラグイン有効（デフォルト）
  "allowedPlugins": undefined,

  // amazon と wikipedia だけ有効
  "allowedPlugins": ["amazon", "wikipedia"],

  // 組み込み全 disable（汎用パスのみで動作）
  "allowedPlugins": []
}
```

組み込みプラグイン名は [Plugins.md](Plugins.md#組み込みプラグイン詳細) の表参照。

### 性的コンテンツを含むサイトのプラグインを除外したい場合

`iwara` / `komiflo` / `nijie` / `dlsite` を除外:

```jsonc
{
  "allowedPlugins": [
    "amazon", "bluesky", "wikipedia", "branchio-deeplinks",
    "youtube", "spotify"
  ]
}
```

これらのサイトは `general()` パスで処理されますが、サイト構造によってはタイトル / description が取れない可能性があります。

### YouTube / Spotify の description を取りたい場合

`youtube` / `spotify` プラグインは oEmbed 直叩きで高速ですが、oEmbed には description フィールドが無いため `description: null` を返します。description（OG meta 由来）を取得したい場合は除外してください:

```jsonc
{
  "allowedPlugins": ["amazon", "bluesky", "wikipedia", "branchio-deeplinks"]
}
```

HTTP エージェント / プロキシ / IP family
----------------------------------------------------------------

### keep-alive デフォルト agent

`setAgent()` で外部 agent を設定していない限り、summaly は自前の **keep-alive 有効な `http.Agent` / `https.Agent`** を使います。高頻度プレビューでの TCP/TLS ハンドシェイクを節約します。

### IP family の強制

環境変数で IP family を固定できます（mei23 fork 互換）:

```bash
SUMMALY_FAMILY=4   # IPv4 のみ
SUMMALY_FAMILY=6   # IPv6 のみ
# 未設定 → システム任せ
```

### カスタム agent（プロキシ用途）

```javascript
import { setAgent } from 'summaly';
import { HttpsProxyAgent } from 'https-proxy-agent';

setAgent({ https: new HttpsProxyAgent('http://proxy:8080') });
```

⚠️ **`setAgent` で外部 agent を設定すると、プライベート IP 拒否（SSRF ガード）が無効になります**。プロキシ越しに任意 IP に到達する用途のためですが、信頼できないユーザーから URL を受け取る環境では使用前にリスク評価してください。

本番デプロイ例（nginx + systemd）
----------------------------------------------------------------

[docs/deploy-examples/](deploy-examples/) に以下のサンプルがあります（**動作保証なし、参考用**。OS / ディストリ / 配置構成に応じた読み替えが必要）:

- [summaly.nginx.conf.example](deploy-examples/summaly.nginx.conf.example) — nginx reverse proxy 設定
- [summaly.service.example](deploy-examples/summaly.service.example) — systemd unit（TOML 設定 + `bin/summaly-server.ts`）
- [summaly-config.example.toml](deploy-examples/summaly-config.example.toml) — **推奨**: TOML 設定例
- [summaly-config.example.json](deploy-examples/summaly-config.example.json) — DEPRECATED: 旧 fastify-cli `--options` 用 JSON。リリース 1 サイクル後に削除予定

### nginx + summaly 推奨構成

```nginx
proxy_cache_path /var/cache/nginx/summaly levels=1:2 keys_zone=summaly:10m max_size=1g inactive=7d;

upstream summaly_backend {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name summaly.example.com;
    # TLS 設定省略

    location / {
        proxy_pass http://summaly_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # summaly が返す Cache-Control を尊重
        proxy_cache summaly;
        proxy_cache_valid 200 7d;
        proxy_cache_valid 4xx 5xx 1h;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        add_header X-Cache-Status $upstream_cache_status;

        proxy_read_timeout 65s;
    }
}
```

`proxy_cache_use_stale` を設定しておくと、summaly や対象サイトが落ちても直近のキャッシュを返せて UX が下がりにくくなります。

SSRF / セキュリティ既定値
----------------------------------------------------------------

- **プライベート IP 拒否**: 対象 URL の解決先 IP が `127.0.0.0/8` / `10.0.0.0/8` / `192.168.0.0/16` 等の unicast でないアドレスなら 400 Bad Request。`ipaddr.js` で判定（IPv4-mapped IPv6 も展開）
- **レスポンスサイズ上限**: `contentLengthLimit`（デフォルト 10 MiB）。`content-length` ヘッダと受信中の `downloadProgress` 両方で検査
- **typeFilter**: スクレイピングは `text/html` / `application/xhtml+xml` のみ許可（`enablePdf: true` のとき `application/pdf` も追加）
- **結果 URL の sanitize**: `icon` / `thumbnail` / `player.url` / `medias[]` は `https:` / `http:` / `data:` <10KB のみ通過。`javascript:` / `file:` 等は `null` に置換
- **HTTP/2 無効**、リトライ無効
- **HEAD リクエストの maxRedirects: 5**（短縮 URL 解決時の SSRF チェイン緩和）

### テスト用エスケープ

`SUMMALY_ALLOW_PRIVATE_IP=true` でプライベート IP ガードを無効化できますが、**本番では絶対に有効化しないでください**。CI / 開発環境のローカルテスト専用の逃げ道です。

運用上の注意点
----------------------------------------------------------------

- **プロセス再起動の頻度**: インメモリキャッシュは再起動で消えます。長期運用では起動直後にキャッシュが冷えている時間帯があることを意識
- **メモリ消費の見積もり**: `inMemoryCacheMaxEntries: 1000` は数 MB 〜 数十 MB 程度。`description` が長い記事や `data:` URI thumbnail を含む結果が混じると上振れする可能性あり
- **タイムアウト調整**: 海外の重いサイトを扱うなら `responseTimeout` / `operationTimeout` を上げる。逆にレスポンス時間 SLA が厳しいなら下げる
- **PDF 機能の本番投入**: `enablePdf: true` を投入する前に、トラフィックの中で PDF URL がどれくらいの割合・サイズで来るかを確認してから判断
