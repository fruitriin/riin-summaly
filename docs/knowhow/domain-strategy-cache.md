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

## bootstrap JSONL の運用 (Step 3 で同梱予定)

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

### `forceX` フラグとの優先順位

cache hit より forceX (forceProxyFallback / forceCurlCffiFallback) を優先する設計:

- `forceX` はプラグインが「このサイトは確実にこの経路でしか取れない」と確信しているシグナル
- cache に古い情報が残っていても plugin の意思を尊重する
- phase14 Step 4 で `forceX` は廃止予定。移行期は二重存在して問題ない (forceX が短期で使われるサイトは限定的)

### `'default'` strategy の fast path は UA リトライしない設計

通常カスケードの 1 段目は `getResponseWithFallback` (UA リトライ付き) だが、cache hit `'default'` の fast path は `getResponse` 直接 (リトライなし)。理由:

- cache が `'default'` を記録 = 過去 default UA 単独で成功した実績
- リトライ前提のラッパは不要
- fast path で失敗したら recordFailure → cascade で改めて UA リトライを試す形になる (二重リトライにならない)

## 参考

- [docs/plans/phase14-domain-strategy-cache.md](../plans/phase14-domain-strategy-cache.md)
- [src/utils/domain-strategy-cache.ts](../../src/utils/domain-strategy-cache.ts)
- [test/domain-strategy-cache.test.ts](../../test/domain-strategy-cache.test.ts)
- [docs/knowhow/observability-parse-failure-log.md](observability-parse-failure-log.md) — JSONL 永続化 + LRU パターンの先行事例
- [docs/knowhow/curl-cffi-tls-impersonation.md](curl-cffi-tls-impersonation.md) — yodobashi の bootstrap 値の根拠
- [docs/knowhow/cf-workers-outbound-proxy.md](cf-workers-outbound-proxy.md) — sqex の bootstrap 値の根拠
