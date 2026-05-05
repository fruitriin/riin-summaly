# External — Misskey fork: UrlPreview の `lang` を localStorage 生値ベースに変更

> 状態: **計画のみ / summaly のスコープ外**（Misskey fork 側で対応）
> 種別: クロスリポ連携 / 観測指標改善
> サイズ: **S**
> 関連: [phase10.1 パース失敗ログ](phase10.1-parse-failure-log.md)（アクセスログ調査の発端）、本リポ README の compare 表

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

## 参考

- [misskey-dev/misskey: frontend-shared/js/config.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/config.ts)（en-US ハードコード元凶）
- [misskey-dev/misskey: frontend-shared/js/intl-const.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend-shared/js/intl-const.ts)（versatileLang 経路）
- [misskey-dev/misskey: MkUrlPreview.vue](https://github.com/misskey-dev/misskey/blob/develop/packages/frontend/src/components/MkUrlPreview.vue)（実際の fetch コール）
- [misskey-dev/misskey: UrlPreviewService.ts](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/web/UrlPreviewService.ts)（サーバ側フォールバック）
