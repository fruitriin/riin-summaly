# phase12.6 — Square Enix e-STORE 救援 (forceProxyFallback + sqex プラグイン)

## 背景

`https://store.jp.square-enix.com/item/MWFF140773_2.html` (および短縮 URL `https://sqex.to/ZjZdX`) が
本番 summaly (Vultr Tokyo) では `{"title":"404 NOT FOUND", ...}` を返す。

切り分け結果:

| 確認 | 結果 |
|---|---|
| ローカル MacOS から curl (全 UA) | ✅ 200 + OGP 完璧 (`og:title` / `og:description` / `og:image` / `og:site_name`) |
| Vultr 本番から curl (SummalyBot UA) | ❌ 404 ページ HTML が返る (オーナー確認済み) |
| 短縮 URL `sqex.to/ZjZdX` の HEAD redirect | ✅ `store.jp.square-enix.com/item/MWFF140773_2.html` に解決される |

**fail mode B (IP レピュテーション層の遮断) の新パターン**:

phase12.1 で対処済みの Amazon パターンは「200 + content-type 欠落」「5xx 直接返却」など **HTTP 層でエラーが
発生するシグネチャ** だったが、SQEX は **HTTP 200 + `text/html;charset=utf-8` + ボディが正規の 404 ページ**
で返ってくる。`got` レイヤでは完全に正常レスポンスなので、既存の `getResponseWithProxyFallback`
(エラーカテゴリベース発火) では救援できない。

## ゴール

1. **`forceProxyFallback` フラグの追加** — phase12.5 の `forceCurlCffiFallback` と並列構造で、
   プラグインが「最初から proxy 経由で取りに行く」ことを宣言できる
2. **sqex プラグインの追加** — `(www\.)?store\.jp\.square-enix\.com` にマッチし `forceProxyFallback: true` を渡す
3. **設定 example / Worker allowlist の更新** — `[scraping.proxy].domains` と `wrangler.toml` の
   `ALLOWED_DOMAINS` の両方に `store.jp.square-enix.com` を追加

## 完了状況

### Step 1 — `forceProxyFallback` コア機能 (完了 2026-05-07)

- [x] `src/general.ts` の `GeneralScrapingOptions` に `forceProxyFallback?: boolean` を追加
  (`forceCurlCffiFallback` と並列、JSDoc で意図 + 排他性ルールを明記)
- [x] `src/general.ts` 内 `general()` で `scpaping` 呼び出し時に `forceProxyFallback` を伝搬
- [x] `src/utils/got.ts` の `scpaping()` に分岐を追加: `forceProxyFallback === true` かつ
  `proxyFallback?.enabled === true` かつ `secret !== ''` のとき `viaProxyWorker` を直行
- [x] defense-in-depth: `domains` allowlist と `https:` プロトコルを再検証 (満たさなければ通常段階に fallthrough)
- [x] `src/utils/proxy-fallback.ts` の `viaProxyWorker` を `export async function` に変更 (got.ts から直接呼ぶ)

### Step 2 — sqex プラグイン (完了 2026-05-07)

- [x] `src/plugins/sqex.ts` を新設:
  - `name = 'sqex'`
  - `test(url)`: `(www\.)?store\.jp\.square-enix\.com` にマッチ (anchored)
  - `summarize(url, opts)`: `scpaping(url, { ...opts, forceProxyFallback: true })` → `parseGeneral`
  - `skipRedirectResolution` は宣言しない (短縮 URL `sqex.to` は HEAD で解決できているので
    `summaly()` の resolveRedirect 段に任せる)
- [x] `src/plugins/index.ts` の `plugins[]` 配列の末尾に登録

### Step 3 — 設定 / Worker allowlist (完了 2026-05-07)

- [x] `config.example.toml` の `[scraping.proxy].domains` コメント例に `store.jp.square-enix.com` を追加
- [x] `config.example.toml` の `[plugins].allowed` リストに `"sqex"` を追加
- [x] `docs/deploy-examples/summaly-config.example.toml` も同様
- [x] `tools/cf-proxy-worker/wrangler.toml` の `ALLOWED_DOMAINS` に `store.jp.square-enix.com` を追加
- [ ] (運用者側で) `wrangler deploy` を実行してデプロイ + summaly 本番 config に proxy domain 追加

### Step 4 — テスト (完了 2026-05-07)

- [x] `test/index.test.ts` に sqex テスト追加:
  - `test()` のマッチ確認 (正・否定パターン、短縮 URL は resolveRedirect で展開後にマッチする等)
  - `skipRedirectResolution` を宣言していないことの確認
