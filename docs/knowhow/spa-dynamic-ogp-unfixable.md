# SPA + JavaScript 動的 OGP 注入は summaly では救援不可

> **2026-05-10 第 2 例: monotaro (モノタロウ) も fail mode J 確定**: phase18 hedge race
> + pino ログ拡張 (commit 206e646 / f485d77) で各経路の error message を本番 journalctl
> から取れるようになり、monotaro の各経路を確定:
>
> | 経路 | error | 解釈 |
> |---|---|---|
> | `default` (SummalyBot UA + Vultr IP) | `Timeout awaiting 'socket' for 20000ms` | TLS layer 切断 |
> | `fallback_ua` (`facebookexternalhit/1.1` + Vultr IP) | 同上 | UA 替えても同じ TLS 切断 |
> | `proxy` (CF Workers AS13335) | `403 Forbidden` (Worker 側 ALLOWED_DOMAINS 撤廃後は HTTP/2 切断 / 404) | CF AS13335 IP も block 対象 |
> | `curl_cffi` (chrome120 偽装 + Vultr IP) | `curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR` | **TLS 偽装しても Vultr IP で別途切断** |
>
> ローカル Mac (家庭 IP) からは curl_cffi (chrome120) で 200 + 完璧な OGP が取れるのに、
> **本番 Vultr Tokyo IP からは TLS 偽装でも切断される** = ニトリと同型の datacenter IP
> 全般 block (fail mode J) パターン。HTML 経由のシンプル OGP サイトであっても datacenter IP
> 利用者には preview 取得不可、という新事例。
>
> **summaly のスコープでは救援不可**。Plan / e2e シナリオでは「UNUSABLE 期待」として整理し、
> Misskey 側の URL のみフォールバック表示に頼る。

> **2026-05-10 確定 (二転三転後)**: ニトリは当初 fail mode I (SPA + JS 動的 OGP) として
> 「救援不可」と整理 → phase15.4 で公式 JSON API 発見により「家庭用 IP からは curl_cffi
> 経由で救援可能」と判明 → 本番 Vultr Tokyo IP からは TLS HTTP/2 INTERNAL_ERROR、
> CF Workers proxy (AS13335) 経由でも 520 Web Server Returns Unknown Error が返る現象を
> 観測し、**datacenter IP 全般が Akamai 系で TLS layer block されている (fail mode J)** と
> 確定。summaly のスコープでは救援不可。
>
> **現状**: `src/plugins/nitori.ts` のコード自体は残す (家庭用 IP / library 直接利用者は
> 引き続き使える)。`config.example.toml` 等の `[plugins].allowed` からは外し、デフォルトで
> 無効化。本番 (Vultr) で運用しているプロジェクトでは効果が無いことを明示。
>
> **教訓 1 (隠れ JSON API 探索)**: 「fail mode I 確定」と判定する前に **隠れ JSON API
> 探索** を必ず 1 段挟むこと。SAP Commerce / Salesforce Commerce / Shopify / Magento 等の
> **EC エンジン**は標準的に商品詳細用の JSON API を晒しており、OCC / Storefront API /
> Admin API 等の慣例 path を ブラウザの DevTools Network タブで検索することで発見できる
> 場合が多い。
>
> **教訓 2 (datacenter IP block の早期切り分け = 新 fail mode J)**: ローカルで動いた
> curl_cffi が本番で動かないとき、TLS フィンガープリントの問題ではなく ASN/IP-based の
> block の可能性が高い。yodobashi (TLS layer block) との違いは **「TLS フィンガープリントを
> 偽装すれば家庭用 IP からは通る」までは同じだが、yodobashi は datacenter IP も TLS 偽装で
> 通るのに対し、ニトリは datacenter IP 全般が block されている**。CF Workers (AS13335) は
> 多くの Akamai 配下サイトで通るが、ニトリのような厳格運用サイトでは通らない。
>
> **対処パターン**: residential proxy (BrightData / Smartproxy / Soax 等の商用サービス) が
> 必要だが summaly の運用コスト的にスコープ外。Playwright モード (phase15.1) を待つか、
> 別 ASN の datacenter (家庭用 IP に近い ISP の VPS) からの egress を試すかの選択になる。

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

