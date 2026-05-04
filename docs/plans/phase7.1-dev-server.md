# Phase 7.1 — Dev サーバ（動作確認 UI）

> 状態: **完了 (2026-05-05)**
> 種別: 開発体験 / 検証ツール
> サイズ: **M**
> 依存: なし（既存 Fastify モードと並走するか単独ツールにするかは設計判断）

## 目的・背景

現状、summaly の動作確認は以下のいずれかでしか行えない:

1. `pnpm serve` で Fastify を起動し、ブラウザの URL バーで `?url=...` を叩いて生 JSON を眺める
2. テストファイルで個別 URL を assert する
3. Node REPL で `summaly()` を叩く

どれも **「結果がどう見えるか（Misskey の note カード上での見え方）」を可視化できない**。プラグインや汎用パスを改修したとき、**iframe プレーヤーが意図通りに埋め込まれるか・サムネイル / アイコン / 説明文が崩れずに表示されるか** を視覚で確認する手段が欲しい。

加えて、プラグインで対応している主要サイト（YouTube / Spotify / Wikipedia / Amazon / GIGAZINE 風の汎用 OG ページ等）は、**毎回 URL をコピペするのが面倒**。ワンクリックでサンプル URL をフィールドに流し込めるとデバッグサイクルが速くなる。

本フェーズでは **dev 専用の動作確認 UI** を導入する。本番出荷物には含めない（`files: ["built", "LICENSE"]` のままにする）。

---

## 現状分析

### 既存のエントリポイント

- [src/index.ts](../../src/index.ts) の `summaly()` 関数 — ライブラリ用途
- [src/index.ts](../../src/index.ts) の default export — Fastify プラグイン (`GET /` を受ける)
- [tsdown.config.ts](../../tsdown.config.ts) は `entry: ./src/index.ts` のみで bundle、dev 用エントリは現状なし

### Misskey の URL プレビュー実装

Misskey-dev の frontend コンポーネント [`packages/frontend-shared/js/url-preview.ts`](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/url-preview.ts) と [`packages/frontend/src/components/MkUrlPreview.vue`](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend/src/components/MkUrlPreview.vue) 相当のロジックが、`SummalyResult` を受け取ってカード UI を組み立てている。本フェーズではその **iframe プレーヤー部分のレンダリングロジックを参考にして** dev UI に同等のものを実装する。

iframe の組み立てで重要な点:
- `player.url` が設定されているときのみ iframe を出す
- `player.width` / `player.height` を `width` / `height` 属性に渡す（`width` が null なら 100%、`height` が null は不可なので非表示）
- `player.allow` 配列を `allow` 属性にセミコロン区切りで連結
- `referrerpolicy="no-referrer"`、`sandbox` の設定で攻撃面を絞る（Misskey の既定値を参照）

---

## 設計方針

### サーバ構成

**選択肢 A**: 既存 Fastify プラグインに `/__dev/*` ルートを追加（`NODE_ENV !== 'production'` のときのみ）。本番ビルドにも含まれるが routes が出ないだけ。

**選択肢 B**: dev 専用の独立スクリプト [`dev/server.ts`](../../dev/server.ts) を新設。`pnpm dev` で起動する。本番 bundle (`./built/*`) には含まれない。

**採用: B**。理由:
- 本番 bundle のサイズに影響しない（HTML / 大量のサンプル URL を抱える）
- セキュリティ境界が明確（dev UI が誤って production で有効化されるリスクなし）
- `pnpm dev` の意味が直感的（serve = 本番 / dev = 開発）

### URL ルート設計

`pnpm dev` で起動するサーバ（デフォルト `http://localhost:3000`）:

| パス | 内容 |
|---|---|
| `GET /` | dev UI HTML（URL 入力フォーム + JSON ビューア + iframe プレビュー + サンプル URL リンク集） |
| `GET /api/summaly?url=...&lang=...` | summaly プラグインを mount したエンドポイント。`SummalyResult` JSON を返す |
| `GET /assets/*` | dev UI が読み込む静的ファイル（CSS / JS） |

### Dev UI の機能

**1. URL 入力フォーム + 実行ボタン + 結果表示エリア**

