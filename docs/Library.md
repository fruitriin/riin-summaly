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

`summaly(url, opts?)` の `opts` はすべて optional。基本オプションは下表参照。

opts (`SummalyOptions`) — ライブラリ利用時の主要オプション
----------------------------------------------------------------

| プロパティ | 型 | 説明 | デフォルト |
|:--|:--|:--|:--|
| **lang** | *string* | リクエストの `Accept-Language` | `null` |
| **followRedirects** | *boolean* | リダイレクトを追跡するか | `true` |
| **plugins** | *SummalyPlugin[]* | カスタムプラグイン（組み込みより後ろに連結。詳細は [Plugins.md](Plugins.md)） | `null` |
| **userAgent** | *string* | リクエストの `User-Agent` | `SummalyBot/[version]` |
| **responseTimeout** | *number* | フェーズ単位のタイムアウト（DNS解決・接続・レスポンス各々）ミリ秒 | `20000` |
| **operationTimeout** | *number* | リクエスト全体のタイムアウト ミリ秒 | `60000` |
| **contentLengthLimit** | *number* | レスポンスサイズ上限（content-length ヘッダ + ストリーミング両方で検査） | `10485760` (10 MiB) |
| **contentLengthRequired** | *boolean* | true なら content-length 未返却サーバをエラー扱い | `false` |
| **agent** | *Got.Agents* | カスタム HTTP エージェント（プロキシ用途。設定するとプライベート IP 拒否は無効化される） | `null` |
| **allowedPlugins** | *string[]* | 利用許可するプラグイン名の配列。`undefined` で全有効、`[]` で組み込み全 disable | `undefined` |

Fastify モード固有のオプション（`cacheMaxAge` / `inMemoryCache` / `enablePdf` / `useRange` 等）は [SETUP.md](SETUP.md) に集約しています。

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

Fastify プラグインとして
----------------------------------------------------------------

`fastify.register` でも利用できます（`GET /` を受ける）:

```javascript
import Summaly from 'summaly';
fastify.register(Summaly, opts);
```

スタンドアロン HTTP サーバとして起動・運用する詳細は **[SETUP.md](SETUP.md)** を参照。
