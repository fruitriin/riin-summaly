# パース失敗ログ集約パターン（プラグイン候補発見器）

> phase10.1 で導入。Misskey の URL preview 運用で「このドメインのプラグインが欲しい」を可視化する仕組みを作るときの設計知見。

## 課題

Misskey インスタンスを運用していると「あのドメインがプレビュー綺麗にならない」という気付きが systemd ジャーナルに散らばる。実際にプラグインを書く判断材料にしたいが、

- どのドメインがどれくらいプレビューに失敗しているか
- どのドメインの URL がよく貼られるか
- そのドメインのどの URL パターン（記事 / プロフィール等）が問題か

を集約するのが手間。

## 設計

### 「失敗」の判定: throw / thin の 2 系統

- `throw`: `summaly()` が例外。ただし `isFilteredFailure` で「絶対失敗類型」を除外
- `thin`: 結果が「`description == null && thumbnail == null && player.url == null && (medias[]) なし` かつ title が hostname / 空 / null」=「汎用パスで OG/Twitter Card/`<title>` 何も取れなかった」

→ プラグインを書けば改善する候補は基本 `thin`。`throw` は filter で振り落とした残りカスを拾う。

### 「絶対失敗類型」の除外（重要）

ユーザーから「Akamai bot block の 403 のような絶対失敗するやつをログに詰むとノイズ」という指摘で追加した。次は filter 対象:

- `StatusError` (4xx/5xx 全般、Akamai/Cloudflare bot block 含む)
- `TimeoutError` / `AbortError` / `CancelError`
- メッセージ正規表現:
  - `^\s*\d{3}\s` (Got の "403 Forbidden" 形式)
  - `Private IP rejected` (SSRF block)
  - `Rejected by type filter` (非 HTML)
  - `timeout|timed out|aborted`
  - `ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN` (低レベルネットワーク到達不能)

→ 残るのは「summaly がリクエスト成功したのにパースに失敗した URL」だけになり、純度の高いプラグイン候補が手に入る。

### 集約 key の粒度

`${hostname}/${パスの先頭1〜2セグメント}`:

- `https://qiita.com/UserA/items/abc?token=x` → `qiita.com/UserA/items`
- `https://note.com/foo/n/abc` → `note.com/foo/n`

ホスト全体だと粗すぎ・フルパスだと細かすぎの中間。「ユーザー＋投稿カテゴリ」単位でサイト構造が見える。`URL.hostname` は port を含まないので localhost テストでは `localhost/articles/foo` のような key になる点に注意。

### プライバシー保護

- サンプル URL は `${origin}${pathname}` のみ（query / fragment / basic auth は捨てる）
- `data:` / `file:` / `javascript:` 等の non-http(s) スキームは `URL.origin` が `"null"` を返すため `nulltext/html,...` の怪しい文字列がログに混入する。`sanitizeUrlForLog` の冒頭で `protocol` を確認して `${u.protocol}[sanitized]` の placeholder に変える
- それでも path 自体に機密が含まれる場合（例: `https://example.com/<secret-token>/page`）は守れないため、**エンドポイント公開時の nginx ガードを必須化** とドキュメント明記

### メモリ保護

- `Map<groupKey, samples[]>` の挿入順を LRU 風に使用（記録のたびに `delete` → `set` で末尾に移動）
- グループ数上限超過時は最古のキーから捨てる
- 同 URL の重複追加抑制（`samples.filter(s => s.url !== sanitized)`）
- 上限内訳: 1000 group × 5 sample × 約 300B ≒ **1.5MB**

### `record()` は同期関数

Fastify の async ハンドラから並行に呼ばれるが、`record` 自体に await が無いため Node.js の event loop 上で原子的に完了する。`Map` の中間状態は競合しない。**将来 await を入れたくなったら呼び出し側との競合を再設計** とコメントで明記。

### エンドポイントの設計

`GET /__diagnostics/parse-failures` で `{ groups, size, enabled }` を返す。`enabled` フィールドで消費側が機能有無を確認できる（将来「ログ機能を一時停止」のような状態を表現する余地もある）。

`enabled` だけでなく `endpoint` の方も別フラグ (`parseFailureLogEndpoint`) にして、誤って production で空っぽのエンドポイントを公開するリスクを下げる。**`endpoint: true` + `log: false` の組み合わせは register 時に fail-fast** で防ぐ（誤設定検出）。

## Fastify ハンドラ統合のフロー

MISS 経路（LRU/dedup HIT 以外）で `entry` が確定した直後に判定:

```ts
if (parseFailureLog != null) {
  if (entry.kind === 'error') {
    const msg = entry.error.message;
    const name = entry.error.name;
    if (!isFilteredFailure('throw', msg, name)) {
      parseFailureLog.record(url, 'throw', msg);
    }
  } else if (isThinSummary(entry.value)) {
    parseFailureLog.record(url, 'thin');
  }
}
```

LRU/dedup HIT は重複記録しない（既に最初の MISS で記録済みのため、リクエスト数 = 記録回数にならない）。これは「グループ key の頻度」を運用者が見るときに「閲覧数」ではなく「**ユニーク URL 数**」を反映する設計上の選択。

## TOML スキーマ設計

`[diagnostics]` セクションで切る:

```toml
[diagnostics]
parseFailureLog = false
parseFailureLogMaxGroups = 1000
parseFailureLogSamplesPerGroup = 5
parseFailureLogEndpoint = false
```

`[summaly.cache]` のように `[summaly.diagnostics]` のサブセクションにする案もあったが、cache / pdf / dedup と違って **`SummalyOptions` 型に直接乗らない、Fastify モード専用の運用 metric** なのでトップレベル `[diagnostics]` に。将来 metrics 系（カウンタ / Prometheus exporter 等）を増やすときも自然に同居できる。

## 参考

- [docs/plans/phase10.1-parse-failure-log.md](../plans/phase10.1-parse-failure-log.md)
- [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts)
- [src/index.ts](../../src/index.ts)（Fastify ハンドラ統合）
- [bin/config-loader.ts](../../bin/config-loader.ts)（`[diagnostics]` セクション parsing）
- [test/parse-failure-log.test.ts](../../test/parse-failure-log.test.ts)
