# phase14 — 経路学習キャッシュ (domain strategy cache) で forceX 廃止 + 汎用最適化

## 背景

phase11.9 / 12.1 / 12.5 / 12.6 で **段階的フォールバック** (default UA → fallback UA → CF Workers proxy → curl_cffi) を整備し、各層を強制スキップする `forceCurlCffiFallback` (yodobashi) / `forceProxyFallback` (sqex) フラグも追加した。

これは **「人間が観測した最適経路をプラグインに焼き付ける」** 形であり、以下の課題がある:

1. **新サイト追加コストが高い**: プラグイン書く → 経路フラグを宣言 → デプロイのサイクル
2. **汎用パスでも同じ問題が起こる**: プラグイン無しのサイトも IP block / TLS 切断に遭遇するが救援できない
3. **「初回は default で 20 秒空回り」が学習機構なら不要だった**: 観察を毎回するのは無駄

オーナーからの提案:

> フォールバックは探索的な動作だけど、一度正解を引いたら、そのドメインに対して前段をスキップする、というより、第一選択肢として使うために成功した方法を記録するっていうふうにあらかじめ組み込んでおいたほうが、色々柔軟になる

## ゴール

- ドメイン (host + path prefix 1〜2 段) ごとに **「成功した取得経路」を学習** して JSONL で永続化
- 次回以降のリクエストでは **学習した経路を第一選択肢** として使い、失敗したら通常カスケードに fallback
- bootstrap JSONL をリポに同梱 (yodobashi → curl_cffi、sqex → proxy 等の主要サイト) して新規環境でも初回 20 秒待ちを回避
- `forceCurlCffiFallback` / `forceProxyFallback` フラグを削除 (プラグインから外す、TypeScript 型からも削除)
- プラグインは **「引き出し方の自在性」** (DOM 直読み・API 直叩き・URL 正規化等) のためだけに残す

## 設計詳細

### キャッシュエントリ

```typescript
interface DomainStrategyEntry {
  /** lookup key: 例 "amazon.co.jp" / "amazon.co.jp/dp" / "amazon.co.jp/gp/video" */
  pathKey: string;
  /** 成功した経路名 */
  strategy: 'default' | 'fallback_ua' | 'proxy' | 'curl_cffi';
  /** 連続成功回数 (= 信頼度) */
  successCount: number;
  /** 連続失敗回数 (これが N 以上で破棄) */
  consecutiveFailures: number;
  /** 最後に成功した unix ms */
  lastSuccessAt: number;
  /** 最後に試行した unix ms */
  lastAttemptAt: number;
}
```

### lookup 順序 (specific → general)

リクエスト URL `https://amazon.co.jp/dp/B0XXXXXXXX/?ref=...` の場合:

1. `amazon.co.jp/dp/...` (path 2 段) — 完全一致
2. `amazon.co.jp/dp` (path 1 段) — prefix 一致
3. `amazon.co.jp` (host のみ) — host 一致

**最初にヒットしたエントリの `strategy` を第一選択肢** として使う。

`amazon.co.jp/gp/video` を default UA で取れているとき、`amazon.co.jp/dp` だけ proxy 経由が必要、というケースが綺麗に表現できる。

### 成功 / 失敗の判定

**成功**:
- HTTP 取得が throw せず、最終的な `Summary` で:
  - `title != null && title !== url.hostname` (host と一致するのは thin の典型)
  - `description != null` (or `image != null` でも可)

**失敗**:
- `getResponseWithCurlCffiFallback` が throw する (= 全段失敗)
- もしくは Summary の `title` が host と一致 / 全フィールド null

**N 連続失敗で破棄** (一時的なサイト障害でエントリを破棄しないため、デフォルト N=3)。連続失敗中は学習した経路を引き続き第一選択肢として使う (= 一時障害なら次回成功で `consecutiveFailures` リセット)。N 回連続失敗したらエントリ破棄、次回から default 経路に戻る。

### 永続化

```
data/domain-strategy-bootstrap.jsonl    (リポに commit、初期データ)
~/.cache/summaly/domain-strategy.jsonl  (runtime、gitignored、append-only)
```

