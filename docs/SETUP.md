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
- [パース失敗ドメインのログ蓄積 (phase10.1)](#パース失敗ドメインのログ蓄積-phase101)
- [バージョン確認エンドポイント `GET /v`](#バージョン確認エンドポイント-get-v)
- [エラーレスポンスのカテゴリ (phase11.2)](#エラーレスポンスのカテゴリ-phase112)
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

パース失敗ドメインのログ蓄積 (phase10.1)
----------------------------------------------------------------

`parseFailureLog: true` で「**汎用パスでスカスカ（OG/Twitter Card/`<title>` のいずれも取れず）になった URL**」をホスト + パス先頭 1〜2 セグメント単位で集約してプロセス内に保持します。**プラグイン化候補のドメイン発見器** として運用する想定です。

```toml
[diagnostics]
parseFailureLog = true
parseFailureLogMaxGroups = 1000
parseFailureLogSamplesPerGroup = 5
parseFailureLogEndpoint = true
```

| 設定キー | 説明 | デフォルト |
|:--|:--|:--|
| `parseFailureLog` | 集約を有効化 | `false` |
| `parseFailureLogMaxGroups` | グループ数上限（超過時 LRU 風に最古から削除） | `1000` |
| `parseFailureLogSamplesPerGroup` | 1 グループあたりの直近サンプル数 | `5` |
| `parseFailureLogEndpoint` | `GET /__diagnostics/parse-failures` を mount | `false` |

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

### `GET /__diagnostics/parse-failures`

```jsonc
{
  "groups": [
    {
      "key": "qiita.com/UserA/items",
      "samples": [
        { "url": "https://qiita.com/UserA/items/abc", "ts": 1733433600000, "reason": "thin" }
      ]
    }
  ],
  "size": 1,
  "enabled": true
}
```

**⚠ 公開時は nginx で必ずアクセス制限してください**（過去の preview 試行 URL が誰でも見える状態になりプライバシー漏洩につながります）:

```nginx
location /__diagnostics/ {
    allow 127.0.0.1;
    deny all;
}
```

### プライバシー保護

サンプルに保存される `url` は **`${origin}${pathname}` のみ**（query / fragment / basic auth は捨てる）。session ID / API token がクエリに乗っているケースをある程度防ぎます。それでも path 自体に機密が含まれるサイトのプレビュー URL は記録されるため、エンドポイント公開時の nginx ガードは必須です。

### JSONL 永続化（オプトイン）

プロセス再起動で in-memory ログは消えるため、月次レビュー等で過去ログを残したい場合は JSONL ファイルへの append を有効化できます:

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
| `parse_error` | プレビューが取得できませんでした | プラグイン化候補（パース失敗ログで追跡） |
| `unknown` | 不明なエラー | ログを確認 |

`StatusError` のときは `error.statusCode` も同梱されるため、Misskey 側で `URL_PREVIEW_NOT_FOUND` (404) と `URL_PREVIEW_BOT_BLOCKED` (403/429 等) を分けて API エラーコードを返すことができます。

**後方互換**: 既存の `error.message` / `error.name` は維持されます。`category` を見ない既存実装は影響を受けません。

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

    # /__diagnostics/parse-failures を有効化する場合は外部公開しないこと
    # (過去の preview 試行 URL が誰でも見える状態になりプライバシー漏洩につながる)
    location /__diagnostics/ {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://summaly_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
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
