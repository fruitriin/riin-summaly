---
name: url-preview-check
description: |
  特定の URL で summaly のプレビュー生成が動くか調査し、動かない場合の対処方針を決める。
  本番ログから症状特定 → curl で再現テスト → fail mode 分類 → 修正レイヤ選定 → 動作確認の流れ。
  新規プラグイン追加・既存プラグインの URL 形式追加・bot block への対応・preview HTML 詐欺対策など。
  「このサイトで preview が出ない」「新しい短縮 URL に対応したい」「特定商品で title が null になる」等のときに使う。
user_invocable: true
---

# URL プレビュー生成 — 動作確認 + 新規対応スキル

phase11.4 / 11.6 / 11.7 / 11.9 / 12.1 で確立した「動かない URL の切り分け → 適切な layer での修正」の方法論を再利用するための skill。

## 引数

- `$ARGUMENTS`: 調査したい URL 1 件（例: `https://www.amazon.co.jp/dp/B0XXXXXXXX/?ref=...`）。省略時はこのスキルの使い方を表示。

## 全体フロー

```
[症状特定] → [再現テスト] → [fail mode 分類] → [修正レイヤ選定] → [実装] → [動作確認]
   ログ        curl 各種        A〜J             5 layer         + テスト       4-5 URL バリエーション + 本番 IP 実機
```

## テスト用エンドポイント

開発時・本番動作確認時に使う summaly サーバ:

| 環境 | URL pattern | 用途 |
|---|---|---|
| **ローカル dev** | `http://127.0.0.1:3000/api/summaly?url=<encoded>&proxy=1` | `pnpm dev` で起動。proxy fallback の手元再現は `&proxy=1` 追加 (env で `SUMMALY_PROXY_URL` + `SUMMALY_PROXY_SECRET` 設定済みのとき) |
| **本番 (riin-summaly fork)** | `https://summaly.riinswork.space/?url=<encoded>` | デプロイ済み Vultr Tokyo インスタンス。`&t=<任意>` を付けると nginx の前段キャッシュを bypass できる (運用上の cache buster) |
| **CF Workers proxy 直叩き** | `https://summaly-proxy.riinsworkspace.workers.dev/?url=<encoded>` | HMAC または token 認証のヘッダが必要。Worker そのものの動作確認用 (詳細は [tools/cf-proxy-worker/README.md](../../tools/cf-proxy-worker/README.md)) |

呼び出し例:

```bash
# URL を encode してから本番に叩く
URL='https://www.amazon.co.jp/gp/video/detail/B0BX1TYH98/'
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")

# 本番 (cache buster 付き)
curl -sS "https://summaly.riinswork.space/?t=$(date +%s)&url=${ENC}" | jq

# ローカル dev (proxy 機能 ON)
curl -sS "http://127.0.0.1:3000/api/summaly?url=${ENC}&proxy=1" | jq

# 本番ログを並行で観察 (別ターミナル)
# 注: journalctl は環境によって `-o cat` でも `5月 06 21:45 host proc[123]:` プレフィックスが
# 残ることがある + jq の `select(.x | ...)` は null フィールドで parse error になるため、
# `grep ^{` で JSON 行だけ抽出 + `// ""` で null safe 化が安全
ssh summaly 'sudo journalctl -u summaly -o cat -f' \
  | grep --line-buffered -E '^\{' \
  | jq -c 'select(.msg == "summaly error")'
```

## Phase 1: 症状特定 (本番ログから)

本番が稼働中なら **まず pino ログを確認**（phase11.8 で出力するようにしている）:

```bash
# error / warn だけ抽出（amazon を含む URL に絞る例）
# `grep ^{` で JSON 行だけ抽出 (環境により `5月 06 21:45 host proc[123]:` プレフィックスが残る場合あり)。
# `// ""` で null safe 化 (incoming request ログ等で `.url` が無い行を select すると jq が parse error になる)。
sudo journalctl -u summaly -o cat --since "30 min ago" \
  | grep -E '^\{' \
  | jq -c 'select((.url // "") | contains("amazon")) | select((.req.url // "") | contains("amazon"))'

# req.url 経由 (Fastify 「incoming request」ログ) のみ見たい場合
sudo journalctl -u summaly -o cat --since "30 min ago" \
  | grep -E '^\{' \
  | jq -c 'select(.req != null) | select(.req.url | contains("amazon"))'
```

注目するフィールド:

| フィールド | 何が分かるか |
|---|---|
| `err.category` | bot_blocked / origin_error / timeout / parse_error / unsupported_type 等の大分類 |
| `err.message` | "403 Forbidden" / "500 Internal Server Error" / "Rejected by type filter undefined" / "socket hang up" 等の具体シグナル |
| `err.stack` | **どの関数フレーム経由で来たか** — `general` / `<plugin>.summarize` / `scpaping` / `viaProxyWorker` |
| `err.statusCode` | HTTP ステータス |

**stack の関数フレームで原因の 90% は特定できる**:

| stack のフレーム | 推察される原因 |
|---|---|
| `at general (...)` | プラグインがマッチせず汎用パスに流れている (host matching の漏れ) |
| `at <plugin>.summarize (...)` | プラグインは効いているが取得 / パース失敗 |
| `at scpaping (...)` | HTTP 層の問題 (bot block / timeout / SSRF) |
| `at viaProxyWorker (...)` | proxy 経由でも upstream が拒否 |
| `at parseGeneral (...)` | HTML 取得は成功したが OG / title 抽出失敗 (preview HTML 詐欺) |

## Phase 2: 再現テスト (curl)

ローカルから複数 UA / 複数 path で叩き、**Vultr 本番との挙動差** を切り分ける:

```bash
URL='<対象 URL>'

# A) SummalyBot UA (本番デフォルト)
curl -sS -L -A "Mozilla/5.0 (compatible; SummalyBot/5.3.0; +https://github.com/fruitriin/riin-summaly)" \
  -o /tmp/sb.html \
  -w "final=%{url_effective} status=%{http_code} ct=%{content_type} size=%{size_download}\n" \
  "$URL"

# B) ブラウザ UA
curl -sS -L -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36" \
  -o /tmp/br.html \
  -w "final=%{url_effective} status=%{http_code} ct=%{content_type} size=%{size_download}\n" \
  "$URL"

# C) facebookexternalhit UA (phase11.9 fallback UA)
curl -sS -L -A "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" \
  -o /tmp/fb.html \
  -w "final=%{url_effective} status=%{http_code} ct=%{content_type} size=%{size_download}\n" \
  "$URL"

# D) HEAD only (phase9.1 resolveRedirect の挙動再現)
curl -sS -I -L -A "Mozilla/5.0" -w "final=%{url_effective} status=%{http_code}\n" "$URL"

# E) Worker proxy 経由 (phase12.1、HMAC 認証は scripts/check-via-worker 経由が安全)
#    secret を直接 curl に渡さず、scripts/check-nitori-via-worker.mjs を参考に
#    対象 URL を差し替えた検証スクリプトを書く方が事故りにくい (env 経由)。
#    一発で叩きたい場合のみ:
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")
TS=$(date +%s)000
SIG=$(printf '%s\n%s' "$URL" "$TS" | openssl dgst -sha256 -hmac "${SUMMALY_PROXY_SECRET}" -hex | awk '{print $2}')
curl -sS -L -o /tmp/proxy.html \
  -H "x-summaly-sig: $SIG" -H "x-summaly-ts: $TS" \
  -H "x-summaly-forward-ua: Mozilla/5.0" \
  -w "status=%{http_code} ct=%{content_type} size=%{size_download}\n" \
  "${SUMMALY_PROXY_URL}/?url=${ENC}"

# F) curl_cffi (libcurl-impersonate) でローカル MacOS から TLS 偽装 (家庭 IP の挙動)
cd tools/curl-cffi-fetcher && uv run fetch "$URL" --impersonate chrome120 \
  --header "Accept:application/json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('status:', d.get('status'), 'ct:', d.get('content_type'))"

# G) 本番 ssh 経由で同じ curl_cffi を叩く (datacenter IP の挙動)
#    ローカルで OK でも本番 (Vultr 等) で失敗するケース (fail mode J) を切り分けるために必須。
ssh prod 'cd /root/summaly/tools/curl-cffi-fetcher && uv run fetch '"'$URL'"' --impersonate chrome120' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('status:', d.get('status'), 'category:', d.get('category', '-'))"
```

各 HTML から meta タグを抽出して比較:

```bash
for f in /tmp/sb.html /tmp/br.html /tmp/fb.html /tmp/proxy.html; do
  echo "=== $f ==="
  echo "  og:title: $(grep -oE '<meta[^>]*property="og:title"[^>]*>' "$f" | head -1 | head -c 200)"
  echo "  og:image: $(grep -oE '<meta[^>]*property="og:image"[^>]*>' "$f" | head -1 | head -c 200)"
  echo "  <title>: $(grep -oE '<title[^>]*>[^<]+</title>' "$f" | head -1 | head -c 150)"
  echo "  #title: $(grep -c 'id="title"' "$f")"
  echo "  previewdoh (= preview HTML 詐欺シグナル): $(grep -c 'previewdoh' "$f")"
done
```

## Phase 3: Fail mode の分類

curl 結果のパターンから以下のいずれかに分類 (A〜J、加筆順):

### A. UA 文字列で弾く WAF (phase11.9 で対処済み)

- 兆候: SummalyBot UA → `socket hang up` / `connection_dropped`、ブラウザ UA → 200 OK
- 対処: phase11.9 の fallback UA リトライがデフォルトで効く (`[scraping.fallback]`)
- 救援できる比率: 上限あり (約 2/3、IP-based block は救えない)
- 関連 knowhow: [bot-block-ua-retry.md](../../docs/knowhow/bot-block-ua-retry.md)

### B. IP レピュテーション層の遮断 (phase12.1 で対処済み)

- 兆候: あらゆる UA で 5xx / 200 + content-type 欠落 / `Rejected by type filter undefined`、Cloudflare 帯 (Worker 経由) からは 200
- 対処: phase12.1 の proxy fallback。`[scraping.proxy].domains` allowlist にホスト追加 + Worker `wrangler.toml` の `ALLOWED_DOMAINS` も同期更新
- 関連 knowhow: [cf-workers-outbound-proxy.md](../../docs/knowhow/cf-workers-outbound-proxy.md), [outbound-ip-reputation.md](../../docs/knowhow/outbound-ip-reputation.md)

### B'. IP レピュテーション層の遮断・エラーシグナルなし版 (phase12.6 で対処済み)

- **兆候**: 本番サーバから curl すると **HTTP 200 + `text/html;charset=utf-8` + 正規 404 ページボディ** が返る (`<title>404 NOT FOUND</title>`)。`got` レイヤでは何のエラーも発生しない。ローカル MacOS や CF Workers から curl すると 200 + 完璧な OGP が返る
- **判定方法**: ローカル vs 本番の **黒箱比較** が最速。両方の `<title>` が違えば fail mode B' 確定:
  ```bash
  # ローカル
  curl -sS -L "$URL" | grep -oE '<title[^>]*>[^<]+</title>'  # → 商品名等
  # 本番
  ssh summaly "curl -sS -L '$URL' | grep -oE '<title[^>]*>[^<]+</title>'"  # → 404 NOT FOUND
  ```
- **B との違い**: B はエラーシグナル (5xx / type filter undefined / connection_dropped) があるので `getResponseWithProxyFallback` のエラー発火型で救援できるが、B' は HTTP 層完全正常なので発火しない
- **対処 (phase14 Step 4 以降)**: 経路学習キャッシュ + bootstrap で proxy fast path を発火させる。`data/domain-strategy-bootstrap.jsonl` に `<host> → proxy` エントリを 1 行追加する (旧 `forceProxyFallback` フラグは phase14 Step 4 で廃止)。プラグインを書く必要は「URL 正規化」「DOM 直読み」等の引き出し方の自在性が必要なケースのみ
- **実例 (2026-05-07)**: `store.jp.square-enix.com` (Square Enix e-STORE / `sqex` プラグイン + bootstrap entry で対処)
- 関連 knowhow: [cf-workers-outbound-proxy.md](../../docs/knowhow/cf-workers-outbound-proxy.md) の「phase12.6 で発見: エラーシグナルなし IP block」セクション、[domain-strategy-cache.md](../../docs/knowhow/domain-strategy-cache.md)
- 関連実装: [src/plugins/sqex.ts](../../src/plugins/sqex.ts), [data/domain-strategy-bootstrap.jsonl](../../data/domain-strategy-bootstrap.jsonl), [docs/plans/phase12.6-sqex-store-proxy.md](../../docs/plans/phase12.6-sqex-store-proxy.md)

### C. 短縮 URL の preview HTML 詐欺 (phase12.1 followup #4)

- 兆候: `amzn.asia` / `bit.ly` 等で 200 + 軽量 preview HTML、OG が汎用文字列 (`og:image=previewdoh.png` / `og:title="Amazon"` 等)
- 対処: 短縮ホストを plugin の `test()` でマッチ + summarize 内で 2 段取得 (final URL から ASIN 抽出 → canonical 再 scpaping)
- 関連 knowhow: [amazon-url-normalization.md](../../docs/knowhow/amazon-url-normalization.md)

### D. URL 形式違いで弾く (phase12.1 followup #2)

- 兆候: `/dp/<asin>` (canonical) → 200、`/<slug>/dp/<asin>?ref_=...` (長 query 付き) → Worker 経由でも 500
- 対処: plugin で URL 正規化 (`normalizeAmazonUrl` パターン)。query / fragment / SEO slug を全部削って canonical に揃えてから取得
- 関連 knowhow: [amazon-url-normalization.md](../../docs/knowhow/amazon-url-normalization.md)

### E. JS 動的レンダリングで static HTML が空 (phase12.1 followup #5)

- 兆候: `#title` 要素はある or `<title>` タグはあるが、商品ページ用 DOM 要素 (`#title` / `#productDescription` 等) が空文字を返す
- 対処: 抽出 fallback 連鎖を追加。例: `#title` → `og:title` → `twitter:title` → `<title>` → ``
- 関連 knowhow: [amazon-url-normalization.md](../../docs/knowhow/amazon-url-normalization.md)

### F. Cloudflare Bot Management (phase11.4)

- 兆候: 公開 HTML が 403 だが **公式 JSON API は 200**、CF Workers 経由でも HTML は 403
- 対処: HTML スクレイプを諦めて公式 API 直叩き (npm の `registry.npmjs.org` パターン)
- 関連 knowhow: [plugin-infrastructure-patterns.md](../../docs/knowhow/plugin-infrastructure-patterns.md) の「Cloudflare 配下サイトの公式 JSON API 直叩きパターン」

### G. Akamai Bot Manager の JS challenge (一部 SNS bot allowlist 経由で救援可)

- 兆候: 元 URL から `*-wr.example.com/?c=ncl&...&kupver=akamai-5.0.1&t=<元URL>` のような challenge ページに redirect。HTML には `<title>` も og 系も全部空
- 切り分け方法: **複数の SNS bot UA を試す**:
  - `Mozilla/5.0` ブラウザ UA → challenge (= JS 実行必要)
  - `Twitterbot/1.0` → challenge (or 通る)
  - `facebookexternalhit/1.1` → ★**通れば allowlist あり**
  - `Slackbot-LinkExpanding 1.0` → ★**通れば allowlist あり**
  - `Discordbot/2.0` → challenge (or 通る)
- **対処 A (allowlist がある場合)**: 該当サイト用プラグインを作り `scpaping()` の `userAgent` を `facebookexternalhit/1.1` に固定して取得 → `parseGeneral()` で OGP 抽出。`bluesky` プラグインや `nintendo-store` プラグインがこのパターン (phase12.3 で実装、`store-jp.nintendo.com`)
- **対処 B (allowlist が無い場合)**: JS 実行エンジン (Puppeteer / Playwright) が必要だが summaly のスコープ外。**対処保留**として Misskey 側で薄い preview を許容
- 関連 knowhow: [src/plugins/nintendo-store.ts](../../src/plugins/nintendo-store.ts) — `facebookexternalhit` UA 固定の実装例

### H. HTTP/2 stream INTERNAL_ERROR / TLS layer 切断 (curl_cffi で救援可、phase12.5 で対処済み)

- 兆候: `curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR` でローカルから即座に切断 (`status=000 size=0 time<0.1s`)、本番 (Vultr) からは `category: timeout` (`Timeout awaiting 'socket' for 20000ms`)。UA / SNS bot UA すべてで弾かれる + **CF Workers proxy fetch も同じ TLS フィンガープリントで弾かれる** (proxy 経由でも救えない)
- **判断**: `curl_cffi` (libcurl-impersonate) で Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を**完全再現**することだけが正解経路
- **対処 (phase14 Step 4 以降)**: 経路学習キャッシュ + bootstrap で curl_cffi fast path を発火させる。`data/domain-strategy-bootstrap.jsonl` に `<host> → curl_cffi` エントリを 1 行追加する (旧 `forceCurlCffiFallback` フラグは phase14 Step 4 で廃止)。`(www.)?yodobashi.com` で実装済 (`yodobashi` プラグイン + bootstrap entry):
  - **bootstrap entry**: `data/domain-strategy-bootstrap.jsonl` に `{"pathKey":"yodobashi.com","strategy":"curl_cffi",...}` (本サイト用は実装済)
  - **プラグイン (引き出し方の自在性が必要な場合のみ)**: test() で対象ホストにマッチ、`export const skipRedirectResolution = true` を宣言 (resolveRedirect HEAD probe も yodobashi で 20 秒空回りするため切る、cache では代替不可な独立最適化)
  - **config**: `[scraping.curl_cffi]` を有効化 + `domains` allowlist に対象ホスト追加、`[scraping.strategy_cache]` を有効化 (デフォルト)
  - production server に `uv` インストール + `tools/curl-cffi-fetcher/` で `uv sync`
- **判断条件**: 対象サイトが OGP を整備していて (= share させたい意思あり、static HTML に OGP が入っている)、curl_cffi (chrome120 impersonate) で 200 + OGP が取れれば実装する価値あり
- 関連 knowhow: [curl-cffi-tls-impersonation.md](../../docs/knowhow/curl-cffi-tls-impersonation.md)、[domain-strategy-cache.md](../../docs/knowhow/domain-strategy-cache.md)、[src/plugins/yodobashi.ts](../../src/plugins/yodobashi.ts)、[data/domain-strategy-bootstrap.jsonl](../../data/domain-strategy-bootstrap.jsonl)

### I. SPA で OGP が JS 実行後の DOM にだけ入るサイト (JSON API があれば救援可、無ければ保留)

- **兆候**:
  - curl_cffi 等で取得すると `200 + 小さな (~10〜30 KB) SPA shell HTML` が返る (`<title>` はサイト共通の汎用タイトル、og/twitter meta 全く無し)
  - **ブラウザで開くと OGP meta が入っている** (= JavaScript で `<head>` に動的挿入)
  - `<meta name="occ-backend-base-url" ...>` (SAP Commerce Cloud) や React/Vue の SPA shell の特徴 (`<div id="root">` など) が見える
- **切り分け方法**:
  ```bash
  # サーバ HTML の OGP 確認 (JS 未実行)
  uv run fetch <URL> | python3 -c "import json,sys,re; d=json.load(sys.stdin); print(len(re.findall(r'<meta[^>]+og:', d['body'])), 'og: tags')"
  # 0 件かつブラウザで開くと OGP が見える → fail mode I 確定
  ```
- **fail mode I 判定の前段に「隠れ JSON API 探索」を 1 段挟む** (phase15.4 の教訓):
  - DevTools Network タブで XHR / fetch を監視 → 商品ページ表示時に走る JSON 系 path (`product-details` / `products/<id>` 等) を探す
  - EC エンジン共通 path を試す: SAP Commerce OCC (`/occ/v2/<tenant>/products/<sku>`)、Salesforce Commerce、Shopify Storefront API、Magento REST 等
  - JSON API が見つかれば **fail mode F (Cloudflare Bot Management) パターン** または **fail mode J (datacenter IP block)** に流す
- **真の fail mode I (JSON API も無い / 全 path 塞がれている)**: **summaly のスコープ外**。Playwright/Puppeteer 等の実ブラウザレンダリング基盤が必要だが採用しない判断 (メモリ・レイテンシ・コスト全部割に合わない)。Misskey 側で **URL のみのフォールバック表示** を許容
- 関連 knowhow: [spa-dynamic-ogp-unfixable.md](../../docs/knowhow/spa-dynamic-ogp-unfixable.md)
- 関連 phase: [phase15.1-playwright-fallback.md](../../docs/plans/phase15.1-playwright-fallback.md) (将来の Plan B)

### J. datacenter IP 全般 block (residential proxy が無いと救援不可、phase15.4 で発見)

H (yodobashi 系の TLS 切断) より厳格で、**TLS フィンガープリントを偽装しても datacenter IP からは block** されるパターン。家庭用 IP (一般 ISP / NAT) からは curl_cffi で通るが、Vultr Tokyo / CF Workers AS13335 / 別 datacenter どこから叩いても block される。

- **兆候**:
  - 家庭 IP + curl_cffi (chrome120) → ✅ 200 OK
  - 本番 Vultr / CF Workers proxy → ❌ HTTP/2 INTERNAL_ERROR / 520 Web Server Returns Unknown Error / `upstream_fetch_error`
  - UA / TLS フィンガープリント偽装すべて無効
- **切り分け方法 (4 段階チェックリスト)**:
  ```bash
  # 1. 家庭用 IP からの基本確認
  curl -A "Mozilla/5.0 ...Chrome/131..." "$URL"  # 200 OK ?

  # 2. 家庭用 IP + curl_cffi (TLS 偽装で通るか)
  cd tools/curl-cffi-fetcher && uv run fetch "$URL" --impersonate chrome120  # 200 OK ?

  # 3. 本番 (datacenter IP) から同じ curl_cffi
  ssh prod 'cd /root/summaly/tools/curl-cffi-fetcher && uv run fetch "'"$URL"'" --impersonate chrome120'

  # 4. CF Workers proxy 経由 (別 ASN datacenter)
  #    scripts/check-nitori-via-worker.mjs を URL 差し替えて流用 (env から secret 読み)
  node scripts/check-via-worker.mjs

  # 1=OK, 2=OK, 3=NG, 4=NG → fail mode J 確定 (residential proxy 必要)
  # 1=NG, 2=OK, 3=OK, 4=OK → fail mode H (yodobashi パターン、curl_cffi で救援可)
  # 1=NG, 2=NG, 3=NG, 4=NG → 真の fail mode I (JS 必須、Playwright)
  ```
- **判別の決め手**: ステップ 2 では OK なのにステップ 3 で NG になる。**TLS フィンガープリント単独問題なら 3 でも OK のはず**。3 で NG = ASN-based block。
- **対処**: summaly のスコープでは救援困難:
  1. **Playwright モード ([phase15.1](../../docs/plans/phase15.1-playwright-fallback.md))** — ブラウザフィンガープリント完全再現で通る可能性 (要実機検証、ただし Vultr IP は変わらない)
  2. **別 ASN の datacenter VPS** — 家庭 ISP に近い ASN の VPS から egress、要実験
  3. **Residential proxy 商用サービス** (BrightData / Smartproxy / Soax 等) — 月額サブスクリプションで summaly のスコープ外
  4. **コードベース上は残しつつ default disable** — 家庭 IP / library 直接利用者は使える、本番では disable (nitori プラグインの方針)
- **実例 (2026-05-10)**: `nitori-net.jp` (SAP Commerce OCC API はあるが Akamai が ASN-based でも block、`src/plugins/nitori.ts` は default disable で残置)
- 関連 knowhow: [spa-dynamic-ogp-unfixable.md](../../docs/knowhow/spa-dynamic-ogp-unfixable.md) の fail mode J セクション
- 関連 phase: [phase15.4-plugin-nitori.md](../../docs/plans/phase15.4-plugin-nitori.md) (Followup #2 で fail mode J 確定)
- 検証ツール: [scripts/check-nitori-via-worker.mjs](../../scripts/check-nitori-via-worker.mjs) (Worker 経由検証、env から secret 読み、URL 差し替えで他サイトでも流用可)

## Phase 4: 修正レイヤの選定

問題 layer ごとに修正先が変わる:

| Layer | 該当 fail mode | 実装ファイル |
|---|---|---|
| **経路学習キャッシュ (第一選択肢、phase14)** | B' / H | **`data/domain-strategy-bootstrap.jsonl` に 1 行追加** (`{"pathKey":"<host>","strategy":"<proxy\|curl_cffi\|fallback_ua>",...}`) で `scpaping()` 冒頭の cache hit fast path から該当 strategy を直接呼ぶ。プラグイン作成は不要 (URL 正規化や DOM 直読み等の「引き出し方の自在性」が必要なケースのみ) |
| URL 解決 | C / D | `src/utils/short-urls.ts` (`KNOWN_SHORT_HOSTS`)、各 plugin の `test()` + `summarize()` 内 URL 正規化 |
| HTTP 取得 | A / B / F | `src/utils/got.ts` (`getResponseWithFallback`)、`src/utils/proxy-fallback.ts` (`viaProxyWorker`)、`src/utils/curl-cffi-fetch.ts` (`viaCurlCffi`) |
| プラグイン | C / D / E / F | `src/plugins/<name>.ts`、`src/plugins/index.ts` 登録。phase14 以降は **bootstrap で経路だけ済むなら作らない** ことを推奨 (test() + URL 正規化 + DOM 直読み等の理由が必要) |
| 汎用パス | E (汎用) | `src/general.ts` (`parseGeneral`)、phase11.7 favicon fallback 等 |
| エラー分類 / 救援 | A / B | `src/utils/parse-failure-log.ts` (`categorizeError`)、`bin/config-loader.ts` 設定 |

**新サイト追加の判断フロー (phase14 以降)**:
1. 経路だけが問題 (= デフォルト UA で 5xx / 200+thin / TLS 切断、proxy or curl_cffi で取れる) → **bootstrap entry 追加だけで完了**
2. 上記 + URL 正規化が必要 (短縮 URL や `?ref_=...` 等) → プラグインを新設して `test()` + URL 正規化を実装、bootstrap entry も追加
3. 上記 + DOM 直読みや公式 API 直叩きが必要 → プラグインで `summarize()` をフル実装 (npmjs / amazon パターン)
4. ブラウザ JS 実行が必須 (fail mode I) → **summaly のスコープ外** (Misskey 側で URL のみ表示にフォールバック)
5. **datacenter IP 全般 block (fail mode J)** → コードベース上は残しつつ default disable (`[plugins].allowed` から外す + bootstrap entry も削除)。家庭 IP / library 直接利用者は使える形を保ちつつ、本番では実用不能と明示する (nitori パターン)

## Phase 5: 実装 + テスト

### 既存プラグインの拡張 (例: 短縮 URL 追加 / URL 正規化)

1. `src/plugins/<name>.ts` の `test()` を拡張
2. `summarize()` 内で URL 正規化 / 2 段取得などを追加
3. `test/plugin-<name>.test.ts` に**ユニットテストを必ず追加** (`normalizeXxxUrl` のような pure 関数を export してフィクスチャテスト)
4. `docs/Plugins.md` の該当 plugin セクションを更新
5. `dev/sample-urls.ts` に動作確認用の URL を追加

### 新規プラグイン追加

1. `src/plugins/<name>.ts` を新設、`SummalyPlugin` interface (`test` + `summarize` + `name`) を実装
2. `src/plugins/index.ts` の `plugins[]` に登録（**順序重要**: 先勝ち）
3. `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` の **両方** の `[plugins].allowed` リストに新規 plugin 名を追加（CLAUDE.repo.md ステップ 4.5、`test/config-example-plugins.test.ts` で自動検証）
4. テスト・ドキュメント・dev sample (上記と同じ)
5. `CLAUDE.repo.md` の「対応形式（組み込みプラグイン）」表に行追加
6. `CHANGELOG.md` unreleased に **feat** で記録

### proxy fallback / UA fallback / カテゴリ拡張

`bin/config-loader.ts` の `[scraping.fallback]` / `[scraping.proxy]` のスキーマと、`src/utils/proxy-fallback.ts` の `DEFAULT_PROXY_CATEGORIES` 等の定数を整合させる。

## Phase 6: 動作確認

### ローカル

```bash
pnpm test                                    # 全テスト
pnpm exec vitest run -t "<新規テスト名>"      # 新規テストだけ
pnpm dev                                     # dev サーバ起動 → サンプル URL クリック確認
```

dev サーバの sample-urls からワンクリックで JSON / カードプレビューが取れることを確認。proxy fallback が必要なケースは env を設定して checkbox を ON にする (phase12.1 dev 統合で対応済み)。

### 本番デプロイ前 (実機 IP 確認の必須化、phase15.4 Followup #2 教訓)

**ローカル動作確認だけで Plan を完了にしない**。phase15.4 ではローカル MacOS (家庭 IP) で `uv run fetch <api>` が 200 OK だったため OK 判定で本番 deploy したが、本番 Vultr IP からは `HTTP/2 INTERNAL_ERROR` で完全に動かなかった (fail mode J)。これは **「TLS フィンガープリント偽装で通るのは家庭 IP だけ、datacenter IP は ASN-based でも block されている」** という事実を見落としていたため。

**curl_cffi / TLS 偽装系のサイト対応では Plan Step に必須化する**:

```bash
# Plan Step 4.5 必須化: 本番 ssh 経由で curl_cffi を直接叩いて 200 OK を確認
ssh prod 'cd /root/summaly/tools/curl-cffi-fetcher && uv run fetch "'"$URL"'" --impersonate chrome120' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('status:', d.get('status'), 'category:', d.get('category', '-'))"

# 期待: status: 200
# datacenter IP block (fail mode J) なら status エラー or category: 'tls'/'network' が返る
# → ローカル成功でも本番では動かないことが判明 → fail mode J 整理 + default disable
```

`scripts/check-nitori-via-worker.mjs` を URL 差し替えて流用すれば Worker 経由 (CF Workers AS13335) も同時に検証できる (env から secret 読み)。**家庭 IP / 本番 Vultr / CF Workers の 3 ASN で挙動を比べる**ことで fail mode H (TLS 切断、curl_cffi で救援可) と fail mode J (datacenter 全般 block、救援不可) を区別できる。

### 本番デプロイ後

**4〜5 URL バリエーションで叩いて確認**（phase12.1 GO 判定で 1 パターンだけだと本番で穴が残った教訓）:

| バリエーション | 例 |
|---|---|
| canonical 形 (短い path、query なし) | `https://www.amazon.co.jp/dp/B0XXXXXXXX` |
| 長 query 付き | `https://www.amazon.co.jp/dp/B0XXXXXXXX?_encoding=UTF8&ref_=...` |
| SEO slug 付き | `https://www.amazon.co.jp/<日本語slug>/dp/B0XXXXXXXX/` |
| bare hostname (www. なし) | `https://amazon.co.jp/dp/B0XXXXXXXX` |
| 短縮 URL | `https://amzn.asia/d/<id>` |

各バリエーションで本番サーバ (`https://summaly.riinswork.space/?url=<encoded>`) を叩き、JSON が正しく返ることを確認。`?t=<任意>` を加えると nginx 前段キャッシュを bypass できる。

実例 (Prime Video URL の動作確認、followup #5 の対象):

```bash
URL='https://www.amazon.co.jp/gp/video/detail/B0BX1TYH98/ref=atv_hm_hom_c_DG1e775c_4_2'
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")
curl -sS "https://summaly.riinswork.space/?t=$(date +%s)&url=${ENC}" | jq .
# 期待: title が「機動戦士ガンダム 水星の魔女 シーズン1を観る | Prime Video」になること
```

### 失敗時の本番ログ確認

```bash
sudo journalctl -u summaly -o cat -f \
  | grep --line-buffered -E '^\{' \
  | jq -c 'select(.msg == "summaly error")'
```

stack trace を見て Phase 1 の表に戻り、再判定。

## 品質ゲート完走 (Stage 1 + Stage 2)

修正後は CLAUDE.md / Progress.md の品質ゲートを通す:

```bash
# Stage 1
pnpm build && pnpm eslint && pnpm typecheck && pnpm test
bash .claude/tests/run-all.sh

# Stage 2
# - addf-code-review-agent でレビュー (特にセキュリティ / proxy 関連の変更は重点)
# - addf-contribution-agent (`.claude/` `docs/knowhow/ADDF/` `templates/` を触らないならスキップ可)
```

ドキュメント突き合わせ (Step 4.5):

| 修正対象 | 同期するドキュメント |
|---|---|
| 公開 API (`SummalyOptions` / プラグイン) | README, docs/Library.md, docs/Plugins.md |
| Fastify 設定 | docs/SETUP.md, docs/deploy-examples/README.md |
| 設定例 | `config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` の **両方** |
| ユーザー向け機能 | CHANGELOG (unreleased) |
| dev サーバ | dev/sample-urls.ts |
| 設計判断 | docs/knowhow/ + docs/knowhow/INDEX.md |

## journalctl + jq の落とし穴 (再発しがち)

```bash
# ❌ 失敗パターン 1: parse error (環境によりプレフィックスが残る)
sudo journalctl -u summaly -o cat | jq -c '...'
# → jq: parse error: Invalid numeric literal at line 1, column 9
# → "5月 06 21:45 host proc[123]: {...}" の "5" が数値として解釈される

# ❌ 失敗パターン 2: null containment (incoming request 等の部分ログで select が落ちる)
... | jq -c 'select(.req.url | contains("amazon"))'
# → jq: error: null (null) and string ("amazon") cannot have their containment checked

# ✅ 正解: grep ^{ で JSON 行だけ抽出 + null safe 化
sudo journalctl -u summaly -o cat \
  | grep -E '^\{' \
  | jq -c 'select((.req.url // "") | contains("amazon"))'
```

`select((.foo // "") | contains("..."))` で **「キーが無い行も `""` 扱い → contains は false → select 外す」** という null safe ナビゲーションが定石。

## 関連 knowhow

- [docs/knowhow/cf-workers-outbound-proxy.md](../../docs/knowhow/cf-workers-outbound-proxy.md) — Worker 設計と運用知見 (phase12.1 followup #1〜#5)
- [docs/knowhow/amazon-url-normalization.md](../../docs/knowhow/amazon-url-normalization.md) — Amazon URL 正規化と短縮 URL 対応
- [docs/knowhow/bot-block-ua-retry.md](../../docs/knowhow/bot-block-ua-retry.md) — phase11.9 UA レイヤ救援
- [docs/knowhow/outbound-ip-reputation.md](../../docs/knowhow/outbound-ip-reputation.md) — IP レピュテーション層の実証データ
- [docs/knowhow/plugin-infrastructure-patterns.md](../../docs/knowhow/plugin-infrastructure-patterns.md) — プラグイン基盤と Cloudflare Bot Management 配下の API 直叩きパターン
- [docs/knowhow/observability-parse-failure-log.md](../../docs/knowhow/observability-parse-failure-log.md) — pino + JSONL パース失敗ログの観測パターン

## 経験の活用

実行ごとに知見が増えたら以下に追記:

- 新しい fail mode を発見したら Phase 3 の表に追加
- 既存 fail mode の対処に新しい工夫があったら関連 knowhow に追記
- スキル自体の使い勝手の改善は `.claude/Feedback.md` に記録