- 起動時に **bootstrap → runtime の順でロード**、runtime 優先 (上書き)
- 学習更新は **runtime ファイルに append**
- 定期的に compaction (重複エントリを最新だけ残してファイル書き換え) — 例: 1000 行超えたら BG で実施
- ファイルパスは `[scraping.strategy_cache]` TOML セクションで設定可能

### bootstrap 同梱内容 (リポ管理)

```jsonl
{"pathKey":"yodobashi.com","strategy":"curl_cffi","successCount":1,...}
{"pathKey":"www.yodobashi.com","strategy":"curl_cffi","successCount":1,...}
{"pathKey":"store.jp.square-enix.com","strategy":"proxy","successCount":1,...}
{"pathKey":"www.amazon.co.jp/dp","strategy":"proxy","successCount":1,...}
{"pathKey":"amazon.co.jp/dp","strategy":"proxy","successCount":1,...}
```

bootstrap は **「どこが詰まる経験則」** を集約したリポ知見の表現。新サイト追加時に `force*` を書く代わりにここに 1 行追加する形に進化。

### `scpaping()` への統合

```
scpaping(url, opts)
  ↓
  lookup domain-strategy-cache (specific → general)
  ↓
  ヒット → 該当 strategy を最初に試す
       ↓
       成功 → 結果返却 + cache.recordSuccess(pathKey)
       失敗 → 通常カスケードで他経路を試行
                成功 → 結果返却 + cache.upsert(pathKey, 成功した strategy)
                全失敗 → throw + cache.recordFailure(pathKey)
  ヒットなし → 通常カスケード (= default UA から)
```

### `forceCurlCffiFallback` / `forceProxyFallback` の削除

1. **準備フェーズ**: 学習機構を実装、bootstrap に yodobashi / sqex を入れる
2. **検証フェーズ**: 学習機構を有効化した dev サーバで `forceX` フラグを外しても yodobashi / sqex が取れることを確認
3. **削除フェーズ**: `GeneralScrapingOptions.forceCurlCffiFallback` / `forceProxyFallback` を削除、プラグインから対応コード削除、テスト削除
4. **互換性**: `forceX` フラグ削除は **internal API change** (npm 公開の `SummalyOptions` には含まれていないので外部互換性影響なし)

## 実装ステップ

### Step 1 — ストレージ層 (S〜M) (完了 2026-05-07)

- [x] `src/utils/domain-strategy-cache.ts`:
  - `DomainStrategyEntry` 型定義 + `DomainStrategy` ユニオン型
  - `pathKeysOf(url)` で specific → general 順 (2 段, 1 段, host のみ) のキー生成
  - in-memory LRU (上限 5000 entries) + JSONL persistence
  - `lookup(url)` で最初にヒットしたエントリを `{entry, hitKey}` で返す
  - `recordSuccess(pathKey, strategy)` / `recordFailure(pathKey)`
  - bootstrap JSONL ロード (起動時 1 回、`consecutiveFailures` を 0 にリセットして取り込み)
  - runtime JSONL append (`appendFileSync` 同期、event loop 上で原子的)
  - compaction (`compactionThreshold` 行超で `setImmediate` 経由 → `writeFileSync` + `renameSync` 原子置き換え)
  - N 連続失敗で破棄 (デフォルト 3)
- [x] `bin/config-loader.ts` に `[scraping.strategy_cache]` セクション追加:
  - `enabled = true` (デフォルト ON)
  - `bootstrapPath` (省略時: bootstrap なし。Step 3 で `data/domain-strategy-bootstrap.jsonl` 同梱予定)
  - `runtimePath` (省略時: 永続化なし、in-memory のみ)
  - `maxEntries = 5000`
  - `consecutiveFailureThreshold = 3`
  - `compactionThreshold = 1000`
- [x] `SummalyOptions.domainStrategyCache?: DomainStrategyCacheOptions` を追加
- [x] テスト (36 ケース): lookup 順序 / append / compaction / 連続失敗破棄 / bootstrap consecutiveFailures リセット (C-1) / data: file: スキーム除外 (W-3)
- [x] config-loader テスト 11 ケース追加
- [x] config.example.toml + docs/deploy-examples/summaly-config.example.toml 両方に `[scraping.strategy_cache]` セクション追加
- [x] docs/Library.md / docs/SETUP.md に説明追加
- [x] CHANGELOG (unreleased) にエントリ追加

