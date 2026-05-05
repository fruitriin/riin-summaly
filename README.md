summaly
================================================================

[![][npm-badge]][npm-link]
[![][mit-badge]][mit]
[![][himawari-badge]][himasaku]
[![][sakurako-badge]][himasaku]

**summaly は Misskey の note プレビューカードを生成しているライブラリ／HTTP サーバです**。note にリンクが貼られると下のようなプレビューが表示される、その裏側で動いています。

<table>
<tr>
<td><img src="docs/screenshots/misskey-card-gigazine.png" alt="GIGAZINE 記事のプレビューカード（サムネイル + タイトル + 説明 + サイト名）" /></td>
<td><img src="docs/screenshots/misskey-card-wikipedia.png" alt="Wikipedia 記事のプレビューカード（アイコン + タイトル + 説明）" /></td>
</tr>
<tr>
<td><img src="docs/screenshots/misskey-card-twitter-collapsed.png" alt="X (Twitter) ポストのプレビューカード（折りたたみ表示）" /></td>
<td><img src="docs/screenshots/misskey-card-twitter-detail.png" alt="X (Twitter) ポストの展開表示（ツイート本文 + プロフィール + 返信ボタン）" /></td>
</tr>
</table>

URL から `title` / `description` / `thumbnail` / `icon` / `sitename` / 埋め込みプレーヤー / ActivityPub リンク等を抽出して JSON で返します。Misskey サーバはこの JSON を受け取って上図のようなカード UI を組み立てます。

何ができるか
----------------------------------------------------------------

- **OpenGraph / Twitter Card / oEmbed / `<title>` / `<meta>` から優先順位付きでメタ情報抽出**
- **サイト固有プラグイン** で高速・正確な結果（YouTube・Spotify は oEmbed 直叩きで 1 リクエスト、Wikipedia は MediaWiki API、Amazon は DOM 直接抽出など）
- **PDF レスポンスのタイトル取得**（オプトイン）
- **SSRF 対策**: プライベート IP 拒否・レスポンスサイズ上限（10 MiB）・結果 URL のスキーム検証（`javascript:` 等を null に置換）
- **キャッシュ機構**: `Cache-Control` ヘッダ・プロセス内 LRU キャッシュ
- **多文字コード対応**: UTF-8 / Shift_JIS / ISO-2022-JP（[issue #39](https://github.com/misskey-dev/summaly/issues/39)）

Misskey 管理人として導入する場合
----------------------------------------------------------------

スタンドアロンの Fastify サーバとして起動し、Misskey 本体から `GET /?url=...` を呼ぶ構成が標準です。

```bash
git clone https://github.com/fruitriin/summaly.git
cd summaly
pnpm install --frozen-lockfile
pnpm build
cp config.example.toml config.toml   # TOML 設定をコピーして編集
pnpm serve config.toml               # = tsx bin/summaly-server.ts config.toml
```

詳細なセットアップ手順、TOML 設定スキーマ、Fastify モード固有のオプション（キャッシュ・PDF・プラグイン絞り込み・nginx + systemd デプロイ例）、SSRF 既定値、運用上の注意点は **[docs/SETUP.md](docs/SETUP.md)** を参照してください。

対応サイト（プラグイン一覧）
----------------------------------------------------------------

サイト固有プラグインは登録順にマッチし、最初に当たったものが採用されます。マッチしなかった URL は汎用パスで OG / Twitter Card / oEmbed から抽出されます。

| プラグイン | 対象 | 概要 |
|:--|:--|:--|
| `amazon` | `www.amazon.{com, co.jp, ...}` | DOM から商品タイトル・画像を直接取得 |
| `bluesky` | `bsky.app` | HEAD が 404 になるため GET のみで取得 |
| `wikipedia` | `*.wikipedia.org` | MediaWiki API から intro テキスト取得 |
| `branchio-deeplinks` | `*.app.link` / `spotify.link` | `$web_only=true` を付けて Web 版にリダイレクトさせ汎用パスへ |
| `youtube` | `(www\|m).youtube.com/{watch,v,playlist,shorts}` / `youtu.be` | oEmbed エンドポイント直叩きで 1 リクエスト |
| `spotify` | `open.spotify.com` | oEmbed エンドポイント直叩き |
| `twitter` | `(twitter\|x).com/<user>/status/<id>` | `cdn.syndication.twimg.com` から JSON 取得 + `platform.twitter.com/embed/Tweet.html` を player に展開。**X 側仕様変更で壊れうるため要メンテ** |
| `dlsite` | `www.dlsite.com` | `/announce/` ↔ `/work/` の 404 リトライ + パス分類で sensitive 判定 |
| `iwara` | `(www\|ecchi).iwara.tv` | description / thumbnail を DOM から補完、`ecchi.` ホストで sensitive |
| `komiflo` | `komiflo.com/comics/<id>` | thumbnail フォールバック時に `api.komiflo.com` から取得 + sensitive |
| `nijie` | `nijie.info/view.php` | JSON-LD `ImageObject` から description / thumbnail を補完 + sensitive |

各プラグインの詳細仕様、カスタムプラグインの書き方、共通ユーティリティは **[docs/Plugins.md](docs/Plugins.md)** にあります。

ライブラリとして直接利用する場合
----------------------------------------------------------------

Node.js プロジェクト内で `summaly()` 関数を直接 import して使うこともできます。API リファレンス・戻り値型・全オプションは **[docs/Library.md](docs/Library.md)** を参照してください。

```javascript
import { summaly } from 'summaly';
const summary = await summaly('https://example.com/article');
```

開発
----------------------------------------------------------------

```bash
pnpm install
pnpm build       # tsdown で ./built に出力
pnpm test        # vitest
pnpm eslint      # ESLint
pnpm typecheck   # tsc --noEmit (src + test + dev の 3 構成)
pnpm serve config.toml  # Fastify サーバ起動（TOML 設定）
pnpm dev         # 動作確認 UI（http://127.0.0.1:3000、tsx で src/ を直接実行）
```

### 動作確認 UI (`pnpm dev`)

`pnpm dev` で `http://127.0.0.1:3000` に動作確認用の Web UI が立ち上がります。本番 bundle (`./built/`) には含まれない dev 専用ツールです。

- URL を入力 → JSON / Misskey 風カード / iframe プレーヤーの 3 タブで結果を確認できる
- 組み込みプラグイン対応サイトのサンプル URL をワンクリックで入力欄に流し込める
- `lang` / `useRange` / `enablePdf` / `allowedPlugins` をリクエスト単位で切り替えできる
- ローカル URL をプレビューできるよう `SUMMALY_ALLOW_PRIVATE_IP=true` を **dev サーバ内で限定的に** 設定する。シェル env は汚染しないため、`pnpm serve`（本番）には影響しない

`PORT` / `HOST` 環境変数で待ち受けを変更可能（デフォルト `127.0.0.1:3000`）。

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
