# External — Misskey fork: UrlPreview 連携改善（lang / エラー細分化 / Amazon 切り分け）

> 状態: **計画のみ / summaly のスコープ外**（Misskey fork 側で対応）
> 種別: クロスリポ連携 / 観測指標改善
> サイズ: **S 〜 M**
> 関連: [phase10.1 パース失敗ログ](phase10.1-parse-failure-log.md)（アクセスログ調査の発端）、[phase11.2 エラーカテゴリ](phase11.2-error-category.md)（API 拡張側）、本リポ README の compare 表
> 関連 issue: [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1) / [riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)

## サマリ

Misskey fork 側で対応すべきタスクのトラッキング:

| 項目 | 関連 | 概要 |
|:--|:--|:--|
| 1. UrlPreview の `lang` を localStorage 生値ベースに | — | en-US ハードコード回避（後述） |
| 2. summaly の `error.category` を受け取って分岐表示 | [phase11.2](phase11.2-error-category.md) | 「プレビューできませんでした」を「タイムアウト」「bot block」等に細分化 |
| 3. Amazon プレビュー失敗の切り分け | [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1) | summaly 側で取れる URL が Misskey で「プレビューできませんでした」表示になる原因を確認 |

---

## 1. UrlPreview の `lang` を localStorage 生値ベースに変更

## 目的・背景

[Misskey フロントエンド `frontend-shared/js/config.ts`](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/config.ts) の **1 行のハードコード**:

```ts
export const lang = localStorage.getItem('lang') ?? 'en-US';
```

これが原因で **プロフィール言語未設定のユーザーは必ず `?lang=en-US`** で URL preview を呼ぶ。`MkUrlPreview.vue` から派生する `versatileLang` も `('en-US' ?? 'ja-JP').replace('ja-KS','ja-JP')` で `en-US` になり、サーバ側 [`UrlPreviewService.ts`](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/web/UrlPreviewService.ts) の `lang ?? 'ja-JP'` フォールバックは発火しない（クエリで明示的に `en-US` が来るため）。

結果として **summaly インスタンスのアクセスログが `Accept-Language: en-US` だらけ**になっており、ja-JP インスタンス + 言語未指定の日本人ユーザー（多数）に対して英語ロケールで scrape が走っている。

## 設計方針（Misskey fork 側で実施）

### 採用案: `MkUrlPreview.vue` で localStorage 生値を直接読み、未設定時は `?lang=` を送らない

```ts
// Before
import { versatileLang } from '@@/js/intl-const.js';
window.fetch(`/url?url=${encodeURIComponent(url)}&lang=${versatileLang}`)

// After
const rawLang = localStorage.getItem('lang');  // null を許容
const qs = rawLang ? `&lang=${encodeURIComponent(rawLang)}` : '';
window.fetch(`/url?url=${encodeURIComponent(url)}${qs}`)
```

これで:
- **言語設定済みユーザー**: 設定値（`ja-JP` / `en-US` / `ko-KR` 等）がそのまま summaly に渡る → 既存挙動と同等
- **未設定ユーザー**: `?lang=` 自体が無い → サーバ側 `UrlPreviewService.ts` の `lang ?? 'ja-JP'` フォールバックが**やっと**発火、summaly に `ja-JP` が渡る

### 別案（不採用）

- **A. `config.ts` のハードコード修正**: `?? 'en-US'` → `?? null`
  - 影響範囲が広すぎる（`intl-const.ts` の `dateTimeFormat` / `numberFormat` / `versatileLang` 等、UI 全体の locale 計算に波及）
  - upstream に出す価値はあるが本対応のスコープでは過大
- **B. summaly 側の TOML で `defaultLang` を強制上書き**:
  - インスタンス管理者が「うちは ja-JP に強制したい」をサーバ側で設定できる
  - **ユーザーが en を希望しているケースを潰す**ので、A よりさらに副作用が大きい
  - 本対応で解決できるなら summaly 側は手を入れない方が綺麗

## 実装ステップ（Misskey fork 側）

> 本リポでは実施しない。**完了状況をトラッキングするためのチェックリスト**。

- [ ] `MkUrlPreview.vue` の `versatileLang` import を `MkUrlPreview` 内に閉じた `localStorage.getItem('lang')` 読み出しに置換
- [ ] 同様の経路（もしあれば: `MkLink.vue` / `MkNoteDetailed.vue` 等で別途 url preview を fetch している箇所）も確認
- [ ] Misskey fork の test / lint / build を回す
- [ ] 自分のインスタンスにデプロイ
- [ ] summaly 側のアクセスログで「未設定ユーザー由来の `lang=en-US`」が消えた / `lang=ja-JP` (サーバフォールバック由来) になったことを確認
- [ ] **オプション**: upstream (misskey-dev/misskey) への PR を投げて議論

## 完了条件 (Definition of Done)

- 自分のインスタンスでログ未設定ユーザーが note を開いたとき、summaly 側のログで `?lang=en-US` が消えるか有意に減る
- 言語設定済みユーザーは設定値がそのまま流れる（既存挙動）
- summaly 側のコード・設定は **一切変更しない**

## summaly 側で何かすべきか