#### 方針からの変更

- `lookup(host, path)` ではなく `lookup(url)` API に変更 (URL から自動で pathKeys を導出)
- `runtimePath` のデフォルトを `~/.cache/summaly/domain-strategy.jsonl` ではなく **省略時は永続化なし** に変更 (依存関係を増やさず、運用者が明示的に指定する設計)
- bootstrap ロード時に `consecutiveFailures` を 0 にリセットして取り込み (レビュー C-1: 同梱データの誤削除防止)
- `pathKeysOf` は `data:` / `file:` / `javascript:` 等の non-http(s) スキームを空配列で返す (レビュー W-3: phase10.1 sanitizeUrlForLog の教訓再適用)
- compaction 失敗時の `.tmp` ファイル cleanup を `unlinkSync` で追加 (レビュー C-2)
- append 用と compaction 用の error logged フラグを分離 (レビュー W-1: 一方が抑制されても他方は通る)

### Step 2a — `scpaping()` への統合 (cache hit fast path のみ) (完了 2026-05-07)

- [x] `src/utils/domain-strategy-cache.ts` に module-level singleton (`setActiveCache` / `getActiveCache`) 追加 (`agent` と同じパターン)
- [x] `src/utils/got.ts` の `scpaping()` で:
  - 内部関数 `fetchResponse` に切り出し
  - 開始時に cache lookup (forceX フラグの後、通常カスケードの前)
  - ヒット → `fetchByStrategy` で該当 strategy を直接呼ぶ
    - 'default' / 'fallback_ua' → `getResponse` (UA 切替のみ、リトライなし)
    - 'proxy' → `viaProxyWorker` (cascade 経由しない)
    - 'curl_cffi' → `viaCurlCffi` (cascade 経由しない)
  - ゲート不通過 (config / allowlist / https 不一致) → null 返して fallthrough (recordFailure 呼ばない、中立)
  - fast path 成功 → `cache.recordSuccess(hitKey, strategy)`
  - fast path 失敗 (throw) → `cache.recordFailure(hitKey)` + 通常カスケード fallthrough
  - キャッシュミス → 通常 4 段カスケード (既存挙動)
- [x] テスト 7 ケース: cache 未設定回帰 / default 成功 / default 失敗 → throw / default 失敗 → cascade 救援 / fallback_ua ゲート不通過 / proxy ゲート不通過 / 閾値到達破棄
- [x] レビュー対応 (W-1 / W-2 / S-1 / S-2 / S-3 全て修正)

### Step 2b 前半 — cascade tracking + cache miss 時の recordSuccess (完了 2026-05-07)

- [x] `src/utils/got.ts` の cascade 関数群 (`getResponseWithFallback` / `getResponseWithProxyFallback` / `getResponseWithCurlCffiFallback`) に optional **`StrategyTracker`** ({ value?: DomainStrategy }) 引数を追加し、各段成功時に `tracker.value` を該当 strategy にセット
- [x] `src/utils/got.ts` の `fetchResponse` で cache miss 時に tracker を作成 + cascade に渡し、成功時に状況別に pathKey を選定して `recordSuccess` 呼出
  - cache hit が throw で失敗 → `hit.hitKey` 上書き
  - cache miss → 1-seg pathKey (host のみ URL は host)
  - cache hit gate-fail → record せず (entry を「config 復帰時の再利用候補」として温存、neutrality)
- [x] テスト 4 件追加 (cache miss + cascade default 成功 / host のみ URL / cache hit fail + cascade success → hitKey 上書き / cache miss + cascade fail → 何も記録しない)
- [x] Step 2a の test 1 件 (cache hit + fast path 失敗 → cascade で成功) を Step 2b 仕様 (cascade success で consecutiveFailures が 0 にリセット) に更新
- [x] レビュー対応 (W-1 / W-2 / W-3 / S-1 / S-3 全て修正、S-2 はコメントのみ対応)

### Step 2b 後半 — Summary レイヤ override (完了 2026-05-08)

