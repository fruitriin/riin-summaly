Plugins.md — プラグイン詳細
================================================================

summaly のプラグインシステムと、組み込み 13 プラグインの仕様、カスタムプラグインの書き方をまとめます。

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
}
```

`Summary` 型は [README.md](../README.md#summalyresult) の `Omit<SummalyResult, "url">` を参照。

マッチング・ディスパッチの流れ
----------------------------------------------------------------

`summaly(url, opts)` の処理順:

1. `opts.followRedirects` が true、または URL のホストが `KNOWN_SHORT_HOSTS`（`youtu.be` / `amzn.asia` / `amzn.to` / `a.co` / `t.co` / `bit.ly` 等）に含まれるなら **`resolveRedirect()`** でリダイレクトを解決:
   - まず HEAD を試す（軽量、body を受信しない）
   - HEAD が失敗した場合は GET に fallback (`Range: bytes=0-0` で body 受信を最小化)。`amzn.asia` のように HEAD に 404 を返すが GET には 301 を返すサーバ向け (phase9.1)
   - どちらも失敗した場合は元の URL のまま続行
2. プラグイン配列を順に走査して `test(url)` が `true` を返す **最初の** プラグインを採用
3. プラグイン配列の構築順:
   1. 組み込みプラグイン（`allowedPlugins` が指定されていれば `name` で絞り込み）
   2. `opts.plugins` で渡されたカスタムプラグイン（フィルタ対象外）
4. マッチしたプラグインの `summarize(url, scrapingOptions)` を呼ぶ。マッチが無ければ汎用パス `general()` を呼ぶ
5. 結果の URL フィールド（`icon` / `thumbnail` / `player.url` / `medias[]`）を `sanitizeUrl()` でフィルタ（`https:` / `http:` / `data:` <10KB のみ通す）

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
