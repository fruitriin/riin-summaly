# SPA + JavaScript 動的 OGP 注入は summaly では救援不可

## 課題

一部の SPA サイトは「サーバから返す HTML には OGP meta が無い」「ブラウザで JavaScript を
実行した後の DOM にだけ OGP meta が挿入される」という実装をしている。具体的には
`react-helmet` / `vue-meta` 等のクライアントサイド head 管理ライブラリを使って
`<head>` を実行時に書き換えている。

実例: **ニトリネット (`nitori-net.jp/ec/product/...`)** (2026-05-06 確認)

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

## なぜ救援不可か

| 経路 | ニトリでの結果 |
|---|---|
| HTML scraping (curl_cffi + chrome120 impersonate) | 200 + 15KB SPA shell、OGP **0 件** |
| 公式 JSON API 直叩き (`/occ/v2/sapnitori/products/...`) | 403 Access Denied (Akamai 配下) |
| SNS bot UA prerender (`facebookexternalhit/1.1` + chrome120 impersonate) | HTTP/2 INTERNAL_ERROR (UA 不一致で TLS bot 検知発火) |

3 経路すべて壁。**JS 実行が必要だが summaly のスコープ外**:

- Playwright / Puppeteer / Chrome DevTools Protocol 等の実ブラウザレンダリング基盤が必要
- メモリ・レイテンシ・運用コストすべてが summaly の射程外 (10 倍以上のリソース消費)
- そもそも「**JS 動的 OGP 注入は実装ミス**」なのでサイト側に直してもらうのが筋

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

## 関連

- skill `/url-preview-check` — fail mode I として組み込み済
- 関連 fail mode H: TLS layer 切断 (静的 HTML には OGP がある場合、curl_cffi で救援可能 = yodobashi パターン)
- phase12.5: curl_cffi (libcurl-impersonate) 統合 (fail mode I を切り分ける道具にもなる — 静的 HTML の中身を確実に見れる)