- [x] `src/utils/domain-strategy-cache.ts` に `CacheRecordingState` 型を追加 (mutable side-channel)
- [x] `src/general.ts` の `GeneralScrapingOptions._cacheRecording` フィールド追加 (`@internal`)、`general()` で scpaping 呼出時に opts spread に伝搬
- [x] `src/utils/got.ts` の `fetchResponse` から `cache.recordSuccess` / `cache.recordFailure` 呼出を全削除、`opts._cacheRecording` に context 埋める形に refactor
  - `recordKey` を lookup 直後に決定 (cache hit なら hitKey、miss なら 1-seg pathKey)
  - fast path 成功 → `state.strategy = hit.entry.strategy`
  - ゲート不通過 (null) → `state.gateFailedNeutral = true`
  - cascade 成功 → `state.strategy = tracker.value`
  - **fast path 失敗そのものは recordFailure しない** (transient とみなし、cascade 結果が支配する)
- [x] `src/index.ts` で `summaly()` トップレベルの try/catch wrapping + Summary 確定後の `isThinSummary` 判定 + `recordCacheSuccess` / `recordCacheFailure` ヘルパ呼出
- [x] テスト 3 件追加 (Summary thin → recordFailure / 連続 thin で閾値到達 invalidate / HTTP throw → recordFailure)
- [x] 既存テスト 2 件のコメント整合性更新 (Step 2b 前半時代の挙動コメントを Step 2b 後半挙動に追従)
- [x] レビュー対応 (W-1 / W-2 / S-1 / S-3 / S-4 全てコメント・JSDoc 更新で対応、S-2 は意図通りで記載のみ)

#### 設計判断

- **HTTP 層 recordSuccess を廃止 → Summary 層に集約**: HTTP 200 + Summary thin の振動で連続失敗カウンタが閾値に達せず invalidate が機能しない構造的バグを解消
- **fast path 失敗は記録しない (transient とみなす)**: cascade で同 strategy が成功すれば一過性の失敗、別 strategy で成功すれば新 strategy が hitKey に上書き (recordSuccess) されるため、いずれにせよ最終的な cache 状態は cascade 結果が支配する。fast path 失敗を別途 recordFailure すると、cascade success の recordSuccess でリセットされて結局意味がない
- **`forceX` 経路では `_cacheRecording` を触らない**: phase14 Step 4 で `forceX` 廃止予定のため、移行期で cache に記録すると `forceX` を消した瞬間に矛盾する経路情報が残る恐れがある。`forceX` 経路は cache 管理対象外で運用

### Step 2b-4 — Fastify auto-init (完了 2026-05-08)

- [x] `src/index.ts` の Fastify plugin setup で `options.domainStrategyCache?.enabled === true` のとき `DomainStrategyCache` インスタンス化 + `setActiveCache(cache)`
- [x] テスト 4 件追加 (auto-init / 未指定 / enabled=false / 全オプション伝搬 path 系含む)
- [x] レビュー対応 (W-1 シャドーイング解消 / W-2 テスト対称性 / W-3 path オプション伝搬テスト)

#### 設計判断

- モジュールレベル singleton (既存 `setAgent` パターン踏襲): 1 プロセス 1 Fastify 想定で複数インスタンスは「後勝ち」
- Fastify close 時の cleanup なし: 既存 `setAgent` も同様で、ライブラリ利用時のテスト責任で reset
- `bootstrapPath` / `runtimePath` 未指定時 (`undefined`) は `DomainStrategyCache` 内で「bootstrap なし / 永続化なし」として解釈される。Step 3 で bootstrap.jsonl 同梱したらデフォルトのパス解決を入れる予定

### Step 3 — bootstrap JSONL 同梱 (完了 2026-05-08)

- [x] `data/domain-strategy-bootstrap.jsonl` を作成 (yodobashi / www.yodobashi / sqex / amazon.co.jp/dp / amazon.co.jp/gp / amazon.com/dp 等 9 行)
- [x] `package.json` の `files` に `data/` を追加 (npm publish に含める)
- [x] パス解決方式: tsdown bundle へのコピーではなく **`getDefaultBootstrapPath()` で `import.meta.url` から自動解決** (bundled `built/<file>` → `../data/...` と source `src/utils/X.ts` → `../../data/...` の 2 候補を `statSync` で probe)
- [x] `data/README.md` で bootstrap の役割を説明 (スキーマ・新サイト追加の流れ・curl_cffi/proxy/fallback_ua 選定基準・amazon.com/gp 不在の判断メモ)
- [x] `src/index.ts` Fastify auto-init で `bootstrapPath ?? getDefaultBootstrapPath()` を適用
- [x] テスト 3 件追加 (getDefaultBootstrapPath 絶対パス返却 / 全グループ網羅 lookup / Fastify auto-load)
- [x] `docs/SETUP.md` / `config.example.toml` / `docs/deploy-examples/...example.toml` の bootstrapPath 説明を「省略時は同梱を自動解決」に更新
- [x] レビュー対応 (W-1 docs 乖離 / W-2 CHANGELOG 漏れ / W-3 path 区切り依存 / S-1 候補設計コメント / S-2 amazon.com/gp 判断メモ / S-3 全グループ網羅テスト / S-4 README 導入バージョン)

