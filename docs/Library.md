Library.md — ライブラリとしての利用
================================================================

summaly を **Node.js ライブラリとして直接 import** して使う場合のリファレンスです。

Fastify サーバとして運用する場合（Misskey 管理人など）は **[SETUP.md](SETUP.md)** を、組み込みプラグインの仕様やカスタムプラグインの書き方は **[Plugins.md](Plugins.md)** を参照してください。

インストール
----------------------------------------------------------------

```
npm install @misskey-dev/summaly
```

最小サンプル
----------------------------------------------------------------

```javascript
import { summaly } from 'summaly';

const summary = await summaly('https://www.youtube.com/watch?v=NMIEAhH_fTU');
console.log(summary);
```

出力例:

```json
{
  "title": "【アイドルマスター】「Stage Bye Stage」(歌：島村卯月、渋谷凛、本田未央)",
  "icon": "https://www.youtube.com/favicon.ico",
  "description": null,
  "thumbnail": "https://i.ytimg.com/vi/NMIEAhH_fTU/maxresdefault.jpg",
  "player": {
    "url": "https://www.youtube.com/embed/NMIEAhH_fTU?feature=oembed",
    "width": 200,
    "height": 113,
    "allow": ["autoplay", "clipboard-write", "encrypted-media", "picture-in-picture", "web-share", "fullscreen"]
  },
  "sitename": "YouTube",
  "activityPub": null,
  "fediverseCreator": null,
  "url": "https://www.youtube.com/watch?v=NMIEAhH_fTU"
}
```

複数画像を返すサイト（twitter プラグイン等）の出力例:

```json
{
  "title": "photog on X",
  "thumbnail": "https://pbs.twimg.com/media/img1.jpg",
  "medias": [
    "https://pbs.twimg.com/media/img1.jpg",
    "https://pbs.twimg.com/media/img2.jpg",
    "https://pbs.twimg.com/media/img3.jpg"
  ],
  "player": {
    "url": "https://platform.twitter.com/embed/Tweet.html?id=...",
    "width": 550,
    "height": 600,
    "allow": ["autoplay", "clipboard-write", "encrypted-media", "picture-in-picture", "web-share", "fullscreen"]
  },
  "sitename": "X",
  "sensitive": false,
  "url": "https://x.com/photog/status/..."
}
```

`summaly(url, opts?)` の `opts` はすべて optional。

opts (`SummalyOptions`) — ライブラリ利用時に効くオプション
----------------------------------------------------------------

下表のオプションは `summaly()` 関数を直接呼ぶときに参照されます。Fastify プラグインモード専用のオプション（`inMemoryCache` / `inFlightDedup` / `cacheMaxAge` / `parseFailureLog` 等）は `summaly()` に渡しても無視されます — 後述の「Fastify モード専用オプション」を参照。

