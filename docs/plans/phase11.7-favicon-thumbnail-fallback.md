# Phase 11.7 — favicon を thumbnail のフォールバックに採用

> 状態: **完了 (2026-05-05)**
> 種別: 機能改善（汎用パスの体験向上）
> サイズ: **S**
> 依存: phase10.1（`isThinSummary` の判定ロジック）
> 関連 issue: [fruitriin/riin-summaly#3](https://github.com/fruitriin/riin-summaly/issues/3)
> 並列可: phase11.1 / 11.2 / 11.4 / 11.5 / 11.6 すべてと独立

## 目的・背景

汎用パス（[src/general.ts](../../src/general.ts) `parseGeneral`）でタイトルは取得できたが OG/Twitter 画像系メタが一切無いサイトは、現在 `thumbnail: null` のまま返る。Misskey のクライアントから見ると「タイトルだけのプレーンなプレビュー」になり、サムネ枠が空白で表示される。

issue #3 の要望: **og:image / twitter:image / image_src / apple-touch-icon が全部無い場合、favicon を thumbnail として採用する**。favicon はほぼ必ず存在するため、空白サムネを「サイトのアイコンが入った最低限の見た目」に格上げできる。

### 現状の解決チェーン（[src/general.ts:238-244](../../src/general.ts#L238-L244)）

```ts
let image: string | null | undefined =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="twitter:image"]').attr('content') ||
    $('link[rel="image_src"]').attr('href') ||
    $('link[rel="apple-touch-icon"]').attr('href') ||
    $('link[rel="apple-touch-icon image_src"]').attr('href');

image = image ? (new URL(image, url.href)).href : null;
```

apple-touch-icon は既に末尾に入っているが、これも欠けているサイトが多い（特に個人ブログや古いサイト）。その下に **favicon（`getIcon()` で HEAD 検証済みの URL）** をもう一段足すのが本フェーズの趣旨。

## 設計方針

### 1. フォールバック位置

favicon は `getIcon()` が **HEAD で実在確認** した上で `icon` に代入される（[src/general.ts:316-318](../../src/general.ts#L316-L318)）。`Promise.all([getIcon(), getOEmbedPlayer(...)])` の **後** に thumbnail フォールバックを差し込む形が最も低リスク。

```ts
const [icon, oEmbed] = await Promise.all([
    getIcon(),
    getOEmbedPlayer($, url.href),
]);

// 既存の image チェーンが null だったら、HEAD 検証済みの favicon を thumbnail に流用
const thumbnail = image ?? icon?.href ?? null;
```

`image` を直接書き換えず `thumbnail` 変数に集約する形にして、後続コードの読みやすさを保つ。

### 2. apple-touch-icon との優先順位

apple-touch-icon（180×180 程度が多い）は既存チェーンに入っているので **favicon より優先される**。これは画質的にも望ましい順序：
- og:image / twitter:image（高品質、設計された OG 画像）
- image_src（旧仕様、希少）
- apple-touch-icon（中品質、180×180 等）
- **favicon（最終フォールバック、16×16〜192×192 と幅広い）**

### 3. `isThinSummary` の判定への影響

[src/utils/parse-failure-log.ts:84-94](../../src/utils/parse-failure-log.ts#L84-L94) の `isThinSummary` は `summary.thumbnail != null` を「thin ではない」シグナルにしている。本フェーズの変更で **favicon が必ず thumbnail に乗る** ため、従来 `thin` 判定されていた「title だけのスカスカページ」が thin として記録されなくなる。

これは parseFailureLog のシグナル品質を下げるので、**`isThinSummary` 側に補正を入れる**:

```ts
// 既存判定の前段に: thumbnail が icon と同一なら「OG 画像なし」として thin 候補に戻す
if (summary.thumbnail != null && summary.thumbnail !== summary.icon) return false;
```

これで:
- `thumbnail` が `icon` と異なる（OG 画像が取れている）→ thin ではない（既存挙動）
- `thumbnail` が `icon` と同一（favicon フォールバック発動）→ thin 判定に進む（新挙動。description / player.url / medias[] / title 内容で最終判定）

### 4. プラグイン経由の Summary には影響を与えない

本変更は **`parseGeneral` 内のみ**。`amazon` / `wikipedia` / `twitter` 等の独自プラグインは自前で thumbnail を組み立てており、本変更の影響を受けない。`bluesky` プラグインは `parseGeneral` に流すので影響対象だが、bluesky は OG を持つので favicon フォールバック発動はレアケース。

### 5. `data:` / 巨大 favicon の懸念

- favicon が `data:image/...` URI のサイトもまれにあるが、`getIcon()` が HEAD する関係で `<link rel="icon" href="data:...">` は HEAD 失敗 → `icon: null` になり、フォールバックも発動しない。安全。
- favicon が巨大（>1 MiB の PNG / SVG）でクライアント側でサムネとして展開すると重い、というケースはあり得る。が、現状の OG 画像にもサイズ検証は無いので妥協する（issue 範囲外）。

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `parseGeneral` の thumbnail 解決を後段に移動**
  - [src/general.ts](../../src/general.ts) の `parseGeneral`:
    - `image = image ? new URL(image, url.href).href : null;` のあと、`image` を `thumbnail` 候補として保持するだけにする（`null` のままで良い）
    - `Promise.all([getIcon(), getOEmbedPlayer(...)])` の後に `const thumbnail = image ?? icon?.href ?? null;` を追加
    - return オブジェクトの `thumbnail: image || null` を `thumbnail` に差し替え
- [x] **Step 2 — `isThinSummary` の補正**
  - [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) `isThinSummary`:
    - `summary.thumbnail != null` 早期 return を `summary.thumbnail != null && summary.thumbnail !== summary.icon` に変更
    - JSDoc に「thumbnail === icon は favicon フォールバック発動状態なので thin 候補として継続判定する」と追記
- [x] **Step 3 — テスト追加**
  - [test/index.test.ts](../../test/index.test.ts) に以下を追加:
    1. **favicon フォールバック発動**: `<title>X</title><link rel="icon" href="/favicon.ico">` だけの HTML（OG 一切無し） → `summary.thumbnail === summary.icon` になることを検証
    2. **OG 画像があるときは favicon を採用しない**: `<meta property="og:image" content="/og.png">` がある HTML → `summary.thumbnail` は OG 画像のまま
    3. **apple-touch-icon が favicon より優先**: `<link rel="apple-touch-icon" href="/touch.png">` だけある HTML → `summary.thumbnail === '/touch.png' の絶対 URL`、`!== summary.icon`
    4. **favicon 自体が存在しない（HEAD 失敗）**: 1900 番台の既存 thin テスト挙動と同じく `thumbnail: null` で thin 記録される
    5. **既存の thin 記録テスト** ([test/index.test.ts:1765-1794](../../test/index.test.ts#L1765-L1794)): モック HTML に `<link rel="icon" href="/favicon.ico">` が含まれていなければ挙動不変。既存ケースの HTML が `<title>localhost</title>` しか持たないことを確認し、必要なら別ケースで「favicon あり + thin」を別途検証
- [x] **Step 4 — parseFailureLog の thin 判定が壊れていないことを確認**
  - 既存の「thin が記録される」テストが favicon 経由で false 判定にならないか実際に走らせて検証
  - ケース「favicon あり + title だけ」は **thin として記録される** ことを新規テストで担保
- [x] **Step 5 — ドキュメント更新（4.5 のドキュメント突き合わせ）**
  - [docs/Library.md](../../docs/Library.md) の `SummalyResult.thumbnail` 説明に「OG/Twitter Card/image_src/apple-touch-icon が全部無い場合は favicon を採用する」と追記
  - [CLAUDE.repo.md](../../CLAUDE.repo.md) の「アーキテクチャ §3」（`general.ts` の優先順位記述）に favicon フォールバックを追加
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased に `enhance: 汎用パスで OG 画像が無い場合 favicon を thumbnail に採用` を追加
- [x] **Step 6 — knowhow 記録**
  - 「`parseGeneral` の thumbnail/icon 二段フォールバック設計」を `docs/knowhow/general-parse-fallback.md` 等にまとめる（既存 knowhow があれば追記）
  - thin 判定が `thumbnail === icon` を識別する設計判断もメモ
- [x] **Step 7 — 品質ゲート**
  - `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
  - `bash .claude/tests/run-all.sh`
  - `addf-code-review-agent` / `addf-contribution-agent`

## 完了条件 (Definition of Done)

- title だけある HTML（OG 一切無し）+ favicon が HEAD 200 を返すサイト → `summary.thumbnail === summary.icon` で返る
- OG/Twitter/apple-touch-icon のいずれかがあるサイトでは従来挙動を維持（thumbnail は OG 由来）
- favicon が HEAD 失敗するサイトでは `thumbnail: null` で従来挙動を維持
- `isThinSummary` が `thumbnail === icon` を thin 候補として継続判定する
- 上記すべてのケースに対してテストがある
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る

## リスク・注意点

1. **小さい favicon の見た目悪化**: 16×16 の favicon を Misskey クライアントが大きなサムネ枠に拡大表示すると見た目がボヤける。クライアント側で「`thumbnail === icon` ならアイコン扱いの小さい枠にする」等の表示分岐を入れる余地はあるが、これは Misskey fork 側の責務（TODO の external-misskey-fork タスクに連動可能）
2. **thin 判定の純度低下**: 「favicon あり + title=hostname」のページは現状 thin 判定されるが、本変更でも `summary.thumbnail === summary.icon` の補正により従来通り thin 判定される。新規テストで担保
3. **bluesky プラグインの `parseGeneral` 経由**: bsky.app は OG を持つので favicon フォールバック発動は事実上ない。回帰リスクは低い
4. **icon が動的生成系（`/favicon.ico` がリダイレクトされる）**: `getIcon()` は HEAD で URL の最終形を解決していないので、`icon.href` はリダイレクト前の URL になる。これは既存挙動と同じで本フェーズの変更点ではない
5. **既存 thin テスト ([test/index.test.ts:1765](../../test/index.test.ts#L1765)) の HTML**: `<html><head><title>localhost</title></head><body>x</body></html>` には `<link rel="icon">` が無いが `getIcon()` は `/favicon.ico` を fallback で HEAD する。テストハーネスの fastify がこのパスを 404 で返せば `icon: null` で thin 維持、200 を返すと `icon` 付きになり `thumbnail === icon` になる。**既存テスト挙動を壊さないか実装時に確認必須**（必要に応じて mock サーバ設定を見直す）
