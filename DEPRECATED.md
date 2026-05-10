# DEPRECATED.md — 廃止された機能と移行ガイド

riin-summaly の進化過程で削除された機能・設定の一覧と、運用者向けの移行手順をまとめたドキュメントです。**現在動く機能** の解説は [README.md](README.md) / [docs/SETUP.md](docs/SETUP.md) / [docs/Library.md](docs/Library.md) / [docs/Plugins.md](docs/Plugins.md) を参照してください。時系列の変更履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## 廃止された機能の一覧

| 廃止機能 | 廃止フェーズ | 移行先 | このドキュメント内のセクション |
|:--|:--|:--|:--|
| fastify-cli `--options summaly-config.json` | phase8.1 (リリース 5.4) | TOML config (`pnpm serve config.toml`) | [↓](#fastify-cli---options-summaly-configjson-phase81--リリース-54-で廃止) |
| `/__diagnostics/parse-failures` HTTP エンドポイント | phase11.5 | `parseFailureLogJsonlPath` (JSONL + `cat \| jq`) | [↓](#__diagnosticsparse-failures-http-エンドポイント-phase115-で廃止) |
| `parseFailureLogEndpoint` TOML 設定キー | phase11.5 | (silent ignore、移行不要) | [↓](#parsefailurelogendpoint-toml-設定キー-phase115-で廃止) |
| `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ | phase14 Step 4 | `data/domain-strategy-bootstrap.jsonl` のエントリ | [↓](#forcecurlcffifallback--forceproxyfallback-プラグインフラグ-phase14-step-4-で廃止) |
| `[server].publicUrl` TOML キー | phase16.3 | `[embed].publicUrl` | [↓](#serverpubliurl-phase163-で-embedpubliurl-に移動) |
| `[embed].allowedPlugins` TOML キー | phase16.3 | `[plugins].allowed` × `renderEmbed` 実装プラグインから auto-fill | [↓](#embedallowedplugins-phase163-で削除) |
| `[scraping.proxy].categories` / `domains` TOML キー | phase16.3 | コード側 default 固定 + bootstrap.jsonl から自動導出 | [↓](#scrapingproxycategories--domains--scrapingcurl_cfficategories--domains--scrapingfallbackcategories-phase163-で削除) |
| `[scraping.curl_cffi].categories` / `domains` TOML キー | phase16.3 | 同上 | [↑](#scrapingproxycategories--domains--scrapingcurl_cfficategories--domains--scrapingfallbackcategories-phase163-で削除) |
| `[scraping.fallback].categories` TOML キー | phase16.3 | コード側 default 固定 | [↑](#scrapingproxycategories--domains--scrapingcurl_cfficategories--domains--scrapingfallbackcategories-phase163-で削除) |
| 旧キー silent ignore (smol-toml の標準挙動) | phase16.3 | 全セクション expectKnownKeys で起動失敗化 | [↓](#旧キー-silent-ignore-phase163-で-fail-fast-起動失敗-に変更) |
| 旧 cascade 関数 (`getResponseWithFallback` / `getResponseWithProxyFallback` / `getResponseWithCurlCffiFallback`) + `StrategyTracker` 型 | phase18.1 | hedge race (`fetchByStrategy` から `viaProxyWorker` / `viaCurlCffi` 直接呼び) | [↓](#旧-cascade-関数--strategytracker-phase181-で削除) |
| `ProxyFallbackConfig.domains` / `CurlCffiFallbackConfig.domains` 内部フィールド + bootstrap 自動導出 + 経路依存 fail-fast | phase18.1 | フィールド自体撤廃 (hedge race ですべての URL に対して並列発火、Worker 側 ALLOWED_DOMAINS が最終防衛、curl_cffi 側 SSRF ガード `assert_public_ip` で防御) | [↓](#proxyfallbackconfigdomains--curlcffifallbackconfigdomains--bootstrap-自動導出--経路依存-fail-fast-phase181-で撤廃) |

---

## fastify-cli `--options summaly-config.json` (phase8.1 / リリース 5.4 で廃止)

### 旧

`fastify-cli` の `--options summaly-config.json` で JSON 設定を読み込み、`fastify start` で起動する形式。

```bash
# 旧
fastify start --options --address 127.0.0.1 --port 3000 \
  -- summaly-config.json built/index.js
```

旧 JSON 設定例 (`summaly-config.example.json`):

```json
{
    "useRange": true,
    "allowedPlugins": ["amazon", "bluesky"],
    "cacheMaxAge": 604800,
    "inMemoryCache": true,
    "inFlightDedup": true
}
```

### 新 (移行先)

`bin/summaly-server.ts` で TOML 設定を読み込み、`pnpm serve` で起動する形式。

```bash
# 新
pnpm serve /etc/summaly/config.toml
# または
SUMMALY_CONFIG_PATH=/etc/summaly/config.toml pnpm serve
```

新 TOML 設定例 (抜粋):

```toml
[server]
host = "127.0.0.1"
port = 3000

[summaly]
useRange = true

[summaly.cache]
maxAge = 604800
inMemory = true
inFlightDedup = true

[plugins]
allowed = ["amazon", "bluesky"]
```

### 廃止理由

- コメント・セクション分割が書きたい (運用上の判断や注意点を設定ファイル内に記録できる)
- fastify-cli の `--options` インターフェース依存からの脱却 (起動経路の自由度確保)
- 環境変数経由の secret 注入 (`SUMMALY_PROXY_SECRET` など) を統合管理しやすい構造化

### 移行手順詳細

旧 JSON キーと新 TOML キーの完全な対応表は **[docs/deploy-examples/README.md](docs/deploy-examples/README.md#マイグレーション-json--toml)** を参照。`summaly-config.example.json` も deploy-examples に DEPRECATED 注記付きで残されている (リリース 1 サイクル後に削除予定)。

関連: [phase8.1 Plan](docs/plans/phase8.1-toml-config.md) / [knowhow/toml-config-loader-pattern.md](docs/knowhow/toml-config-loader-pattern.md)

---

## `/__diagnostics/parse-failures` HTTP エンドポイント (phase11.5 で廃止)

### 旧

`[diagnostics] parseFailureLogEndpoint = true` で有効化された HTTP エンドポイントが、過去のパース失敗ドメインの集約データを JSON で返していた:

```bash
# 旧
curl http://127.0.0.1:3000/__diagnostics/parse-failures
# → { "groups": [ { "key": "...", "count": 10, "samples": [...] } ] }
```

### 新 (移行先)

集約データは TOML の `[diagnostics] parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"` で JSONL ファイルに書き出され、shell から直接参照する運用に変更:

```bash
# 新
# 月次レビュー: 頻出グループ key を集計
cat /var/log/summaly/parse-failures.jsonl | jq -r '.key' | sort | uniq -c | sort -rn | head -20

# bot block (4xx) されたサイトを集計
cat /var/log/summaly/parse-failures.jsonl | jq -c 'select(.reason == "throw" and .errorName == "StatusError")'

# tail -f でリアルタイム観察
tail -f /var/log/summaly/parse-failures.jsonl | jq -c '.'
```

### 廃止理由

**プライバシーリスク (過去 preview 試行 URL の HTTP 露出) の恒久排除**:

- HTTP エンドポイントを露出すると、nginx 設定ミス (`location /__diagnostics/` を internal にし忘れる等) で外部からアクセスできてしまう構造的リスクが残る
- 集約データは「過去にこのインスタンスを通過した URL のサンプル」を含むため、漏洩した場合のプライバシー影響が大きい
- ファイルシステム経由 (`chmod 600 /var/log/summaly/parse-failures.jsonl`) ならファイルシステム権限で攻撃面を最小化できる

### 移行手順

1. `config.toml` から `parseFailureLogEndpoint = true` を削除 (silent ignore されるので残しても可)
2. `[diagnostics] parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"` を追加 (未設定なら集約はメモリ上のみで再起動時に消える)
3. ログディレクトリを `mkdir -p /var/log/summaly && chown summaly:summaly /var/log/summaly && chmod 750 /var/log/summaly` で準備
4. 既存の curl ベースの監視スクリプトを `cat | jq` ベースに書き換え

関連: [phase11.5 Plan](docs/plans/phase11.5-remove-diagnostics-endpoint.md) / [knowhow/observability-parse-failure-log.md](docs/knowhow/observability-parse-failure-log.md)

---

## `parseFailureLogEndpoint` TOML 設定キー (phase11.5 で廃止)

### 旧の動作

`[diagnostics] parseFailureLogEndpoint = true` を設定すると `/__diagnostics/parse-failures` HTTP エンドポイントが有効化され、過去のパース失敗集約を JSON で返していました。

### 現在の動作

上記 HTTP エンドポイント廃止に伴い、対応する TOML キーも実装から削除されました。

**smol-toml は unknown key を silent ignore する** ため、既存ユーザーの `config.toml` に `parseFailureLogEndpoint = true` が残っていても **起動失敗しません** (forward-compat 設計)。`(cfg.summaly).parseFailureLogEndpoint` は実装側で undefined になり、エンドポイント有効化されないだけです。

### 移行手順

不要 (削除しても残しても挙動同一)。クリーンナップしたい場合は `config.toml` から該当行を削除。

[test/config-loader.test.ts](test/config-loader.test.ts) に forward-compat テストを置いており、smol-toml の挙動変更で気付けない壊れ方を防いでいます。

---

## `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ (phase14 Step 4 で廃止)

### 旧

`GeneralScrapingOptions` (内部型、`SummalyOptions` には含まれない) に `forceCurlCffiFallback: true` または `forceProxyFallback: true` を設定すると、cascade fallback の前段をスキップして curl_cffi / proxy で直接取得する仕組み。

- phase12.5 Step 2 followup #3 で `forceCurlCffiFallback` を導入 (yodobashi の TLS 切断回避で「20 秒空回り → fallback で成功」のコストを回避)
- phase12.6 で `forceProxyFallback` を導入 (sqex の DC IP block 救援で同様)
- プラグイン側 (`src/plugins/yodobashi.ts` / `src/plugins/sqex.ts`) で `summarize()` の opts に積んで cascade をスキップ

### 新 (移行先)

phase14 で導入された **経路学習キャッシュ + bootstrap JSONL** に統合。

```jsonl
{"pathKey":"yodobashi.com","strategy":"curl_cffi","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234567890,"lastAttemptAt":1234567890}
{"pathKey":"www.yodobashi.com","strategy":"curl_cffi","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234567890,"lastAttemptAt":1234567890}
{"pathKey":"store.jp.square-enix.com","strategy":"proxy","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234567890,"lastAttemptAt":1234567890}
```

`scpaping()` 冒頭の cache hit fast path から該当 strategy で直接呼ばれます。実際のエントリは [data/domain-strategy-bootstrap.jsonl](data/domain-strategy-bootstrap.jsonl) を参照。

### 廃止理由

**プラグインから経路選択責務を外し、経路学習キャッシュに集約**:

- プラグインは「extraction の自在性」専用 (DOM 直読み・公式 API 直叩き・URL 正規化・`skipRedirectResolution` 等) に整理
- 経路選択は host + path prefix 単位で動的に学習・bootstrap で初期値供給
- 新サイトで「経路詰まり」を発見した時の運用フローが「プラグインに forceX フラグ追加 → コミット → デプロイ」から「`bootstrap.jsonl` に 1 行追加 → コミット → デプロイ」に簡素化

### 移行手順

カスタムプラグインで forceX を使っていた場合の置き換え:

#### 旧 (廃止済)

```typescript
// プラグイン側
export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
    const opts2 = { ...opts, forceCurlCffiFallback: true };  // ← 廃止
    return general(url, opts2);
}
```

#### 新

カスタム bootstrap JSONL を `[scraping.strategy_cache].bootstrapPath` で指定:

```toml
[scraping.strategy_cache]
enabled = true
bootstrapPath = "/path/to/your-custom-bootstrap.jsonl"
```

または同梱 `data/domain-strategy-bootstrap.jsonl` をフォークして該当ホストのエントリを追加 (npm 同梱版を優先したい場合は PR 経由で merge)。

組み込みプラグインの `yodobashi` / `sqex` は phase14 Step 4 完了時点で **bootstrap エントリ + extraction-only に整理済み** で移行サンプルとして参照できます ([src/plugins/yodobashi.ts](src/plugins/yodobashi.ts) / [src/plugins/sqex.ts](src/plugins/sqex.ts))。

関連: [phase14 Plan](docs/plans/phase14-domain-strategy-cache.md) / [data/README.md](data/README.md) / [knowhow/domain-strategy-cache.md](docs/knowhow/domain-strategy-cache.md)

---

## `[server].publicUrl` (phase16.3 で `[embed].publicUrl` に移動)

### 旧

```toml
[server]
host = "127.0.0.1"
port = 3000
publicUrl = "https://summaly.example.com"
```

### 新 (移行先)

```toml
[server]
host = "127.0.0.1"
port = 3000

[embed]
enabled = true
publicUrl = "https://summaly.example.com"
```

### 廃止理由

`publicUrl` は `/embed` エンドポイント (phase13.1) でしか使われていないため、概念的に `[embed]` セクション配下に置くのが自然。`[server]` セクションは Fastify の listen 設定 (host/port) だけに整理。

### 移行手順

`config.toml` の `[server].publicUrl` を `[embed].publicUrl` に書き換える (1 行移動)。phase16.3 で `[server]` の未知キー検出が起動失敗化されているため、移行漏れがあれば即時エラーで検知できる。

---

## `[embed].allowedPlugins` (phase16.3 で削除)

### 旧

```toml
[embed]
enabled = true
allowedPlugins = ["syosetu", "kakuyomu"]
```

### 新 (移行先)

```toml
[embed]
enabled = true
# allowedPlugins は不要 (削除済み)。`[plugins].allowed` で有効化されたプラグインのうち
# renderEmbed を実装しているものが自動で embed 対応される。

[plugins]
allowed = ["syosetu", "kakuyomu", ...]
```

### 廃止理由

`[embed].allowedPlugins` と `[plugins].allowed` の二重管理を撤廃。embed 対応プラグインは `renderEmbed` を実装している builtinPlugins から判定でき、`[plugins].allowed` で有効化されたものだけを Fastify auto-init 側で自動構成する設計に変更。「embed 対応プラグインを部分的に embed では除外したい」という低頻度ニーズは `[plugins].allowed` から外すことで実現する。

### 移行手順

`config.toml` の `[embed].allowedPlugins` 行を削除。`[plugins].allowed` に該当プラグイン (syosetu / kakuyomu) が含まれていれば自動で embed 対応される。

---

## `[scraping.proxy].categories` / `domains` / `[scraping.curl_cffi].categories` / `domains` / `[scraping.fallback].categories` (phase16.3 で削除)

### 旧

```toml
[scraping.proxy]
enabled = true
url = "https://x.workers.dev"
categories = ["origin_error", "bot_blocked"]
domains = ["amazon.co.jp", "store.jp.square-enix.com"]

[scraping.curl_cffi]
enabled = true
projectDir = "/path/to/curl-cffi-fetcher"
categories = ["timeout", "connection_dropped", "bot_blocked"]
domains = ["yodobashi.com"]

[scraping.fallback]
enabled = true
categories = ["bot_blocked", "connection_dropped"]
```

### 新 (移行先)

```toml
[scraping.proxy]
enabled = true
url = "https://x.workers.dev"
# categories はコード側 default `['origin_error', 'bot_blocked']` 固定
# domains は data/domain-strategy-bootstrap.jsonl から `strategy === "proxy"` の host を自動導出

[scraping.curl_cffi]
enabled = true
projectDir = "/path/to/curl-cffi-fetcher"
# 同上 (domains は bootstrap から自動導出)

[scraping.fallback]
enabled = true
# categories はコード側 default `['bot_blocked', 'connection_dropped']` 固定
```

### 廃止理由

運用者が `categories` / `domains` を個別に override する実用ニーズがほぼ無く、ほぼ全員がコード側 default 値を使っていた。設定責任を運用者から外しコード側に集約することで:

- TOML が短くシンプルになる (新規セットアップが楽)
- `domains` 不整合 (Worker `ALLOWED_DOMAINS` と TOML の二重管理ミス) のリスク撤廃
- bootstrap.jsonl を 1 ソース管理 (新サイト救援は bootstrap に 1 行追加するだけ、TOML 編集不要)

### 移行手順

`config.toml` から該当キーを削除するだけ。新サイトを `proxy` / `curl_cffi` 経路で救援したい場合は `data/domain-strategy-bootstrap.jsonl` に エントリ追加 + `[plugins].allowed` 反映 + 経路 `enabled = true`。

### 経路依存 fail-fast (関連)

phase16.3 では bootstrap × `enabled` の不整合 (= bootstrap が proxy 経路を要求するけど `[scraping.proxy].enabled = false`) を起動失敗にする変更も入れた。「動かないが破壊的でもない」沈黙バグを構造的に防ぐ。エラーメッセージで「(a) 該当経路を有効化、(b) `[scraping.strategy_cache].enabled = false`、(c) bootstrap entry を削除」の 3 択を案内する。

---

## 旧キー silent ignore (phase16.3 で fail-fast 起動失敗 に変更)

### 旧

smol-toml は unknown key を silent ignore する仕様だったため、phase11.5 で削除された `parseFailureLogEndpoint = true` 等が `config.toml` に残っていても起動成功し、機能だけ無効化されている状態だった。

### 新 (phase16.3)

各 TOML セクションで `expectKnownKeys` を実装し、未知キーを **起動失敗** で検出する。エラーメッセージで「DEPRECATED.md を参照」と案内。

### 移行手順

phase16.3 にアップグレード後、起動失敗エラーで未知キーを案内されたらそのキーを `config.toml` から削除する (本ドキュメントの移行手順に従う)。

---

## 旧 cascade 関数 + `StrategyTracker` (phase18.1 で削除)

### 旧

phase14 まで段階的 cascade fallback で経路選定を行っていた:

```typescript
// 旧: src/utils/got.ts / proxy-fallback.ts / curl-cffi-fetch.ts
import { getResponseWithCurlCffiFallback } from '@/utils/curl-cffi-fetch.js';
const response = await getResponseWithCurlCffiFallback({ ...args, method: 'GET' }, fallback, proxyCfg, curlCffiCfg, tracker);
// 内部: getResponse → 失敗 → getResponseWithFallback (UA fallback) → 失敗 → getResponseWithProxyFallback (proxy)
//      → 失敗 → getResponseWithCurlCffiFallback (curl_cffi)
// 各段の発火条件: categories (エラーカテゴリ判定) + domains allowlist (host 制約)
```

`StrategyTracker = { value?: DomainStrategy }` で各段の成功 strategy を mutable holder に書き込んでいた。

### 新

phase18 hedge race で各経路を **並列発火** に変更。`fetchByStrategy` から `viaProxyWorker` / `viaCurlCffi` を直接呼ぶ:

```typescript
// 新: src/utils/got.ts fetchResponse
const result = await hedgedRace(
  { champion, challengers, thresholdMs, isFinalError },
  fetcher, // 各経路は viaProxyWorker / viaCurlCffi を直接呼ぶ
  () => true,
);
```

成功 strategy は `recState.strategy` (CacheRecordingState) で伝搬。`StrategyTracker` は不要。

### 廃止理由

- 段階的 cascade は **最悪 4 段直列で 60+ 秒** かかる (各段 timeout 待ち)。hedge race は champion 5 秒待ち + 並列発火で短縮
- categories / domains による発火制御は「並列発火モデル」と相性が悪い (どの経路も常に試せる方が学習機構と整合)
- `StrategyTracker` の mutable side-channel は `CacheRecordingState` に集約 (hedge 情報も同居できて綺麗)

### 移行手順

外部からこれらを直接 import している利用者はほぼ居ない想定 (内部 API)。万一いる場合は:

- `getResponseWithFallback(args, fallback, tracker)` → `getResponse(args)` 単発呼び (UA fallback は hedge race で別経路として発火)
- `getResponseWithProxyFallback(...)` → `viaProxyWorker(args, proxyCfg, signal?)` 直接呼び
- `getResponseWithCurlCffiFallback(...)` → `viaCurlCffi(args, curlCffiCfg, signal?)` 直接呼び
- `StrategyTracker` → 不要 (`CacheRecordingState.strategy` で代替)

---

## `ProxyFallbackConfig.domains` / `CurlCffiFallbackConfig.domains` + bootstrap 自動導出 + 経路依存 fail-fast (phase18.1 で撤廃)

### 旧

phase14〜phase16.3 の設計では、proxy / curl_cffi の `domains` 配列で host allowlist を持っていた。phase16.3 で TOML キーは silent ignore に変更したが、内部フィールドは温存し `bin/config-loader.ts` で **bootstrap.jsonl から自動導出** する仕組みになっていた。

```typescript
// 旧: src/utils/proxy-fallback.ts ProxyFallbackConfig
export interface ProxyFallbackConfig {
  enabled: boolean;
  url: string;
  secret: string;
  categories: SummalyErrorCategory[]; // エラーカテゴリ判定 (発火条件)
  domains: string[];                  // host allowlist (suffix-match)
  timeoutMs: number;
}
```

加えて **経路依存 fail-fast** (phase16.3) で「bootstrap に proxy entry あり + `[scraping.proxy].enabled = false` → 起動失敗」していた。

### 新

phase18.1 で `domains` 内部フィールド + bootstrap 自動導出 + 経路依存 fail-fast を **すべて撤廃**:

```typescript
// 新: src/utils/proxy-fallback.ts (CurlCffi も同型)
export interface ProxyFallbackConfig {
  enabled: boolean;
  url: string;
  secret: string;
  timeoutMs: number; // domains / categories 削除
}
```

hedge race の `fetchByStrategy` で「`enabled === true` + `https:` 」だけが gate。host 制約はなく、すべての URL に対して全 strategy が並列発火する。

### 廃止理由

- **並列発火モデルとの矛盾**: domains allowlist は cascade 時代の「特定ホストだけ proxy で救援」発想。hedge race では「全 URL で全経路試す」が前提なので allowlist が機能しない
- **bootstrap 自動導出の運用負担**: 「bootstrap entry がない host で proxy/curl_cffi が呼ばれない」隠れ仕様で、本番で「monotaro が phase18 hedge race でも救援されない」原因究明が困難に
- **SSRF 防御は別経路で確保**: proxy → Worker 側 `ALLOWED_DOMAINS` (オープンプロキシ化防止)、curl_cffi → Python 側 `assert_public_ip` (private IP rejection)

### 移行手順

`config.toml` の `[scraping.proxy].domains` / `[scraping.curl_cffi].domains` / `[scraping.proxy].categories` / `[scraping.curl_cffi].categories` キーは **silent ignore** (起動失敗にしない、forward-compat)。明示的な削除は不要だが、不要キーとして掃除推奨。

bootstrap 自動導出が無くなったため、**bootstrap entry なしでも proxy / curl_cffi 経路は発火する**。逆に「bootstrap に書いてないと curl_cffi が動かなかった」サイト (monotaro 等) は phase18.1 で自動救援されるようになる。

経路依存 fail-fast の起動失敗メッセージも撤廃 (`[scraping.proxy].enabled = false` でも bootstrap に proxy entry があれば起動失敗していた、これは起きなくなる)。
