# phase15.1 — Playwright モードによる fail mode I (SPA + JS 動的 OGP) 救援

## 背景

phase11.9 / 12.1 / 12.5 / 12.6 / 14 で **段階的フォールバック + 経路学習キャッシュ** を整備し、IP block / TLS bot block / データセンター IP 弾きを救援する基盤が揃った。

しかし `/url-preview-check` skill の **fail mode I** (SPA + JS 動的 OGP 注入、`react-helmet` / `vue-meta` 等で実行時に `<head>` を書き換える実装) は、**いかなる HTTP scraping でも救えない構造的な壁** である。実例:

- ニトリネット (`nitori-net.jp/ec/product/...`): サーバ HTML には OGP **0 件**、ブラウザで JS 実行後の DOM にだけ挿入される
- curl_cffi + chrome120 impersonate でも 200 + SPA shell HTML のみ
- 公式 JSON API も Akamai 配下で 403、SNS bot UA でも HTTP/2 INTERNAL_ERROR

**設計上の判断**: 「JS 動的 OGP 注入は実装ミス (SNS bot は誰一人 JS を実行しない)」という認識のもと、これまで summaly 側では救援対象外としてきた (詳細: [docs/knowhow/spa-dynamic-ogp-unfixable.md](../knowhow/spa-dynamic-ogp-unfixable.md))。

しかし fail mode I の発生頻度が無視できないレベル (parse-failure-log で月 N 件) になってきた、もしくは個人的に preview したい SPA EC が増えた段階で、**実ブラウザレンダリング (Playwright)** を最後の救援経路として組み込む。

## ゴール

1. **Step 1 (実験 / GO/NO-GO 判定)**: `tools/playwright-fetcher/` に CLI ツールを置き、ニトリ等 fail mode I サイトで OGP 取得が安定するか確認する
2. **Step 2 (統合)**: GO ならば summaly の Node.js 側から spawn-per-request で呼び出すブリッジを作り、経路学習キャッシュの strategy として組み込む (`'playwright'`)
3. **Step 3 (運用整備)**: production 環境への Playwright 配備手順、メモリ要件 (Vultr のメモリ拡張)、許可ドメイン allowlist 制御、daemon 化検討

## 設計方針

### 経路学習キャッシュとの統合 (phase14 完了後の前提)

phase14 で `forceCurlCffiFallback` / `forceProxyFallback` を廃止し、**bootstrap JSONL + 学習** で経路を選択する形になっている。Playwright も同じレールに乗せる:

```typescript
type DomainStrategy = 'default' | 'fallback_ua' | 'proxy' | 'curl_cffi' | 'playwright';
```

`data/domain-strategy-bootstrap.jsonl` に `nitori-net.jp → playwright` を追記すれば、cache hit fast path で Playwright 直行になる。プラグイン側で flag を立てる必要はない (旧 `forceCurlCffiFallback` パターンは廃止済み)。

### tools/playwright-fetcher/ の構成

curl_cffi (`tools/curl-cffi-fetcher/`) と同じ独立 npm 構成:

- `tools/playwright-fetcher/package.json` — Playwright 依存
- `tools/playwright-fetcher/src/fetch.ts` — CLI スクリプト (URL を受け取り、render 後の DOM HTML を stdout JSON で返す)
- main の `package.json` `files: ["built", "LICENSE"]` で publish 対象から自動除外
- `eslint.config.js` の `tools` ignore 設定で main eslint からも分離

### CLI 仕様 (curl_cffi と類似)

```bash
$ pnpx playwright-fetcher \
    --url https://example.com/spa \
    --timeout 30000 \
    --max-bytes 10485760 \
    --wait-for "meta[property='og:title']" \
    --user-agent "SummalyBot/x.y.z (+https://github.com/...)"

# stdout (success):
{"status": 200, "final_url": "https://...", "content_type": "text/html", "headers": {...}, "body": "<html>...</html>"}

# stdout (error):
{"error": "...", "category": "timeout|network|render|setup|content_too_large|other"}
```

`--wait-for` selector で「OGP meta が DOM に挿入されるまで待つ」明示制御。タイムアウト時は category=timeout で諦める。