- `<input type="url">` に URL を入力 → 「取得」ボタンで `/api/summaly?url=` を叩く
- 結果ペインを 3 タブ構成:
  - **JSON** — 整形した `SummalyResult` を表示（vscode 風の syntax highlight があれば嬉しいが、`<pre>` で十分）
  - **カードプレビュー** — Misskey 風のリンクカードを HTML で再現（thumbnail / title / description / sitename を表示）
  - **iframe プレーヤー** — `player.url` がある場合に iframe を embed（`width`/`height`/`allow` を Misskey 互換で組み立て）

**2. プラグイン対応サイトのワンクリック URL リスト**

組み込みプラグイン名と「動作確認用のサンプル URL」を表で並べる:

```
youtube     [https://www.youtube.com/watch?v=NMIEAhH_fTU] → クリックで入力欄に流し込み
spotify     [https://open.spotify.com/track/...]
wikipedia   [https://ja.wikipedia.org/wiki/...]
amazon      [https://www.amazon.co.jp/dp/...]
bluesky     [https://bsky.app/profile/.../post/...]
youtu.be    [https://youtu.be/NMIEAhH_fTU] (短縮 URL の dispatcher 検証)
PDF         [https://example.com/sample.pdf] + enablePdf チェックボックス
```

サンプル URL は **コードでハードコード** する（外部 JSON にせず、`dev/sample-urls.ts` 等に静的データとして保持）。サイト側で URL が陳腐化したら都度更新する。

**3. オプションフォーム**

URL 入力欄の下に collapse 可能なオプションパネル:
- `lang` (text input、空欄で送らない)
- `useRange` (checkbox)
- `enablePdf` (checkbox)
- `allowedPlugins` (multi-select、組み込み 10 プラグインから選ぶ)

設定値はクエリ文字列に乗せて `/api/summaly` に渡す。

### 技術スタック

- **サーバ**: Fastify (既存依存)
- **dev UI**: 素の HTML + Vanilla JS + 軽量 CSS
  - フレームワーク非採用（Vue / React 等）でビルド工程を増やさない
  - vscode などの syntax highlight は `<pre>` + 簡易な色付けで代用
