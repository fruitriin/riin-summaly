# 経路学習キャッシュ (domain strategy cache) 設計知見

> phase14 Step 1 で導入。サイトごとに「成功した取得経路」を学習・JSONL 永続化することで、段階的フォールバックの空回りコストをゼロ化する仕組み。

## 動機

phase11.9 / 12.1 / 12.5 / 12.6 で段階的フォールバック (default UA → fallback UA → CF Workers proxy → curl_cffi) を整備したが:

1. **「初回 default で 20 秒空回り」** が yodobashi 級の TLS 切断サイトで発生する
2. **`forceCurlCffiFallback` / `forceProxyFallback` フラグの宣言コスト** が新サイト追加で必須になる
3. **汎用パス (プラグイン非対応サイト)** は経路選択ができず、毎回最初から空回り

→ 「経路を学習して再利用する」キャッシュ機構で根本解決する設計が phase14。Step 1 はストレージ層のみで、`scpaping()` 統合 (Step 2) と `forceX` 廃止 (Step 4) は次フェーズ。

## 設計のキモ

### bootstrap + runtime の 2 段ロード

```
data/domain-strategy-bootstrap.jsonl    # リポ管理、横断的知見
~/.cache/summaly/domain-strategy.jsonl  # 環境固有学習履歴 (gitignored)
```

- bootstrap → runtime の順にロード、runtime 優先で上書き
- bootstrap は「同梱時点でのベスト経路」のスナップショット (yodobashi → curl_cffi 等)
- runtime は環境固有 (本番 Vultr Tokyo IP の学習結果と dev MacOS の学習結果は別物)

**設計教訓**: bootstrap ロード時は **`consecutiveFailures` を 0 にリセットして取り込む** こと。bootstrap.jsonl に `consecutiveFailures: N` が書かれていても、それは過去の同梱時点の状態であり、現環境では意味を持たない。runtime threshold で誤って削除されないよう、bootstrap は 0 リセットが必須 (phase14 Step 1 レビュー C-1)。

### lookup 順序: specific → general

URL `https://amazon.co.jp/dp/B0XXXXXX/?ref=...`:

1. `amazon.co.jp/dp/B0XXXXXX` (path 2 段) — 完全一致
2. `amazon.co.jp/dp` (path 1 段) — prefix 一致 (bootstrap で典型的)
3. `amazon.co.jp` (host のみ) — host 一致

最初にヒットしたエントリを採用。「同一サイトで path 別に経路が違う」ケース (例: amazon.co.jp/dp は proxy / amazon.co.jp/gp/video は default) を 2 段で表現できる。3 段以上はオーバーフィット (キャッシュサイズ爆発、ヒット率低下) になるため不採用。

### 失敗ベース invalidate

- N 連続失敗 (デフォルト 3) でエントリ破棄
- 失敗中は学習した経路を引き続き使う (一時障害なら次回成功で `consecutiveFailures` リセット)
- WAF ポリシー変更にも自然に追従 (静的 TTL より柔軟)

**設計教訓**: 連続失敗カウントは「**現在の経路がもう使えない**」シグナル。1 回の失敗で破棄するとサイト一時障害でエントリが消失して次回再学習コストが発生するため N>1 が必須。

### 閾値到達 → 「破棄済みマーク」を JSONL append

```
runtime.jsonl:
  {"pathKey":"a.com","strategy":"proxy","successCount":5,"consecutiveFailures":0,...}
  {"pathKey":"a.com","strategy":"proxy","successCount":5,"consecutiveFailures":1,...}
  {"pathKey":"a.com","strategy":"proxy","successCount":5,"consecutiveFailures":2,...}
  {"pathKey":"a.com","strategy":"proxy","successCount":5,"consecutiveFailures":3,...}  # 閾値到達
```

次回起動時の `loadJsonl` で閾値到達エントリを検出 → `map.delete(pathKey)` で破棄。bootstrap に同 key があっても上書き打ち消し。トムストーン ({"deleted":true}) を別途設けるよりシンプル。

**設計教訓**: 削除を表現するのに新規スキーマ要素 (deleted flag) を増やすより、「閾値到達 = 削除」という既存の状態を再利用する方が後方互換性とロジック単純化の両面で得。

## 永続化 / 並行性

