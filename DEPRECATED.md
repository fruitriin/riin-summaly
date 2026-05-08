# DEPRECATED.md — 廃止された機能と移行ガイド

riin-summaly の進化過程で削除された機能・設定の一覧と、運用者向けの移行手順をまとめたドキュメントです。**現在動く機能** の解説は [README.md](README.md) / [docs/SETUP.md](docs/SETUP.md) / [docs/Library.md](docs/Library.md) / [docs/Plugins.md](docs/Plugins.md) を参照してください。時系列の変更履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## 廃止された機能の一覧

| 廃止機能 | 廃止フェーズ | 移行先 | このドキュメント内のセクション |
|:--|:--|:--|:--|
| fastify-cli `--options summaly-config.json` | phase8.1 (リリース 5.4) | TOML config (`pnpm serve config.toml`) | [↓](#fastify-cli---options-summaly-configjson-phase81--リリース-54-で廃止) |
| `/__diagnostics/parse-failures` HTTP エンドポイント | phase11.5 | `parseFailureLogJsonlPath` (JSONL + `cat \| jq`) | [↓](#__diagnosticsparse-failures-http-エンドポイント-phase115-で廃止) |
| `parseFailureLogEndpoint` TOML 設定キー | phase11.5 | (silent ignore、移行不要) | [↓](#parsefailurelogendpoint-toml-設定キー-phase115-で廃止) |
| `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ | phase14 Step 4 | `data/domain-strategy-bootstrap.jsonl` のエントリ | [↓](#forcecurlcffifallback--forceproxyfallback-プラグインフラグ-phase14-step-4-で廃止) |

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