### Step 4 — `forceX` 廃止 + プラグイン整理 (完了 2026-05-08)

- [x] `src/plugins/yodobashi.ts` から `forceCurlCffiFallback: true` / `proxyFallback: undefined` 削除
- [x] `src/plugins/sqex.ts` から `forceProxyFallback: true` 削除
- [x] `src/general.ts` の `GeneralScrapingOptions` から `forceCurlCffiFallback?` / `forceProxyFallback?` 削除 (フィールド + 伝搬行)
- [x] `src/utils/got.ts` の scpaping 分岐から該当ブロック削除 (~50 行) + JSDoc 更新
- [x] `src/utils/proxy-fallback.ts` の `viaProxyWorker` は引き続き export (cache lookup から呼ぶため、変更なし)
- [x] テスト削除 (`describe('scpaping forceCurlCffiFallback ...')` 3 件、`describe('scpaping forceProxyFallback ...')` 5 件)
- [x] `skipRedirectResolution` は維持 (yodobashi に対して有効、HEAD probe スキップは経路学習と独立した最適化)
- [x] docs 更新 (Plugins.md / SETUP.md / cf-workers-outbound-proxy / domain-strategy-cache knowhow / CHANGELOG)
- [x] レビュー対応 (W-1 sqex JSDoc strategy_cache 前提明示 / W-2 yodobashi JSDoc 同上 + デグレ警告 / I-1 「プラグイン残す意味」明示)

### Step 5 — dev サーバ UI 統合 (部分完了 2026-05-08)

- [x] **`/api/strategy-cache` エンドポイント (dev 専用)** — `dev/server.ts` で `DomainStrategyCache` を `getDefaultBootstrapPath()` 自動ロード付きでインスタンス化 + `setActiveCache` で singleton 登録。`GET /api/strategy-cache` が cache 中身 (size + bootstrapPath + entries `lastAttemptAt` 降順) を JSON で返す。本番には載せない (機密データ漏洩経路化を防ぐため dev 限定)
- [ ] **`pnpm dev` UI に「現在のドメイン経路マッピング」表示パネル** — UI work、手動検証必要のため自動化対象外
- [ ] **サンプル URL から取得すると経路マッピングが学習される動作確認** — UI 操作 + 目視検証必要のため手動

### Step 6 — ドキュメント (完了 2026-05-08)

- [x] `docs/Library.md` に `[scraping.strategy_cache]` 設定説明 (Step 1 / 2b-4 / 3 で逐次完了)
- [x] `docs/SETUP.md` に bootstrap / runtime path の運用説明 (Step 1 / 3 で完了、Step 4 で「予定」表現を完了形に)
- [x] `docs/Plugins.md` の sqex / yodobashi セクションを更新 (Step 4 で「forceX フラグ → cache + bootstrap 経由」に書き換え)
- [x] `docs/knowhow/domain-strategy-cache.md` を新設 (Step 1 で作成、各 Step ごとに追記)
- [x] `CLAUDE.repo.md` の yodobashi / sqex 行を Step 4 反映に更新 (Step 6 で実施)
- [x] `CHANGELOG.md` に各 Step エントリ追加 (Step 4 は **breaking note** で internal 型 `GeneralScrapingOptions` から forceX 削除を記載)

### Step 7 — skill 更新 (完了 2026-05-08)