### `appendFileSync` (同期) を選択

- Fastify async ハンドラから並行に呼ばれても event loop 上で原子的に完了する
- 非同期 `fs.promises.appendFile` だと writes が interleave して JSONL 行が混ざる可能性
- 同期 I/O の遅延は ~ms オーダーで許容範囲 (parse-failure-log と同じパターン)

### compaction の原子置き換え

```
1. tmp = `${runtime}.tmp.${pid}.${ts}`
2. writeFileSync(tmp, allLines)
3. renameSync(tmp, runtime)  # filesystem-level atomic
4. catch: unlinkSync(tmp)    # tmp リーク防止
```

`setImmediate` で defer して呼び出しスタックから切り離すが、内部処理は同期で原子性を担保。**設計教訓**: writeFileSync 成功後 renameSync 失敗 (cross-device 等) で tmp リーク。catch 内で必ず unlinkSync を試みる (失敗しても無視) (phase14 Step 1 レビュー C-2)。

### error logged フラグの分離

```
private appendErrorLogged = false;   // 行 append 用
private compactErrorLogged = false;  // rewrite 用
```

両方を共通フラグで抑制すると、append が一度失敗 → 以降 compaction 失敗ログも出ない構造。append と compaction はそれぞれ独立した I/O 経路なので**抑制フラグを分離**するのが正解 (phase14 Step 1 レビュー W-1)。

## URL スキームの取り扱い

`pathKeysOf` は **`http:` / `https:` 限定** で、その他のスキームは空配列を返す。

```typescript
if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
if (u.hostname === '') return [];
```

- `data:text/html,...` → `URL.origin === 'null'`、hostname 空 → `[]`
- `file:///etc/passwd` → hostname 空 → `[]`
- `javascript:alert(1)` → 同上 → `[]`
- `ftp://example.com/foo` → スキーム外 → `[]`

phase10.1 で `sanitizeUrlForLog` が同じ落とし穴 (URL.origin === "null" 時のガベージ文字列混入) で対処したのと同種の防衛。**設計教訓**: phase10.1 の sanitizeUrlForLog 教訓は学習キャッシュにも横展開すべきで、レビュー段階でも knowhow 照合が役立つ事例 (Feedback 「過去 knowhow 横展開」と同じパターン)。

## API 設計

```typescript
class DomainStrategyCache {
  lookup(url: URL | string): { entry; hitKey } | undefined;
  recordSuccess(pathKey: string, strategy: DomainStrategy): void;
  recordFailure(pathKey: string): void;
  snapshot(): DomainStrategyEntry[];
  clear(): void;
}
```

- `lookup` の戻り値が `{entry, hitKey}` の理由: Step 2 統合で「**ヒットしたキーと同じ pathKey に成功記録する**」か「**より specific なキーに成功記録する**」か呼び出し側が判断するため、hitKey の露出が必要
- `recordSuccess` / `recordFailure` は同期関数で event loop 上で原子的 (parse-failure-log の `record` と同じ理由)
- `forceCompaction()` は `@internal` でテスト専用

## bootstrap JSONL の運用 (Step 3 で同梱済み — `data/domain-strategy-bootstrap.jsonl`)

```jsonl
{"pathKey":"yodobashi.com","strategy":"curl_cffi","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234,"lastAttemptAt":1234}
{"pathKey":"www.yodobashi.com","strategy":"curl_cffi","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234,"lastAttemptAt":1234}
{"pathKey":"store.jp.square-enix.com","strategy":"proxy","successCount":1,"consecutiveFailures":0,"lastSuccessAt":1234,"lastAttemptAt":1234}
```

新サイトで「経路詰まり」を発見した時の運用フロー:

| 旧 (phase12.5 / 12.6) | 新 (phase14 完成後) |
|---|---|
| プラグインに `forceX` フラグ追加 → コミット → デプロイ | `data/domain-strategy-bootstrap.jsonl` に 1 行追加 → コミット → デプロイ |

プラグインは **「引き出し方の自在性」** (DOM 直読み・API 直叩き・URL 正規化) のみ担当する設計に進化する。

## phase14 Step 2a 統合パターン (2026-05-07)

### モジュールレベル singleton で cache を共有

