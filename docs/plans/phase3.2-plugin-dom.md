# Phase 3.2 — DOM 後処理系プラグインの取り込み（dlsite / iwara / komiflo / nijie）

> 状態: **完了 (2026-05-04)**
> 種別: 機能拡張 / プラグイン移植
> サイズ: **M**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md)（`getJson`、UA オーバーライド機構）、[phase2.2](phase2.2-mei23-non-plugin.md)（`sanitize-url`、`medias[]`）
> 並列可: [phase3.1](phase3.1-plugin-oembed.md)

## 目的・背景

mei23 fork から **HTML を取得した上で DOM 解析や後処理を行うプラグイン** を取り込む。具体的には:

- `dlsite`: `general()` が 404 のとき `/announce/` ↔ `/work/` を入れ替えて再取得
- `iwara`: `general()` 結果に description / thumbnail を補完。`//ecchi.` ホストで `sensitive`
- `komiflo`: 作品ページで thumbnail がフォールバックしていたら `api.komiflo.com` から取得
- `nijie`: JSON-LD `ImageObject` から description / thumbnail を補完

mei23 は `postProcess` フックとして実装しているが、upstream に取り込む際は **`postProcess` フックを追加せず、各プラグインが `summarize` 内で `scpaping → parseGeneral → 後処理` を自前で呼ぶ形** に統一する（[phase1.x の方針議論](#) で確定済み）。bluesky プラグインが既にこのパターンの実装例。

---

## 現状分析

### upstream で各サイトが当たる経路

現在は専用プラグインがないため、全て [src/general.ts](src/general.ts) → `parseGeneral()` 経由で処理。一部のサイト（iwara、komiflo、nijie）はデフォルト画像にフォールバックしてしまったり、description が取れなかったりする。

### mei23 の各プラグイン詳細

#### dlsite (process)

[worktrees/mei-summaly/src/plugins/dlsite.ts](worktrees/mei-summaly/src/plugins/dlsite.ts):

- マッチ: `www.dlsite.com`
- `general(url)` 呼び出し → `StatusError.statusCode === 404` を catch して `/announce/` ↔ `/work/` を入れ替えて再 `general()`
- 結果の `summaly.url` を見て、`/(home|comic|soft|app|ai)/` のどれにも該当しないパスなら `summaly.sensitive = true`

#### iwara (postProcess)

[worktrees/mei-summaly/src/plugins/iwara.ts](worktrees/mei-summaly/src/plugins/iwara.ts):

- マッチ: `(www|ecchi).iwara.tv`
- description が null のとき `.field-type-text-with-summary` テキストを `decodeEntities` 経由で 500 文字に整形して採用
- thumbnail が null のとき `#video-player[poster]` または `.field-name-field-images a:first[href]` を `new URL(.., landingUrl)` で解決
- `landingUrl` に `//ecchi.` を含めば `sensitive = true`

#### komiflo (postProcess)

[worktrees/mei-summaly/src/plugins/komiflo.ts](worktrees/mei-summaly/src/plugins/komiflo.ts):

- マッチ: `komiflo.com`
- `/comics/<id>` ページかつ thumbnail が `favicon|ogp_logo` を含む場合のみ動作
- `https://api.komiflo.com/content/id/<id>` を `getJson(apiUrl, landingUrl)` で取得
- `named_imgs.cover.filename` と `variants` に `'346_mobile'` がある場合に `https://t.komiflo.com/346_mobile/<filename>` を thumbnail に採用、`sensitive = true`
- 例外は console.log のみで握りつぶす（黙って fallback）

#### nijie (postProcess)

[worktrees/mei-summaly/src/plugins/nijie.ts](worktrees/mei-summaly/src/plugins/nijie.ts):

- マッチ: `nijie.info`
- `landingUrl` が `nijie.info/view.php` のとき、`<script type="application/ld+json">` を全て JSON.parse して `@type === 'ImageObject'` のものを採用
- 改行をそのまま含む JSON があるため、`parse` 前に `\r?\n` → `\\n` にエスケープ
- `thumbnailUrl` を `summaly.thumbnail` に書き戻し、`sensitive = true`

---

## 設計方針

### 共通: `summarize` 形式への統一

各プラグインが自前で `scpaping → parseGeneral → 後処理` を呼ぶ。`postProcess` フックは追加しない。bluesky が同パターンの先行実装。

```ts
// 例: iwara.ts
import { scpaping } from '../utils/got';
import { parseGeneral } from '../general';

export const name = 'iwara';
export function test(url: URL): boolean {
    return /(^|\.)iwara\.tv$/.test(url.host);
}
export async function summarize(url: URL, opts) {
    const res = await scpaping(url.href, opts);
    const summary = await parseGeneral(url, res);
    if (summary == null) return null;

    // 後処理: description / thumbnail / sensitive を補完
    // ...
    return summary;
}
```

### 共通: `decodeEntities` 代替

mei23 の `decodeEntities` は `clip(decode(...))` の薄いラッパ。upstream には `html-entities` の `decode` が既に使われているので、各プラグインで `decode` を直接呼ぶか、共通ヘルパを [src/utils/clip.ts](src/utils/clip.ts) 隣に追加する。**ヘルパ追加ではなく直接呼び出しを採用**（行数が少ないため）。

### dlsite 固有

- `StatusError.statusCode === 404` の catch は upstream の [src/utils/status-error.ts](src/utils/status-error.ts) と互換
- 再帰呼出で `/announce/` ↔ `/work/` を入れ替え（無限ループにならないよう state 管理）
- `sensitive` 判定の URL パスマッチは正規表現で

### iwara 固有

- `parseGeneral` 結果の `$` を再利用（[phase2.1](phase2.1-plugin-infrastructure.md) で `parseGeneral` の入力 `$` を再エクスポーズする必要があれば確認）
- description が title と一致するときは採用しない（mei23 互換）

### komiflo 固有

- `api.komiflo.com` 呼出に [phase2.1](phase2.1-plugin-infrastructure.md) の `getJson(apiUrl, refererUrl)` を利用
- 例外は **console.log ではなく** 静かに握りつぶしてフォールバック（library として stdout に書かない）
- `346_mobile` variant 固定のメンテリスクは **コードコメントに明記**

### nijie 固有

- JSON-LD `\r?\n` → `\\n` エスケープ手法を実装
- `<script type="application/ld+json">` 全件を `each` で走査して `@type === 'ImageObject'` を抽出

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。プラグイン間に依存はないため、Step 1〜4 は worktree を分けて並列開発も可能。

- [x] **Step 1 — dlsite プラグイン**
  - [src/plugins/dlsite.ts](src/plugins/dlsite.ts) を新設、`name = 'dlsite'`
  - 404 リトライロジック実装（`/announce/` ↔ `/work/` 入れ替え、無限ループ防止）
  - `sensitive` 自動判定（パス正規表現）
  - [src/plugins/index.ts](src/plugins/index.ts) に登録
  - フィクスチャテスト（200 と 404 の両方のレスポンスをモック）
- [x] **Step 2 — iwara プラグイン**
  - [src/plugins/iwara.ts](src/plugins/iwara.ts) を新設、`name = 'iwara'`
  - `scpaping → parseGeneral → 後処理` パターンで実装
  - description 補完（`.field-type-text-with-summary`）、thumbnail 補完（`#video-player[poster]`）、`//ecchi.` ホストで `sensitive`
  - `decodeEntities` は `html-entities.decode` 直呼び
  - [src/plugins/index.ts](src/plugins/index.ts) に登録
  - フィクスチャテスト
- [x] **Step 3 — komiflo プラグイン**
  - [src/plugins/komiflo.ts](src/plugins/komiflo.ts) を新設、`name = 'komiflo'`
  - `parseGeneral` 結果の thumbnail が favicon/ogp_logo フォールバックの場合のみ `api.komiflo.com` を `getJson` で叩く
  - `346_mobile` variant 固定のリスクをコメントに明記
  - 例外は静かに握りつぶしてフォールバック
  - [src/plugins/index.ts](src/plugins/index.ts) に登録
  - フィクスチャテスト（API レスポンスをモック）
- [x] **Step 4 — nijie プラグイン**
  - [src/plugins/nijie.ts](src/plugins/nijie.ts) を新設、`name = 'nijie'`
  - JSON-LD `\r?\n` → `\\n` エスケープ後パース、`@type === 'ImageObject'` 抽出
  - `thumbnailUrl` を `summary.thumbnail` に書き戻し、`sensitive = true`
  - [src/plugins/index.ts](src/plugins/index.ts) に登録
  - フィクスチャテスト
- [x] **Step 5 — README / CHANGELOG 更新**
  - 「対応形式（組み込みプラグイン）」表に dlsite / iwara / komiflo / nijie を追加
  - mei23 由来である旨を記載

---

## 完了条件 (Definition of Done)

- 4 プラグインが [src/plugins/index.ts](src/plugins/index.ts) に登録され、各々が `summarize` 形式で動作する
- 各プラグインに `name` 定数が付与されている（[phase2.1](phase2.1-plugin-infrastructure.md) 規約準拠）
- 4 つともネットワーク非依存のフィクスチャベースのテストが付いている
- 既存の `general()` 経由で動いていた挙動から、各プラグインが先にマッチするよう振る舞いが切り替わる（テストで担保）
- `pnpm build && pnpm eslint && pnpm test` が通る

---

## リスク・注意点

1. **メンテナンス依存リスク**: komiflo の `346_mobile` variant 固定、各サイトの DOM 構造は外部仕様変更で陳腐化する。コードコメントで明記し、テストはなるべく「重要なフィールドだけ assert」する形にする
2. **`parseGeneral` の戻り値に `$` を含める必要があるか**: 後処理で cheerio の `$` を再利用したい場合、`parseGeneral` がそれを返すか、各プラグインが `scpaping` の戻り値の `$` を直接使うかの設計判断が必要。**bluesky の実装パターンを踏襲**する（`scpaping` の戻り値 `{ body, $, response }` を直接使い、`parseGeneral(url, { body, $, response })` を呼んだあとも `$` を保持して後処理）
3. **`StatusError` の互換**: dlsite が 404 catch に依存。upstream の [src/utils/status-error.ts](src/utils/status-error.ts) と互換性を確認（`statusCode` プロパティでアクセス可能であること）
4. **`sensitive` の意味揺れ**: iwara は `//ecchi.` ホスト、komiflo / nijie は機械的に `true` 固定、dlsite はパス分類。各プラグインで「sensitive をいつ立てるか」は仕様判断であり、運用者がプラグイン採用を `allowedPlugins` で絞れる（[phase2.2](phase2.2-mei23-non-plugin.md)）
5. **ToS / 規約**: `nijie.info`、`komiflo.com`、`iwara.tv` 等は性的コンテンツを含むサイトで、機械的アクセスに対する規約が個別にある。**プラグインを `allowedPlugins` でデフォルト disable にしたい運用者向けに README で言及**する