## ニトリの救援断念 (phase15.4 + Followup #1, #2)

ニトリは fail mode I の代表例として「救援不可」と整理されていたが、2026-05-10 のオーナー
情報提供で **`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`
(SAP Commerce Cloud OCC API)** が **完璧な構造化データ** を返すことが判明した。

ただし JSON API 自体も **TLS layer block 配下** にあり、`SummalyBot` / `facebookexternalhit` /
`Twitterbot` などの UA で叩くと HTTP/2 INTERNAL_ERROR で切断される。Chrome JA3 を curl_cffi で
偽装することで **家庭用 IP (一般 ISP / NAT) からは唯一通る**。phase15.4 ではこの経路で実装した
が、本番 Vultr Tokyo からのデプロイで以下の追加 fail を観測した:

### 経路ごとの実機検証結果 (2026-05-10)

| 経路 | 結果 | 備考 |
|---|---|---|
| ローカル MacOS (家庭 IP) + curl_cffi (chrome120 / 131) | ✅ 200 OK + JSON 4.5KB | Followup #1 で `--header Accept:application/json` 追加後 |
| 本番 Vultr Tokyo + curl_cffi | ❌ HTTP/2 INTERNAL_ERROR (TLS 切断) | Akamai が Vultr ASN を弾く |
| 本番 → CF Workers proxy (AS13335) | ❌ 520 Web Server Returns Unknown Error | Akamai が CF AS13335 も弾く (CF が origin から異常終了を受け取り 520 を生成) |
| 本番 → curl_cffi (Vultr 上) → JSON API | ❌ 同上 (Vultr IP から出るので結局同じ) | TLS 偽装してても出口 IP が問題 |

→ **fail mode J 確定: datacenter IP 全般 block**。residential proxy (BrightData / Smartproxy 等の
商用サービス) が必要だが summaly の運用コスト的にスコープ外。

### 現状の運用判断

