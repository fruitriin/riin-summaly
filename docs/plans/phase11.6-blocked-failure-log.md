# Phase 11.6 — 迂回候補ログ（ブロック失敗の別系統 JSONL）

> 状態: **完了 (2026-05-05)**
> 種別: 機能追加
> サイズ: **S〜M**
> 依存: なし（[phase11.5](phase11.5-remove-diagnostics-endpoint.md) と並列可、後着手なら API がスッキリ）
> 関連: [phase10.1](phase10.1-parse-failure-log.md)（既存のプラグイン候補ログ）、[phase11.4](phase11.4-plugin-npmjs.md)（このログから発見したパターンの一例）

## 目的・背景

[phase10.1](phase10.1-parse-failure-log.md) で導入した `parseFailureLog` は **「プラグインを書けば救える候補」**（thin Summary + パース例外）の発見器として設計され、`isFilteredFailure()` で 4xx/5xx・timeout・SSRF block・type filter 等を意図的にノイズ扱いして除外している。

しかし [phase11.4](phase11.4-plugin-npmjs.md) で発見したように、**「公開 HTML は Cloudflare 等で 403 だが、別ホストの公式 API（registry.npmjs.org）から JSON で同等情報が取れる」** ケースが現実に存在する。これは現在の `parseFailureLog` ではノイズ扱いで捨てられているため、運用者が手動で気付くしかない。

**「迂回可能性のあるブロック失敗」を別系統の JSONL ファイルに記録**して、運用者が定期的に `cat blocked.jsonl | jq -r '.url' | sort -u | head` で「頻出ブロック先」を眺めれば npm 以外の同種パターン（API ドキュメントを別ホストで公開してる SaaS、JSON 版エンドポイントを持つメディアサイト等）を発見できる。

### このログから発見できる候補例

- npm.com（403 → registry.npmjs.org が公開 JSON API）
- GitHub のレート制限ページ → API トークン経由の代替
- Cloudflare 配下のメディアサイトで oEmbed エンドポイントは ungated なケース
- ニュースサイトの会員制ページ → AMP 版 / 公式 RSS が公開
- timeout 多発サイト → 別 CDN ホストや軽量モバイル版の存在

## 設計方針

### 別ファイルにする理由（既存 `parseFailureLogJsonlPath` を流用しない）

- **シグナルの純度を下げない**: 既存のプラグイン候補ログ（thin）と混ぜると、403 大量発生で「本当にプラグインを書けば救える候補」が埋もれる
- **流量が違う**: ブロック失敗は 4xx/5xx 全部なので量が桁違いに多い可能性。サイズ cap も別管理にしたい
- **目的が違う**: プラグイン候補は「コードを書けば改善」、迂回候補は「別 API を見つけるか諦めるか」の二段階レビュー。ファイルを分ければ `jq` クエリも分けられる

### 新規オプション

```ts
interface FastifyPluginOptions {
  // 既存
  parseFailureLog?: boolean;
  parseFailureLogJsonlPath?: string;
  parseFailureLogJsonlMaxBytes?: number;

  // 新規
  /**
   * 迂回候補ログ JSONL の出力先パス。`isFilteredFailure` 対象（4xx/5xx, timeout, SSRF block 等）を
   * 1 行ずつ append する。プラグイン化候補ログとは別ファイルで純度を保つ。
   * 用途: npm のように「公開 HTML はブロックだが別 API で同等情報が取れる」パターンを後から発見する。
   * `parseFailureLog: true` のときのみ動作（既存ログと同じスイッチで有効化）。
   */
  parseFailureLogBlockedJsonlPath?: string;

  /** 迂回候補ログの最大バイト数。デフォルト 10 MiB。既存 cap とは独立に効く。 */
  parseFailureLogBlockedJsonlMaxBytes?: number;
}
```

### `category` フィールド追加

迂回候補ログ側の JSONL 各行に **ブロック理由のカテゴリ** を付与（grep / jq しやすくするため）:

| category | 判定条件 (isFilteredFailure 内のロジック) |
|---|---|
| `status-4xx` | `errorName === 'StatusError'` で message が 4xx、または `Response code 4\d{2}` |
| `status-5xx` | `errorName === 'StatusError'` で message が 5xx、または `Response code 5\d{2}` |
| `timeout` | `errorName === 'TimeoutError'` または message に `timeout/timed out/aborted` |
| `cancel` | `errorName === 'CancelError' \| 'AbortError'` |
| `private-ip` | message に `Private IP rejected` |
| `type-filter` | message に `Rejected by type filter` |
| `network-unreachable` | message に `ENOTFOUND \| ECONNREFUSED \| ECONNRESET \| EHOSTUNREACH \| ENETUNREACH \| EAI_AGAIN` |
| `unknown` | 上記いずれにも当てはまらないが `isFilteredFailure` が true（保険） |

JSON Lines 出力例:

```jsonl
{"key":"www.npmjs.com/package","url":"https://www.npmjs.com/package/mfm-renderer","ts":1777970000000,"reason":"throw","errorMessage":"403 Forbidden","errorName":"StatusError","category":"status-4xx"}
{"key":"slow.example.com/article","url":"https://slow.example.com/article/123","ts":1777970100000,"reason":"throw","errorMessage":"Request timed out","errorName":"TimeoutError","category":"timeout"}
```

### in-memory 集約の扱い

迂回候補は **JSONL 専用 / in-memory aggregation しない** で良い。理由:

- in-memory map は phase11.5 で endpoint 撤去後に「テスト/将来用途」のためだけに残る存在になる
- 迂回候補のレビューは月次〜不定期で十分、ライブで見る用途は無い
- メモリ消費を増やしたくない

実装的には `ParseFailureLog` クラス内に二段の JSONL writer を持つだけ。既存の `record()` のシグネチャ（`record(url, reason, errorMessage)`）に `errorName` 引数を 1 つ足し、内部で `isFilteredFailure` を呼んで分岐する。

### 既存 `parseFailureLog: false` 時は何も書かれない

`parseFailureLog` フラグは「フィルタ機能のオン/オフ全体」のスイッチを担う。`parseFailureLog: false` のままで `parseFailureLogBlockedJsonlPath` だけ指定しても無効。これは既存挙動と一貫させる。

---

## 現状分析

### `record()` の現呼び出し ([src/index.ts:523-538](../../src/index.ts#L523-L538))

```ts
if (parseFailureLog != null) {
  if (entry.kind === 'error') {
    const errPayload = entry.error as { message?: string; name?: string } | undefined;
    const message = ...;
    const name = ...;
    if (!isFilteredFailure('throw', message, name)) {
      parseFailureLog.record(url, 'throw', message);
    }
    // ↑ 現状: フィルタ対象は捨てている。ここで blocked log に流す
  } else if (isThinSummary(entry.value)) {
    parseFailureLog.record(url, 'thin');
  }
}
```

修正後:

```ts
if (parseFailureLog != null) {
  if (entry.kind === 'error') {
    const errPayload = entry.error as { message?: string; name?: string } | undefined;
    const message = ...;
    const name = ...;
    parseFailureLog.record(url, 'throw', message, name);  // 引数追加
    // ↑ ParseFailureLog 内部で isFilteredFailure を呼んで JSONL を分岐
  } else if (isThinSummary(entry.value)) {
    parseFailureLog.record(url, 'thin');
  }
}
```

`record()` 内部で:

1. `reason === 'throw' && isFilteredFailure(reason, errorMessage, errorName)` なら blocked JSONL に append（in-memory 集約はしない）
2. それ以外（thin or 非フィルタ throw）は既存の挙動（in-memory map 更新 + plugin-candidate JSONL append）

### `categorize()` の追加

[src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) に新関数:

```ts
export type BlockedCategory =
  | 'status-4xx' | 'status-5xx' | 'timeout' | 'cancel'
  | 'private-ip' | 'type-filter' | 'network-unreachable' | 'unknown';

export function categorizeBlockedFailure(errorName?: string, errorMessage?: string): BlockedCategory {
  // isFilteredFailure と同じ判定ロジックを再利用するため、内部で共有 helper にリファクタしたい
  // …
}
```