- [x] `test/proxy-fallback.test.ts` の末尾に `describe('scpaping forceProxyFallback (phase12.6)')` 追加 (5 テスト):
  - 直行成功 / proxy disabled fallthrough / secret 空 fallthrough / domain allowlist 不一致 fallthrough / http: 非対応 fallthrough

### Step 5 — ドキュメント (完了 2026-05-07)

- [x] `docs/Plugins.md` に sqex プラグインのセクション追加
- [x] `CLAUDE.repo.md` の「対応形式（組み込みプラグイン）」表に sqex 行を追加
- [x] `dev/sample-urls.ts` にサンプル URL 追加 (直リンクと短縮 URL `sqex.to/ZjZdX` の両方)
- [x] `CHANGELOG.md` の unreleased セクションに `feat` で記録

### Step 6 — 知見記録

- [x] `/url-preview-check` skill の Phase 3 fail mode 表に **fail mode B 拡張: HTTP 200 + 正規 404 ページボディ** を追加 (skill 更新)
- [x] `docs/knowhow/cf-workers-outbound-proxy.md` に `forceProxyFallback` パターンを追記 (新パターン: エラーシグナルなし IP block 救援)

## 設計判断

### なぜ `forceProxyFallback` フラグを追加するのか

既存の `getResponseWithProxyFallback` は **エラー発火型**:

> 1 回目 + UA fallback の両方が失敗 → カテゴリ判定 + ドメイン allowlist チェック → proxy 経由でリトライ

SQEX は HTTP/200 + text/html + 正規 404 ページボディで返ってくるため、`got` レイヤでは何も
エラーが発生しない (status code は 200 で content-type も妥当)。`categorizeError` も
何のシグナルも拾えない。

→ **エラーシグナルなしに proxy 直行する経路** が必要。これは phase12.5 で curl_cffi に対して
実装したのと完全に同じ設計判断 (yodobashi の TLS 切断は本番では `category: timeout` を出すが
ローカルでは即時切断で 0.05 秒で完了するなど不安定なシグナルなので、`forceCurlCffiFallback` で
強制直行を選んだ)。

### なぜ `parseGeneral` 経由 (専用パーサーを作らない) のか

サーバ HTML には正規の `og:*` がフルセット入っているので、汎用の `parseGeneral` が正しく拾える
(`og:title`, `og:description`, `og:image`, `og:site_name`)。Amazon プラグインのような独自
DOM パーサーは不要。

### URL 形式のバリエーションについて

Square Enix は国別ストアが分散している:

- 日本: `store.jp.square-enix.com` (本フェーズの対象)
- 米国: `store.na.square-enix-games.com` (別ドメイン、別実装の可能性大)
- 欧州: 不明

phase12.4 の yodobashi (`yodobashi.com` 限定) と同様、まずは確認できているドメインだけ対応する。
他国ストアは要望があれば追加する。

### 短縮 URL `sqex.to`

HEAD で `store.jp.square-enix.com/item/...` に正常解決できるため、`KNOWN_SHORT_HOSTS` 等への
追加は **必須ではない**。`summaly()` 冒頭の resolveRedirect で展開される → sqex プラグインが
本ドメインにマッチして発火する。動作確認には `dev/sample-urls.ts` に短縮 URL も含めておく。

## 動作確認

ローカル dev (proxy 設定済み):

```bash
URL='https://store.jp.square-enix.com/item/MWFF140773_2.html'
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")
curl -sS "http://127.0.0.1:3000/api/summaly?url=${ENC}&proxy=1" | jq
# 期待: title, description, thumbnail が正しく入る
```

本番デプロイ後 (Worker allowlist 更新 + summaly config 更新 + summaly デプロイ):

```bash
URL='https://store.jp.square-enix.com/item/MWFF140773_2.html'
ENC=$(node -e "console.log(encodeURIComponent('$URL'))")
curl -sS "https://summaly.riinswork.space/?t=$(date +%s)&url=${ENC}" | jq

# 短縮 URL 経由
URL2='https://sqex.to/ZjZdX'
ENC2=$(node -e "console.log(encodeURIComponent('$URL2'))")
curl -sS "https://summaly.riinswork.space/?t=$(date +%s)&url=${ENC2}" | jq
```

## 関連 knowhow

- [docs/knowhow/cf-workers-outbound-proxy.md](../knowhow/cf-workers-outbound-proxy.md) — proxy fallback の設計
- [docs/knowhow/outbound-ip-reputation.md](../knowhow/outbound-ip-reputation.md) — IP レピュテーション層実証データ
- [docs/knowhow/curl-cffi-tls-impersonation.md](../knowhow/curl-cffi-tls-impersonation.md) — `forceCurlCffiFallback` の前例
- [src/plugins/yodobashi.ts](../../src/plugins/yodobashi.ts) — 強制スキップフラグの実装例