### Node.js IPC ブリッジ (`src/utils/playwright-fetch.ts`)

curl_cffi 統合 (`src/utils/curl-cffi-fetch.ts`) と同じ spawn-per-request パターン:

- `child_process.spawn('pnpm', ['exec', 'playwright-fetcher', ...args], { cwd: projectDir, shell: false })`
- stdout JSON をパース → `Got.Response<string>` 互換に整形
- timeout 二重防御 (CLI `--timeout` + spawn timer)
- `error` / `exit` 二重発火ガード (`settled` flag、curl_cffi で確立済みのパターン)
- 起動コスト ~1〜2 秒 (Chromium boot)、curl_cffi (~100ms) より圧倒的に重いため **最終手段** として位置付け

### config TOML 仕様 (`bin/config-loader.ts`)

```toml
[scraping.playwright]
enabled = false               # オプトイン
projectDir = "tools/playwright-fetcher"
domains = ["nitori-net.jp"]   # allowlist 必須、空配列禁止
timeoutMs = 30000             # CLI + spawn timer 両方に適用
waitFor = "meta[property='og:title']"  # 省略可、デフォルトは load イベント
userAgent = ""                # 省略時は default UA
```

`VALID_DOMAIN_STRATEGY` に `'playwright'` を追加 (`bin/config-loader.ts` の strategy_cache 検証)。

### セキュリティ防御層

任意 URL で JS 実行は **SSRF + RCE 経路の温床**。多層防御:

1. **HTTPS only** — http: は弾く (TOML 検証段階)
2. **allowlist 必須** — `domains` 空配列禁止
3. **navigation interception** — Playwright `route()` で外部 navigation を block (XSS で仕組まれた URL 跳ねを防ぐ)
4. **resource block** — `image` / `media` / `font` を block (帯域節約 + tracking pixel 防止)
5. **Cookie / localStorage 永続化なし** — 毎回 incognito context で起動
6. **content size cap** — `--max-bytes` で巨大ページ DoS を抑制
7. **メモリ cap** — `--memory-limit` (Chromium `--memory-pressure-off` 等で抑制)
8. **private IP guard** — Playwright DNS 解決後の IP を `ipaddr.js` でチェック (curl_cffi にはない、Playwright 固有のリスク)

### メモリ要件

Playwright + Chromium は最低 1 GB RAM 推奨 (個別ページレンダリングで瞬間的に 500 MB 以上を消費しうる)。Vultr の現在のサーバ規模 (1 GB プラン?) では daemon 化が必要かもしれない。

撤退条件 (Step 1 で判断):
- ニトリ等 3 サイトすべてで安定取得できない
- メモリピークが既存 Vultr プランで OOM を頻発させる
- Chromium boot コストが許容範囲外 (10 秒以上)

## Step 1 — 実験 (GO/NO-GO 判定)

### タスク

- [ ] `tools/playwright-fetcher/package.json` (playwright>=1.40,<2.0)
- [ ] `tools/playwright-fetcher/src/fetch.ts` — CLI スクリプト
  - argparse 相当 (commander 等) で `--url` / `--timeout` / `--max-bytes` / `--wait-for` / `--user-agent` を受け取る
  - `chromium.launch({ headless: true })` → `incognito context` → `page.goto(url, { waitUntil: 'domcontentloaded' })`
  - `--wait-for` selector がある場合は `page.waitForSelector(selector, { timeout })` で OGP 注入を待つ
  - `await page.content()` で DOM HTML を取得 → stdout JSON 出力
  - エラーは `{error, category}` で `category: timeout|network|render|setup|content_too_large|other`
- [ ] `tools/playwright-fetcher/README.md` (実験手順 / 撤退条件 / 運用注意)
- [ ] 実機検証: ニトリ + 別の SPA EC 2〜3 サイトで OGP 取得安定性を確認
- [ ] GO 判定基準: 3 サイト中 2 サイト以上で 30 秒以内に OGP 完全取得 + メモリピーク許容範囲内

### 撤退条件

- 3 サイト中 2 サイト未満で取得失敗
- メモリピークが Vultr 現プランで OOM 頻発
- Chromium boot コスト 10 秒超