- **静的ファイル**: Fastify の [`@fastify/static`](https://github.com/fastify/fastify-static) を dev 専用 `devDependencies` で追加

### iframe レンダリング規約

Misskey の `MkUrlPreview.vue` を参考に、本フェーズでは以下の最小実装を採用:

```html
<iframe
  src="{player.url}"
  width="{player.width ?? '100%'}"
  height="{player.height}"
  allow="{player.allow.join('; ')}"
  referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
  loading="lazy"
></iframe>
```

`sandbox` の値は YouTube / Spotify の埋め込みに必要な最小集合。Misskey 側で別の値が使われている場合は揃える。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm typecheck` を通す。

- [x] **Step 1 — `dev/` ディレクトリ構成** — `server.ts` / `setup-version.ts` / `sample-urls.ts` / `public/{index.html,app.js,style.css}` を新設
- [x] **Step 2 — `pnpm dev` script 追加** — `tsx` / `@fastify/static` を devDependencies に、`pnpm dev` script + typecheck 拡張
- [x] **Step 3 — Fastify サーバ実装** — Fastify プラグイン mount ではなく、`summaly()` 関数を request 単位で叩く `/api/summaly` ハンドラに変更（UI のチェックボックスを即時反映するため）
- [x] **Step 4 — UI 実装** — URL 入力 / JSON・カード・iframe の 3 タブ / サンプル URL ワンクリック / オプションフォーム / エラー表示
- [x] **Step 5 — Misskey 風カードプレビュー**
- [x] **Step 6 — iframe レンダリング** — `https:` 限定、`player.height == null` で非表示、sandbox: `allow-scripts allow-same-origin allow-presentation allow-popups`
- [x] **Step 7 — README 更新**

## 実装結果メモ

- **`_VERSION_` シム**: tsdown の build-time 定数 `_VERSION_` が tsx 直実行で `ReferenceError` になる。`dev/setup-version.ts` を side-effect import で先頭に置き、ESM の depth-first 評価順序を使って `globalThis._VERSION_` に注入。詳細は `docs/knowhow/dev-server-tsx-pattern.md`
- **オプションをリクエスト単位で切り替えられる**: 元プランは「summaly プラグインを mount」だったが、Fastify プラグインは register 時に options が固定されるため、dev では `summaly()` 関数を直接叩く形に変更。UI のチェックボックスが即時反映できる
- **HOST/PORT の defensive validation**: `process.env.HOST ?? '127.0.0.1'` だと `HOST=''` で `::` バインドになり SSRF リレー化リスク。空文字も fallback 対象にする。`PORT` も数値検証（`Number('')` = 0、`Number('abc')` = NaN のサイレント誤動作回避）
- **`builtinPluginNames` を動的取得**: 元プランは `dev/sample-urls.ts` に手動同期だったが、`src/plugins/index.ts` から `plugins.map(p => p.name)` で動的取得に変更（プラグイン追加時の漏れ防止）
- **本番 bundle への混入防止**: `tsdown.config.ts` の entry / `tsconfig.json` の include / `package.json` `files` / eslint ignore のすべてが `dev/` を本番スコープから除外している。typecheck だけ `tsconfig.dev.json` で別途検証

---

## 完了条件 (Definition of Done)

- `pnpm dev` で起動して `http://localhost:3000` にアクセスすると URL 入力 UI が表示される
- 任意の URL を入力 → 「取得」で `SummalyResult` JSON が表示される
- player を持つ URL（YouTube 等）で iframe が embed される
- カードプレビューが Misskey 風に表示される
- プラグイン対応サイトのサンプル URL 一覧からワンクリックで入力欄に流し込める
- `pnpm build && pnpm typecheck && pnpm test` が引き続き通る（dev/ は本番 bundle に含まれない）
- 本番 `pnpm serve` の挙動は変わらない

---

## リスク・注意点

1. **本番 bundle への混入**: `tsdown.config.ts` の `entry: ./src/index.ts` を変えない限り `dev/` は bundle されないが、`tsconfig.json` の `include` に `dev/` を追加すると `pnpm typecheck` が dev も含めて検証する形になる。type 定義の漏れを catch する一方で、`dev/` で `@fastify/static` のような devDependency を使った場合に `tsconfig.json` 経由で本番ビルドに影響しないか確認が必要。**`tsconfig.dev.json` を分けて typecheck する** のが安全
2. **iframe の sandbox 設定**: Misskey 本体の値とずれていると、dev UI で問題なく見えても本番で表示崩れが起きる。Misskey-dev の最新コミットを参照して定期的に同期するか、初回採用時の Misskey commit hash をコメントに残す
3. **サンプル URL の陳腐化**: YouTube / Wikipedia 等の URL は時々消える / 変わる。dev サーバが起動しないという致命的なものではないので、気付いたタイミングで都度更新する程度の温度感
4. **`SUMMALY_ALLOW_PRIVATE_IP=true` の意図せぬ漏洩**: dev サーバは privite IP を許可するが、これを **本番の `pnpm serve` 起動シェルに残してしまう** と SSRF の穴になる。`dev/server.ts` 内で `process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true'` を設定する形は **shell に env が残らない** ため安全。README の「開発」セクションでも触れて注意喚起
5. **静的ファイル配信のセキュリティ**: dev サーバはローカル限定なので攻撃面はほぼないが、`@fastify/static` のデフォルトはディレクトリトラバーサル対策が入っているため特別な設定は不要。`prefix: '/'` で `dev/public/` のみ公開する
6. **既存テストへの影響**: `dev/` 配下にコードを置くだけなら既存テストは影響を受けない。`tsconfig.test.json` の `include` に `dev/` を追加するかは別途判断（dev のテストは書かない方針なら追加しない）

---

## オープンクエスチョン

- **A. dev サーバを Vite ベースにするか**: 静的 HTML + Vanilla JS で十分なので Vite は不要と判断。HMR の便益より「依存追加コスト」が大きい
- **B. Misskey の `MkUrlPreview.vue` をそのまま import するか**: ライセンス・依存関係的に難しい（Vue + Misskey 内部依存）。**ロジックを参考に Vanilla JS で再実装** が無難
- **C. dev UI を npm パッケージとして公開するか**: 本フェーズでは行わない。`dev/` は repo 内ツール扱い
