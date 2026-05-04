# Phase 4.2 — Fastify モードの in-flight リクエスト dedup（thundering herd 緩和）

> 状態: **完了 (2026-05-04)**
> 種別: 機能拡張 / 運用最適化
> サイズ: **S〜M**
> 依存: [phase4.1](phase4.1-fastify-in-memory-cache.md)（LRU キャッシュ）

## 目的・背景

Misskey はユーザーストリーミング機能のため、1 つのリンクが Note に貼られると **ほぼ同時に複数のクライアント** がそのリンクのプレビュー（summaly エンドポイント）をリクエストする。

このとき、現状の summaly Fastify モード（[phase4.1](phase4.1-fastify-in-memory-cache.md) のインメモリ LRU キャッシュ有無に関わらず）は:

1. リクエスト 1 が origin に到達 → スクレイピング開始（HTML 取得に数百 ms 〜 数秒かかる）
2. リクエスト 2..N が同 URL に到達 → 1 はまだキャッシュに書き込まれていないので **全て origin にも到達**
3. 結果として origin が **同じ URL に対して N 並列リクエスト** を受ける

これは origin 側から見ると **DDoS のように見える**（特に重い CMS ページや海外サイトで HTML 取得に 2 秒かかるようなケース）。HTTP `Cache-Control` ヘッダも LRU キャッシュも「先頭リクエストが完了してから」しか効かないため、この期間の集中は止められない。

本フェーズでは **in-flight dedup**（先頭リクエストが完了するまで後続を pending させ、結果をまとめて返す）を実装する。

---

## 現状分析

### phase4.1 の thundering herd の扱い

[docs/plans/phase4.1-fastify-in-memory-cache.md](phase4.1-fastify-in-memory-cache.md) のリスク 6:

> **競合**: 同じ URL に同時リクエストが来た場合、両方が origin にリクエストを発行してしまう（thundering herd）。本フェーズでは扱わない（in-flight dedup を入れたければ将来 issue）

→ phase4.1 で意図的にスコープ外にした「将来 issue」を本フェーズで対応する。

### Fastify ハンドラの現状

[src/index.ts](src/index.ts) の Fastify ハンドラで `cache.set()` するのは `summaly()` 完了**後**。完了までの数百ミリ秒〜数秒の間に来た並列リクエストは LRU を見ても miss する。

---

## 設計方針

### in-flight Map（key → Promise<CacheEntry>）

LRU キャッシュとは別に、**進行中のリクエストの Promise を保持する Map** を持つ:

```ts
const inFlight = new Map<string, Promise<CacheEntry>>();
```

ハンドラの流れ:

1. **LRU キャッシュ HIT** → そのまま返す（既存）
2. **LRU MISS だが in-flight に同 key の Promise がある** → その Promise を `await` して結果を返す（origin には行かない）
3. **両方 miss** → 新規 Promise を作成し `inFlight.set(key, promise)`、settle 後に `inFlight.delete(key)` + LRU `set()`

### キャッシュキーは LRU と同一

`normalizeCacheKey(url, lang)`（URL フラグメント除去 + NULL byte 区切り + lang）を流用する。同じキーで dedup と LRU の両方を引く。

### Promise の再利用は同期的に行う

`Promise<CacheEntry>` は `summaly()` の戻り値を `{ kind: 'success', value }` または `{ kind: 'error', error }` にラップしたもの。`Promise.race` 等は使わず、各 waiter が同じ Promise を await する素直な実装。

### エラー伝搬

先頭リクエストが throw した場合、in-flight Map に残った Promise は reject になり、await 中の全 waiter も同じ error を受け取る。各 waiter で同じ `errorPayload` をレスポンスし、LRU には先頭リクエストが完了した時点で 1 度だけ書き込む（settle で `delete` してから LRU `set()`、二重 set を避ける）。

### `inMemoryCache` とは独立

LRU キャッシュは「結果を再利用」、in-flight dedup は「同時実行を 1 本化」と効く局面が違う。**両者は独立して動く** 設計:

- `inMemoryCache: false` でも dedup は効く（次回リクエストは origin に行くが、並列の集中だけは抑える）
- `inMemoryCache: true` なら dedup + LRU の両方が効く（最初の集中も後続の重複も抑える）

ただし両者の関係を説明しやすくするため **dedup もデフォルト有効**（オプトアウト用に `inFlightDedup?: boolean` を用意、未指定なら `true`）。「Fastify モードの ddos 緩和は dedup と LRU の 2 段構え」と README で説明する。

### 並列度の上限はかけない

「同時実行 100 件まで」のような上限は本フェーズでは扱わない。dedup によって**同 URL の同時 origin アクセスは 1 件**になるが、**異なる URL の同時数は無制限**。Fastify 全体のリクエストキューイングは上位レイヤ（nginx connection limit 等）の責務とする。

### `X-Cache` ヘッダの拡張

