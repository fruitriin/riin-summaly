# SPA + JavaScript 動的 OGP 注入は summaly では救援不可

> **2026-05-10 重要更新**: 当初「ニトリ (`nitori-net.jp/ec/product/...`)」を fail mode I の代表例
> として「救援不可」と整理していたが、phase15.4 で**公式 SAP Commerce OCC API
> (`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`) を curl_cffi
> 経由で直叩きすると完璧な構造化データが返る** ことが判明し、ニトリは救援可能となった
> (詳細は本ドキュメント末尾「ニトリの救援 (phase15.4)」セクションと
> [docs/plans/phase15.4-plugin-nitori.md](../plans/phase15.4-plugin-nitori.md))。
>
> **教訓**: 「fail mode I 確定」と判定する前に **隠れ JSON API 探索** を必ず 1 段挟むこと。
> SAP Commerce / Salesforce Commerce / Shopify / Magento 等の **EC エンジン** は標準的に
> 商品詳細用の JSON API を晒しており、OCC / Storefront API / Admin API 等の慣例 path を
> ブラウザの DevTools Network タブで検索することで発見できる場合が多い。
>
> ニトリ救援後も **fail mode I という分類自体は健在** で、「ブラウザでは見えるのに
> サーバ HTML には OGP が無い」という現象 + 「JSON API も塞がっているか存在しない」場合に
> 真の救援不可となる。本ドキュメントは「JSON API があれば救援できる」「無ければ Playwright
> モード (phase15.1) または救援不可」という両面を扱う。

## 課題

一部の SPA サイトは「サーバから返す HTML には OGP meta が無い」「ブラウザで JavaScript を
実行した後の DOM にだけ OGP meta が挿入される」という実装をしている。具体的には
`react-helmet` / `vue-meta` 等のクライアントサイド head 管理ライブラリを使って
`<head>` を実行時に書き換えている。

実例: **ニトリネット (`nitori-net.jp/ec/product/...`)** (2026-05-06 確認、HTML 経路の挙動)

```bash
# サーバが返す HTML (curl_cffi + chrome120 impersonate)
$ uv run fetch https://www.nitori-net.jp/ec/product/2116100013272s/ \
  | python3 -c "import json,sys,re; d=json.load(sys.stdin); body=d['body']; print('len:', len(body)); print('og tags:', len(re.findall(r'<meta[^>]+og:', body)))"
len: 15059
og tags: 0

# ブラウザで開いた後の DOM (DevTools で確認)
<meta property="og:title" content="[Nクール ぬいぐるみ ニシキアナゴ L(BK26)]通販">
<meta property="og:description" content="...">
<meta property="og:image" content="...">
<meta property="og:url" content="...">
```

## なぜ HTML 経路だけでは救援不可か

| 経路 | ニトリでの結果 |
|---|---|
| HTML scraping (curl_cffi + chrome120 impersonate) | 200 + 15KB SPA shell、OGP **0 件** |
| 公式 JSON API 直叩き (`/occ/v2/sapnitori/products/...` — **古い path**) | 403 Access Denied (Akamai 配下) |
| 公式 JSON API 直叩き (`/occ/v2/nitorinet/nitori/products/...` — **2026-05-10 発見の現用 path**) | **200 + 完璧な JSON (4.5KB)、ただし TLS layer block で `SummalyBot` UA は弾かれるため curl_cffi 経由が必須** |
| SNS bot UA prerender (`facebookexternalhit/1.1` + chrome120 impersonate) | HTTP/2 INTERNAL_ERROR (UA 不一致で TLS bot 検知発火) |

HTML 経路のみで判断していた頃は 3 経路全壁で「JS 実行が必要 = summaly スコープ外」と結論
していた。**JSON API の現用 path 発見後はニトリは救援可能** (phase15.4)。

それでも以下の前提は変わらない:
- Playwright / Puppeteer / Chrome DevTools Protocol 等の実ブラウザレンダリング基盤は summaly の
  メモリ・レイテンシ・運用コストの射程外 (10 倍以上のリソース消費、phase15.1 で別構成として検討中)
- 「**JS 動的 OGP 注入は SNS share プレビューのためには無意味な実装**」という事実は変わらず
  (下表参照)、サイト側に直してもらうのが本筋

## 「実装ミス」と言い切る理由

OGP / Twitter Card を **JavaScript で `<head>` に動的挿入する実装は完全に意味が無い**。
SNS bot は誰一人として JS を実行しない:

| Bot | JS 実行 |
|---|---|
| Twitterbot/1.0 | ❌ |
| facebookexternalhit/1.1 | ❌ |
| Slackbot-LinkExpanding 1.0 | ❌ |
| Discordbot/2.0 | ❌ |
| LinkedInBot/1.0 | ❌ |
| Mastodon (各インスタンスの fetch) | ❌ |
| Misskey (summaly 経由) | ❌ |

つまり **react-helmet 等で head を書き換える機能は SNS share プレビューには一切寄与しない** 。
ニトリが share button を UI に置いていても、Twitter / Facebook / Misskey 等で同 URL を貼っても
プレビューは展開されない (URL リンクのみ表示)。

