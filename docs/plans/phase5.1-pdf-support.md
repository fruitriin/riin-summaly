# Phase 5.1 — PDF レスポンス対応（オプトイン + ハング対策5層）

> 状態: **完了 (2026-05-04)**
>
> **実装メモ**: pdf-parse v2 の API は計画時 (v1) と異なる。`pdf-parse(buffer, { max: 1 })` は無く、代わりに `new PDFParse({ data }).getInfo()` を使用。`getInfo()` は document-level metadata のみ読むため「1 ページのみパース」より安全な実装になった。
> 種別: 機能拡張 / 大型機能
> サイズ: **M〜L**
> 依存: [phase2.2](phase2.2-mei23-non-plugin.md)（`useRange`、`sanitize-url` の `data:` 許可）

## 目的・背景

Misskey の Note プレビューで PDF へのリンクは頻出する。現状の summaly は HTML only で、PDF は `typeFilter` でリジェクトされ「タイトルが取れずただの URL 表示」になる。**PDF レスポンスのタイトルとアイコンを返せるだけでも UX が大きく改善する**。

mei23 fork は `pdf-parse` で PDF を解析する実装を持っている ([worktrees/mei-summaly/src/utils/got.ts:51-58](worktrees/mei-summaly/src/utils/got.ts#L51-L58))。これを upstream に取り込みたい。

ただし PDF パース処理は **巨大 PDF / 悪意ある PDF** で内部の `pdfjs-dist` がメモリ膨張・CPU 占有を起こすリスクが現実にある。本フェーズの採用条件は:

1. **`pdf-parse` は通常の `dependencies` でインストールしてしまう**（`optionalDependencies` のセットアップ煩雑さを避ける）
2. **機能のオン・オフはランタイムオプトインフラグで制御**（`SummalyOptions.enablePdf` または `SUMMALY_ENABLE_PDF=true` 環境変数）
3. **ハング対策5層** を全て実装する（後述）

---

## 現状分析

### upstream の現状

[src/utils/got.ts](src/utils/got.ts) の `scpaping` の `typeFilter` は `text/html, application/xhtml+xml` のみ許可。`application/pdf` は **type filter で reject** され、`general()` まで到達しない。

### mei23 の参考実装

[worktrees/mei-summaly/src/utils/got.ts:51-58](worktrees/mei-summaly/src/utils/got.ts#L51-L58):

```ts
const pdf = require('pdf-parse');
// ...
if (response.headers['content-type']?.match(/^application\/pdf/)) {
    const data = await pdf(response.rawBody);
    return {
        pdf: { title: data?.info?.Title as string | undefined },
        response,
    };
}
```

[worktrees/mei-summaly/src/general.ts:14-32](worktrees/mei-summaly/src/general.ts#L14-L32):

```ts
if (res.pdf) {
    return {
        title: res.pdf.title ?? 'PDF Document',
        icon: 'data:image/png;base64,...', // PDF アイコン定数
        description: null,
        thumbnail: null,
        // ...
    };
}
```

mei23 では:
- 制限なくフルパース（`{ max: 1 }` 指定なし）
- timeout なし
- ランタイムオプトインフラグなし

→ **そのまま取り込むのはハングリスクが大きい**。本フェーズで多段防衛を加える。

---

## 設計方針

### スキーマ

- `scpaping(url, opts)` の戻り値に `pdf?: { title?: string }` を追加し、PDF レスポンス時は `body` / `$` を返さず `pdf` を返す
- `general.ts` で `res.pdf` がある場合は専用結果（`title`、`icon`（PDF アイコン定数）、`sitename: <hostname>`、`description: null`、`thumbnail: null`、`player: { url: null, ... }`）を返す
- 依存方針: `pdf-parse` は通常の `dependencies` に追加（インストール時に必ず入る）
- ランタイムオプトイン: PDF 機能はデフォルト無効。以下のいずれかで明示的に有効化された場合のみ動く:
  - 関数 API: `summaly(url, { enablePdf: true })`
  - 環境変数: `SUMMALY_ENABLE_PDF=true`（Fastify モードや独自サーバ起動時の運用デフォルト用）
- 無効時は `typeFilter` から `application/pdf` を外し、PDF レスポンスは通常通り `Rejected by type filter` で弾かれる（既存と完全互換の挙動）
- 有効時のみ `typeFilter` が PDF を許可し、`scpaping` が PDF 分岐に入る

### ハング対策5層（採用条件・必須）

| 層 | 対策 | 効き方 |
|:--|:---|:---|
| ① 受信前 | 既存 `contentLengthLimit`（10 MiB）。`content-length` ヘッダ / `downloadProgress` 両方で超過を検出して `req.cancel()` | 10 MiB 超 PDF はそもそもパースに到達しない |
| ② 受信中 | `useRange` 併用で `Range: bytes=0-<MAX-1>` で先頭だけ取得（[phase2.2](phase2.2-mei23-non-plugin.md) で導入） | 帯域・受信時間ともに上限保証 |
| ③ パース直前 | `pdf-parse(buffer, { max: 1 })` で **1 ページのみパース**。タイトルだけ取れれば良い | CPU / メモリの主要消費を切り詰め |
| ④ パース時 | `Promise.race([pdfParse(buf), timeout(5000)])` で **5 秒 hard timeout**。超過したら例外、フォールバックして `title=hostname` + PDF アイコン定数のみ返す | パース処理暴走時も呼び元はハングしない |
| ⑤ ランタイムフラグ | `enablePdf: true` または `SUMMALY_ENABLE_PDF=true` 時のみ PDF パスに入る。**デフォルトは PDF 完全 disable** | サーバ運用者が「PDF を扱う／扱わない」を明示的に選ぶ |
| ⑥ オプトイン拡張 | （将来）`worker_threads` でパース実行し、メイン Event Loop からブロッキング処理を隔離 | 本フェーズではスコープ外、「将来オプション」として記録 |

①〜⑤ はデフォルトで有効（⑤ は「フラグ未設定なら無効」という意味で、これ自体がデフォルトの安全側）。

### PDF アイコン定数

mei23 が使っている base64 PNG（[worktrees/mei-summaly/src/general.ts:17](worktrees/mei-summaly/src/general.ts#L17)）を [src/utils/pdf-icon.ts](src/utils/pdf-icon.ts) に取り込み、`data:image/png;base64,...` 形式で export。

### sanitize-url との連携

[phase2.2](phase2.2-mei23-non-plugin.md) で `sanitize-url` が結果フィールドをフィルタする際、`icon` が `data:image/png;base64,...` のときに通すよう `data:` プロトコルを許可（長さ上限 10 KB）。本フェーズの PDF アイコンが PCI 通過するための前提条件。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `pdf-parse` 依存追加**
  - `package.json` の `dependencies` に `pdf-parse`（最新安定版）を追加
  - 利用箇所は通常の `import`（dynamic import は不要、`dependencies` なので必ず存在する）
  - インストール後の `pnpm install` が通ることを確認
- [x] **Step 2 — `enablePdf` オプション**
  - `SummalyOptions.enablePdf?: boolean` を追加
  - 環境変数 `SUMMALY_ENABLE_PDF=true` を読む（`process.env` 参照）
  - 統合: `enablePdf` または `SUMMALY_ENABLE_PDF=true` のいずれかが真なら PDF 機能を有効化
- [x] **Step 3 — `typeFilter` の動的化**
  - [src/utils/got.ts](src/utils/got.ts) の `scpaping` で `enablePdf` 真時のみ `typeFilter` に `application/pdf` を追加
  - `enablePdf` 偽時は既存と完全互換（`text/html|application/xhtml+xml` のみ）
- [x] **Step 4 — PDF 分岐実装**
  - `scpaping` 戻り値型に `pdf?: { title?: string }` を追加
  - `enablePdf` 真かつ `content-type: application/pdf` のとき:
    - `pdf-parse(rawBody, { max: 1 })` で 1 ページのみパース
    - `Promise.race([pdfParse(rawBody, { max: 1 }), timeout(5000)])` で 5 秒 timeout
    - timeout または例外時は `pdf: { title: undefined }` を返す（フォールバック）
- [x] **Step 5 — PDF アイコン定数**
  - [src/utils/pdf-icon.ts](src/utils/pdf-icon.ts) を新設、`PDF_ICON_DATA_URL` を export
  - mei23 から base64 PNG を取り込み（または独自に作成、サイズが小さく `sanitize-url` の長さ上限内に収まること）
- [x] **Step 6 — `general.ts` の PDF 分岐**
  - [src/general.ts](src/general.ts) で `res.pdf` がある場合の専用結果を返す
  - `title: res.pdf.title ?? new URL(actualUrl).hostname`、`icon: PDF_ICON_DATA_URL`、`sitename: hostname`、`description: null`、`thumbnail: null`、`player: { url: null, width: null, height: null, allow: [] }`
- [x] **Step 7 — テスト**
  - フィクスチャ用に小さな PDF を `test/pdfs/` に配置
  - ハング系テスト:
    - `enablePdf: false`（デフォルト）で PDF レスポンスが type filter リジェクトされる
    - `enablePdf: true` で 10 MiB 超 PDF レスポンスのモックを `contentLengthLimit` がキャンセルする
    - `enablePdf: true` で 5 秒超かかる PDF（モックでパース関数を遅延）の timeout fallback が返る
    - `enablePdf: true` で正常 PDF からタイトルが取れる
    - `SUMMALY_ENABLE_PDF=true` 環境変数でも有効化できる
- [x] **Step 8 — README / CHANGELOG 更新**
  - 新オプション `enablePdf` の説明
  - 環境変数 `SUMMALY_ENABLE_PDF=true` の説明
  - 挙動制約（10 MiB / 5 秒 timeout / 1 ページのみ）を明記
  - mei23 由来である旨

---

## 完了条件 (Definition of Done)

- ハング対策5層（① 受信前サイズ上限／② Range／③ 1 ページのみ／④ 5 秒 timeout／⑤ ランタイムオプトインフラグ）が全て実装され、**ハング系テスト（10 MiB 超 / 5 秒超 / `enablePdf` 未設定で type filter reject）が通る**
- PDF 機能は `enablePdf` または `SUMMALY_ENABLE_PDF=true` 未設定時はデフォルトで完全 disable（既存挙動と互換）
- 有効時に小さな PDF からタイトルとアイコンが取れる
- 既存ユーザーの呼び出しが破壊的変更を受けていない
- `pnpm build && pnpm eslint && pnpm test` が通る
- README に新機能と挙動制約が反映されている

---

## リスク・注意点

1. **`pdf-parse` の依存サイズと脆弱性履歴**
   `pdf-parse` は内部で `pdfjs-dist` を抱え依存サイズが大きい。**`dependencies` に追加するのでインストール時のディスク使用量は増える**（`optionalDependencies` の方が軽量だがセットアップ煩雑なので採用しない、というユーザー判断）。**機能のオン・オフはランタイムオプトインフラグ（`enablePdf`）で制御**する。**ハング・メモリ膨張は採用条件のハング対策5層で多段に抑え込む**
2. **`data:` URI を結果に許可する範囲**
   PDF アイコンの base64 のために [phase2.2](phase2.2-mei23-non-plugin.md) の `sanitize-url` で `data:` を許可するが、長さ上限を必ず設ける（10 KB）。さもないと巨大 base64 によるメモリ膨張のリスク
3. **`Range` でフルボディが返るサーバ**
   サーバが `Range` 非対応で `200 OK` フルボディを返したら、既存の `contentLengthLimit` で切り詰められて末端まで読まれない可能性。PDF パースは末端のメタデータも参照することがあるため、**1 ページのみパース** で先頭から取れる情報だけを使う設計が重要
4. **`pdf-parse` の同期処理での Event Loop ブロック**
   `pdf-parse` は同期的に CPU を使う。worker_threads 化は将来オプション扱い。**5 秒 timeout** がメインの安全装置
5. **PDF アイコンの著作権・ライセンス**
   mei23 のアイコン PNG が再配布可能か確認。不明なら自分で軽量な PDF アイコンを作って差し替える（SVG → base64 でも良い）
6. **環境変数の優先順位**
   `enablePdf: false` をオプションで明示的に渡したとき、`SUMMALY_ENABLE_PDF=true` 環境変数の方を優先するか、関数オプションを優先するか。**関数オプションを優先**する設計（呼出側の意思を尊重）

---

## オープンクエスチョン / 次のアクション候補

- **A. PDF アイコン PNG をどこから持ってくるか**: mei23 流用 / 独自作成 / 既存のオープンライセンス（Wikimedia Commons 等）
- **B. `pdf-parse` でなく `pdfjs-dist` を直接使うか**: `pdf-parse` は thin wrapper だが、自前で `pdfjs-dist` を呼べば worker 化や API 制御が柔軟。本フェーズでは `pdf-parse` を採用（mei23 互換、シンプル）
- **C. `enablePdf` のデフォルト**: 本フェーズでは `false`（オプトイン）。将来「PDF 対応の運用ノウハウが溜まったらデフォルト `true` に変える」議論を別 issue で
