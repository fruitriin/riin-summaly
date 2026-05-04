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
git clone https://github.com/misskey-dev/summaly.git
cd summaly
pnpm install --frozen-lockfile
pnpm build
pnpm serve   # = fastify start ./built/index.js (デフォルト 0.0.0.0:3000)
```

ポート / バインドアドレスを変更:

```bash
pnpm exec fastify start ./built/index.js --address 127.0.0.1 --port 3000
```

オプション JSON を渡す（後述の Fastify モード固有のオプションを設定）:

```bash
pnpm exec fastify start ./built/index.js --options summaly-config.json
```

`summaly-config.json` のサンプルは [docs/deploy-examples/summaly-config.example.json](deploy-examples/summaly-config.example.json)。

Fastify モード固有のオプション
----------------------------------------------------------------

`fastify.register(Summaly, opts)` または `--options config.json` で渡せるオプション。ライブラリ共通のオプション（`lang` / `userAgent` / `responseTimeout` / `operationTimeout` / `contentLengthLimit` / `agent` 等）は [README.md](../README.md) を参照。

| プロパティ | 型 | 説明 | デフォルト |
|:--|:--|:--|:--|
| **cacheMaxAge** | *number* | 成功レスポンスの `Cache-Control: public, max-age=<秒>`。`0` で `no-store` | `604800` (1 週間) |
| **cacheErrorMaxAge** | *number* | エラーレスポンスの `Cache-Control` | `3600` (1 時間) |
| **inMemoryCache** | *boolean* | プロセス内 LRU キャッシュを有効化 | `false` |
| **inMemoryCacheMaxEntries** | *number* | LRU の最大エントリ数 | `1000` |
| **useRange** | *boolean* | `Range: bytes=0-N-1` で先頭領域だけ取得（帯域節約） | `false` |
| **allowedPlugins** | *string[]* | 利用許可するプラグイン名の配列 | `undefined` (全有効) |
| **enablePdf** | *boolean* | PDF レスポンスのタイトル取得を有効化 | `false` |

`SUMMALY_FAMILY` / `SUMMALY_ENABLE_PDF` / `SUMMALY_ALLOW_PRIVATE_IP` は環境変数。後述。

キャッシュ戦略
----------------------------------------------------------------

summaly のキャッシュは **3 段重ね** で考えるのが運用の基本:

1. **`Cache-Control` ヘッダ（自動）** — 全レスポンスに `public, max-age=<cacheMaxAge>` が付く。前段の nginx `proxy_cache` / Cloudflare 等が尊重して再リクエストを減らす
2. **インメモリ LRU キャッシュ（`inMemoryCache: true` でオプトイン）** — `Cache-Control` を解釈しない HTTP クライアント（Misskey の Got / node-fetch 等）でも summaly サーバ単独で重複アクセスを抑える
3. **前段プロキシ / CDN（運用者が用意）** — nginx の `proxy_cache_path` + `proxy_cache_valid` で `Cache-Control` を尊重した永続キャッシュ

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
- **`X-Cache` ヘッダ**: HIT / MISS が付く（無効時は付かない）

#### 注意点

- **5xx エラーもキャッシュされる**: 上流が一時障害から復旧しても `cacheErrorMaxAge` までエラーが返り続けます。プロセス再起動するか `cacheErrorMaxAge` を短く設定して緩和
- **同時リクエストの dedup は行わない**（thundering herd 残課題、[phase4.2](plans/phase4.2-inflight-dedup.md) で対応予定）。キャッシュが完成する前に来た並列リクエストは全て origin に到達します。Misskey のユーザーストリーミング由来で同時集中が起きる場合は phase4.2 完了を待つか、前段に nginx `proxy_cache` を立てて吸収してください
- **プロセス再起動でキャッシュは消えます**。永続キャッシュは別実装（要望次第で Redis 等を将来検討）

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
- [summaly.service.example](deploy-examples/summaly.service.example) — systemd unit
- [summaly-config.example.json](deploy-examples/summaly-config.example.json) — Fastify プラグイン設定 JSON

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
