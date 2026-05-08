# phase16.2 — DEPRECATED.md 新設 + 廃止経緯の docs からの切り出し

## 背景

phase16.1 で「経路優先システム」を README の目玉特徴に位置づけた際、**廃止された機能の経緯記述が docs/SETUP.md / docs/Library.md / docs/Plugins.md / README.md に散在している** 状態が露呈した。

具体的には以下 4 機能が廃止済みだが、各ドキュメントの「現在動く機能」の説明文中に「phase X で廃止」「Step Y で廃止予定」等の歴史的経緯が織り込まれており、新規利用者が「**今動く機能だけ知りたい**」目線で読むときにノイズになっている:

| 廃止機能 | 廃止フェーズ | 言及箇所数 |
|:--|:--|:--|
| fastify-cli `--options summaly-config.json` | phase8.1 / 5.4 | 1 (SETUP.md) |
| `/__diagnostics/parse-failures` HTTP エンドポイント | phase11.5 | 3 (README / Library / SETUP) |
| `parseFailureLogEndpoint` 設定 | phase11.5 | 1 (SETUP.md) |
| `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ | phase14 Step 4 | 6 (README / SETUP × 2 / Library / Plugins × 2) |

既存の `CHANGELOG.md` にも廃止履歴は載っているが、CHANGELOG は時系列で「変更が起きた事実」の集積なので、**「廃止 + 移行手順」を一元的に参照したい運用者にとってアクセシビリティが低い** (該当エントリを探すために CHANGELOG 全体を読む必要がある)。

## 目的

1. **`DEPRECATED.md` を新設** — 廃止された機能の一覧と移行ガイドを一元化
2. **README / docs から「廃止経緯の詳細」を削除し DEPRECATED.md にリンク** — 新規利用者が読むドキュメントを「今動く機能」だけに絞る
3. **「現在の動作説明に必要な経緯」は docs に残す** — 例: yodobashi の `skipRedirectResolution` がなぜ必要かは現在の動作の文脈なので Plugins.md に残す。「phase14 Step 4 で旧フラグを廃止し経路学習キャッシュに統合した」という履歴は DEPRECATED.md に切り出す

## Step 1: `DEPRECATED.md` 新規作成 (ルート直下)

CHANGELOG.md と並ぶ位置 (`/DEPRECATED.md`) に配置。各廃止機能について以下構成で記載:

```markdown
# DEPRECATED.md — 廃止された機能と移行ガイド

riin-summaly の進化過程で削除された機能・設定の一覧と、運用者向けの移行手順。
最新の機能ドキュメントは [README.md](README.md) / [docs/SETUP.md](docs/SETUP.md) / [docs/Library.md](docs/Library.md) を参照してください。

## 廃止された機能の一覧

