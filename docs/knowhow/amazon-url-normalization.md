# Amazon URL 正規化と短縮 URL 対応

> phase12.1 followup #2〜#4 で蓄積した、Amazon プラグインに固有の URL ハンドリング知見。
>
> Cloudflare Workers proxy (phase12.1) で IP block を回避できるようになったが、**proxy 経由でも
> Amazon は URL の形式によって違う応答を返す** ため、URL 正規化を入れないと proxy が機能しても
> 取得失敗するケースが残った。

## 結論 (TL;DR)

Amazon URL は次の 3 つの正規化を入れる:

1. **`/dp/<ASIN>` の canonical 形に揃える** — query / fragment / SEO slug を全部削る
2. **hostname を `www.` 付きに揃える** — bare `amazon.co.jp` を Amazon が 301 でリダイレクトする手間を先回り
3. **短縮 URL (`amzn.asia` 等) は 2 段取得** — final URL から ASIN 抽出 → canonical で再取得

実装: [src/plugins/amazon.ts](../../src/plugins/amazon.ts) の `normalizeAmazonUrl` + `summarize` の 2 段ロジック。

## 背景: Amazon は URL 形式で応答が変わる

CF Workers 経由でも次の挙動が観測された (phase12.1 followup):

| URL 形式 | Vultr 直叩き | CF Workers 経由 | 備考 |
|---|---|---|---|
| `www.amazon.co.jp/dp/B0C4LRBFX6` (canonical) | 500 | **200 + フル HTML 2.6 MB** | 救援成功の標準形 |
| `www.amazon.co.jp/<slug>/dp/B0FRSGC73Z/?ref_=...&pd_rd_w=...` | 500 | **500** ← Worker 経由でも弾かれる | 長 query が bot detection の追加シグナル |
| `amazon.co.jp/dp/<asin>` (bare hostname) | 500 | 200 (リダイレクト追跡で www.* に到達) | summaly 側 plugin が match しないバグあり |
| `amzn.asia/d/<id>` (短縮 URL) | **200 + preview HTML 軽量版** | 200 | 「成功」と誤判定されて proxy 救援に乗らない |

つまり **proxy が IP 層を救援しても、URL 層の正規化が無いと取れない**。

## 正規化 1: `/dp/<ASIN>` canonical 化

```ts
export function normalizeAmazonUrl(url: URL): URL {
  const dpMatch = /\/dp\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
  const gpMatch = /\/gp\/product\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
  const asin = (dpMatch ?? gpMatch)?.[1];
  if (asin == null) return url;
  const normalized = new URL(url.href);
  if (!normalized.hostname.startsWith('www.')) {
    normalized.hostname = 'www.' + normalized.hostname;
  }
  normalized.pathname = `/dp/${asin.toUpperCase()}`;
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}
```

### 設計の決め手

- **ASIN は `[A-Z0-9]{10}` の固定長**: `{10}` 厳密マッチ + `(?:\/|$)` 境界チェックで偶然的な英数字列やネストパスに誤マッチしない
- **`/dp/` を `/gp/product/` より優先**: 標準形が `/dp/`、`/gp/product/` は古い形式
- **`toUpperCase()` で大文字化**: ASIN 仕様は大文字英数字のみ、defensive normalization
- **元 URL を mutate しない**: `new URL(url.href)` でコピーしてから書き換える

### 副作用なし

referral tracking の query (`?_encoding=UTF8&pd_rd_w=...&ref_=...`) は商品ページの内容に**影響しない**。Amazon は ASIN ベースで内容を決定するため、query を全部削っても同じページが返る。実証済み。

## 正規化 2: bare hostname → `www.` 付き

`amazon.co.jp` (bare) と `www.amazon.co.jp` は両方 Amazon が運用しているが、**summaly の plugin matching は最初の `actualUrl` のホストを見る**ため、bare → www 変換を summaly 側で先回りしないと plugin が match しない。

```ts
const AMAZON_HOST = /^(?:www\.)?amazon\.(?:com|co\.jp|ca|com\.br|com\.mx|co\.uk|de|fr|it|es|nl|cn|in|au)$/;
```

`^...$` の anchored 形にすることで `aws.amazon.com` 等の AWS サブドメインを誤マッチさせない（plugin の責務は商品ページ専用）。

実証: phase12.1 followup #3 で `amazon.co.jp/dp/B0GFN8129G/ref=sspa_dk_detail_5` が **general パスに流れていた** ことが本番ログの stack trace `at general (...general.ts:181)` から判明。

## 正規化 3: 短縮 URL の 2 段取得

`amzn.asia/d/<id>` は path から ASIN を抽出できない (`0faScmAn` は短縮 ID で ASIN ではない)。さらに **Vultr から GET すると Amazon は 301 リダイレクトを返さず 200 + 軽量 preview HTML** を返してしまうため、`resolveRedirect` も `www.amazon.co.jp` に到達しない。