**現時点では No**。

将来「Misskey 以外のクライアント（他の Fediverse 実装等）からの呼び出しで同種の問題が再発したら」TOML `[summaly] defaultLang` を別 Plan として検討する。本リポではそのときに別 phase を起こす。

## 参考（lang 関連）

- [misskey-dev/misskey: frontend-shared/js/config.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/config.ts)（en-US ハードコード元凶）
- [misskey-dev/misskey: frontend-shared/js/intl-const.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/intl-const.ts)（versatileLang 経路）
- [misskey-dev/misskey: MkUrlPreview.vue](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend/src/components/MkUrlPreview.vue)（実際の fetch コール）
- [misskey-dev/misskey: UrlPreviewService.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/web/UrlPreviewService.ts)（サーバ側フォールバック）

---

## 2. summaly の `error.category` を受け取って分岐表示

> 関連 issue: [riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)
> 連携先: 本リポの [phase11.2](phase11.2-error-category.md)（summaly 側 API 拡張）

### 目的

phase11.2 で summaly が `{ error: { category, message, name, statusCode? } }` を返すようになるが、Misskey 側がそれを表示に使わなければユーザー体験は変わらない。Misskey fork で受け取って分岐表示する。

### 実装ステップ（Misskey fork 側）

- [ ] `UrlPreviewService.ts` の catch ブロックで summaly レスポンスの `error.category` を受け取り、`URL_PREVIEW_TIMEOUT` / `URL_PREVIEW_BOT_BLOCKED` / `URL_PREVIEW_NOT_FOUND` 等のサブコードを `ApiError` の `id` に乗せる
- [ ] `MkUrlPreview.vue` でカテゴリ別メッセージを `i18n.ts` から取得して出し分け（`failedToPreviewUrl` だけだったのを `failedToPreviewUrl_timeout` / `_botBlocked` / `_notFound` 等に分岐）
- [ ] フォールバック: 未知の `category` または旧 summaly（`category` を返さない）に対しては従来の `failedToPreviewUrl` を維持

### 完了条件

- 自分のインスタンスで bot block サイト / 404 / タイムアウトの URL を貼ったとき、それぞれ別メッセージが出る

---

## 3. Amazon プレビュー失敗の切り分け（riin-summaly#1）

> 関連 issue: [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1)

### 状況

- 例 URL `https://amzn.asia/d/07Bh8rNE` は **本 fork (riin-summaly) 単体では成功**（phase9.1 の HEAD→GET fallback で `www.amazon.co.jp/dp/...` に解決され、amazon プラグインが ATH-102USB のタイトル/description を取得）
- 一方 `misskey.systems` の `/url?url=...&lang=ja-JP` で同じ URL を叩くと **`URL_PREVIEW_FAILED` (id `09d01cb5-53b9-4856-82e5-38a50c290a3b`) が返る** ← Misskey 由来のエラーで確定
- このエラーは [`UrlPreviewService.ts`](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/web/UrlPreviewService.ts) の catch ブロックでのみ投げられる固定 ID

### 結論（最有力）

**misskey.systems が使っている summaly は upstream `@misskey-dev/summaly@5.x` で、phase9.1 (HEAD→GET fallback) を持っていない**。

- amzn.asia は HEAD に 404 を返す → upstream summaly は catch して `actualUrl = url`（短縮 URL のまま）で続行
- amazon プラグインの `test()`（`www.amazon.{com,co.jp,...}`）にマッチしない
- 汎用パス `general()` で `amzn.asia` ページを scrape → 何も取れない or `failed summarize` を throw
- Misskey の catch でつかんで `URL_PREVIEW_FAILED`

つまり **本 fork の summaly に置き換えれば解決する**。misskey.systems で再現したのはたまたま上流バージョンを動かしているからで、Misskey クライアントの `lang` ハードコードや `urlPreviewTimeout` 等は無関係。

### 検証ステップ

- [ ] **本 fork (riin-summaly) を自分の Misskey インスタンスに繋ぎ替えて**（npm link または `urlPreviewSummaryProxyUrl` で本 fork が動いているサーバを指す）、同 URL を貼ってプレビューが出るか確認
- [ ] 出れば「summaly のバージョン違い」が原因確定 → [riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1) にコメントして close
- [ ] 出なければ別の切り分け候補に進む（下表）

### 副次的な切り分け候補（上記で解決しない場合）

| 候補 | 確認方法 |
|:--|:--|
| Misskey の `summary.url` が `http://` / `https://` で始まらない判定で弾いている | `UrlPreviewService.ts` の該当チェック箇所にログ |
| `summary.player.url` の検証で弾いている | 同上 |
| `urlPreviewTimeout` が短すぎる（amzn.asia は GET fallback で 4 秒以上かかる） | Misskey の preview timeout 設定値を確認 |
| Misskey クライアントの `lang=en-US` で Amazon が違う反応 | 本 fork の dev サーバで `?lang=en-US` を試す |

### summaly 側で何かすべきか

**最有力ケース（バージョン違い）なら No**: 本 fork で既に対応済み。

副次切り分けで他の原因が出てきたら別 phase を起こす。