`scpaping()` から cache を参照する経路として、`agent` (got.ts) と同じく `setActiveCache` / `getActiveCache` のモジュールレベル singleton を採用。理由:

- summaly() は per-request 関数なので cache を request 引数で渡すと毎回インスタンス再作成のリスク (永続化ファイル再ロード等)
- Fastify mode は plugin instance state で持てるが、ライブラリ mode + テストの両方をカバーするには singleton が最も簡潔
- テスト分離は `afterEach(() => setActiveCache(undefined))` で OK (`setAgent({})` と同じ運用)

### ゲート不通過 (`null`) と実行時失敗 (`throw`) の意味区別

`fetchByStrategy` の戻り値設計:

```typescript
// null = ゲート不通過 (config 無効・allowlist 不一致・https 以外) → recordFailure 呼ばない
// throw = 実行時失敗 → recordFailure (連続失敗カウント増)
```

混同すると「config を一時的に無効化したらキャッシュエントリが N 回で破棄されてしまう」誤動作になる。**「現環境で使えない」** と **「一時的に失敗」** は別物として扱う。

### `forceX` フラグとの優先順位 (phase14 Step 4 で廃止済)

phase14 Step 2a の移行期は cache hit より forceX (forceProxyFallback / forceCurlCffiFallback) を優先する設計だった:

- `forceX` はプラグインが「このサイトは確実にこの経路でしか取れない」と確信しているシグナル
- cache に古い情報が残っていても plugin の意思を尊重する

**phase14 Step 4 で `forceX` フラグは廃止済**。プラグイン側からは経路選択の責務が外れ、bootstrap JSONL に同等エントリを書くことで `'curl_cffi'` / `'proxy'` の cache fast path 経由に統合された。プラグインは extraction (`skipRedirectResolution` 等) の自在性専用に整理されている。

### `'default'` strategy の fast path は UA リトライしない設計

通常カスケードの 1 段目は `getResponseWithFallback` (UA リトライ付き) だが、cache hit `'default'` の fast path は `getResponse` 直接 (リトライなし)。理由:

- cache が `'default'` を記録 = 過去 default UA 単独で成功した実績
- リトライ前提のラッパは不要
- fast path で失敗したら recordFailure → cascade で改めて UA リトライを試す形になる (二重リトライにならない)

## phase14 Step 2b 前半 統合パターン (2026-05-07)

### `StrategyTracker` mutable side-channel

cascade 関数群 (getResponseWithFallback / Proxy / CurlCffi) に **どの段で成功したかを伝える** 必要があるが、既存シグネチャ (`Promise<Got.Response<string>>`) を変えると下流の呼出側 (`scpaping()` / 直接利用テスト等) に幅広い影響が出る。

そこで **optional `tracker?: StrategyTracker` 引数** を追加して mutable side-channel で値を渡す:

```typescript
export type StrategyTracker = { value?: DomainStrategy };

// 各層の関数末尾で:
const r = await innerFetch(...);
if (tracker != null) tracker.value = '<strategy>';
return r;
```

**設計の利点**:
- 既存シグネチャ変更なし → tracker 未渡しの呼出側 (テスト含む) は完全互換
- 関数スコープ内で都度作成 (`const tracker = cache != null ? {} : undefined`) → 並行 summaly() 呼出間で混線無し
- カスケードチェーン (`Outer → Inner → Innermost`) で tracker を pass-through するだけで全層の情報を集約

**設計の妥協点**:
- mutable parameter は読みづらい (Promise の resolve に値を埋め込むパターンに比べて、状態がいつ確定するか不明瞭)
- 並行アクセスがある場合は危険 (本実装は関数スコープで完結なので影響無し)

### gate-fail neutrality (entry 温存設計)

Cache hit が `null` を返した = **「ゲート不通過」** ケースは entry が現環境で使えないだけで、過去成功した実績は残しておきたい。理由:

- ユーザーが proxy config を一時的に無効化して再有効化するワークフロー
- フィーチャーフラグの ON/OFF サイクル
- bootstrap の安定エントリが運用環境でたまたま無効になっているとき

そこで `cacheHitGateFailed` フラグで cascade success の record を **skip** し、entry を「config 復帰時の再利用候補」として温存する。

