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

### エンドポイントは廃止 (phase11.5)

phase10.1 では `GET /__diagnostics/parse-failures` で `{ groups, size, enabled }` を返していたが、**phase11.5 で削除した**。理由:

- 過去 preview 試行 URL（社内ブログ・短縮 URL の展開先・個人ドメイン等）が in-memory に貯まる構造で、エンドポイントを mount している間は前段 nginx の設定ミスで外部から JSON で全部読まれる「構造的リスク」が残る
- 月次レビュー / プラグイン化候補発見の用途は `parseFailureLogJsonlPath` で書き出した JSONL を `cat | jq` するだけで足りる（ローカル dev も `tail -f` で観察できる）
- メンテ表面の縮小（`parseFailureLogEndpoint` フラグ・組み合わせ検証・ハンドラ・config example の警告コメント・テストがまとめて消える）

**設計教訓**: 「機微データを集めるエンドポイントを `endpoint: true` + nginx allow IP で守る」設計は、運用ミス耐性が低い。**JSONL ファイル + ファイルシステム権限**（`chmod 600` + 運用者のみアクセス）の方が攻撃面が圧倒的に狭い。同種の機能を作るときは「外部 HTTP インターフェース vs ファイル経由」を最初に検討する。

`ParseFailureLog` クラス本体は `record()` / `snapshot()` を維持（テスト・将来の用途用）、削除したのはハンドラと `parseFailureLogEndpoint` オプションだけ。

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
parseFailureLogJsonlPath = "/var/log/summaly/parse-failures.jsonl"
parseFailureLogJsonlMaxBytes = 10485760
```

`[summaly.cache]` のように `[summaly.diagnostics]` のサブセクションにする案もあったが、cache / pdf / dedup と違って **`SummalyOptions` 型に直接乗らない、Fastify モード専用の運用 metric** なのでトップレベル `[diagnostics]` に。将来 metrics 系（カウンタ / Prometheus exporter 等）を増やすときも自然に同居できる。

> phase11.5: `parseFailureLogEndpoint` キーは削除済み。TOML に残っていても smol-toml が unknown key を silent ignore するため起動失敗にはならない（既存ユーザーの移行を緩やかにするため）。

## 迂回候補ログ（別系統 JSONL、phase11.6）

phase10.1 の「プラグイン候補ログ」とは別ファイルに、**`isFilteredFailure` 対象**（4xx/5xx, timeout, SSRF block, type filter, network, connection_dropped）の失敗を集約する仕組みを phase11.6 で追加。

### なぜ別ファイルにするか

1. **シグナルの純度を保つ**: 既存ログと混ぜると 4xx/5xx 大量発生で「本当にプラグインを書けば救える候補」が埋もれる
2. **流量が違う**: ブロック失敗は 4xx/5xx 全部なので量が桁違いに多い可能性。サイズ cap も別管理
3. **目的が違う**: プラグイン候補は「コードを書けば改善」、迂回候補は「別 API を見つけるか諦めるか」の二段階レビュー
4. **`jq` クエリも分けやすい**: 同一ファイルに混ぜると category フィルタが必要、別ファイルなら全行対象でシンプル

### 設計の決め手

- **`record()` 内部で振り分け**: 呼出側はカテゴリ判定ロジックを持たない。`record(url, reason, errorMessage?, errorName?, statusCode?)` に判定材料を渡すだけ
- **`JsonlAppender` の抽出**: cap・I/O エラー連発抑制のロジックを内部クラスに切り出し、candidate / blocked で再利用。phase10.1 までは `appendJsonl` メソッドだった部分をクラス化することで、複数の出力先を持つときの状態管理（`bytes` カウンタ・`writeErrorLogged` フラグ）が綺麗に分離される
- **in-memory 集約しない**: 迂回候補は月次〜不定期レビューで十分、ライブで見る用途は無い。メモリ消費を増やしたくない（4xx/5xx 大量流入時に `Map` を肥大化させたくない）
- **互換性**: `record()` の `errorName` / `statusCode` 引数は optional。古い呼び出し側は判定材料が不足するが既存挙動を保つ

### このログから発見できる候補例

- npm.com（403 → registry.npmjs.org が公開 JSON API、phase11.4 で実装済み）
- GitHub のレート制限ページ → API トークン経由の代替
- Cloudflare 配下のメディアサイトで oEmbed エンドポイントは ungated なケース
- ニュースサイトの会員制ページ → AMP 版 / 公式 RSS が公開
- `connection_dropped` 多発サイト → phase11.9 のフォールバック UA で救えなかった残り（IP block 系、Vultr Tokyo IP 等のレピュテーション差問題）
- `timeout` 多発サイト → 別 CDN ホストや軽量モバイル版の存在

### 運用クエリ例

```bash
# bot block (4xx) されたサイトを集計
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "bot_blocked") | .url' | sort -u | head -20

# WAF 黙殺 (connection_dropped) を抽出
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "connection_dropped") | .url' | sort -u

# timeout 多発サイト
cat /var/log/summaly/parse-failures-blocked.jsonl \
  | jq -c 'select(.category == "timeout") | .url' | sort | uniq -c | sort -rn
```

### プライバシー

candidate ログと同じく失敗 URL の origin+pathname を記録。ファイルパーミッション 600 推奨。

## 参考

- [docs/plans/phase10.1-parse-failure-log.md](../plans/phase10.1-parse-failure-log.md)
- [docs/plans/phase11.6-blocked-failure-log.md](../plans/phase11.6-blocked-failure-log.md)
- [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts)
- [src/index.ts](../../src/index.ts)（Fastify ハンドラ統合）
- [bin/config-loader.ts](../../bin/config-loader.ts)（`[diagnostics]` セクション parsing）
- [test/parse-failure-log.test.ts](../../test/parse-failure-log.test.ts)
