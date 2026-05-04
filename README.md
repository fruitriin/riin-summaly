summaly
================================================================

[![][npm-badge]][npm-link]
[![][mit-badge]][mit]
[![][himawari-badge]][himasaku]
[![][sakurako-badge]][himasaku]

URL を渡すと、その Web ページのプレビュー（タイトル・説明・サムネイル・oEmbed プレーヤー等）を返す Node.js ライブラリです。Misskey の Note プレビュー生成に使われています。

- 関数として利用するか、Fastify プラグインとして HTTP サーバ化して利用できます
- OpenGraph / Twitter Card / oEmbed / `<title>` / `<meta>` / `<link rel="icon">` から優先順位付きでメタ情報を抽出
- サイト固有のプラグインで高速・正確な結果を返せる（YouTube / Spotify / Amazon / Wikipedia / dlsite 等）
- PDF レスポンスのタイトル取得（オプトイン）
- SSRF 対策（プライベート IP 拒否、レスポンスサイズ上限、結果 URL のスキーム検証）

詳細ドキュメント:
- **[Plugins.md](Plugins.md)** — 組み込みプラグインの詳細とカスタムプラグインの作り方
- **[SETUP.md](SETUP.md)** — Misskey 管理人など Fastify サーバとして運用する人向けの設定ガイド

インストール
----------------------------------------------------------------

```
npm install @misskey-dev/summaly
```

使い方
----------------------------------------------------------------

### 関数として

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

### Fastify プラグインとして（`GET /` を受ける）

```javascript
import Summaly from 'summaly';

fastify.register(Summaly, opts);
```

スタンドアロンの HTTP サーバとして起動する場合は **[SETUP.md](SETUP.md)** を参照してください。

### opts (`SummalyOptions`) — ライブラリ利用時の主要オプション

| プロパティ | 型 | 説明 | デフォルト |
|:--|:--|:--|:--|
| **lang** | *string* | リクエストの `Accept-Language` | `null` |
| **followRedirects** | *boolean* | リダイレクトを追跡するか（Fastify モードでは強制 `false`） | `true` |
| **plugins** | *SummalyPlugin[]* | カスタムプラグイン（組み込みより後ろに連結。詳細は [Plugins.md](Plugins.md)） | `null` |
| **userAgent** | *string* | リクエストの `User-Agent` | `SummalyBot/[version]` |
| **responseTimeout** | *number* | フェーズ単位のタイムアウト（DNS解決・接続・レスポンス各々）ミリ秒 | `20000` |
| **operationTimeout** | *number* | リクエスト全体のタイムアウト ミリ秒 | `60000` |
| **contentLengthLimit** | *number* | レスポンスサイズ上限（content-length ヘッダ + ストリーミング両方で検査） | `10485760` (10 MiB) |
| **contentLengthRequired** | *boolean* | true なら content-length 未返却サーバをエラー扱い | `false` |
| **agent** | *Got.Agents* | カスタム HTTP エージェント（プロキシ用途。設定するとプライベート IP 拒否は無効化される） | `null` |

Fastify モード固有のオプション（`cacheMaxAge` / `inMemoryCache` / `enablePdf` / `useRange` / `allowedPlugins` 等）は **[SETUP.md](SETUP.md)** に集約しています。

戻り値
----------------------------------------------------------------

ほぼ全フィールドが nullable です（`player` のみ非 null）。

### `SummalyResult`

| プロパティ | 型 | 説明 |
|:--|:--|:--|
| **title** | *string* \| *null* | ページのタイトル |
| **icon** | *string* \| *null* | ページのアイコン URL |
| **description** | *string* \| *null* | ページの説明 |
| **thumbnail** | *string* \| *null* | ページのサムネイル URL |
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

対応サイト（プラグイン一覧）
----------------------------------------------------------------

サイト固有プラグインは登録順にマッチし、最初に当たったものが採用されます。マッチしなかった URL は汎用パス (`general()`) で OG / Twitter Card / oEmbed から抽出されます。

| プラグイン名 | 対象 | 概要 |
|:--|:--|:--|
| `amazon` | `www.amazon.{com, co.jp, ...}` | DOM から商品タイトル・画像を直接取得 |
| `bluesky` | `bsky.app` | HEAD が 404 になるため GET のみで取得 |
| `wikipedia` | `*.wikipedia.org` | MediaWiki API から intro テキスト取得 |
| `branchio-deeplinks` | `*.app.link` / `spotify.link` | `$web_only=true` を付けて Web 版にリダイレクトさせ汎用パスへ |
| `youtube` | `(www\|m).youtube.com/{watch,v,playlist,shorts}` / `youtu.be` | oEmbed エンドポイント直叩きで 1 リクエスト取得 |
| `spotify` | `open.spotify.com` | oEmbed エンドポイント直叩き |
| `dlsite` | `www.dlsite.com` | `/announce/` ↔ `/work/` の 404 リトライ + パス分類で sensitive 判定 |
| `iwara` | `(www\|ecchi).iwara.tv` | description / thumbnail を DOM から補完、`ecchi.` ホストで sensitive |
| `komiflo` | `komiflo.com/comics/<id>` | thumbnail フォールバック時に `api.komiflo.com` から取得 + sensitive |
| `nijie` | `nijie.info/view.php` | JSON-LD `ImageObject` から description / thumbnail を補完 + sensitive |

各プラグインの詳細仕様・カスタムプラグインの書き方・共通ユーティリティ（`getJson` / `BROWSER_UA` / `KNOWN_SHORT_HOSTS` / `PLAYER_ALLOW_OEMBED` 等）は **[Plugins.md](Plugins.md)** にあります。

`allowedPlugins` で組み込みプラグインを絞り込めます（オプトイン許可リスト）。詳細は [SETUP.md](SETUP.md) を参照。

開発
----------------------------------------------------------------

```bash
git clone https://github.com/misskey-dev/summaly.git
cd summaly
pnpm install
pnpm build       # tsdown で ./built に出力
pnpm test        # vitest
pnpm eslint      # ESLint
pnpm typecheck   # tsc --noEmit (src + test 両方)
pnpm serve       # Fastify サーバ起動（事前に build 必須）
```

ライセンス
----------------------------------------------------------------

[MIT](LICENSE)

[mit]:            http://opensource.org/licenses/MIT
[mit-badge]:      https://img.shields.io/badge/license-MIT-444444.svg?style=flat-square
[himasaku]:       https://himasaku.net
[himawari-badge]: https://img.shields.io/badge/%E5%8F%A4%E8%B0%B7-%E5%90%91%E6%97%A5%E8%91%B5-1684c5.svg?style=flat-square
[sakurako-badge]: https://img.shields.io/badge/%E5%A4%A7%E5%AE%A4-%E6%AB%BB%E5%AD%90-efb02a.svg?style=flat-square
[npm-link]:       https://www.npmjs.com/package/@misskey-dev/summaly
[npm-badge]:      https://img.shields.io/npm/v/@misskey-dev/summaly.svg?style=flat-square
