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
   ログ        curl 各種        5 種類            5 layer         + テスト       4-5 URL バリエーション
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
ssh summaly 'sudo journalctl -u summaly -o cat -f' | jq -c 'select(.msg == "summaly error")'
```

## Phase 1: 症状特定 (本番ログから)

本番が稼働中なら **まず pino ログを確認**（phase11.8 で出力するようにしている）:

```bash
# error / warn だけ抽出（amazon を含む URL に絞る例）
sudo journalctl -u summaly -o cat --since "30 min ago" \
  | jq -c 'select(.url | contains("amazon"))'
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

# E) Worker proxy 経由 (phase12.1 認証トークン環境変数あり)
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")
curl -sS -L -A "Mozilla/5.0" -o /tmp/proxy.html \
  -H "x-summaly-token: ${SUMMALY_PROXY_TOKEN:-riin-summaly}" \
  -w "status=%{http_code} ct=%{content_type} size=%{size_download}\n" \
  "https://summaly-proxy.riinsworkspace.workers.dev/?url=${ENC}"
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

curl 結果のパターンから **5 タイプ**に分類:

### A. UA 文字列で弾く WAF (phase11.9 で対処済み)

- 兆候: SummalyBot UA → `socket hang up` / `connection_dropped`、ブラウザ UA → 200 OK
- 対処: phase11.9 の fallback UA リトライがデフォルトで効く (`[scraping.fallback]`)
- 救援できる比率: 上限あり (約 2/3、IP-based block は救えない)
- 関連 knowhow: [bot-block-ua-retry.md](../../docs/knowhow/bot-block-ua-retry.md)

### B. IP レピュテーション層の遮断 (phase12.1 で対処済み)

- 兆候: あらゆる UA で 5xx / 200 + content-type 欠落 / `Rejected by type filter undefined`、Cloudflare 帯 (Worker 経由) からは 200
- 対処: phase12.1 の proxy fallback。`[scraping.proxy].domains` allowlist にホスト追加 + Worker `wrangler.toml` の `ALLOWED_DOMAINS` も同期更新
- 関連 knowhow: [cf-workers-outbound-proxy.md](../../docs/knowhow/cf-workers-outbound-proxy.md), [outbound-ip-reputation.md](../../docs/knowhow/outbound-ip-reputation.md)

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

### G. Akamai Bot Manager の JS challenge (対処困難)

- 兆候: 元 URL から `*-wr.example.com/?c=ncl&...&kupver=akamai-5.0.1&t=<元URL>` のような challenge ページに redirect。HTML には `<title>` も og 系も全部空。`store-jp.nintendo.com` で実証 (2026-05-06)
- 対処: **JS 実行エンジンが必要** (Puppeteer / Playwright) で、CF Workers でも proxy でも突破不可
- 判断: summaly のスコープ外として **対処保留**。Misskey 側で当該サイトのカードは表示しない / 薄い preview を許容する選択

### H. HTTP/2 stream INTERNAL_ERROR (対処困難)

- 兆候: `curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR` でローカル / 本番ともに即座に切断 (`status=000 size=0 time<0.1s`)。`yodobashi.com` で実証 (2026-05-06)。`category` は `timeout` (got 側で `socket` 待ちタイムアウトに化ける)
- 対処: TLS / HTTP/2 ハンドシェイク段階で server 側が能動的に切る bot 対策。UA を変えても、IP を変えても切断される。**proxy 経由でも同じ TLS スタックなので救えない**
- 判断: 対処保留。CF Workers の TLS fingerprint が違えば通る可能性あるが、未実証

## Phase 4: 修正レイヤの選定

問題 layer ごとに修正先が変わる:

| Layer | 該当 fail mode | 実装ファイル |
|---|---|---|
| URL 解決 | C / D | `src/utils/short-urls.ts` (`KNOWN_SHORT_HOSTS`)、各 plugin の `test()` + `summarize()` 内 URL 正規化 |
| HTTP 取得 | A / B / F | `src/utils/got.ts` (`getResponseWithFallback`)、`src/utils/proxy-fallback.ts` (`viaProxyWorker`) |
| プラグイン | C / D / E / F | `src/plugins/<name>.ts`、`src/plugins/index.ts` 登録 |
| 汎用パス | E (汎用) | `src/general.ts` (`parseGeneral`)、phase11.7 favicon fallback 等 |
| エラー分類 / 救援 | A / B | `src/utils/parse-failure-log.ts` (`categorizeError`)、`bin/config-loader.ts` 設定 |

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