- `src/plugins/nitori.ts` の **コードと登録は残す** (家庭用 IP / library 直接利用者は引き続き使える、
  Followup #1 の curl_cffi CLI `--header` 機構は他の JSON API ケース用に資産として有用)
- `config.example.toml` / `docs/deploy-examples/summaly-config.example.toml` の `[plugins].allowed`
  からは **コメントアウト形式で外す** + 「fail mode J で本番運用は救援不可」を明記
- `data/domain-strategy-bootstrap.jsonl` から `nitori-net.jp → curl_cffi` を削除 (allowlist
  自動導出されないことで誤動作回避)
- `tools/cf-proxy-worker/wrangler.toml` の `ALLOWED_DOMAINS` から `nitori-net.jp` を削除

### Plan B 候補 (将来の検討事項)

1. **Playwright モード** ([phase15.1](../plans/phase15.1-playwright-fallback.md)): 実ブラウザで叩く。
   ただし Playwright も Vultr IP から出るため、IP block が解消するわけではない。**ただしブラウザ
   フィンガープリント + 動的挙動の完全再現で Akamai がブラウザと判定する可能性は curl_cffi より高い**
   (要実機検証)
2. **別 ASN の datacenter VPS (家庭 ISP に近いやつ)**: ニトリで実際に通る ASN は実験で見つける
   しかない。維持コスト上昇 + 構成複雑化のトレードオフ
3. **Residential proxy 商用サービス連携**: BrightData / Smartproxy / Soax 等。月額サブスクリプション
   の運用コストが summaly のスコープ外

### 教訓 1: fail mode I 判定の前段に「隠れ JSON API 探索」を 1 段入れる

「ブラウザでは見えるのに HTML スクレイプでは取れない」を観測したら、即 fail mode I 結論にせず:

1. **DevTools Network タブで XHR / fetch を監視** — 商品ページを開いたときに走る JSON 系
   リクエストを確認 (`product-details` / `products/<id>` / `cart-items` 等の慣例 path)
2. **EC エンジン共通 path を試す** — SAP Commerce OCC (`/occ/v2/<tenant>/products/<sku>`),
   Salesforce Commerce (`/dw/shop/v22_X/products/<sku>`), Shopify Storefront API (`/api/.../products/<handle>`),
   Magento REST (`/rest/V1/products/<sku>`) 等の慣例 URL を Chrome UA で `curl` してみる
3. **curl_cffi を使うか判断** — JSON API も TLS / UA layer block 配下なら curl_cffi 経由
   (ニトリパターン)、素通しなら通常 `getJson` (npmjs パターン)

### 教訓 2: ローカルで通っても本番 (datacenter IP) で同じとは限らない

curl_cffi は **TLS フィンガープリント** だけ偽装する。**送信元 IP の ASN は偽装しない**。
yodobashi では「Chrome JA3 偽装」で TLS 切断が解消するが、これは「Akamai が UA + JA3 だけ
見ている」のが前提。ニトリは更に厳格で **送信元 ASN まで見ており、datacenter ASN は全部弾く**。

実装フェーズで **本番 IP からの動作確認を Plan の Step に組み込む** べき。具体的には:

- Plan Step (E2E 検証時) に「本番 ssh 上で `uv run fetch <api>` を実行して 200 OK を確認」を必須化
- ローカル検証だけで「OK」判断しない
- skill `/url-preview-check` の Phase 2 で「本番 ssh 経由 curl 検証」を組み込む (既存)

## fail mode J: datacenter IP 全般 block

「ブラウザでは見えるのに、TLS 偽装して datacenter IP から叩いても通らない」パターン。
yodobashi (fail mode H) との違い:

| | fail mode H (yodobashi) | fail mode J (nitori) |
|---|---|---|
| 家庭用 IP + 通常 UA | ❌ TLS 切断 | ❌ TLS 切断 |
| 家庭用 IP + curl_cffi (Chrome JA3) | ✅ 通過 | ✅ 通過 |
| Vultr IP + curl_cffi | ✅ 通過 | ❌ TLS 切断 |
| CF Workers proxy (AS13335) | ✅ 通過 (yodobashi なら) | ❌ 520 |

→ **H は TLS フィンガープリント検査だけ**、**J は ASN-based block も併用**。J は summaly の
スコープでは救援困難。

### 切り分けチェックリスト (新サイト遭遇時)

```bash
# 1. 家庭用 IP からの基本確認
curl -A "Mozilla/5.0 ...Chrome/131..." "$URL"  # 200 OK ?

# 2. 家庭用 IP + curl_cffi
uv run fetch "$URL" --impersonate chrome120  # 200 OK ?

# 3. 本番 Vultr などの datacenter IP から同じことを試す
ssh prod "cd /root/summaly/tools/curl-cffi-fetcher && uv run fetch '$URL' --impersonate chrome120"

# 4. CF Workers proxy 経由 (sqex の経路を流用)
node scripts/check-via-worker.mjs  # url を埋めて

# 1=OK, 2=OK, 3=NG, 4=NG → fail mode J 確定 (residential proxy 必要)
# 1=NG, 2=OK, 3=OK, 4=OK → fail mode H (yodobashi パターン、curl_cffi で救援可)
# 1=NG, 2=NG, 3=NG, 4=NG → 真の fail mode I (JS 必須、Playwright)
```

## 関連

- skill `/url-preview-check` — fail mode I + J を組み込み (J は今回の発見で追加)
- 関連 fail mode H: TLS layer 切断 (datacenter IP も curl_cffi で通る、yodobashi)
- 関連 fail mode J: TLS layer 切断 + datacenter IP 全般 block (nitori、本セクション)
- phase12.5: curl_cffi (libcurl-impersonate) 統合
- phase15.4: ニトリプラグイン (家庭用 IP では救援可、本番 Vultr では fail mode J で実用不能)
- phase15.1: Playwright モード (要 residential 等価環境がなければ J も完全救援は難しい)