- [x] `/url-preview-check` の Phase 4 「修正レイヤの選定」表を更新: **経路学習キャッシュ層** を最上段に追加し「`bootstrap.jsonl` に 1 行追加」を第一選択肢に明示
- [x] 同 skill の fail mode H (yodobashi 系 TLS 切断) / B' (sqex 系 IP block 200+thin) セクションを「forceX フラグ」から「bootstrap entry + (必要なら) プラグイン」の説明に書き換え
- [x] 「新サイト追加の判断フロー (phase14 以降)」を Phase 4 末尾に追加 — 経路だけ問題 / URL 正規化必要 / DOM 直読み必要 / ブラウザ JS 実行必要 の 4 段階で判断

## 設計判断

### なぜ静的 TTL を使わないか

オーナー意見: 「経路情報は時間経過でほぼ変わらない」 (= サイトが新たに WAF を入れることは年に何度もない)。

→ **静的 TTL より失敗ベース invalidate** のほうが運用上シンプル。N 連続失敗 (デフォルト 3) で破棄するだけで、サイト側のポリシー変更にも自然に追従する。一時的な障害 (たまたま 5xx) で経路が破棄されないように N>1 で連続性を担保。

### なぜ host のみ + path prefix 2 段で打ち切るか

実例: `amazon.co.jp/dp/*` だけ proxy / `amazon.co.jp/gp/video/*` は default UA / `amazon.co.jp/exec/...` は別経路、というように **同一サイトでパス別に挙動が違うケース** は実在する (Amazon が典型)。

ただし path 3 段以上の細分化はオーバーフィットのリスク (= キャッシュサイズ爆発、ヒット率低下)。2 段で経験則上十分という判断 (拡張可能性は残す)。

### なぜ runtime cache を gitignored にするか

- 個人運用情報 (どのサイトをよく見ているか) が含まれる
- 環境ごとに学習結果が違う (本番 Vultr Tokyo IP と dev MacOS で経路が違う) ので commit できない
- bootstrap (= 横断的に共有できる知見) と runtime (= 環境固有の学習) の分離

### bootstrap JSONL の運用

新サイトで「経路詰まり」を発見したら:

1. (これまで) プラグインに `forceX` フラグ追加 → コミット → デプロイ
2. (今後) `data/domain-strategy-bootstrap.jsonl` に 1 行追加 → コミット → デプロイ

プラグインを書く必要は **「独自 DOM パース」「URL 正規化」「API 直叩き」** の場合のみ。経路選択は学習機構に任せる。

### マイグレーション戦略 (Step 4 の安全性)

- `forceX` 削除前に Step 1〜3 を完了 + bootstrap に yodobashi / sqex 入れる
- Step 4 で `forceX` を削除する直前に **bootstrap が効いている確認** を取る (dev で `force*` を消した状態で yodobashi / sqex が取れるテストを追加)
- 削除後に本番デプロイ + 動作確認

## 関連

- [docs/plans/phase12.6-sqex-store-proxy.md](phase12.6-sqex-store-proxy.md) — `forceProxyFallback` 導入元 (本フェーズで廃止対象)
- [docs/plans/phase12.5-curl-cffi-fetcher.md](phase12.5-curl-cffi-fetcher.md) — `forceCurlCffiFallback` 導入元 (同上)
- [docs/knowhow/cf-workers-outbound-proxy.md](../knowhow/cf-workers-outbound-proxy.md) — proxy fallback 設計
- [docs/knowhow/curl-cffi-tls-impersonation.md](../knowhow/curl-cffi-tls-impersonation.md) — curl_cffi 設計
- [docs/knowhow/inflight-dedup-pattern.md](../knowhow/inflight-dedup-pattern.md) — phase4.2 で実装した類似 in-memory cache パターンの参考

## 想定サイズ

**M〜L**: ストレージ層 + scpaping 統合 + bootstrap 同梱 + forceX 廃止 + dev UI + ドキュメントで広範囲の変更だが、各 Step は独立性が高く逐次着手可能。AI 実装で 4〜6 セッション (Step 1, Step 2+3, Step 4, Step 5+6+7) 程度の見積もり。

## 完了状況

Step 1 + Step 2 系 + Step 3 + Step 4 + Step 6 (docs 仕上げ) + Step 7 (skill 更新) + Step 5 部分 (`/api/strategy-cache` API) 完了 (2026-05-08)。**残るは Step 5 の UI パネル + 目視検証のみ** — UI work と動作確認は手動範囲。
