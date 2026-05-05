# Phase 11.2 — エラーレスポンスをカテゴリ化（プレビュー失敗理由の細分化）

> 状態: **完了 (2026-05-05)**
> 種別: 観測性 / API 拡張
> サイズ: **S**
> 関連 issue: [riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)
> 関連: [phase10.1 パース失敗ログ](phase10.1-parse-failure-log.md)（`isFilteredFailure` のロジックを流用）、[external-misskey-fork-urlpreview-lang.md](external-misskey-fork-urlpreview-lang.md)（同じく Misskey fork 側修正が必要）

## 実装結果メモ

- **判定優先順位を Plan から変更**: Plan 案では `StatusError + statusCode` を最優先にしていたが、`Private IP rejected` (内部で `StatusError(_, 400)`) や `Invalid IP` (同 500) が `bot_blocked` / `origin_error` と誤判定される問題があり、**メッセージ高シグナルパターン → errorName timeout 系 → statusCode → メッセージ先頭 3 桁** の順に変更した。意味重視の優先順位
- **カテゴリを Plan から 1 つ追加**: `content_too_large` (S-1 レビュー指摘)。`maxSize exceeded` メッセージを別カテゴリに昇格。プラグインで救えない類型として `FILTERED_CATEGORIES` に含める
- **`Invalid IP` も `ssrf_blocked` に分類** (W-2 レビュー指摘): IP パース失敗 (`StatusError(_, 500, 'Invalid IP')`) は意味的に SSRF ガード由来なので `origin_error` ではなく `ssrf_blocked`。`got.ts` のメッセージ変更ではなく `categorizeError` 側でパターン追加して対応
- **`SummalyErrorCategory` を `src/index.ts` から re-export** (W-1 レビュー指摘): `SerializableError['category']` で間接参照する必要が無いよう、ライブラリ公開 API として直接 export
- **timeout カテゴリの Fastify 統合テストは未カバー**: フレーキー要素 (`responseTimeout` を意図的に短くする) を生むため別 phase 案件として保留

## 目的・背景

[riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2): プレビュー取得失敗時に Misskey 側は「プレビューできませんでした」しか出ない。実態は

- タイムアウト
- Akamai/Cloudflare の bot block (4xx)
- 5xx (origin 障害)
- 非 HTML（PDF 無効時の PDF / 画像 / etc.）
- DNS 失敗 / 接続拒否
- パース失敗 (HTML は取れたが summary が空)

など多岐にわたるが、現状の summaly Fastify モードは **`{ error: { message, name } }` を 500 で返すだけ** で、Misskey 側は汎用 `URL_PREVIEW_FAILED` に潰している。

リンク切れと bot block は意味が違うので**運用上区別したい**（リンク切れなら諦め、bot block なら別経路で取得を試みる、等）。本フェーズで summaly 側のレスポンスをカテゴリ化する。

ただし Misskey 側で表示分岐するには [UrlPreviewService.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/web/UrlPreviewService.ts) と `MkUrlPreview.vue` の改修も必要なので、本フェーズは **summaly 側の構造化レスポンス**まで。Misskey 側は別途 fork で対応 (external 連携 Plan に追記)。

## 現状分析

### エラー発生経路

[src/index.ts](../../src/index.ts) Fastify ハンドラ:

```ts
try {
  const summary = await summaly(url, { ... });
  return { kind: 'success', value: summary };
} catch (e) {
  return { kind: 'error', error: serializableError(e) };
  //                                ↑ { message, name } または raw
}
```

### 既存のカテゴリ判別ロジック

[src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) の `isFilteredFailure`:

| 検出キー | 元のエラー |
|:--|:--|
| `errorName === 'StatusError'` | `src/utils/got.ts` の 4xx/5xx |
| `errorName === 'TimeoutError'` | got のタイムアウト |
| `errorName === 'AbortError' / 'CancelError'` | abort 系 |
| `^\d{3}\s` メッセージ | got 一般 |
| `Private IP rejected` | SSRF ガード |
| `Rejected by type filter` | 非 HTML |
| `timeout\|timed out\|aborted` | タイムアウト系 |
| `ENOTFOUND\|ECONNREFUSED\|ECONNRESET\|EHOSTUNREACH\|ENETUNREACH\|EAI_AGAIN` | ネット到達不能 |

これを **公開 API のカテゴリ enum** に昇格する。

## 設計方針

### カテゴリ定義

```ts
export type SummalyErrorCategory =
  | 'timeout'             // 取得タイムアウト / abort
  | 'bot_blocked'         // 4xx — Akamai/Cloudflare 等の bot 検知含む
  | 'not_found'           // 404 だけ別カテゴリ（リンク切れ判別）
  | 'origin_error'        // 5xx — 上流障害
  | 'unsupported_type'    // type filter — 非 HTML（PDF 無効時の PDF 等）
  | 'ssrf_blocked'        // Private IP rejected
  | 'network_error'       // DNS / 接続拒否 (ENOTFOUND など)
  | 'parse_error'         // HTML は取れたが summarize() が null / cheerio パース失敗
  | 'unknown';            // 上記いずれにも該当しない（catch-all）
```

### 分類関数

`src/utils/parse-failure-log.ts` の `isFilteredFailure` から抽出して `categorizeError(e)` を export。`categorizeError` は **`isFilteredFailure` の supersedure**（カテゴリを返す関数の `category !== 'unknown' && category !== 'parse_error'` が `isFilteredFailure === true` に該当）。