**実装ポイント**:
- `cacheHitFailed` (throw 失敗) と `cacheHitGateFailed` (null 返却) を **排他的フラグ** で分離
- recordSuccess 判定: `cache != null && tracker?.value != null && !cacheHitGateFailed`
- gate-fail 時は entry が次回 lookup で hit 続けるが、fast path で再び null 返却 → cascade fallthrough → 同様に neutral 維持

**テストでの落とし穴**: short URL (`http://host/`) では hitKey と 1-seg pathKey が同じ `host` に collide する。Step 2a で書いた「proxy gate-fail entry が変わらない」テストが Step 2b で破綻する可能性があったが、`!cacheHitGateFailed` ガードで救済。

### 1-seg pathKey 選定の境界処理

cache miss 時の record 先は `keys[Math.max(0, keys.length - 2)]`:

| URL | pathKeysOf | length | index | recordKey |
|---|---|---|---|---|
| `https://example.com/` | `['example.com']` | 1 | 0 | `example.com` |
| `https://example.com/foo` | `['example.com/foo', 'example.com']` | 2 | 0 | `example.com/foo` |
| `https://example.com/foo/bar` | `['example.com/foo/bar', 'example.com/foo', 'example.com']` | 3 | 1 | `example.com/foo` |

**選定理由**:
- 「同パス配下の他 URL でも再利用される generalize 度」と「過剰一般化リスク」のバランス
- bootstrap JSONL も 1-seg を主流にする予定 (Step 3)
- length が 1 (host のみ) のときは index = 0 が host を返すため、`Math.max(0, keys.length - 2)` で境界も自然に処理される

### 既存仕様の挙動変化管理

Step 2a の 1 テスト (cache hit + fast path 失敗 → cascade で成功) は、Step 2b で **`consecutiveFailures` が 0 にリセットされる** 挙動になる (cascade success の recordSuccess が呼ばれて entry が更新されるため)。テスト expectation を `consecutiveFailures: 1` から `0` に変更した。

**設計判断**: 「fast path 失敗 → cascade 成功」は「strategy が今回も使えた = 一時障害」と解釈するため、failure カウントをリセットして hit entry を温存するのが正しい。Step 2a の expectation は HTTP 層のシグナルしか見ていなかったため、Step 2b の cascade success による「strategy 再確認」の意味を反映できていなかった。

## phase14 Step 2b 後半 統合パターン (2026-05-08)

### HTTP 層 recordSuccess を廃止し、Summary 層に集約する設計

Step 2b 前半までは scpaping レイヤで `cache.recordSuccess` を呼んでいたが、**HTTP 200 + Summary thin の振動** で連続失敗カウンタが閾値に達しない構造的バグが発覚:

```
1 回目: HTTP 200 → recordSuccess (cf=0, count=2) → Summary thin → recordFailure (cf=1, count=2)
2 回目: HTTP 200 → recordSuccess (cf=0, count=3) → Summary thin → recordFailure (cf=1, count=3)
...
```

`recordSuccess` が呼ばれるたびに `consecutiveFailures` が 0 にリセットされるため、invalidate (N 連続失敗で破棄) が永久に発火しない。これは yodobashi / sqex の **bot-block 200 + 正規 404 ページボディ** パターンで致命的。

**解決**: scpaping は `cache.recordX` を一切呼ばず、`opts._cacheRecording` に context を埋めて summaly() に伝達。summaly() が Summary 確定後に thin 判定して `recordSuccess` / `recordFailure` を一括判定する。これにより:

```
1 回目: HTTP 200 → state.strategy='default' → Summary thin → recordFailure (cf=1)
2 回目: HTTP 200 → state.strategy='default' → Summary thin → recordFailure (cf=2)
3 回目: HTTP 200 → state.strategy='default' → Summary thin → recordFailure (cf=3 = threshold) → 破棄
```

連続失敗が正しく蓄積される。

### `opts._cacheRecording` mutable side-channel パターン

scpaping → summaly の context 伝達手段として **opts への mutable side-channel** を採用。