| プロパティ | 型 | 説明 | デフォルト |
|:--|:--|:--|:--|
| **lang** | *string* | リクエストの `Accept-Language` | `null` |
| **followRedirects** | *boolean* | `summaly()` の **初期 HEAD/GET でリダイレクト解決をするか**。`KNOWN_SHORT_HOSTS` のホストは false でも HEAD/GET 解決される。本フラグは scrape 本体の HTTP リダイレクト follow には影響しない（後者は常に有効、`maxRedirects: 5` + プライベート IP ガードで抑制） | `true` |
| **plugins** | *SummalyPlugin[]* | カスタムプラグイン（組み込みより後ろに連結。詳細は [Plugins.md](Plugins.md)） | `null` |
| **userAgent** | *string* | リクエストの `User-Agent` | `SummalyBot/[version]` |
| **responseTimeout** | *number* | フェーズ単位のタイムアウト（DNS解決・接続・レスポンス各々）ミリ秒 | `20000` |
| **operationTimeout** | *number* | リクエスト全体のタイムアウト ミリ秒 | `60000` |
| **contentLengthLimit** | *number* | レスポンスサイズ上限（content-length ヘッダ + ストリーミング両方で検査） | `10485760` (10 MiB) |
| **contentLengthRequired** | *boolean* | true なら content-length 未返却サーバをエラー扱い | `false` |
| **agent** | *Got.Agents* | カスタム HTTP エージェント（プロキシ用途。設定するとプライベート IP 拒否は無効化される） | `null` |
| **allowedPlugins** | *string[]* | 利用許可するプラグイン名の配列。`undefined` で全有効、`[]` で組み込み全 disable | `undefined` |
| **useRange** | *boolean* | `Range: bytes=0-N-1` で先頭領域のみ取得して帯域節約（サーバ未対応時は通常 GET と同等にフォールバック） | `false` |
| **enablePdf** | *boolean* | PDF レスポンスのタイトル取得を有効化（5 層のハング対策付き）。`false` を明示すると環境変数 `SUMMALY_ENABLE_PDF=true` を上書きする | `undefined` |
| **fallbackUserAgent** | *string* | Bot block 検出時に UA を差し替えて 1 回だけ再試行する (phase11.9)。`undefined` または空文字列ならリトライ無効。`SummalyBot` 文字列を WAF が弾くサイトを `facebookexternalhit/1.1` 等で救援する用途 | `undefined` |
| **fallbackRetryCategories** | *SummalyErrorCategory[]* | `fallbackUserAgent` が発火するカテゴリ。デフォルトは `['bot_blocked', 'connection_dropped']` | `undefined` (= デフォルト) |
| **proxyFallback** | *ProxyFallbackConfig* | Cloudflare Workers proxy 経由の救援 (phase12.1)。UA fallback でも救えない IP レピュテーション層の遮断 (Vultr Tokyo IP からの amazon.co.jp 等) に対し、CF Workers 経由でリトライ。`{ enabled, url, secret, categories, domains, timeoutMs }`。Fastify モードでは `[scraping.proxy]` から自動注入。**phase16.3**: `categories` はコード側 default 固定 (`['origin_error', 'bot_blocked']`)、`domains` は bootstrap.jsonl から自動導出 (TOML キーは廃止 — [DEPRECATED.md](../DEPRECATED.md#scrapingproxycategories--domains--scrapingcurl_cfficategories--domains--scrapingfallbackcategories-phase163-で削除) 参照) | `undefined` |
| **curlCffiFallback** | *CurlCffiFallbackConfig* | curl_cffi (libcurl-impersonate) 経由の救援 (phase12.5)。proxy fallback でも救えない **TLS layer bot block** (yodobashi 級の HTTP/2 INTERNAL_ERROR / 即時切断) に対し、`tools/curl-cffi-fetcher/` の Python CLI を spawn して Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を偽装してリトライ。`{ enabled, uvPath, projectDir, impersonate, categories, domains, timeoutMs }`。Fastify モードでは `[scraping.curl_cffi]` から自動注入。**phase16.3**: `categories` / `domains` は同上のコード側固定 + bootstrap 自動導出。production server には別途 `uv` をインストール + `cd tools/curl-cffi-fetcher && uv sync` 必須 | `undefined` |
| **domainStrategyCache** | *DomainStrategyCacheOptions* | 経路学習キャッシュ設定 (phase14)。host + path prefix 1〜2 段ごとに「成功した取得経路」(`default` / `fallback_ua` / `proxy` / `curl_cffi`) を学習・JSONL 永続化し、次回以降のリクエストで第一選択肢として使う。`{ enabled, bootstrapPath?, runtimePath?, maxEntries?, consecutiveFailureThreshold?, compactionThreshold? }`。Fastify モードでは `[scraping.strategy_cache]` を書くだけで自動インスタンス化される。`scpaping()` に統合済 — cache hit fast path で cascade スキップ、cache miss は cascade tracking で自動学習、Summary 層で thin 判定して N 連続失敗で entry 破棄。bootstrap JSONL (`data/domain-strategy-bootstrap.jsonl`) を npm パッケージに同梱しており、yodobashi / sqex / amazon.co.jp /dp 等の経路は新規環境でも初日から最適化される。プラグインから旧 `forceCurlCffiFallback` / `forceProxyFallback` フラグへの移行は [DEPRECATED.md](../DEPRECATED.md#forcecurlcffifallback--forceproxyfallback-プラグインフラグ-phase14-step-4-で廃止) を参照 | `undefined` |
| **embedBaseUrl** | *string* | Fastify モード専用。`/embed?url=...` を経由したプレイヤー iframe 用 HTML を返す自身の公開 URL ベース (phase13.1)。設定すると、対応プラグイン (`syosetu` / `kakuyomu`) が Summary の `player.url` を `<embedBaseUrl>/embed?url=<encoded>` で組み立てる。`[server].publicUrl` から自動投入。library mode では参照されない | `undefined` |
| **embedConfig** | *{ enabled, allowedPlugins, frameAncestors }* | Fastify モード専用。`/embed` エンドポイントの有効化 + プラグイン allowlist + CSP `frame-ancestors` (phase13.1)。`[embed]` TOML から自動投入。`enabled = false` で `/embed` が 404 を返し player.url も生成しない (完全無効化、fail-close)。詳細は `docs/SETUP.md` の `[embed]` 節参照 | `undefined` |

### 環境変数

| 変数 | 効果 |
|:--|:--|
| `SUMMALY_ALLOW_PRIVATE_IP=true` | プライベート IP 宛のリクエストを許可（テスト用） |
| `SUMMALY_FAMILY=4` / `=6` | IP family を強制 |
| `SUMMALY_ENABLE_PDF=true` | `enablePdf` 未指定時のフォールバック |

### Fastify モード専用オプション

下記オプションは `fastify.register(Summaly, opts)` 経由でのみ意味を持ちます。`summaly()` 関数に渡しても何もしません。詳細は [SETUP.md](SETUP.md) 参照。

| プロパティ | 説明 |
|:--|:--|
| `cacheMaxAge` / `cacheErrorMaxAge` | レスポンスの `Cache-Control` ヘッダ |
| `inMemoryCache` / `inMemoryCacheMaxEntries` | プロセス内 LRU キャッシュ |
| `inFlightDedup` | 同一 URL の並列リクエストを 1 本化 |
| `parseFailureLog` / `parseFailureLogMaxGroups` / `parseFailureLogSamplesPerGroup` / `parseFailureLogJsonlPath` / `parseFailureLogJsonlMaxBytes` | パース失敗ドメインのログ集約 + JSONL 永続化 |
| `parseFailureLogBlockedJsonlPath` / `parseFailureLogBlockedJsonlMaxBytes` | 迂回候補ログ JSONL (phase11.6)。4xx/5xx・timeout・SSRF block 等の「フィルタ対象」失敗を別ファイルに集約。「公開 HTML はブロックだが別 API で同等情報が取れる」パターン発見用 |

戻り値
----------------------------------------------------------------

ほぼ全フィールドが nullable です（`player` のみ非 null）。

### `SummalyResult`

| プロパティ | 型 | 説明 |
|:--|:--|:--|
| **title** | *string* \| *null* | ページのタイトル |
| **icon** | *string* \| *null* | ページのアイコン URL |
| **description** | *string* \| *null* | ページの説明 |
| **thumbnail** | *string* \| *null* | ページのサムネイル URL。汎用パスでは og:image / twitter:image / image_src / apple-touch-icon の順で探し、いずれも無い場合は HEAD 検証済みの favicon を採用する (phase11.7)。`thumbnail === icon` のとき favicon フォールバックが発動した状態 |
| **sitename** | *string* \| *null* | サイト名 |
| **player** | *Player* | 埋め込みプレーヤー情報 |
| **sensitive** | *boolean* | 成人向け等、機微なコンテンツの可能性 |
| **activityPub** | *string* \| *null* | ページの ActivityPub 表現の URL |
| **fediverseCreator** | *string* \| *null* | Fediverse の作者ハンドル |
| **medias** | *string[]* \| *undefined* | 追加メディア URL（マルチ写真投稿等）。設定があれば `medias` を優先、無ければ `thumbnail` を使う想定 |
| **url** | *string* | リダイレクト解決後の最終的なページ URL |

### `Summary`

`Omit<SummalyResult, "url">`。プラグインの `summarize()` が返す型。`summaly()` のラッパが解決後の `url` を付与して `SummalyResult` を生成する。

### `Player`

| プロパティ | 型 | 説明 |
|:--|:--|:--|
| **url** | *string* \| *null* | プレーヤーの URL（iframe `src`） |
| **width** | *number* \| *null* | プレーヤーの幅 |
| **height** | *number* \| *null* | プレーヤーの高さ |
| **allow** | *string[]* | iframe に許可する permissions |

`allow` に入りうる値: `autoplay` / `clipboard-write` / `fullscreen` / `encrypted-media` / `picture-in-picture` / `web-share`。詳細は MDN の [Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Permissions_Policy) 参照。

Fastify プラグインとして
----------------------------------------------------------------

`fastify.register` でも利用できます（`GET /` を受ける）:

```javascript
import Summaly from 'summaly';
await fastify.register(Summaly, {
  // 上記 SummalyOptions に加えて Fastify モード専用オプションを指定可能
  inMemoryCache: true,
  inFlightDedup: true,
  cacheMaxAge: 604800,
});
```

スタンドアロン HTTP サーバとして起動・運用する詳細（TOML 設定 / nginx + systemd / パース失敗ログ等）は **[SETUP.md](SETUP.md)** を参照。

### Fastify モードのエラーレスポンス (phase11.2)

`summaly()` が throw すると Fastify ハンドラが 500 と JSON ボディを返します。失敗理由を機械可読に区別するため `error.category` を含みます:

```jsonc
{
  "error": {
    "category": "bot_blocked",     // SummalyErrorCategory
    "message": "403 Forbidden",
    "name": "StatusError",
    "statusCode": 403              // StatusError のときのみ
  }
}
```

| `category` | 意味 | 典型例 |
|:--|:--|:--|
| `timeout` | 取得タイムアウト / abort | got の `TimeoutError`、`responseTimeout` 超過 |
| `bot_blocked` | 4xx (404 以外) | Akamai/Cloudflare の 403、429 Too Many Requests |
| `not_found` | 404 | リンク切れ / ASIN 廃番 |
| `origin_error` | 5xx | 上流障害 |
| `unsupported_type` | typeFilter で reject | 非 HTML レスポンス（`enablePdf: false` での PDF 等） |
| `content_too_large` | `contentLengthLimit` 超過 (デフォルト 10 MiB) | 巨大 HTML、`useRange` 推奨 |
| `ssrf_blocked` | プライベート IP 拒否 | `192.168.*` 等 (ガード有効時)、IP パース失敗の `Invalid IP` も含む |
| `network_error` | DNS 失敗 / 接続拒否 | `ENOTFOUND` / `ECONNREFUSED` |
| `connection_dropped` | TCP/TLS 後の HTTP 応答前切断 (phase11.9) | `socket hang up` / `EPIPE` / `ECONNRESET` / WAF 黙殺 |
| `parse_error` | summarize null / cheerio 失敗 | `failed summarize` |
| `unknown` | 上記いずれにも該当しない | catch-all |

既存の `error.message` / `error.name` も維持しており、`category` を見ない実装は単に無視するだけ（後方互換）。Misskey 等の UI でカテゴリ別メッセージを出し分ける用途を想定しています。

カスタムエージェント / プロキシ
----------------------------------------------------------------

`setAgent()` で global agent を差し込めます（プロキシ経由で外向き通信したい場合）:

```javascript
import { setAgent } from 'summaly';
import { HttpsProxyAgent } from 'https-proxy-agent';

setAgent({
  https: new HttpsProxyAgent('http://proxy.example.com:8080'),
});
```

**`setAgent` を呼ぶと SSRF 対策のプライベート IP ガードが解除されます**（プロキシ前段で別途制御する想定）。`opts.agent` も同じ挙動です。
