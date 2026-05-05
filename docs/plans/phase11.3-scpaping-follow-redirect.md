# Phase 11.3 — Fastify モードで scpaping のリダイレクト follow が無効化されているバグ修正

> 状態: **完了 (2026-05-05)**
> 種別: バグ修正
> サイズ: **S**
> 関連 issue: [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1)（Amazon プレビュー失敗の真因）
> 関連: [phase9.1 短縮 URL HEAD→GET fallback](phase9.1-short-url-get-fallback.md)、[phase11.2 エラーカテゴリ化](phase11.2-error-category.md)

## 目的・背景

[riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1) の真因を調査した結果、**`summaly()` の `followRedirects` フラグが scpaping (本体取得) の got リクエストにまで伝播し、scrape 中の HTTP リダイレクトすら追わなくなる**ことが判明。

### 再現

```bash
$ curl -s 'https://summaly.riinswork.space/?url=https%3A%2F%2Fwww.amazon.co.jp%2Fdp%2FB0989HTQ32&lang=ja-JP'
{"error":{"message":"Rejected by type filter undefined","name":"Error"}}
```

### 経路

1. `amazon.co.jp/dp/<ASIN>` は 301 で `/<タイトル>/dp/<ASIN>` にリダイレクトする Amazon の正規挙動
2. Fastify ハンドラが `summaly()` に `followRedirects: false` を渡す（[src/index.ts](../../src/index.ts) L476）
3. `summaly()` 内で `scrapingOptions.followRedirects = opts.followRedirects` (= false) として `general()` に渡す（L334）
4. `general()` → `scpaping()` → `getGotOptions()` → `getResponse({ followRedirects: false, ... })`
5. `getResponse()` が `got({ followRedirect: false })` を呼ぶ（[src/utils/got.ts](../../src/utils/got.ts) L268）
6. got が 301 を follow せず中間レスポンスを返す（content-type 無し、content-length: 0）
7. typeFilter が `^(text/html|application/xhtml+xml)` で undefined にマッチせず throw → `Rejected by type filter undefined`

### `followRedirects` の本来の意図

- `summaly()` の **初期 HEAD/GET でリダイレクト解決をするかどうか**（[src/index.ts](../../src/index.ts) L314-322 の `shouldResolve` 分岐）
- Fastify モードで `false` にしているのは、Misskey 等の利用側が「summaly がプロアクティブに最終 URL を解決するのは余計」と判断するため
- **scrape 本体の HTTP リダイレクト follow は別の話**: `maxRedirects: 5` 等で抑制すれば SSRF チェイン防御は十分

つまり `summaly()` の `followRedirects` は **summaly レイヤの URL 解決オプション**であって、got レイヤの `followRedirect` にそのまま透過させるのは設計上の誤り。

## 設計方針

### 採用案: `scrapingOptions` から `followRedirects` を削除

`summaly()` 内で `general()` / プラグインに渡す `scrapingOptions` から `followRedirects` を **そもそも渡さない**。`getGotOptions()` で `opts?.followRedirects` が undefined になり、`getResponse()` の `followRedirect: undefined` → got がデフォルト挙動 (`true`) でリダイレクトを follow する。

```ts
// src/index.ts
const scrapingOptions: GeneralScrapingOptions = {
  lang: opts.lang,
  userAgent: opts.userAgent,
  responseTimeout: opts.responseTimeout,
  // followRedirects: opts.followRedirects,   ← 削除
  operationTimeout: opts.operationTimeout,
  contentLengthLimit: opts.contentLengthLimit,
  contentLengthRequired: opts.contentLengthRequired,
  useRange: opts.useRange,
  enablePdf: opts.enablePdf,
};
```

### 影響範囲

| 利用シナリオ | 旧挙動 | 新挙動 |
|:--|:--|:--|
| Fastify モード + リダイレクトする URL（amazon `/dp/<ASIN>` 等） | scpaping が follow しないので 301 中間レスポンスで死ぬ | scpaping が follow して最終ページを取れる |
| ライブラリモード（`summaly()` 直接呼び、`followRedirects` デフォルト true） | scpaping は follow（既存挙動） | 同じ（変わらない） |
| ライブラリモード + `followRedirects: false` を明示 | scpaping は follow しなかった | **scpaping は follow するようになる** |

3 番目のケースだけ挙動が変わる。ただし「scrape 中のリダイレクト follow を完全に抑制したい」というユースケースは想定しにくい (SSRF 対策は `maxRedirects: 5` + プライベート IP ガードで担保)。`followRedirects: false` の意味を **「summaly() の初期 HEAD 解決をスキップ」だけ**にするのは設計をクリーンにする変更。

ドキュメント更新で `followRedirects` の責務を明確化する。

### 別案（不採用）

- **A. `getGotOptions` のデフォルトを `true` にする** (`opts?.followRedirects ?? true`):
  - 同等の効果だが、`scrapingOptions` 経由で意図的に false を渡せる余地が残る
  - 「Fastify モードハンドラで false が透過する」という根本問題は解決しない
  - 不採用
- **B. Fastify ハンドラで `followRedirects: false` を渡すのをやめる**:
  - 旧来の意図 (Misskey のリクエストはリダイレクト解決しない) を破壊
  - 不採用

## 実装ステップ

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

- [x] **Step 1 — `scrapingOptions` から `followRedirects` を削除**
  - [src/index.ts](../../src/index.ts): `scrapingOptions` から削除 + JSDoc 明確化
  - [src/general.ts](../../src/general.ts): `general()` 内 `scpaping` 呼び出しからも削除（プラグイン側からの透過パスも遮断）
- [x] **Step 2 — テスト追加** — 2 件追加:
  - `followRedirects: false` (Fastify モード相当) でも scpaping が 301 を follow して最終ページのタイトルを取れる
  - `followRedirects: true` でも当然 follow する（回帰防止）
- [x] **Step 3 — ドキュメント更新** — Library.md / CHANGELOG / 本 Plan

## 完了条件

- `summaly Fastify` が `https://www.amazon.co.jp/dp/B0989HTQ32` で 200 OK + 商品タイトル/description を返す
- `https://amzn.asia/d/<id>` も同様（phase9.1 + phase11.3 の合わせ技）
- 既存テスト全 pass + 新規テスト
- ドキュメント反映済み

## リスク

1. **挙動変更**: `summaly(url, { followRedirects: false })` を直呼びしているライブラリ利用者で「scrape 中のリダイレクトを意図的に止めたい」ケースがあれば挙動が変わる。CHANGELOG で明示
2. **回帰**: Fastify モードの既存テストでリダイレクトを期待していないものは確認。最後 fixture サーバが 301 を返さない限り影響無し
3. **デプロイ後の cache**: `cacheErrorMaxAge` (デフォルト 1 時間) で過去の `Rejected by type filter undefined` エラーがキャッシュされている。本番デプロイ後にプロセス再起動か 1 時間待ちが必要