```typescript
// SummalyOptions 拡張 (internal)
type GeneralScrapingOptions = {
  ...,
  /** @internal */ _cacheRecording?: CacheRecordingState;
};

// summaly() トップで作成
const cacheRecording: CacheRecordingState = {};
const scrapingOptions = { ..., _cacheRecording: cacheRecording };

// scpaping は opts._cacheRecording を mutate
const recState = opts?._cacheRecording;
if (cache != null && recState != null) {
  recState.recordKey = ...;
  recState.strategy = ...;
}

// summaly() で読み取って record
if (isThinSummary(result)) recordCacheFailure(cacheRecording);
else recordCacheSuccess(cacheRecording);
```

**設計のポイント**:
- per-summaly-call で新規作成 (= 並行リクエスト混線無し)
- 各 plugin / `general()` が opts を再構築する際は `_cacheRecording: opts?._cacheRecording` で参照伝搬が必要
  - 落とし穴: `general.ts` で `_cacheRecording` を漏らしていた → Step 2b 後半 実装で発見・修正
  - opts spread (`...opts`) の場合は自動的に伝搬する (sqex / yodobashi / nintendo-store のパターン)
- `getJson` / `getResponse` 直接呼び出し系プラグイン (bluesky / youtube / spotify / twitter / npmjs) は scpaping 経由しないため cache 非関与 (現状仕様、将来拡張余地)

### fast path 失敗を recordFailure しない設計

Step 2b 前半までは `cache hit fast path 失敗 → recordFailure(hitKey)` を即座に呼んでいたが、Step 2b 後半では呼ばない設計に変更。

理由:
- cascade で同 strategy が成功すれば一過性の失敗 (transient) → recordSuccess でリセットされる
- 別 strategy で成功すれば新 strategy が hitKey に上書き (recordSuccess) されて consecutiveFailures = 0
- いずれにせよ最終的な cache 状態は cascade 結果が支配する
- recordFailure を別途呼んでも cascade success の recordSuccess でリセットされるため意味がない

これは「**HTTP 層の即時シグナルを Summary 層の最終判定で吸収する**」という Step 2b 後半 の中心設計と一致。

### `forceX` 経路の取扱 (phase14 Step 4 で廃止)

phase12.5 / 12.6 で導入された `forceCurlCffiFallback` / `forceProxyFallback` フラグは、**phase14 Step 4 で完全廃止**。yodobashi / sqex はそれぞれ bootstrap entry (`yodobashi.com → curl_cffi`、`store.jp.square-enix.com → proxy`) で cache fast path を経由する経路に統合された。

設計の進化:

| phase | yodobashi 経路 | sqex 経路 |
|---|---|---|
| 12.4 | proxy fallback (categories 拡張で救援、~15-20s 空回り) | (未実装) |
| 12.5 | `forceCurlCffiFallback: true` で 1〜3段目スキップ | (未実装) |
| 12.6 | 同上 | `forceProxyFallback: true` で 1〜2段目スキップ |
| 14 Step 4 | bootstrap entry → cache fast path で curl_cffi 直行 | bootstrap entry → cache fast path で proxy 直行 |

新設計の利点: 新サイトを追加するときに `forceX` フラグを書く代わりに bootstrap.jsonl に 1 行追加するだけ。プラグインは「URL pattern 判定」と (必要なら) 「skipRedirectResolution の宣言」だけ持てばよい。

### `isThinSummary` の url 依存

`isThinSummary` は `summary.url` を `URL.hostname` として参照して `title === host` の判定を行う。

```typescript
const result = Object.assign(summary, { url: actualUrl });
if (isThinSummary(result)) recordCacheFailure(...);
```

順序が重要 — `summary` (url が undefined) を直接渡すと thin 判定が壊れる。コメントで明示すべき箇所。

## phase14 Step 2b-4 統合パターン (2026-05-08)

### Fastify モードでの cache 自動インスタンス化

Fastify plugin の setup フェーズで `options.domainStrategyCache?.enabled` を読み、true なら `DomainStrategyCache` を作成して `setActiveCache(cache)` で singleton 登録する。`parseFailureLog` の自動生成パターンと同一構造。

```typescript
// src/index.ts (Fastify plugin)
const strategyCacheOpts = options.domainStrategyCache;
if (strategyCacheOpts != null && strategyCacheOpts.enabled) {
  setActiveCache(new DomainStrategyCache({
    maxEntries: strategyCacheOpts.maxEntries,
    bootstrapPath: strategyCacheOpts.bootstrapPath,
    runtimePath: strategyCacheOpts.runtimePath,
    consecutiveFailureThreshold: strategyCacheOpts.consecutiveFailureThreshold,
    compactionThreshold: strategyCacheOpts.compactionThreshold,
  }));
}
```