| 廃止機能 | 廃止フェーズ | 移行先 |
|:--|:--|:--|
| fastify-cli `--options summaly-config.json` | phase8.1 / 5.4 | TOML config (`pnpm serve config.toml`) |
| `/__diagnostics/parse-failures` HTTP エンドポイント | phase11.5 | `parseFailureLogJsonlPath` (JSONL + `cat \| jq`) |
| `parseFailureLogEndpoint` TOML 設定キー | phase11.5 | (silent ignore、移行不要) |
| `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ | phase14 Step 4 | `data/domain-strategy-bootstrap.jsonl` のエントリ |

## fastify-cli ベース起動 (phase8.1 / 5.4 で廃止)

### 旧
- 廃止理由
- 旧設定例 (JSON)
- 旧起動コマンド

### 新 (移行先)
- TOML 起動コマンド
- 設定の対応関係 (旧 JSON キー → 新 TOML セクション)
- 関連: [phase8.1 Plan](docs/plans/phase8.1-toml-config.md), [docs/deploy-examples/README.md](docs/deploy-examples/README.md)

## `/__diagnostics/parse-failures` HTTP エンドポイント (phase11.5 で廃止)

### 旧
- HTTP エンドポイントの GET レスポンス例
- 廃止理由: プライバシーリスク (過去 preview 試行 URL の HTTP 露出 + nginx 設定ミスで構造的にリスク残存)

### 新 (移行先)
- `parseFailureLogJsonlPath` で JSONL ファイルに書き出し
- `cat <path> | jq` でフィルタ・集計
- ファイルシステム権限 (`chmod 600`) で攻撃面を最小化
- 関連: [phase11.5 Plan](docs/plans/phase11.5-remove-diagnostics-endpoint.md), [knowhow/observability-parse-failure-log.md](docs/knowhow/observability-parse-failure-log.md)

## `parseFailureLogEndpoint` TOML 設定キー (phase11.5 で廃止)

phase11.5 の HTTP エンドポイント廃止に伴い、対応する TOML キーも実装から削除。**smol-toml は unknown key を silent ignore する** ため、既存ユーザーの `config.toml` に `parseFailureLogEndpoint = true` が残っていても起動失敗しません (forward-compat 設計、`(cfg.summaly).parseFailureLogEndpoint` は undefined になる)。

移行: 不要 (削除しても残しても挙動同一)。クリーンナップしたい場合は config.toml から該当行を削除。

## `forceCurlCffiFallback` / `forceProxyFallback` プラグインフラグ (phase14 Step 4 で廃止)

### 旧
- `GeneralScrapingOptions` に `forceCurlCffiFallback: true` または `forceProxyFallback: true` を設定
- プラグイン側 (例: yodobashi.ts / sqex.ts) で当該フラグを `summarize()` の opts に積んで cascade をスキップ
- phase12.5 Step 2 followup #3 (yodobashi) / phase12.6 (sqex) で導入

### 新 (移行先)
- `data/domain-strategy-bootstrap.jsonl` に `{"pathKey":"<host>","strategy":"curl_cffi","successCount":1,...}` 形式のエントリ追加
- 経路学習キャッシュの cache hit fast path から該当 strategy で直接呼ばれる
- カスタムプラグインで forceX を使っていた場合の置き換え手順:
  ```jsonl
  {"pathKey":"yourhost.example.com","strategy":"curl_cffi","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234567890,"lastAttemptAt":1234567890}
  ```
- 廃止理由: プラグインから経路選択責務を外し、経路学習キャッシュに集約 (プラグインは extraction の自在性専用)
- 関連: [phase14 Plan](docs/plans/phase14-domain-strategy-cache.md), [data/README.md](data/README.md), [knowhow/domain-strategy-cache.md](docs/knowhow/domain-strategy-cache.md)
```

## Step 2: 既存ドキュメントから廃止経緯の詳細削除

### 線引きルール

- **「廃止」「削除」「廃止済」がメインの文** → DEPRECATED.md に移動、docs 側は 1 行サマリ + リンク
- **新機能の動作説明に必要な経緯** → docs に残す (例: yodobashi がなぜ curl_cffi なのか / 経路学習キャッシュへの統合)
- **二重に書かれている経緯** → DEPRECATED.md に一元化

### 個別書き換え

- **README.md L45**: 「(HTTP エンドポイントは phase11.5 で廃止)」→ 削除 (新機能の説明としては不要)
- **README.md L48 / L114**: phase14 言及 → 「プラグインは extraction 専用、経路選択は経路学習キャッシュ」に簡素化、廃止経緯は DEPRECATED.md にリンク
- **README.md 設計ドキュメントセクション**: `DEPRECATED.md` を 1 行追加
- **Library.md L94**: 末尾「Step 4 で…プラグインフラグ廃止済」→ 削除、DEPRECATED.md リンク
- **Library.md L115**: 「HTTP エンドポイント版は phase11.5 で廃止」→ 削除
- **SETUP.md L90**: Migration note → 1 行サマリに削減 + DEPRECATED.md リンク
- **SETUP.md L208**: phase14 リファクタリング言及 → 「経路選択は経路学習キャッシュに集約」のみ残し、廃止経緯詳細は削除
- **SETUP.md L443**: Step 進捗の冗長記述 → 現在の動作説明に絞る
- **SETUP.md L547**: phase11.5 セクション → 1 行 + DEPRECATED.md リンク
- **Plugins.md L258 / L272**: 「phase12.5 Step 2 / followup #3 で導入した forceX… 廃止」→ 削除 (現在の経路説明には不要)

## Step 3: README に DEPRECATED.md リンク追加

「設計ドキュメント」セクションに 1 行追加:

```markdown
- **[DEPRECATED.md](DEPRECATED.md)**: 廃止された機能と移行ガイド (旧 fastify-cli / 診断エンドポイント / forceX フラグ等)
```

## Step 4: 品質ゲート

- `pnpm build` / `pnpm eslint` / `pnpm typecheck` / `pnpm test` (584 件 + ADDF tests)
- **リンク切れチェック** — DEPRECATED.md → docs/plans / docs/knowhow / data/README.md のリンク解決確認
- **README → DEPRECATED.md** リンクの動作確認
- **削除した記述に他から参照が無いか確認** (`grep -rn "phase11.5 で廃止\|phase14 Step 4 で.*廃止" README.md docs/` で残存確認)

## サイズ

S〜M (新規 1 ファイル + 既存 4 ファイル簡素化)

## 実装完了状況 (2026-05-09)

- ✅ Step 1: `DEPRECATED.md` 新規作成 (ルート直下、4 機能 × 旧/新/廃止理由/移行手順 + 関連リンク)
- ✅ Step 2: 各 docs から廃止経緯詳細を削除 + DEPRECATED.md リンクへ集約
  - README.md L45 (HTTP エンドポイント廃止言及削除) / L114 (phase14 廃止経緯削除、現在の責務分離のみ残す)
  - docs/Library.md L94 (forceX 廃止経緯 → DEPRECATED.md リンク) / L115 (HTTP エンドポイント廃止言及削除)
  - docs/SETUP.md L90 (旧 JSON ベース → DEPRECATED.md リンク) / L208 (forceX 廃止経緯 → DEPRECATED.md リンク) / L443 (Step 進捗冗長記述を現状箇条書きに) / L547 (phase11.5 廃止セクション → 1 行 + DEPRECATED.md リンク + silent ignore 1 行)
  - docs/Plugins.md L258 / L272 (yodobashi / sqex の forceX 廃止経緯削除)
  - docs/deploy-examples/README.md L79 (phase11.5 廃止言及 → 1 行 + DEPRECATED.md リンク)
- ✅ Step 3: README.md 設計ドキュメントセクションに DEPRECATED.md リンク追加
- ✅ Step 4: 品質ゲート全パス (build / lint / typecheck / test 584 件 / リンク先存在確認 / アンカー整合)
- ✅ レビュー反映: Info I-1 (`parseFailureLogEndpoint` セクションに「旧の動作」追加で他 3 機能と構成揃え) + I-2 (SETUP.md 側に silent ignore 1 行を残して「古い config.toml を持つ既存運用者がここで詰まらない」ようにする) を反映
- ✅ 副次的修正: `config.example.toml` の `[plugins.allowed]` に `kakuyomu` 追加 (phase15.2 反映漏れを `test/config-example-plugins.test.ts` の自動ガードが catch)