撤退時は `tools/playwright-fetcher/` を削除し、knowhow に「Playwright 実験は撤退、fail mode I は引き続き救援対象外」を追記する。

## Step 2 — Node.js IPC 統合 (Step 1 GO 後)

### タスク

- [ ] `src/utils/playwright-fetch.ts` — `child_process.spawn` で CLI を呼び出し、`Got.Response<string>` 互換オブジェクトを返すブリッジ
  - `projectDir` (絶対 or cwd 相対) を config 経由で受ける
  - timeout は `--timeout` (CLI 側) + spawn timer (`timeoutMs`) の二重防御
  - 子プロセス timeout で SIGKILL 強制終了
  - `error` / `exit` 二重発火ガード (`settled` flag)
- [ ] `getResponseWithPlaywrightFallback` を **5 段目** として追加 (curl_cffi の後ろ)
  - `getResponseWithCurlCffiFallback` の **try ブロック後** に Playwright gating を実装
  - 発火条件 3 重 gating: `enabled === true` + categories 一致 + domains 一致 + `https:` プロトコル
  - `scpaping()` から動的 import で呼ぶ (循環参照回避、curl_cffi と同じパターン)
- [ ] config TOML `[scraping.playwright]` セクション (`bin/config-loader.ts`)
  - `enabled = false` がデフォルトでオプトイン制御
  - `projectDir` / `domains` 必須、空配列禁止 (allowlist 必須)
  - `categories` の typo 検証 (`VALID_ERROR_CATEGORIES` セット)
- [ ] 経路学習キャッシュ (phase14) の `DomainStrategy` に `'playwright'` を追加
  - `data/domain-strategy-bootstrap.jsonl` にニトリ等の bootstrap entry を追加
  - 学習機構が成功時に `recordSuccess(host, 'playwright')` を呼べるようにする
- [ ] テスト 13 本程度: mock CLI (Node.js script with shebang) を tmp dir に置いて spawn 経由テスト
  - 成功 / status >=400 / エラー JSON / type filter / malformed JSON / ENOENT spawn / final URL
  - gating: enabled=false / domains miss / http://非https / config 未指定
- [ ] ドキュメント: `docs/Library.md` (`playwrightFallback` 行追加)、`docs/SETUP.md` (Playwright セクション、配備手順、メモリ要件、セキュリティ)、`config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` (両方)、CHANGELOG (Step 2 完了エントリ)

## Step 3 — 運用整備

- [ ] `docs/SETUP.md` に Playwright 配備手順を追記 (`pnpm install` + `pnpm exec playwright install chromium`)
- [ ] Vultr メモリ拡張ガイド (現プラン → 上位プラン)
- [ ] daemon 化検討: spawn-per-request は起動コスト ~2 秒。頻繁に呼ぶならば stdin で URL を連続受信する常駐プロセスに移行
  - **判断基準**: parse-failure-log で月 N 件の救援が確定した段階で
- [ ] resource block / navigation interception の実装をレビューして SSRF 防御を確認
- [ ] private IP guard の Playwright 経路への適用確認

## 着手トリガー

- fail mode I の発生頻度が無視できないレベル (parse-failure-log で月 N 件) になってきた時
- 個人的に preview したい SPA EC が増えた時

## 想定サイズ

L 〜 XL (Step 1 だけで M、Step 2 統合で +M、Step 3 運用整備で +S)。

curl_cffi (phase12.5) は M〜L で済んだが、Playwright は **メモリ要件 + セキュリティ防御層が curl_cffi より重い** ため XL 寄り。

## 関連

- [docs/knowhow/spa-dynamic-ogp-unfixable.md](../knowhow/spa-dynamic-ogp-unfixable.md) — fail mode I 切り分けチェックリスト
- [docs/knowhow/curl-cffi-tls-impersonation.md](../knowhow/curl-cffi-tls-impersonation.md) — spawn-per-request の防衛パターン (Playwright でも踏襲)
- [docs/knowhow/domain-strategy-cache.md](../knowhow/domain-strategy-cache.md) — phase14 経路学習キャッシュへの統合方針
- [docs/plans/phase12.5-curl-cffi-fetcher.md](phase12.5-curl-cffi-fetcher.md) — 構造的に同じパターンの先行例