## 対処パターン

### 対処不可 (推奨)

- skill `/url-preview-check` の **fail mode I** として記録し、Misskey 側で URL のみフォールバック表示を許容
- Misskey 上で「特定サイトのプレビューが取れない」と苦情が来たら、サイト側の実装ミスである旨を案内

### サイト側の正攻法 (= サイトに要望する内容)

1. **SSR (Server-Side Rendering)** — Next.js / Nuxt / Remix 等で `<head>` を Node 側で生成して static HTML に含める
2. **Prerender service** — `prerender.io` / `Rendertron` 等を Akamai/Cloudflare の前段に置いて bot UA だけブラウザレンダリング結果を返す
3. **Static OGP injection** — 商品ページの初期 HTML に `<meta property="og:title">` だけサーバが埋め込む (商品 DB から bot 用に最小限)

どれも数日〜数週間の作業で実装可能だが、サイト運営者の優先順位次第。

## 切り分けチェックリスト

新規サイトで「ブラウザでは見えるのに summaly で取れない」と相談されたら:

```bash
# 1. サーバ HTML の OGP 確認
URL="https://example.com/page"
uv run fetch "$URL" 2>/dev/null \
  | python3 -c "import json,sys,re; d=json.load(sys.stdin); body=d['body']; print('og tags in static HTML:', len(re.findall(r'<meta[^>]+og:', body))); print('body_len:', len(body))"

# 2. ブラウザで開いて DevTools の Elements パネルで `<head>` を確認
# 3. View Source (Cmd+Opt+U) と Inspect で `<head>` 内 OGP 件数を比較
```

判定:
- 静的 HTML: OGP 多数 + ブラウザ DOM: OGP 多数 → fail mode A〜H のいずれか (救援可能性あり)
- 静的 HTML: OGP 0 件 + ブラウザ DOM: OGP 多数 → **fail mode I 確定 (救援不可)**
- 静的 HTML: OGP 0 件 + ブラウザ DOM: OGP 0 件 → サイトが OGP 自体を実装していない (救援不可、要望のみ)

## ニトリの救援 (phase15.4)

ニトリは fail mode I の代表例として「救援不可」と整理されていたが、2026-05-10 のオーナー
情報提供で **`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`
(SAP Commerce Cloud OCC API)** が **完璧な構造化データ** を返すことが判明した。

ただし JSON API 自体も **TLS layer block 配下** にあり、`SummalyBot` / `facebookexternalhit` /
`Twitterbot` などの UA で叩くと HTTP/2 INTERNAL_ERROR で切断される。Chrome 風の UA (`Mozilla/5.0 ...
Chrome/131.0.0.0 ...`) と Chrome JA3 を curl_cffi で偽装することで唯一通る (yodobashi と同じ TLS
layer block パターン + 公式 JSON API の組み合わせ)。

実装は [src/plugins/nitori.ts](../../src/plugins/nitori.ts) で `viaCurlCffi` を直接呼ぶ
hardcode 方式。経路学習キャッシュではなく、`bootstrap.jsonl` の `nitori-net.jp → curl_cffi`
エントリで `curlCffiFallback.domains` allowlist に自動的に含まれる構成 (phase16.3 設計)。

### 教訓: fail mode I 判定の前段に「隠れ JSON API 探索」を 1 段入れる

「ブラウザでは見えるのに HTML スクレイプでは取れない」を観測したら、即 fail mode I 結論にせず:

1. **DevTools Network タブで XHR / fetch を監視** — 商品ページを開いたときに走る JSON 系
   リクエストを確認 (`product-details` / `products/<id>` / `cart-items` 等の慣例 path)
2. **EC エンジン共通 path を試す** — SAP Commerce OCC (`/occ/v2/<tenant>/products/<sku>`),
   Salesforce Commerce (`/dw/shop/v22_X/products/<sku>`), Shopify Storefront API (`/api/.../products/<handle>`),
   Magento REST (`/rest/V1/products/<sku>`) 等の慣例 URL を Chrome UA で `curl` してみる
3. **curl_cffi を使うか判断** — JSON API も TLS / UA layer block 配下なら curl_cffi 経由
   (ニトリパターン)、素通しなら通常 `getJson` (npmjs パターン)

この 3 段を踏むことで「JSON API 経由で救援可能なサイト」を fail mode I と誤判定して諦めることを
構造的に防げる。

## 関連

- skill `/url-preview-check` — fail mode I として組み込み済
- 関連 fail mode H: TLS layer 切断 (静的 HTML には OGP がある場合、curl_cffi で救援可能 = yodobashi パターン)
- phase12.5: curl_cffi (libcurl-impersonate) 統合 (fail mode I を切り分ける道具にもなる — 静的 HTML の中身を確実に見れる)
- phase15.4: ニトリプラグイン (隠れ JSON API + curl_cffi で救援、本セクションの実例)
- phase15.1: Playwright モード (真の fail mode I 救援、JSON API も無い SPA を実ブラウザレンダリングで救援)