対処: amazon plugin の summarize で 2 段取得:

```ts
if (AMAZON_SHORT_HOST.test(url.hostname) && normalized.href === url.href) {
  // 1段目: 短縮 URL を scpaping (proxy fallback も効く)
  const firstRes = await scpaping(url.href, opts);
  // got.response.url はリダイレクト解決後の最終 URL
  const finalUrl = new URL(firstRes.response.url);
  const reNormalized = normalizeAmazonUrl(finalUrl);
  if (reNormalized.href !== finalUrl.href) {
    // ASIN 抽出成功 → canonical で再 scpaping
    normalized = reNormalized;
  } else {
    // ASIN 抽出失敗 (preview HTML のまま) → 1段目 HTML をそのままパース
    return parseAmazonHtml(firstRes.$);
  }
}
```

### 「ASIN 抽出失敗時のフォールバック」設計

- 短縮 URL が proxy 経由なら `final URL = www.amazon.co.jp/.../dp/<asin>?...` に解決される (リダイレクト follow される)
- final URL に ASIN が含まれていれば canonical 化して**実商品ページを取得** (タイトル / サムネ満載)
- ASIN が抽出できない (= preview HTML が `amzn.asia` のままのケース) → **1段目の preview HTML をそのままパース**

amazon plugin から general パスへのフォールバックは存在しないため、薄い結果でも summary を返す必要がある。preview HTML には `og:title="Amazon"`、`og:image=previewdoh/amazon.png` 程度しか無いが、ゼロ情報よりはマシ。

## OG meta tag fallback の補強

`parseAmazonHtml()` は商品ページの `#title` / `#productDescription` / `#landingImage` を見るが、preview HTML にはこれらの DOM 要素が**無い**。OG meta tags を fallback として見るように補強:

```ts
const title = $('#title').text() || $('meta[property="og:title"]').attr('content') || '';
const description =
  $('#productDescription').text() ||
  $('meta[property="og:description"]').attr('content') ||
  $('meta[name="description"]').attr('content');
const thumbnail =
  $('#landingImage').attr('src') ||
  $('meta[property="og:image"]').attr('content');
```

商品ページで取れる場合は OG meta は無視（DOM 要素が優先）。preview HTML のときだけ OG meta が拾われる。

## 落とし穴

### Amazon の `og:description="Amazon"` という汎用文字列

商品ページや preview HTML の `og:description` が "Amazon" という単なる**文字列**になっているケースがある。fallback で拾うと `description: "Amazon"` という意味のない値が返る。

対処オプション (未実装、将来検討):
- 5 文字以下や ASCII のみの og:description は捨てる
- "Amazon" / "amazon.co.jp" 等のサイト名と同一の値は捨てる

現状は許容範囲（Misskey UI 側で薄い description は折りたたむ等の処理がある）。

### preview HTML の `og:image` は `previewdoh/amazon.png` 一律

preview HTML が出るケースは商品個別の画像が取れず Amazon ロゴ画像が返る。これも `thumbnail` として返ると Misskey カードのサムネ枠に Amazon ロゴだけが出る。実用上は「Amazon の何か」と分かるので OK だが、商品個別の画像が欲しければ 2 段取得を成功させる必要がある（= proxy 経由で final URL が `www.amazon.co.jp/dp/<asin>` に解決される必要がある）。

### `redirect: 'follow'` の allowlist 再検証は必須

CF Workers 経由で `amzn.asia/d/xxx` を fetch すると、Worker は内部で redirect follow して `www.amazon.co.jp/...` に到達する。**Worker 側で最終 URL も allowlist 再検証**しないと `amzn.asia` allowlist だけで「任意の URL に redirect されたら通す」open proxy になる。

実装は [tools/cf-proxy-worker/src/index.ts](../../tools/cf-proxy-worker/src/index.ts) の W-1 fix で対応済み。

## 関連

- [cf-workers-outbound-proxy.md](cf-workers-outbound-proxy.md) — phase12.1 の outbound proxy 設計と認証パターン
- [outbound-ip-reputation.md](outbound-ip-reputation.md) — Vultr/Amazon の IP block 実証データ
- [bot-block-ua-retry.md](bot-block-ua-retry.md) — UA レイヤ救援 (phase11.9)
- [docs/plans/phase12.1-cf-workers-proxy-fallback.md](../plans/phase12.1-cf-workers-proxy-fallback.md) — Plan
- [src/plugins/amazon.ts](../../src/plugins/amazon.ts) — 実装
- [test/plugin-amazon.test.ts](../../test/plugin-amazon.test.ts) — テスト
