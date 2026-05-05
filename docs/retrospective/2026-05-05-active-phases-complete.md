# Retrospective — phase1.x ~ phase8.1 全アクティブフェーズ完了

> 期間: **2026-05-03 〜 2026-05-05**（3 日）
> 投入されたプラン数: **11 件完了 + 1 件保留**
> 成果コミット数: 11 件（`fix:` 2 / `feat:` 8 / `enhance:` 1）
> 主担当: AI（addf-dev ループ）+ オーナーレビュー

---

## 完了したフェーズ一覧

| Phase | 種別 | 主成果 |
|---|---|---|
| **1.1** | バグ修正 | Fastify モードの `Cache-Control` ヘッダ退化を修正（[issue #27](https://github.com/misskey-dev/summaly/issues/27)）。成功 1 週間 / エラー 1 時間の TTL を必ず付与 |
| **1.2** | バグ修正 | `summaly()` の `opts` mutation バグ修正（`Object.assign(summalyDefaultOptions, options)` がモジュール定数を mutate していた）。連続呼び出しでの opts 漏れを解消 |
| **2.1** | プラグイン基盤 | `getJson` ヘルパ、`SummalyPlugin.name`、`BROWSER_UA`、`KNOWN_SHORT_HOSTS`（短縮 URL の HEAD 解決）を追加。後続のプラグイン群を支える共通基盤 |
| **2.2** | 機能 | mei23 fork から非プラグイン機能（`Summary.medias`、`useRange`、`allowedPlugins`、`sanitizeUrl`、keep-alive agent、`SUMMALY_FAMILY`、`jschardet` + `encoding-japanese`）を取り込み。文字化け（[issue #39](https://github.com/misskey-dev/summaly/issues/39)）解消 |
| **3.1** | プラグイン | `youtube` / `spotify` を oEmbed 直叩きで実装。1 リクエストの高速パス |
| **3.2** | プラグイン | `dlsite` / `iwara` / `komiflo` / `nijie` の DOM 後処理プラグイン。NSFW 判定、404 リトライ、API 補完など |
| **4.1** | 流量制御 | Fastify モードのインメモリ LRU キャッシュ（`inMemoryCache`）。`Cache-Control` を解釈しない HTTP クライアント向けの defacto 必須設定 |
| **4.2** | 流量制御 | in-flight リクエスト dedup（`inFlightDedup`、デフォルト on）。Misskey ストリーミング由来の thundering herd を緩和 |
| **5.1** | 機能 | PDF レスポンス対応（`enablePdf`、デフォルト off）。`pdf-parse` v2 + 5 層のハング対策（typeFilter / contentLengthLimit / useRange / 5 秒 timeout / 1 ページ） |
| **7.1** | 開発体験 | `pnpm dev` で起動する動作確認 Web UI。JSON / Misskey 風カード / iframe プレーヤーの 3 タブ。tsx + Vanilla JS |
| **8.1** | 運用基盤 | Breaking: `pnpm serve config.toml` で TOML 設定ファイル方式に移行。fastify-cli `--options config.json` を廃止。`[server]` / `[summaly]` / `[summaly.cache]` / `[summaly.pdf]` / `[plugins]` セクションでコメント・分割 |

保留中: **6.1 twitter プラグイン**（運用判断待ち）

---

## 蓄積した knowhow

| ファイル | 概要 |
|---|---|
| [object-assign-mutable-target.md](../knowhow/object-assign-mutable-target.md) | `Object.assign(constant, override)` がモジュール定数を mutate するアンチパターン |
| [typescript-typecheck-setup.md](../knowhow/typescript-typecheck-setup.md) | bundler / test runner が catch しない型エラー（ts(7016) 等）を `pnpm typecheck` で検出するセットアップ |
| [plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) | プラグイン基盤の設計判断と SSRF 防御パターン |
| [sanitize-and-agent-patterns.md](../knowhow/sanitize-and-agent-patterns.md) | 結果 URL の sanitize、keep-alive デフォルト agent、`useRange` / `allowedPlugins` の設計 |
| [inflight-dedup-pattern.md](../knowhow/inflight-dedup-pattern.md) | in-flight Map で同 URL 並列リクエストを 1 本化、`Promise<CacheEntry>` でエラーを resolve 値に埋め込む finally 不要パターン |
| [dev-server-tsx-pattern.md](../knowhow/dev-server-tsx-pattern.md) | tsx で TS を直接走らせる dev サーバ。`_VERSION_` の side-effect import 注入、HOST/PORT defensive validation |
| [toml-config-loader-pattern.md](../knowhow/toml-config-loader-pattern.md) | TOML 設定 loader を `bin/` 配下に置く設計、`server.host` 空文字 SSRF リレー対策、未知キー silent 無視の forward-compat |

---

## 重要な設計判断と効いた知見

### A. 「`Object.assign` のモジュール定数 mutate」を knowhow にしたら横展開できた

phase1.2 で発見した `Object.assign(summalyDefaultOptions, options)` の mutation バグ。knowhow 化したことで phase4.1 / 7.1 / 8.1 のレビュー時に「同類の落とし穴がないか」を意識できた。

### B. `dev-server-tsx-pattern` の HOST 空文字検証が phase8.1 にそのまま効いた

phase7.1 で dev サーバの `process.env.HOST ?? '127.0.0.1'` を `HOST=''` で `::` バインドするリスクとして knowhow 化。phase8.1 の TOML loader で `server.host = ""` も同じ問題があり、レビュー agent が即座に気付けた。**knowhow → 横展開の流れがうまく回った象徴的事例**。

### C. レビュー指摘で `src/config-loader.ts` を `bin/` に動かした

phase8.1 で当初 plan 通り `src/config-loader.ts` に置いたが、レビュー agent が「`src/index.ts` から将来 import されると smol-toml が npm 公開 bundle に混入するリスク」を構造上の問題として指摘。`bin/` に移動して構造的に排除。**Plan を絶対視せず、レビューで構造改善を許容する運用が機能**。

### D. `Promise<CacheEntry>` の resolve 値にエラーを埋め込む（phase4.2）

エラー伝搬を Promise reject ではなく `{ kind: 'success' | 'error' }` の tagged union で表現。`try/finally` 不要・全 waiter で同じ errorPayload・LRU set パスを統一できる。コードレビューでの ESLint `no-non-null-assertion` 違反指摘が改善方向を示してくれた。

### E. PDF 対応の「オプトイン + 多段防衛」（phase5.1）

`pdf-parse` v2 の重さ・悪性 PDF のリスクを踏まえ「デフォルト off」+ 「typeFilter / Content-Length / useRange / 5 秒 timeout / 1 ページ」の 5 層防御。**運用者に最終判断を委ねる設計**は、後続の機能でも参考にすべき。

---

## 数字で見る進捗

- **テスト件数**: 約 90（初期）→ **158**（最終）。1 件 skip（network test）
- **依存追加**:
  - 本体 (`dependencies`): `lru-cache` (4.1), `pdf-parse` (5.1) を追加。それ以外は 既存
  - 開発 (`devDependencies`): `@fastify/static`, `tsx` (7.1), `smol-toml` (8.1) を追加
- **公開 bundle サイズ**: ~45 KB / gzip ~14 KB（dev/, bin/, smol-toml は **bundle 外**を維持）
- **Breaking change**: 1 件（phase8.1 の `pnpm serve` CLI 仕様変更）
- **CHANGELOG エントリ**: 11 件、すべて (unreleased) で待機中

---

## 残課題と推奨アクション

### 残タスク

- **phase6.1 twitter プラグイン（保留）**: misskey-dev/summaly の元コードから採用するかをオーナー判断中。Twitter API の認証要件 / iframe embed の挙動を確認し、必要なら再開
- **CHANGELOG の (unreleased) 整理**: 機能追加が積み上がっているので、リリース時には phase 単位のバージョン区切りを検討（5.4.0 候補）

### 次に着手するなら

1. **リリース 5.4.0 のタグ切り**: `(unreleased)` セクションを実リリースに固定。`smol-toml` を含む dependencies の最終確認、TOML マイグレーションの実機検証
2. **`docs/deploy-examples/summaly-config.example.json` の削除**（5.4 + 1 リリース後の予定）
3. **dev UI の改善**: phase7.1 の baseline は最小実装。プラグインごとの assertions、Misskey カードのレイアウト精度向上、iframe sandbox の Misskey 最新値同期 など、必要に応じて新規 plan
4. **plugin-options 受け渡し機構**: `[plugins.komiflo]` の placeholder を実装に変える（`SummalyPlugin` インターフェースに options 引数を追加）。新規 plan を起こす

### 運用上のフォロー

- **環境変数 → TOML キーの移行**: `SUMMALY_ALLOW_PRIVATE_IP` / `SUMMALY_FAMILY` は env のみ。要望次第で TOML キー化（別 phase）
- **TOML から環境変数で値を上書きする機能**: 本フェーズではスコープ外。「production の secret 注入」要望が出たら検討
- **永続キャッシュ**: phase4.1 のインメモリ LRU はプロセス再起動で消える。Redis 等の永続層が必要になれば新規 plan

---

## ADDF 推進エンジン側の知見

- **`addf-contribution-agent` のスキップ条件**: 「変更ファイルが `.claude/` `docs/knowhow/ADDF/` `templates/` を含まない場合はスキップ可」が安定運用できている。`.claude/settings.json`（permissions のみ）はスキップ条件の意図ベースで判断
- **`addf-code-review-agent` がセキュリティ観点で機能**: `host=""` SSRF リレー、`Object.assign` mutation、`try/finally` の non-null-assertion など、構造的な指摘が連続して出た
- **`/loop 30m /addf-dev` の運用**: バックログ消化に有効。ただし**未着手タスクなし状態の検出と loop 自動停止**が現状の運用には組み込まれていない（本セッションで AskUserQuestion で確認した）。テンプレート側に「TODO 空の検知 → CronDelete + PushNotification → 終了」の動線を組み込む案

---

## オーナーへの確認事項

1. リリース 5.4.0 を切るタイミング（テストでの実機検証や Misskey 本体への試験統合が必要か）
2. phase6.1 twitter プラグインの採用判断（再開するか、却下か、別のプラットフォーム / 機能で代替するか）
3. 次のロードマップ候補（dev UI 強化、plugin-options 機構、永続キャッシュ、SUMMALY_* env の TOML 化など）の優先付け