| 状態 | X-Cache | 意味 |
|---|---|---|
| LRU HIT | `HIT` | 既存（キャッシュから返した） |
| in-flight 待ちで完了 | `HIT-COALESCED` | 並列リクエストの先頭結果を共有した（dedup 効果あり） |
| 完全な MISS | `MISS` | 自分が origin に行った |
| dedup 無効時 | (HIT/MISS のみ) | 既存挙動 |

`HIT-COALESCED` を追加することで運用者が「dedup がどれくらい効いているか」を可視化できる。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

- [x] **Step 1 — `SummalyOptions.inFlightDedup?: boolean` 追加**
- [x] **Step 2 — in-flight Map の導入**
- [x] **Step 3 — ハンドラのフロー改修**
  - エラー伝搬は Promise の reject ではなく **resolve 値に `CacheEntry` (`kind: 'success' | 'error'`) を持たせる方式** で実装。`fetchEntry` が常に resolve するため `try/finally` を使わずに `inFlight.delete` の順序を制御できる
- [x] **Step 4 — テスト** — `describe('Fastify in-flight dedup (phase4.2)')` で 7 テスト追加
- [x] **Step 5 — README / CHANGELOG 更新** — `docs/SETUP.md` の「キャッシュ戦略」を 4 段重ねに改訂、`X-Cache` 値表追加、CHANGELOG に dedup エントリ追加

## 実装結果メモ

- **エラー伝搬の実装変更**: 元計画では「Promise reject + waiter で同じ error」を想定していたが、実装では `Promise<CacheEntry>` の resolve 値に成功/エラーをラップするタグ付き union を採用。これにより:
  - `try/finally` の `entry` 変数の definite-assignment 問題（ESLint の `no-non-null-assertion` 違反）を回避できる
  - 全 waiter が同一の `errorPayload` を確実に受け取る（`Error` インスタンスを serialize する局所性が leader 1 箇所だけになる）
- **`emitCacheHeader = cache != null || inFlight != null`** で `X-Cache` ヘッダ付与の有無を判断。dedup または LRU のどちらかが有効なら付与。両方 `false` のときだけ既存互換でヘッダ無し
- **`inFlightDedup` デフォルト true** により既存ユーザーの X-Cache レスポンスヘッダが増える。Plan 通り Breaking Change と見做さず CHANGELOG に明記

---

## 完了条件 (Definition of Done)

- 同 URL への 5 並列リクエストで origin ヒット数が 1 件になる（テストで担保）
- `inFlightDedup: false` で従来挙動に戻せる
- in-flight 中のエラーが全 waiter に伝搬する
- `X-Cache: HIT-COALESCED` ヘッダで dedup 効果が可視化できる
- 既存ユーザーの呼び出しが破壊的変更を受けていない（`inFlightDedup` 未指定時はデフォルト on で挙動が改善するだけ）
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- README に新オプションと運用ガイドが反映されている

---

## リスク・注意点

1. **in-flight Map のリーク**: settle 時に必ず `delete` する。例外パスでも漏れないよう `try { ... } finally { inFlight.delete(key) }` で囲む
2. **メモリ消費**: 同時実行 URL 数だけ Promise を保持する。通常は数十〜数百で大したサイズではない。ただし LRU と異なり「上限なし Map」なので、極端な状況（数万 URL が同時にリクエストされる）では Map 自体がメモリ圧迫する可能性。実運用上は phase5 / phase6 のような将来課題
3. **キャンセル**: HTTP リクエストが client side で abort されたとき、後続の waiter が無くなれば origin リクエストもキャンセルしたいが、本フェーズでは扱わない（実装が複雑化、Got 側の signal を全 waiter で共有する必要があるため）
4. **`inFlightDedup` のデフォルト値**: `true` にすることで「未指定で挙動が変わる」が、改善方向のみ（origin 負荷減・レスポンス時間も同等以上）なので互換性問題はないと判断。完全に互換にしたい運用者は `inFlightDedup: false` を明示
5. **`Promise` の漏れ**: in-flight Promise が settle した後 `delete` する前に新規リクエストが入って同じ Promise を await するケースは**むしろ意図通り**（同じ結果を共有できる）。settle 後 LRU に書いてから delete するなら順序を `LRU set → delete` にして、delete 後の新規リクエストが LRU HIT で拾えるようにする

---

## オープンクエスチョン

- **A. `inFlightDedup` を `inMemoryCache` と統合するか**: 「dedup と LRU は別概念」が本プランの立場。同じ flag に統合すると「キャッシュは要らないが dedup は欲しい」要望に応えられない。**独立 flag** が正解と判断
- **B. dedup 範囲を `summaly()` 関数内に下ろすか**: ライブラリレベルで dedup すると「異なる呼出元が異なる opts で呼んだとき」の判定が難しい（同じ URL でも `lang` 違いは別結果になる等）。**Fastify ハンドラレベルだけに留める** のが堅実
