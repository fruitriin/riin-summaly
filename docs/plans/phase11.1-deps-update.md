# Phase 11.1 — 依存更新（patch/minor 安全帯 + major 個別検証）

> 状態: **完了 (2026-05-05)**（eslint 10 のみ次回送り）
> 種別: 保守 / 依存追従
> サイズ: **S** （patch/minor のみ）〜 **M** （major 込み）
> 関連: なし（独立タスク）

## 目的・背景

phase1.1〜10.1 の機能開発が一段落したタイミングで、依存パッケージの古さを棚卸しする。
2026-05-05 時点で `pnpm outdated` が 9 件を報告。うち 3 件は major アップデート。

セキュリティ Advisory が顕在化しているわけではないが、定期メンテとして処理する。

---

## 現状（2026-05-05 時点）

| Package | Current | Latest | カテゴリ |
|---|---|---|---|
| `@typescript-eslint/eslint-plugin` (dev) | 8.59.1 | 8.59.2 | patch |
| `@typescript-eslint/parser` (dev) | 8.59.1 | 8.59.2 | patch |
| `lru-cache` | 11.3.5 | 11.3.6 | patch |
| `@misskey-dev/eslint-plugin` (dev) | 2.1.0 | 2.2.0 | minor |
| `ipaddr.js` | 2.3.0 | 2.4.0 | minor |
| `tsx` (dev) | 4.20.6 | 4.21.0 | minor |
| `@fastify/static` (dev) | 8.2.0 | 9.1.3 | **major** |
| `@types/node` (dev) | 24.10.13 | 25.6.0 | **major** |
| `eslint` (dev) | 9.39.2 | 10.3.0 | **major** |

---

## スコープと方針

### Step A: 安全帯（patch/minor 6 件）

一括で `pnpm update` し、`pnpm build` `pnpm typecheck` `pnpm test` `pnpm eslint` のフルゲートが green であることを確認してコミット。
特に `lru-cache` `ipaddr.js` は実行時依存なので test での回帰を念入りに見る。

### Step B: major 個別検証

各 major アップデートを **別コミット**（または別 PR）で実施。1 件ずつ：

1. **`@types/node` 24 → 25**
   - 影響範囲: typecheck のみ（実行時に影響なし）
   - 確認: `pnpm typecheck` 3 構成すべて green
   - リスク: deprecated API を使っている箇所で型エラーが出る可能性

2. **`@fastify/static` 8 → 9**
   - 影響範囲: dev サーバ（`dev/server.ts`）のみ。本番 `bin/summaly-server.ts` は使っていない
   - 確認: `pnpm dev` を起動して `/` で UI が表示されること、静的アセットが返ること
   - リスク: API 破壊的変更（plugin register option 等）

3. **`eslint` 9 → 10**
   - 影響範囲: lint のみ
   - 確認: `pnpm eslint` が green
   - リスク: flat config の仕様変更。`@misskey-dev/eslint-plugin` 2.2.0 の対応状況にも依存
   - 補足: `@misskey-dev/eslint-plugin` の minor アップデートと **同時に** やった方が整合が取りやすい可能性あり

### Step C: 動作確認

- `pnpm dev` で dev サーバが起動し、サンプル URL のプレビューが取れる
- `pnpm serve config.toml` で本番サーバが起動し、`GET /?url=...` が応答する

---

## 完了条件

- [x] Step A の patch/minor 6 件が一括更新され、フルゲート green (commit `70abd4c`)
- [x] Step B の major 2 件 (@types/node / @fastify/static) を独立コミットで更新、フルゲート green (`2a5bd04` / `dd69dee`)
- [ ] **Step B-3 (eslint 9 → 10) は次回送り**: `@misskey-dev/eslint-plugin@2.2.0` が eslint 10 に追従しておらず、`@eslint/eslintrc` の resolve エラー + `@stylistic/eslint-plugin@>=5` / `globals@>=16` の peer dep 不整合。Plan の見送り条件に該当
- [x] Step C の dev/serve 動作確認 OK (dev: 静的アセット 200、`pnpm serve` で `/v` + `/?url=...` 応答確認)
- [x] `pnpm outdated` の出力は eslint のみ残る

---

## 想定される落とし穴

- `@types/node` 25 で Node.js 22+ の型が前提になり、CI Node バージョンと齟齬が出る可能性 → CI matrix を確認する
- `eslint` 10 で flat config 専用になっているため、もし `.eslintrc.*` 互換 fallback に依存していれば破綻する（本リポは flat config 採用済みなので問題ない見込み）
- `@fastify/static` 9 の breaking change は `serve-static` 系の挙動変更が中心。dev UI の MIME / cache header に影響しないか確認

---

## 見送り条件

- patch/minor は基本的に上げるが、`@misskey-dev/eslint-plugin` が 2.2.0 で eslint 10 に追従していなければ Step B の eslint 部分は次回送り
- major は 1 つでも難航したら他の 2 つは別 phase に分割可