**設計判断**:
- モジュールレベル singleton (既存 `setAgent` パターン): 1 プロセス 1 Fastify 想定で複数インスタンスは「後勝ち」
- Fastify close 時の cleanup なし (= 既存 `setAgent` も同様)
- `bootstrapPath` / `runtimePath` 未指定時 (`undefined`) は `DomainStrategyCache` 内で「bootstrap なし」「永続化なし」として解釈される
- 中間変数 `const cache = new ...` を避けて `setActiveCache(new ...)` で書く (Fastify 内の LRU `cache` 変数とのシャドーイングを回避)

これで `[scraping.strategy_cache]` TOML を書くだけで cache が有効化される (運用者向け簡素な API)。

## phase14 Step 3 統合パターン (2026-05-08)

### bootstrap JSONL の npm 同梱

`data/domain-strategy-bootstrap.jsonl` を `package.json` の `files: ["built", "data", "LICENSE"]` で publish 対象化。`data/` ディレクトリが利用者の `node_modules/@misskey-dev/summaly/data/` 配下に配備される。

bundler (tsdown) は `src/` のみを bundle するので **data/ ファイルは bundle 出力に含まれない**。npm publish の `files` 指定で別途配布される。これは tools/ (curl_cffi Python CLI) の同じパターンと対比できる。

### `import.meta.url` 起点のパス自動解決

ESM の `import.meta.url` を起点に bundle 配置 vs source dev 配置の両方を `statSync` で probe する設計:

```typescript
const dir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(dir, '..', 'data', 'domain-strategy-bootstrap.jsonl'),       // bundled: built/<file> → ../data/
  join(dir, '..', '..', 'data', 'domain-strategy-bootstrap.jsonl'), // source: src/utils/X.ts → ../../data/
];
for (const c of candidates) {
  try { if (statSync(c).isFile()) return c; } catch { /* try next */ }
}
return undefined; // graceful fallback
```

**設計のポイント**:
- 2 候補 probe で「同一コードが build 後と source 直接実行の両方で動く」ことを担保
- 見つからない場合は undefined → bootstrap なしで動作継続 (graceful)
- Fastify auto-init 1 回限りの呼出なので `statSync` 起動コストは無視できる
- 将来 tsdown 設定で chunk が `built/chunks/` 配下に置かれるようになったら 3 つ目の候補追加が必要 (`../../data/...`)

### `DomainStrategyCache` 内では auto-resolve しない設計判断

`getDefaultBootstrapPath()` は `DomainStrategyCache` のコンストラクタからは呼ばれない。テストで `new DomainStrategyCache()` した時に意図せずリポ data ファイルがロードされて状態汚染することを避けるため、**呼出側 (Fastify auto-init / 明示的に library mode で利用) が自分で解決して渡す**。

```typescript
// Fastify auto-init (src/index.ts)
setActiveCache(new DomainStrategyCache({
  bootstrapPath: strategyCacheOpts.bootstrapPath ?? getDefaultBootstrapPath(),
  ...
}));
```

**得られる効果**:
- DomainStrategyCache 単体テストは bootstrap 影響なしで実行可能
- Fastify mode 利用者は何も設定しなくても yodobashi/sqex/amazon が「初日から正しい経路で動く」
- 明示的な `bootstrapPath` を書けば override 可能

## 参考

- [docs/plans/phase14-domain-strategy-cache.md](../plans/phase14-domain-strategy-cache.md)
- [src/utils/domain-strategy-cache.ts](../../src/utils/domain-strategy-cache.ts)
- [test/domain-strategy-cache.test.ts](../../test/domain-strategy-cache.test.ts)
- [docs/knowhow/observability-parse-failure-log.md](observability-parse-failure-log.md) — JSONL 永続化 + LRU パターンの先行事例
- [docs/knowhow/curl-cffi-tls-impersonation.md](curl-cffi-tls-impersonation.md) — yodobashi の bootstrap 値の根拠
- [docs/knowhow/cf-workers-outbound-proxy.md](cf-workers-outbound-proxy.md) — sqex の bootstrap 値の根拠