```ts
export function categorizeError(errorMessage?: string, errorName?: string, statusCode?: number): SummalyErrorCategory {
  if (errorName === 'StatusError' && typeof statusCode === 'number') {
    if (statusCode === 404) return 'not_found';
    if (statusCode >= 500) return 'origin_error';
    if (statusCode >= 400) return 'bot_blocked';
  }
  if (errorName === 'TimeoutError' || errorName === 'AbortError' || errorName === 'CancelError') return 'timeout';
  if (errorMessage != null) {
    const m4xx = errorMessage.match(/^\s*(\d{3})/);
    if (m4xx != null) {
      const code = Number(m4xx[1]);
      if (code === 404) return 'not_found';
      if (code >= 500) return 'origin_error';
      if (code >= 400) return 'bot_blocked';
    }
    if (/Private IP rejected/i.test(errorMessage)) return 'ssrf_blocked';
    if (/Rejected by type filter/i.test(errorMessage)) return 'unsupported_type';
    if (/timeout|timed out|aborted/i.test(errorMessage)) return 'timeout';
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(errorMessage)) return 'network_error';
    if (/failed summarize/i.test(errorMessage)) return 'parse_error';
  }
  return 'unknown';
}
```

`isFilteredFailure` は内部実装として `categorizeError` を呼んで `category !== 'unknown' && category !== 'parse_error'` を返す形にリファクタ（テスト互換）。

### レスポンス形式の拡張

```jsonc
{
  "error": {
    "category": "bot_blocked",     // ← 新規フィールド
    "message": "403 Forbidden",
    "name": "StatusError",
    "statusCode": 403              // ← StatusError のとき限定で追加
  }
}
```

**既存フィールド (`message` / `name`) はそのまま保持** → 後方互換。新規消費側は `category` を使う。

### `serializableError` の拡張

```ts
function serializableError(e: unknown): { message?: string; name?: string; statusCode?: number; category: SummalyErrorCategory } {
  const message = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : undefined;
  const statusCode = (e instanceof StatusError) ? e.statusCode : undefined;
  const category = categorizeError(message, name, statusCode);
  return { message, name, statusCode, category };
}
```

### `parseFailureLog` への波及

`isFilteredFailure` は `categorizeError` で書き換える。テスト 31 件はカテゴリ分類値も assert に追加して移行。

## 実装ステップ

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

- [x] **Step 1 — `categorizeError` 実装** + 単体テスト 14 件 (基本 12 + Invalid IP + maxSize)
- [x] **Step 2 — `isFilteredFailure` を `categorizeError` ベースに** (既存 31 件互換、`statusCode` 引数追加)
- [x] **Step 3 — `serializableError` 拡張** (`{ message?, name?, category, statusCode? }` の `SerializableError` 型を export、`CacheEntry.error` も型を絞った)
- [x] **Step 4-5 — Fastify 統合テスト 7 件** (404/403/503/non-HTML/SSRF/DNS 失敗/成功時 category 無し)
- [x] **Step 6 — ドキュメント更新** (Library.md / SETUP.md にカテゴリ早見表、CHANGELOG)

## 完了条件

- summaly Fastify レスポンスの `error` オブジェクトに `category: SummalyErrorCategory` が必ず乗る
- 既存の `message` / `name` フィールドは維持（後方互換）
- 既存テスト 228+ 件すべて通過 + 新規テスト
- ドキュメント反映済み

## リスク

1. **後方互換**: 既存フィールドを維持しているため Misskey の現行バージョンが拒否することはない。新規 `category` を見ない実装は単に無視するだけ
2. **`parse_error` の判定**: `summary == null` のときの `failed summarize` メッセージで判別しているが、将来 message が変わると false negative になる。**`failed summarize` を `SummarizeError` カスタムエラークラスに昇格する**のが本来は正解 → Step 1 で `parse_error` 判定を `errorName === 'SummarizeError'` で行うリファクタを併走しても良い。サイズ S 維持のため本フェーズではメッセージ正規表現で判定し、別 phase で正規化を検討
3. **`unknown` カテゴリの扱い**: catch-all。Misskey 側もまずは「不明なエラー」として表示し、運用ログから埋まらない類型を検知して逐次カテゴリを追加する想定

## Misskey 側との連携

[external-misskey-fork-urlpreview-lang.md](external-misskey-fork-urlpreview-lang.md) と同じく、Misskey fork で:

- `UrlPreviewService.ts` の catch ブロックで `error.category` を `URL_PREVIEW_*` API エラーコードにマップ
- `MkUrlPreview.vue` でカテゴリ別メッセージを `i18n.ts` から取得して出し分け

これは別途 external Plan として記録する（本フェーズ完了時に追加）。

## オープンクエスチョン

- **A. `category` を `SummalyResult` 成功時にも乗せるか**: No。成功時は `category` を出す必要なし。エラー時のみ
- **B. HTTP ステータス自体を 500 から変えるか**: No。Fastify モードはあくまで「summaly が処理できなかった」という意味で 500 を維持し、原因を `category` で示す。HTTP 仕様的にも cleanest
- **C. `error.message` の文字列を翻訳しない理由**: i18n 責務はクライアント側（Misskey）。summaly は機械可読な `category` だけ渡す
