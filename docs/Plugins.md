Plugins.md — プラグイン詳細
================================================================

summaly のプラグインシステムと、組み込み 14 プラグインの仕様、カスタムプラグインの書き方をまとめます。

目次
----------------------------------------------------------------

- [プラグインインターフェース](#プラグインインターフェース)
- [マッチング・ディスパッチの流れ](#マッチング・ディスパッチの流れ)
- [組み込みプラグイン詳細](#組み込みプラグイン詳細)
  - [amazon](#amazon)
  - [bluesky](#bluesky)
  - [wikipedia](#wikipedia)
  - [branchio-deeplinks](#branchio-deeplinks)
  - [youtube](#youtube)
  - [spotify](#spotify)
  - [twitter (X)](#twitter-x)
  - [dlsite](#dlsite)
  - [iwara](#iwara)
  - [komiflo](#komiflo)
  - [nijie](#nijie)
  - [npmjs](#npmjs)
  - [nintendo-store](#nintendo-store)
  - [yodobashi](#yodobashi)
  - [sqex](#sqex)
- [カスタムプラグインの書き方](#カスタムプラグインの書き方)
- [共通ユーティリティ](#共通ユーティリティ)

プラグインインターフェース
----------------------------------------------------------------

```typescript
interface SummalyPlugin {
  /** プラグイン名。allowedPlugins 等のキーやキャッシュキー用に利用する。
   *  組み込みプラグインではファイル名（拡張子なし）と一致させる。
   *  既存外部プラグインの破壊的変更を避けるため optional。 */
  name?: string;

  /** URL がこのプラグインで処理可能かを判定。test() は副作用なし・URL のみで判定する軽量な処理にする。 */
  test: (url: URL) => boolean;

  /** 実際の取得処理。Summary を返す。マッチしたが処理失敗（null）は呼び元で `failed summarize` として throw される。 */
  summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;

  /** `summaly()` 冒頭の `resolveRedirect` (HEAD/GET probe) を **スキップさせる宣言** (phase12.5)。
   *  `true` を宣言すると、初期 URL がこのプラグインの `test()` にマッチした場合に限り
   *  HEAD/GET probe を完全スキップする。**TLS layer で bot 切断するサイト + URL が終端確定**
   *  (短縮 URL でない、リダイレクト不要) のケースで HEAD probe が timeout で空回りする純損失を回避。
   *  短縮 URL を扱うプラグイン (`amazon` の `amzn.asia` / `branchio-deeplinks` 等) では絶対に true にしないこと。 */
  skipRedirectResolution?: boolean;
}
```

`Summary` 型は [README.md](../README.md#summalyresult) の `Omit<SummalyResult, "url">` を参照。

マッチング・ディスパッチの流れ
----------------------------------------------------------------

`summaly(url, opts)` の処理順:

1. **初期 URL でプラグインを事前マッチング**: `skipRedirectResolution = true` を宣言したプラグインが初期 URL にマッチする場合は、次ステップの `resolveRedirect` をスキップする (phase12.5)
2. `opts.followRedirects` が true、または URL のホストが `KNOWN_SHORT_HOSTS`（`youtu.be` / `amzn.asia` / `amzn.to` / `a.co` / `t.co` / `bit.ly` 等）に含まれるなら **`resolveRedirect()`** でリダイレクトを解決 (ステップ 1 でスキップが宣言されていなければ):
   - まず HEAD を試す（軽量、body を受信しない）
   - HEAD が失敗した場合は GET に fallback (`Range: bytes=0-0` で body 受信を最小化)。`amzn.asia` のように HEAD に 404 を返すが GET には 301 を返すサーバ向け (phase9.1)
   - どちらも失敗した場合は元の URL のまま続行
3. プラグイン配列を順に走査して `test(url)` が `true` を返す **最初の** プラグインを採用
4. プラグイン配列の構築順:
   1. 組み込みプラグイン（`allowedPlugins` が指定されていれば `name` で絞り込み）
   2. `opts.plugins` で渡されたカスタムプラグイン（フィルタ対象外）
5. マッチしたプラグインの `summarize(url, scrapingOptions)` を呼ぶ。マッチが無ければ汎用パス `general()` を呼ぶ
6. 結果の URL フィールド（`icon` / `thumbnail` / `player.url` / `medias[]`）を `sanitizeUrl()` でフィルタ（`https:` / `http:` / `data:` <10KB のみ通す）

組み込みプラグインの登録順は [src/plugins/index.ts](../src/plugins/index.ts) で確認できます。**順序が重要** で、`spotify.link` と `open.spotify.com` のように似たホストを扱うプラグインは登録順で結果が変わる可能性があるため注意。

組み込みプラグイン詳細
----------------------------------------------------------------

### amazon

実装: [src/plugins/amazon.ts](../src/plugins/amazon.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(?:www\.)?amazon\.{com, co.jp, ca, com.br, com.mx, co.uk, de, fr, it, es, nl, cn, in, au}` (bare / www 両形式、phase12.1 followup #3) + `amzn.asia` / `amzn.to` / `a.co` (短縮、phase12.1 followup #4) |
| 取得方法 | `scpaping()` で HTML を取得し、DOM + OG meta tag から抽出 |
| 抽出フィールド | `title` ← `#title` または `meta[property=og:title]`、`description` ← `#productDescription` / `og:description` / `meta[name=description]`、`thumbnail` ← `#landingImage[src]` または `og:image`、`player` ← `meta[property=twitter:player]` 系 |
| 固定値 | `sitename: 'Amazon'`、`icon: 'https://www.amazon.com/favicon.ico'` |
| 備考 | `general` を経由しない独自実装。**proxy fallback 対応** (phase12.1) で Vultr Tokyo IP block を救援 |
| **URL 正規化** (phase12.1 followup) | `normalizeAmazonUrl()` で `/<slug>/dp/<asin>/?ref_=...` を `https://www.amazon.<TLD>/dp/<ASIN>` の canonical 形に揃える。query / fragment / SEO slug を全部削り、bare hostname → `www.` 付きに統一。長 query が CF Workers proxy 経由でも 500 を返すケースへの対処 |
| **短縮 URL の 2 段取得** (phase12.1 followup #4) | `amzn.asia/d/<id>` は path から ASIN を抽出できないため、一度 `scpaping()` → `response.url` から ASIN 抽出 → canonical 形で再 `scpaping()`。Vultr 直叩きでは Amazon が 200 + 軽量 preview HTML (`og:image=previewdoh.png`) を返すケースがあるため、final URL から ASIN が取れない場合は preview HTML をそのままパースして fallback |
| **詳細** | [docs/knowhow/amazon-url-normalization.md](knowhow/amazon-url-normalization.md) — Amazon プラグイン特有の URL ハンドリング知見 |

### bluesky

実装: [src/plugins/bluesky.ts](../src/plugins/bluesky.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `bsky.app` |
| 取得方法 | HEAD だと 404 になるため **GET のみ** で取得し、`parseGeneral()` に流す |
| 抽出フィールド | `general` と同じ OG / Twitter Card ロジック |

### wikipedia

実装: [src/plugins/wikipedia.ts](../src/plugins/wikipedia.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `*.wikipedia.org`（サブドメインを言語コードとして抽出） |
| 取得方法 | スクレイピングではなく MediaWiki API: `https://<lang>.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&exintro=&explaintext=&titles=<title>` |
| 抽出フィールド | `description` は intro テキストを 300 文字で `clip` |
| 固定値 | `icon`・`thumbnail`・`sitename` |

### branchio-deeplinks

実装: [src/plugins/branchio-deeplinks.ts](../src/plugins/branchio-deeplinks.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `<sub>.app.link`（任意のサブドメイン）, `spotify.link` |
| 取得方法 | クエリに `$web_only=true` を付与して branch.io 独自ページではなく実際の Web ページにリダイレクトさせ、`general()` に委譲 |
| 備考 | `spotify.link` 着地後の `open.spotify.com` は別の `spotify` プラグインが拾う |

### youtube

実装: [src/plugins/youtube.ts](../src/plugins/youtube.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(www\|m).youtube.com/{watch,v,playlist,shorts}`、`youtube.com/...`（裸ドメイン）、`youtu.be/<id>` |
| 取得方法 | `https://www.youtube.com/oembed?url=<encodeURIComponent(url.href)>` を `getJson` で 1 リクエスト取得 |
| 検証 | `j.type === 'video'` かつ `j.html` 内 iframe の `src` が `https:` プロトコルであること（`new URL(src).protocol` で厳密チェック） |
| 抽出フィールド | `title` / `thumbnail` / `player.{url,width,height}` を oEmbed から、`player.allow` は固定の [`PLAYER_ALLOW_OEMBED`](#共通ユーティリティ) |
| 固定値 | `icon: 'https://www.youtube.com/favicon.ico'`、`sitename: 'YouTube'`、`description: null`（oEmbed には description 無し） |
| 短縮 URL | `youtu.be` は `KNOWN_SHORT_HOSTS` に含まれるため Fastify モード（`followRedirects: false`）でも HEAD で `youtube.com/watch?v=...` に解決される |
| ヘルパ export | `buildSummaryFromOEmbed(oEmbed: unknown): Summary \| null` をテスト容易化のため export |

### spotify

実装: [src/plugins/spotify.ts](../src/plugins/spotify.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `open.spotify.com` のみ（`spotify.link` は `branchio-deeplinks` 担当） |
| 取得方法 | `https://open.spotify.com/oembed?url=<encodeURIComponent(url.href)>` を `getJson` で取得 |
| 検証 | `j.html` 内 iframe の `src` が `https:` プロトコルであること |
| 抽出フィールド | `title` / `thumbnail` / `provider_name` (→ `sitename`) を oEmbed から、`player.allow` は固定の `PLAYER_ALLOW_OEMBED` |
| 固定値 | `icon: 'https://open.spotify.com/favicon.ico'`、`description: null` |
| ヘルパ export | `buildSummaryFromOEmbed(oEmbed: unknown): Summary \| null` |

### twitter (X)

実装: [src/plugins/twitter.ts](../src/plugins/twitter.ts)

> ⚠ **メンテナンス要注意プラグイン**: X 内部 CDN (`cdn.syndication.twimg.com`、公開 API ではない) と公式 widget の token 算出ロジックを逆算して利用しているため、**X 側仕様変更で予告なく壊れる**。動作不要なら `allowedPlugins` から `twitter` を除外してください。元実装は mei23 fork ([worktrees/mei-summaly/src/plugins/twitter.ts](../worktrees/mei-summaly/src/plugins/twitter.ts))。

| 項目 | 内容 |
|:--|:--|
| マッチ | `(twitter\|x).com/<user>/status/<id>` のみ（プロフィール / リスト等は対象外） |
| 取得方法 | `https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<token>&lang=en` を `getJson` で取得（referer に `https://platform.twitter.com/embed/index.html` を指定して anti-abuse 通過率を上げる） |
| token 算出 | `(Number(id) / 1e15) * Math.PI` を 36 進数化し `0` と `.` を除去（公式 widget の minified JS を逆算した黒魔術） |
| description | `text` から `entities.media[0].indices[0]` で本文末尾の t.co 短縮 URL を切り落とす |
| thumbnail | `video.poster` → `photos[0].url` → `user.profile_image_url_https`（`_normal.` を除去してオリジナル）の優先順位 |
| medias | `photos[*].url` を全て返す（複数画像ツイートの全画像表示用） |
| player | **常に null**。Misskey 側に「ポストを展開する」機能があり、summaly が iframe player を返すと表示が二重化するため返さない（mei23 オリジナル準拠） |
| sitename | 固定値 `'X'` |
| sensitive | `j.possibly_sensitive ?? false` |
| 固定値 | `icon: 'https://abs.twimg.com/favicons/twitter.3.ico'` |
| ヘルパ export | `buildSummary(id, json): Summary \| null`、`calcToken(idStr): string` |

### dlsite

実装: [src/plugins/dlsite.ts](../src/plugins/dlsite.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `www.dlsite.com` |
| 取得方法 | `general(url)` を呼び、`StatusError.statusCode === 404` のとき `/announce/` ↔ `/work/` を入れ替えて 1 度だけリトライ（無限ループ防止のフラグあり） |
| sensitive 判定 | 結果 URL のパスが `/(home\|comic\|soft\|app\|ai)/` のどれにも該当しなければ `sensitive = true` |

### iwara

実装: [src/plugins/iwara.ts](../src/plugins/iwara.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(www\|ecchi).iwara.tv`（正規表現 `/(^\|\.)iwara\.tv$/`） |
| 取得方法 | `scpaping → parseGeneral → enrichWithIwara` パターン |
| description 補完 | `parseGeneral` が `description: null` のとき `.field-type-text-with-summary` の `.text()` を 500 文字 `clip`（cheerio の `.text()` は HTML エンティティをデコード済みなので `decodeHtml` は重ねない） |
| thumbnail 補完 | `#video-player[poster]` または `.field-name-field-images a:first[href]` を `new URL(.., landingUrl)` で解決 |
| sensitive 判定 | `landingUrl.hostname === 'ecchi.iwara.tv'` のとき `true` |
| ヘルパ export | `enrichWithIwara(summary, $, landingUrl): Summary` |

### komiflo

実装: [src/plugins/komiflo.ts](../src/plugins/komiflo.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `komiflo.com` |
| 取得方法 | `scpaping → parseGeneral` の後、URL が `/comics/<id>` 形式かつ thumbnail が null か `favicon\|ogp_logo` フォールバック時のみ `https://api.komiflo.com/content/id/<id>` を `getJson(apiUrl, refererUrl)` で取得 |
| 抽出 | `named_imgs.cover.filename` と `variants` に `'346_mobile'` がある場合に `https://t.komiflo.com/346_mobile/<filename>` を thumbnail に採用 + `sensitive = true` |
| 失敗時 | 例外は静かに握りつぶしてフォールバック（library として `console.log` には出さない） |
| メンテリスク | `346_mobile` variant 固定。komiflo 側仕様変更で陳腐化しうる |
| ヘルパ export | `extractCoverFilename(api: unknown): string \| null` |

### nijie

実装: [src/plugins/nijie.ts](../src/plugins/nijie.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `nijie.info` |
| 取得方法 | `scpaping → parseGeneral → enrichWithNijie` パターン |
| 動作条件 | `landingUrl.pathname === '/view.php'` のときのみ動作 |
| 抽出 | `<script type="application/ld+json">` 全件を走査して `@type === 'ImageObject'` のものから `thumbnailUrl` / `description` を採用 |
| エスケープ | JSON-LD に生制御文字（`\n` / `\r` / `\t` 等 U+0000-U+001F）が含まれるため、Unicode エスケープに置換してから `JSON.parse` |
| sensitive 判定 | `view.php` 着地で `true` |
| ヘルパ export | `enrichWithNijie(summary, $, landingUrl): Summary` |

### npmjs

実装: [src/plugins/npmjs.ts](../src/plugins/npmjs.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(www.)?npmjs.com/package/...` |
| 取得方法 | `getJson('https://registry.npmjs.org/<pkg>')` で Registry API JSON 直叩き（HTML スクレイプは行わない） |
| 動作 | `dist-tags.latest` の `name` / `description` から Summary を組み立てる |
| description フォールバック | トップレベル `description` → `versions[latest].description` → null |
| サブパス対応 | `/package/<pkg>/v/<ver>` `/tutorial` `/security` 等のサブパスでも latest の Summary を返す（簡素化優先） |
| scope 対応 | `/package/@scope/name` は `@scope%2Fname` の形で registry URL を組み立てる |
| 固定値 | `sitename: 'npm'`、icon/thumbnail は `https://static-production.npmjs.com/58a19602036db1daee0d7863c94673a4.png`（120×120 PNG） |
| 背景 | `www.npmjs.com` は Cloudflare Bot Management で正規 bot UA を含めて 403 を返すが、`registry.npmjs.org` は素通しで `application/json` を返す。X / Discord の OG カードは verified bot の IP allowlist 経由で表示されており、HTTP レイヤでは突破不可 |
| ヘルパ export | `extractPackageName(pathname)` / `buildRegistryUrl(pkg)` / `buildSummaryFromRegistry(body)` |

### nintendo-store

実装: [src/plugins/nintendo-store.ts](../src/plugins/nintendo-store.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `store(?:-<TLD>)?\.nintendo\.com` (`store-jp.nintendo.com` / `store-us.nintendo.com` / `store.nintendo.com` 等) |
| 取得方法 | UA を `facebookexternalhit/1.1` に **固定** して `scpaping()` → `parseGeneral()` に流す |
| 抽出フィールド | `parseGeneral` 経由なので OG / Twitter Card 標準ロジック (`og:title` / `og:image` / `og:description` / `og:site_name`) |
| 背景 | Akamai Bot Manager の JS challenge 配下だが、Nintendo は **`facebookexternalhit` / `Slackbot-LinkExpanding` UA を allowlist** している (= SNS share を意図的に許可)。SummalyBot UA や Twitterbot / Discordbot UA だと `*-wr.nintendo.com/?c=ncl&...&kupver=akamai-5.0.1` の challenge ページにリダイレクトされる |
| 倫理判断 | phase11.9 fallback UA と同じ倫理判断: SNS bot UA を名乗るのは「OGP 取得が目的」なので Nintendo の意図に沿う |
| 副作用 | プラグイン内で `fallbackUserAgent` / `fallbackRetryCategories` を **明示的に未設定** にして UA 上書きが発生しないようにしている |

### yodobashi

実装: [src/plugins/yodobashi.ts](../src/plugins/yodobashi.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(?:www\.)?yodobashi\.com` (anchored) |
| 取得方法 | `scpaping()` → `parseGeneral()`。**経路学習キャッシュ + bootstrap で curl_cffi 直行** (phase14 Step 3+4): `data/domain-strategy-bootstrap.jsonl` に `yodobashi.com → curl_cffi` エントリが入っているため Fastify モードで cache 有効なら scpaping 冒頭の cache hit fast path で curl_cffi が直接呼ばれる。さらに `skipRedirectResolution = true` で `summaly()` 冒頭の HEAD/GET probe をスキップ (TLS 切断する HEAD の空回り回避)。phase12.5 Step 2 / followup #3 で導入した `forceCurlCffiFallback` / `proxyFallback: undefined` フラグは phase14 Step 4 で廃止 |
| 抽出フィールド | `parseGeneral` 経由 (OG / Twitter Card 標準) |
| 背景 | yodobashi は **TLS / HTTP/2 レイヤで bot を能動切断**する。Vultr Tokyo IP は `category: "timeout"`、ローカル MacOS は `HTTP/2 stream INTERNAL_ERROR` (即時 RST、time<0.05s) で SummalyBot / ブラウザ UA / 各種 SNS bot UA すべて弾かれる (skill `/url-preview-check` の Phase 3 fail mode H)。HEAD probe も同じく TLS 切断で空回りするため、URL が終端確定 (短縮 URL でない) であることを利用して `skipRedirectResolution = true` で probe 自体をスキップする (本番実証 21 秒 → 数秒に短縮、phase12.5 followup #2) |
| なぜ curl_cffi なのか | **CF Workers fetch も TLS フィンガープリント固定**なので yodobashi 側で構造的に弾かれる。curl_cffi (libcurl-impersonate) で Chrome の TLS フィンガープリント (JA3) を偽装することだけが正解 (phase12.4 → phase12.5 で確認) |
| 運用要件 | production server に `uv` + `tools/curl-cffi-fetcher/` の `uv sync` 必須。`config.toml` の `[scraping.curl_cffi]` で `enabled = true` + `domains = ["yodobashi.com"]`、`[scraping.strategy_cache]` で `enabled = true` (デフォルト)。curl_cffi 未設定なら cache fast path がゲート不通過で通常 scpaping にフォールスルー (= 失敗するが破壊的ではない) |
| 実証 | 本番 (riinswork.space) で `https://www.yodobashi.com/product/100000001009727358/` のプレビュー取得確認 (2026-05-06、phase12.5 Step 2 完了後) |

### sqex

実装: [src/plugins/sqex.ts](../src/plugins/sqex.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(?:www\.)?store\.jp\.square-enix\.com` (anchored) |
| 取得方法 | `scpaping()` → `parseGeneral()`。**経路学習キャッシュ + bootstrap で proxy 直行** (phase14 Step 3+4): `data/domain-strategy-bootstrap.jsonl` に `store.jp.square-enix.com → proxy` エントリが入っているため Fastify モードで cache 有効なら scpaping 冒頭の cache hit fast path で proxy が直接呼ばれる。phase12.6 で導入した `forceProxyFallback` フラグは phase14 Step 4 で廃止 |
| 抽出フィールド | `parseGeneral` 経由 (OG / Twitter Card 標準) |
| 背景 | Square Enix e-STORE はデータセンター IP レンジ全般を CDN 段で広く弾く。Vultr Tokyo IP からは **HTTP/200 + `text/html;charset=utf-8` + 正規 404 ページボディ** が返ってくるため、`got` レイヤでは何のエラーも発生しない (= phase12.1 の `getResponseWithProxyFallback` のエラー発火型では救援できない、新パターン)。サーバ HTML には完璧な OGP (`og:title` / `og:description` / `og:image` / `og:site_name`) が入っているので、proxy 経由で IP を変えれば取得できる |
| 短縮 URL | `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決可能 (CloudFront 経由)。`summaly()` 冒頭の resolveRedirect で展開 → このプラグインがマッチ |
| 運用要件 | `[scraping.proxy]` で `enabled = true` + `domains` に `store.jp.square-enix.com` を含む。CF Worker (`tools/cf-proxy-worker/wrangler.toml`) の `ALLOWED_DOMAINS` にも同 host 必須。`[scraping.strategy_cache]` で `enabled = true` (デフォルト)。proxy が未設定な環境では cache fast path がゲート不通過で通常段階に fallthrough (= 404 ページが返る) |

### syosetu (小説家になろう)

実装: [src/plugins/syosetu.ts](../src/plugins/syosetu.ts) / [src/utils/syosetu-genres.ts](../src/utils/syosetu-genres.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `(?:ncode|novel18)\.syosetu\.com` (anchored) + path に ncode (`n[0-9]+[a-z][0-9a-z]*` 形式)。chapter URL `/<ncode>/<chapter>/` も作品レベルの ncode に集約してマッチ |
| 取得方法 | なろう公式 API (`api.syosetu.com/{novelapi|novel18api}/api/?ncode=<ncode>&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k`) を `getJson` で直叩き。HTML スクレイプを使わない (= PV カウント影響無し、UA 偽装不要) |
| 抽出フィールド | API レスポンス `[{allcount}, novelData]` から title / writer / story / biggenre / genre / novel_type / end / isr15 / iszankoku / isbl / isgl / keyword を抽出 |
| card style description | `composeDescription`: `作者: <writer> / <ジャンル名> / <連載中\|完結\|短編> / [R-15] [残酷描写] [BL] [GL] / あらすじ: <story 80 文字 clip>` を 1 行整形 |
| embed (renderEmbed) | `composeEmbedHtml`: 完全な HTML5 ドキュメント (タイトル / 作者 / ジャンル + 状態 / マーカー / タグ上位 5 件 / あらすじ 300 文字 clip) を返す。**全フィールド `escapeHtml` で entity 化** + CSP `default-src 'none'` (Step 1) で二重 XSS 防御 |
| R-18 | `novel18.syosetu.com` ドメインで `sensitive: true` + sitename `'ノクターンノベルズ / ムーンライトノベルズ'` に切替。API も `/novel18api/` に切替 |
| ジャンル ID | `src/utils/syosetu-genres.ts` の `BIG_GENRE_NAMES` / `GENRE_NAMES` で大ジャンル + ジャンル ID → 表示名を変換。未知 ID は `'その他'` フォールバック |
| 運用要件 | Fastify モードで `[plugins].allowed` に `"syosetu"`、embed 機能を使う場合は `[server].publicUrl` (https only) + `[embed].enabled = true` + `allowedPlugins = ["syosetu"]` 設定。library mode では player.url=null で card style のみ動作 |
| 実装メモ | `n[0-9]+[a-z][0-9a-z]*` の正規表現で `/novelview/` `/ncode/` 等の他パスを構造的に除外 (phase13.1 W-1)。chapter URL の本文取得は API に存在しないため作品見出しと同じ Summary を返す (Plan で割り切り) |

### kakuyomu (カクヨム)

実装: [src/plugins/kakuyomu.ts](../src/plugins/kakuyomu.ts) / [src/utils/kakuyomu-genres.ts](../src/utils/kakuyomu-genres.ts)

| 項目 | 内容 |
|:--|:--|
| マッチ | `kakuyomu.jp` (anchored) + path `/works/<id>` または `/works/<id>/episodes/<eid>` (id は数値) |
| 取得方法 | カクヨムには公式 API が無いため、HTML 内の `<script id="__NEXT_DATA__" type="application/json">` の Apollo (Relay 風) 正規化キャッシュ JSON を parse して `Work:<id>` エンティティを取得。`Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (phase12.3 nintendo-store と同類) |
| 抽出フィールド | Work エンティティから title / catchphrase / introduction / genre (enum 文字列) / serialStatus (`RUNNING`/`COMPLETED`) / publicEpisodeCount / totalCharacterCount / isCruel / isSexual / isViolent / tagLabels / ogImageUrl / lastEpisodePublishedAt を抽出。author は `{__ref:"UserAccount:<id>"}` 経由で別エンティティから name を lookup |
| card style description | `composeDescription`: `作者: <name> / <ジャンル名> / 連載中 (169話) / [残酷描写] [性的描写] [暴力描写] / あらすじ: <catchphrase or introduction の 80 文字 clip>` を 1 行整形 |
| embed (renderEmbed) | `composeEmbedHtml`: 完全な HTML5 ドキュメント (タイトル / 作者 / ジャンル + 状態 + 文字数 + マーカー / あらすじ 300 文字 clip / タグ上位 5 件 / 最終話日付) を返す。**全フィールド `escapeHtml` で entity 化** + CSP `default-src 'none'` で二重 XSS 防御 |
| サムネ | `Work.ogImageUrl` (`cdn-static.kakuyomu.jp/works/<id>/ogimage.png`) を `Summary.thumbnail` に採用。作品ごとのカスタムサムネが取れるためなろうのサイトロゴ固定より見栄え良い |
| R-18 / sensitive | `Work.isSexual === true` で `sensitive: true` を返す。`isCruel` / `isViolent` は description にマーカー表示するが sensitive flag には含めない (なろう基準と揃える) |
| ジャンル enum | `src/utils/kakuyomu-genres.ts` の `GENRE_NAMES` で `LOVE_STORY` / `FANTASY` / `SF` 等 → 日本語表示名を変換。未知 enum は `'その他'` フォールバック (本番ログから収集して都度補強) |
| chapter URL の扱い | episode URL でも作品トップ (`/works/<id>`) から Work data を取得。episode 個別 HTML を別途叩いて `og:title` (= `<EpisodeTitle> - <WorkTitle> - カクヨム`) から各話タイトルだけ抽出し、card description 末尾に「`/ <各話タイトル>`」を付与 (なろう phase13.1 chapter 対応と同パターン) |
| 運用要件 | Fastify モードで `[plugins].allowed` に `"kakuyomu"`、embed 機能を使う場合は `[server].publicUrl` (https only) + `[embed].enabled = true` + `allowedPlugins = ["kakuyomu"]` (or syosetu と併記) 設定。library mode では player.url=null で card style のみ動作 |
| 実装メモ | Apollo state は深いネストを持つため `findWorkInApolloState` / `lookupAuthorName` で再帰探索 + `WeakSet` 循環参照ガード。`__NEXT_DATA__` の構造変更で parse 不能になったらプラグインが null を返すので最終的に汎用 OGP 経路にフォールバック (kakuyomu.jp の OGP は完備) |

カスタムプラグインの書き方
----------------------------------------------------------------

```typescript
import type { SummalyPlugin } from '@misskey-dev/summaly';
import { summaly } from '@misskey-dev/summaly';

const myPlugin: SummalyPlugin = {
  name: 'mysite',
  test: (url) => url.hostname === 'mysite.example.com',
  summarize: async (url, opts) => {
    return {
      title: 'My Site',
      icon: 'https://mysite.example.com/favicon.ico',
      description: '...',
      thumbnail: null,
      sitename: 'My Site',
      player: { url: null, width: null, height: null, allow: [] },
      activityPub: null,
      fediverseCreator: null,
      // 複数画像を返したい場合は medias を追加（利用側は medias 優先、無ければ thumbnail）
      // medias: ['https://.../img1.jpg', 'https://.../img2.jpg'],
    };
  },
};

const summary = await summaly('https://mysite.example.com/article/123', {
  plugins: [myPlugin],
});
```

### `renderEmbed` (オプション、phase13.1)

Fastify モードで `/embed?url=<URL>` 経由の iframe 用 HTML を返したい場合、`renderEmbed` を実装する。

```typescript
import { escapeHtml } from '@misskey-dev/summaly/built/utils/escape-html.js'; // 内部 utility

const myPlugin: SummalyPlugin = {
  name: 'mysite',
  test: (url) => url.hostname === 'mysite.example.com',
  summarize: async (url, opts) => { /* ... */ },
  renderEmbed: async (url, opts) => {
    // API call 等で取得したデータから HTML を組み立て
    const data = await fetchMyApi(url);
    // **必ず escapeHtml で全ユーザー入力を entity 化**
    const titleSafe = escapeHtml(data.title);
    const bodySafe = escapeHtml(data.body);
    return {
      body: `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>${titleSafe}</title></head>
<body><h1>${titleSafe}</h1><p>${bodySafe}</p></body></html>`,
      width: 3,   // アスペクト比 (絶対値ではなく比率として扱われる)
      height: 2,
    };
  },
};
```

**契約**:
- 戻り値の `body` は完全な HTML5 ドキュメント
- **すべてのユーザー入力 (API 由来 / DOM 由来) は `escapeHtml` で entity 化済みであること** (Fastify 側はエスケープしない)
- `<script>` を含めてはならない (Fastify の sanity check で検出されると 500 になる)
- 外部リソース読み込みは CSP `default-src 'none'` + `img-src https:` + `style-src 'unsafe-inline'` の制約下
- `body` のサイズは 512KB 上限 (越えると 500)

**運用**:
- Fastify モードの `[embed].enabled = true` + `allowedPlugins` に plugin name を含める必要あり
- カスタムプラグイン (opts.plugins 経由) は **`/embed` 経由では呼ばれない** (組み込みプラグインのみ dispatch 対象)。カスタムサイトで embed が必要なら fork でビルドすること

### 設計指針

- `test` は **URL のみで判定する軽量な処理** にする（DNS 引きや HTTP リクエストはしない）
- `summarize` は内部の `scpaping()` ヘルパ（`@misskey-dev/summaly` 内部、外部利用は非推奨）を呼ぶか、自前で fetch する
- マッチが当たったら **`general()` には自動でフォールバックしない**（`null` を返すと `failed summarize` として throw される）。汎用処理を流用したい場合は明示的に `parseGeneral()` を呼ぶか、`general()` に委譲する
- 組み込みプラグインより優先順位を高くしたい場合は、現状はサポート無し（組み込みが先にマッチする）。プラグインは「組み込みでカバーされていないサイト」を想定

### `name` の規約

- ファイル名（拡張子なし）と一致させると CI チェックを通せる
- `allowedPlugins` で絞り込まれる対象になるため、衝突しない名前を選ぶ
- 外部プラグインは `name` を持たなくても動くが、`allowedPlugins` のフィルタ対象外（常に有効）になる

共通ユーティリティ
----------------------------------------------------------------

プラグインから利用できる内部ユーティリティ。**外部公開 API ではない** ため将来変更されうる点に注意。

| ユーティリティ | 場所 | 用途 |
|:--|:--|:--|
| `scpaping(url, opts)` | [src/utils/got.ts](../src/utils/got.ts) | HTML 取得 + cheerio パース。`{ body, $, response }` を返す（タイポは半ば公開 API のため改名しない） |
| `getJson(url, referer?, opts?)` | [src/utils/got.ts](../src/utils/got.ts) | JSON エンドポイント取得。SSRF ガードを `getResponse` 経由で継承、`typeFilter` で `application/json` 系を強制 |
| `parseGeneral(url, scpapingResult)` | [src/general.ts](../src/general.ts) | OG / Twitter Card / oEmbed の汎用抽出ロジック |
| `general(url, opts)` | [src/general.ts](../src/general.ts) | `scpaping → parseGeneral` のショートカット |
| `BROWSER_UA` | [src/utils/user-agents.ts](../src/utils/user-agents.ts) | サイト固有プラグインで Chrome UA を上書きしたいとき |
| `KNOWN_SHORT_HOSTS` | [src/utils/short-urls.ts](../src/utils/short-urls.ts) | Fastify モード（`followRedirects: false`）でも `resolveRedirect()` で HEAD/GET 解決する公式短縮 URL ホストの Set |
| `PLAYER_ALLOW_OEMBED` | [src/utils/player-allow.ts](../src/utils/player-allow.ts) | oEmbed 系プラグインで共通利用する iframe `allow` の readonly safelist |
| `PDF_ICON_DATA_URL` | [src/utils/pdf-icon.ts](../src/utils/pdf-icon.ts) | PDF レスポンス用デフォルトアイコン (data URI) |
| `withTimeout(promise, ms)` | [src/utils/got.ts](../src/utils/got.ts) | Promise を timeout 付きで race（`finally` で `setTimeout` を必ず clear） |
| `sanitizeUrl(input, dataUrlLimit?)` | [src/utils/sanitize-url.ts](../src/utils/sanitize-url.ts) | 結果フィールド用 URL のスキーム検証（`https:` / `http:` / `data:` <10KB のみ通す） |

`PLAYER_ALLOW_OEMBED` は `Object.freeze()` 済みなので、`Summary.player.allow` への代入時はスプレッド `[...PLAYER_ALLOW_OEMBED]` でコピーすること。