`isFilteredFailure` と判定ロジックが重複するので、両方を 1 つの `analyzeFailure(): { filtered: boolean; category: BlockedCategory | null }` に統合する案も検討。後者の方がメンテしやすい。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test && pnpm typecheck` を通す。

- [x] **Step 1 — `analyzeFailure()` 統合**
  - [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) に `analyzeFailure(reason, errorMessage, errorName): { filtered: boolean; category: BlockedCategory | null }` を新設
  - 既存 `isFilteredFailure()` は `analyzeFailure().filtered` を呼ぶラッパに変える（公開 API として残す）
  - 単体テストでカテゴリ判定の網羅（`status-4xx` `status-5xx` `timeout` `cancel` `private-ip` `type-filter` `network-unreachable` `unknown`）
- [x] **Step 2 — `JsonlAppender` 抽出**
  - 既存の [src/utils/parse-failure-log.ts:237-259](../../src/utils/parse-failure-log.ts#L237-L259) の `appendJsonl` ロジック（サイズ cap、起動時 stat、エラー連発抑制）を `JsonlAppender` クラスとして抽出
  - `ParseFailureLog` は内部に 2 つの `JsonlAppender`（plugin-candidate 用、blocked 用）を持つ
  - 単体テストで append 動作 / cap 越え / I/O エラー時の stderr 1 回出力を確認
- [x] **Step 3 — `ParseFailureLog.record()` の signature と分岐ロジック**
  - `record(url, reason, errorMessage?, errorName?)` に `errorName` 引数を追加（optional、互換性維持）
  - 内部で `analyzeFailure()` を呼び:
    - `filtered === true` → blocked JSONL appender に書き、in-memory 集約はスキップ
    - `filtered === false` → 既存 plugin-candidate JSONL appender に書き、in-memory 集約も従来通り
  - 単体テストで両系統の JSONL に正しく振り分けられることを確認
- [x] **Step 4 — オプション定義 / 配線**
  - [src/index.ts](../../src/index.ts) `FastifyPluginOptions` に `parseFailureLogBlockedJsonlPath?: string` と `parseFailureLogBlockedJsonlMaxBytes?: number` を追加
  - `ParseFailureLog` のコンストラクタに渡す
  - `if (parseFailureLog != null)` のブロックで `record()` 呼び出しに `errorName` を渡す
- [x] **Step 5 — bin / TOML 側の配線**
  - [bin/summaly-server.ts](../../bin/summaly-server.ts) と TOML loader に新規 2 オプションを追加
  - スキーマ検証（`parseFailureLogBlockedJsonlMaxBytes` は positive integer）
- [x] **Step 6 — 統合テスト**
  - npmjs.com 403 を再現するモックサーバを立て、Fastify モードで:
    - blocked JSONL に 1 行記録される
    - plugin-candidate JSONL は 0 行（純度を保つ）
    - in-memory `size` も増えない
- [x] **Step 7 — config example 更新（4.5 のドキュメント突き合わせ）**
  - [config.example.toml](../../config.example.toml) と [docs/deploy-examples/summaly-config.example.toml](../../docs/deploy-examples/summaly-config.example.toml) に追加:
    ```toml
    # 迂回候補ログ JSONL の出力先（オプトイン）。
    # 4xx/5xx・timeout 等で記録対象外になった失敗を別ファイルに集めることで、
    # 「公開 HTML はブロックだが別 API で取れる」パターン（npm のような）を発見しやすくする。
    # parseFailureLogBlockedJsonlPath = "/var/log/summaly/parse-failures-blocked.jsonl"
    # parseFailureLogBlockedJsonlMaxBytes = 10485760  # 10 MiB（デフォルト）
    ```
- [x] **Step 8 — ドキュメント更新**
  - [CLAUDE.repo.md](../../CLAUDE.repo.md) — 迂回候補ログの存在と運用方法を「対応形式」セクションの後または運用セクションに追加
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased — `### Added` に追記
  - [docs/Library.md](../../docs/Library.md) — 新オプションを公開 API リストに追加
  - 必要なら [docs/SETUP.md](../../docs/SETUP.md) にも運用例（`jq` クエリの例）を追記
- [x] **Step 9 — knowhow 記録**
  - 「Cloudflare bot block 等のフィルタ対象失敗から迂回候補（別 API ホスト）を発見するパターン」を `docs/knowhow/` に記録
  - 既存 [docs/knowhow/INDEX.md](../../docs/knowhow/INDEX.md) に登録
- [x] **Step 10 — 品質ゲート**
  - `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
  - `bash .claude/tests/run-all.sh`
  - `addf-code-review-agent` / `addf-contribution-agent`

---

## 完了条件 (Definition of Done)

- `parseFailureLog: true` + `parseFailureLogBlockedJsonlPath = "/path/to/blocked.jsonl"` で、4xx/5xx・timeout・SSRF block・type filter 等の失敗が当該 JSONL に append される
- 各行に `category` フィールド（`status-4xx` 等）が含まれる
- 既存の `parseFailureLogJsonlPath`（プラグイン候補）には引き続き thin + 非フィルタ throw のみ書かれる（純度維持）
- in-memory 集約は迂回候補を含めない（メモリ消費抑制）
- サイズ cap は両系統で独立に効く
- `ParseFailureLog.record()` の互換性は維持（`errorName` は optional）
- 統合テストで両ファイルの内容が正しく振り分けられることを確認
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- README / CHANGELOG / config example が同期している

---

## リスク・注意点

1. **流量過大による I/O 負荷**: 4xx/5xx 全部を append するとピーク時の I/O が増える。`appendFileSync` は同期 I/O なので応答時間に影響する可能性あり。既存の plugin-candidate ログと同じ実装を流用するため、既存と同じレベルのリスク（許容範囲という前提）。気になるなら将来的に async バッファリングへ移行する独立 plan を起こす
2. **サイズ cap の到達が早い**: blocked ログは流量が多いため 10 MiB cap に短時間で到達する。「気付いたら rm / mv」運用前提なので大規模デプロイは monitoring 必須。CHANGELOG / docs に明記
3. **個人情報の漏洩リスク**: blocked ログに含まれる URL は失敗した preview 試行先。サーバオーナー以外がファイルを読める状態にしない（ファイルパーミッション・nginx で `__diagnostics` 系統が漏れない構造）。docs に注意書き
4. **`isFilteredFailure` と `categorizeBlockedFailure` のロジック重複**: Step 1 で `analyzeFailure()` に統合する設計で対処。リファクタ漏れがあると判定の食い違いが起きるので単体テストで網羅
5. **`record()` のシグネチャ変更**: optional 引数追加なので互換性は保てる。ただし古い呼び出し側は `errorName` を渡さないため `unknown` カテゴリに分類される可能性。フォールバック挙動を docs に明記
