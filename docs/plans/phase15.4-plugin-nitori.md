# Phase 15.4 — ニトリ (nitori-net.jp) プラグイン (公式 JSON API + curl_cffi 経路)

> 状態: **完了 (2026-05-10)**
> 種別: 機能拡張 / プラグイン追加
> サイズ: **M**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md) (`name` フィールド規約)、[phase12.5](phase12.5-curl-cffi-fetcher.md) (curl_cffi 統合)
> 並列可: なし (単独 phase)

## 目的・背景

`https://www.nitori-net.jp/ec/product/<sku>/` を summaly で取得すると **何をやっても OGP が取れない**。
過去の調査 ([docs/knowhow/spa-dynamic-ogp-unfixable.md](../knowhow/spa-dynamic-ogp-unfixable.md))
では「fail mode I (SPA + JS 動的 OGP 注入) で救援不可」と整理していたが、本 phase で **公式 JSON API
(`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`) で完璧な構造化データが
取れる** ことが判明したため救援可能となった。

### 二重壁の構造

ニトリの fail mode は **TLS layer block** と **JS 動的 OGP** の二重壁:

| 経路 | 結果 |
|---|---|
| HTML scraping (SummalyBot UA) | HTTP/2 INTERNAL_ERROR (TLS layer 切断) |
| HTML scraping (`facebookexternalhit/1.1`) | HTTP/2 INTERNAL_ERROR (UA 切替でも切断) |
| HTML scraping (curl_cffi + chrome120) | 200 + 15KB SPA shell、OGP **0 件** |
| **JSON API (`/occ/v2/nitorinet/nitori/products/<sku>`) + Chrome UA + curl_cffi** | **200 + 完璧な JSON (4.5KB)** |
| JSON API + SummalyBot UA / facebookexternalhit | HTTP/2 INTERNAL_ERROR (TLS 切断、API も同 layer 配下) |

要約: **JSON API も TLS layer block 配下にある** ため curl_cffi (libcurl-impersonate) 経路必須。

### 取得できるフィールド (実機検証済 2026-05-10)

```json
{
  "brand": {
    "name": "ニトリ",
    "imageUrl": "https://www.nitori-net.jp/ecstatic/nitori/common/icon/logo/NITORI_LOGO_SQUARE_2.png"
  },
  "skuData": {
    "name": "Nクール ぬいぐるみ ニシキアナゴ L(BK26)",
    "productDescription": "【ニトリの接触冷感(Nクール)】<br><br>■組成<br>側生地：ナイロン90%...",
    "mediasList": [
      { "type": "image", "url": "https://www.nitori-net.jp/ecstatic/image/product/.../211610001327201.jpg?ts=..." },
      ...
    ],
    "specifications": { "color": "その他", "material": "ナイロン　ポリウレタン", "size": "..." }
  },
  "price": { "value": 1990.0, "currencyIso": "JPY" }
}
```

存在しない SKU: HTTP 200 + `{ "error": { "errorCode": "INVALID_PRODUCT", "errorDescription": "..." } }` を返す。

### curl 検証済み (2026-05-10)

| 経路 | 結果 |
|---|---|
| `curl -A SummalyBot/x.y.z https://www.nitori-net.jp/occ/v2/.../<sku>?...` | ❌ HTTP/2 INTERNAL_ERROR |
| `curl -A "facebookexternalhit/1.1" .../occ/...` | ❌ HTTP/2 INTERNAL_ERROR |
| `curl -A "Twitterbot/1.0" .../occ/...` | ❌ HTTP/2 INTERNAL_ERROR |
| `curl -A "Mozilla/5.0 ... Chrome/131.0.0.0 ..." .../occ/...` | ✅ 200 / `application/json;charset=UTF-8` / 4.5KB |
| `curl -A "Mozilla/5.0 ... Chrome/131.0.0.0 ..." .../occ/.../<不正な SKU>?...` | ✅ 200 + `{ "error": { "errorCode": "INVALID_PRODUCT" } }` |

## 設計方針

### 経路選定: 「個別 hardcode」 vs 「経路学習キャッシュ統合」

**採用方針: 個別 hardcode (`viaCurlCffi` 直呼び)**

理由:
- ニトリ JSON API は **TLS + UA の二重 block** で経路が一意 (curl_cffi 必須)
- 他経路 (default UA / fallback UA / proxy) は構造的に救えない (TLS 切断は IP allowlist では救えず、proxy も TLS フィンガープリント固定で同様に切断)
- → cascade を踏む意味が無い、毎回 1 段目で curl_cffi 直行で十分
- yodobashi/sqex は HTML scraping (`scpaping` 経由 + 経路学習キャッシュ) だが、ニトリは **JSON API**: `getJson` は経路学習キャッシュ非統合 (phase14 のスコープ外)、かつ `getJson` 統合は影響範囲広い (6 プラグイン)

**却下した代替案: `getJson` 経路学習キャッシュ統合 → phase15.5 (仮) に切り出し**

`getJson` を `fetchResponse` 経路に統合すれば、`getJson(apiUrl, undefined, opts)` の一行でニトリ含む将来の同種ケースを救える。汎用性が高く本来あるべき設計。ただし:
- 影響範囲: 既存 6 プラグイン (spotify / komiflo / twitter / npmjs / youtube / syosetu) — 副作用評価が必要
- typeFilter / encoding 契約の変更
- 本 phase のスコープ膨張

→ **phase15.5 (仮) として TODO 登録**、本 phase は個別 hardcode で速やかに解決する。

### マッチ範囲

- ホスト: `www.nitori-net.jp` または `nitori-net.jp`
- パス: `^/ec/product/<sku>/?$` (商品詳細ページ固定形)
- 他のパス (`/ec/category/...` 等) はマッチしない (将来検討)

### URL → SKU 抽出

```
/ec/product/2116100013272s/  → "2116100013272s"
/ec/product/2116100013272s   → "2116100013272s"
```

### API URL 組み立て

```ts
const apiUrl = `https://www.nitori-net.jp/occ/v2/nitorinet/nitori/products/${encodeURIComponent(sku)}?handleError=true&lang=ja&curr=JPY`;
```

SKU は英数字+`s` 等の suffix なので encodeURIComponent はほぼ no-op、defense-in-depth のため適用。

### Summary 組み立て

| Summary フィールド | API ソース | フォールバック |
|---|---|---|
| `title` | `skuData.name` | (欠如時 throw) |
| `description` | `skuData.productDescription` (HTML strip + 300 文字 clip) | `null` |
| `thumbnail` | `skuData.mediasList[0]` (type=image) の `url` | `icon` |
| `icon` | `brand.imageUrl` | `https://www.nitori-net.jp/favicon.ico` |
| `sitename` | `brand.name` ("ニトリ") | `'ニトリネット'` |
| `player` | 空 (`url: null`) | — |
| `sensitive` | `false` 固定 | — |
| `activityPub` / `fediverseCreator` | `null` | — |

`productDescription` は HTML タグ込みで返ってくるので strip 関数で:
- `<br>` → 改行
- `<a href="...">text</a>` → `text` (リンク文字列のみ残す)
- HTML エンティティデコード (`&amp;` `&lt;` `&gt;` `&quot;` `&nbsp;`)
- HTML コメント (`<!-- ... -->`) 削除
- 連続空白を 1 個に縮約
- 300 文字超過時は末尾 `…` 付与

### エラーハンドリング

- `error.errorCode === 'INVALID_PRODUCT'` レスポンス → `StatusError(404)` を throw (`category: 'not_found'` 扱い)
- `skuData.name` が無い (API 仕様変更) → `Error('failed summarize: nitori API response missing skuData.name')` を throw (npmjs と同パターン)
- curl_cffi 設定が無効 / `domains` に `nitori-net.jp` が無い → 明示エラーを throw (silent fail を避ける)

### `skipRedirectResolution = true`

ニトリ商品 URL は終端確定 (短縮 URL でない、`/ec/product/<sku>/` 固定形)。
さらに HEAD probe も TLS layer で切断されるため、デフォルトの `resolveRedirect` が 20 秒空回りする
純損失を避けるため宣言する (yodobashi と同じ理由)。

## 実装ステップ (チェックリスト)

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — プラグイン本体**
  - [src/plugins/nitori.ts](../../src/plugins/nitori.ts) を新設
    - `export const name = 'nitori';`
    - `export const skipRedirectResolution = true;`
    - `test(url)`: ホスト `(www\.)?nitori-net\.jp$` かつ pathname が `^/ec/product/<sku>/?$`
    - `extractSku(pathname)`: pure 関数 (テスト用 export)
    - `buildApiUrl(sku)`: pure 関数 (テスト用 export)
    - `buildSummaryFromApi(body, url)`: pure 関数 (テスト用 export)
    - `stripAndTruncate(html, maxLen = 300)`: 内部 helper (export 不要だがテスト用に export 検討)
    - `summarize(url, opts)`:
      - SKU 抽出 → API URL 組み立て
      - `opts.curlCffiFallback` の検証 (enabled + domains)、不備なら throw
      - `viaCurlCffi(args, cfg)` で API 取得 (typeFilter `^application/(?:json|.*\+json)/`)
      - `JSON.parse` してから `buildSummaryFromApi` で組み立て
      - error response / skuData 欠如は throw
  - [src/plugins/index.ts](../../src/plugins/index.ts) に登録 (kakuyomu の後)
- [x] **Step 2 — ユニットテスト**
  - [test/plugins-nitori.test.ts](../../test/plugins-nitori.test.ts) を新設 (フィクスチャパターン、fastify mock 不要)
    - `extractSku` の URL バリエーション (末尾 `/` 有無、不正パス)
    - `buildApiUrl` の SKU エンコード
    - `buildSummaryFromApi` の正常レスポンス → Summary 組み立て
    - `buildSummaryFromApi` の error response (`INVALID_PRODUCT`) → throw
    - `buildSummaryFromApi` の skuData 欠如 → throw
    - `stripAndTruncate` の HTML strip / 300 文字切り詰め
  - フィクスチャは [test/jsons/](../../test/jsons/) (新設) に `nitori-product.json` として配置
- [x] **Step 3 — bootstrap.jsonl 追加 + config example 確認 (4.5 ドキュメント突き合わせ)**
  - [data/domain-strategy-bootstrap.jsonl](../../data/domain-strategy-bootstrap.jsonl) に `nitori-net.jp` および `www.nitori-net.jp` の `strategy: "curl_cffi"` エントリを追加
    - phase16.3 で `domains` TOML キーは廃止され、`curlCffiFallback.domains` は bootstrap.jsonl から自動導出される設計になっているため、bootstrap への追加で `[scraping.curl_cffi].enabled = true` 環境では allowlist に自動的に含まれる
    - 経路学習キャッシュ自体は `getJson` 経路を通らない (本プラグインは `viaCurlCffi` 直接呼び) ため、bootstrap entry は **`curlCffiFallback.domains` 派生のためのソース** として機能する (yodobashi/sqex の cache hit fast path とは意味が違う)
  - [config.example.toml](../../config.example.toml) と [docs/deploy-examples/summaly-config.example.toml](../../docs/deploy-examples/summaly-config.example.toml) の `[plugins].allowed` に `"nitori"` を追加 (新規プラグインを許可リストに反映)
  - [test/config-example-plugins.test.ts](../../test/config-example-plugins.test.ts) で自動検証 (新規プラグインが両 example の `[plugins.allowed]` に言及されているか fail-close ガード)
- [x] **Step 4 — dev サーバ動作確認**
  - [dev/sample-urls.ts](../../dev/sample-urls.ts) に「ニトリ商品 (JSON API + curl_cffi)」グループを追加
    - `https://www.nitori-net.jp/ec/product/2116100013272s/` (検証済 SKU)
    - 別 SKU 1〜2 件 (実機で OK だった商品)
- [x] **Step 5 — ドキュメント更新 (4.5)**
  - [CLAUDE.repo.md](../../CLAUDE.repo.md) の「対応形式 (組み込みプラグイン)」表に `nitori` 行を追加
    - マッチ条件: `(www.)?nitori-net.jp/ec/product/<sku>/`
    - 挙動: 公式 JSON API (`/occ/v2/nitorinet/nitori/products/<sku>`) を curl_cffi 経由で直叩き。TLS layer + UA layer の二重 bot block を curl_cffi で迂回。`[scraping.curl_cffi].domains` に `nitori-net.jp` 必須。`skipRedirectResolution = true`。
  - [README.md](../../README.md) のプラグイン表に nitori 行追加 (経路欄: `curl_cffi` + `JSON API`)
  - [docs/Plugins.md](../../docs/Plugins.md) に nitori セクション追加
  - [docs/SETUP.md](../../docs/SETUP.md) の `[scraping.curl_cffi]` 説明に nitori-net.jp の運用要件を追記
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased セクションに `feat(plugin): nitori プラグイン追加 (公式 JSON API + curl_cffi 経路)` を追加
  - [test/readme-plugins.test.ts](../../test/readme-plugins.test.ts) で同期漏れガード
- [x] **Step 6 — knowhow 更新**
  - [docs/knowhow/spa-dynamic-ogp-unfixable.md](../knowhow/spa-dynamic-ogp-unfixable.md) の nitori セクションを **更新** (救援不可 → 公式 JSON API で救援可能と判明、教訓として「fail mode I 判定前に隠れ JSON API 探索を 1 段挟む」を追記)
  - [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) に「**TLS bot block 配下サイトの公式 JSON API + curl_cffi 直接呼びパターン**」セクションを追加 (npmjs パターン = CF 配下 JSON API、本 phase = TLS 配下 JSON API + curl_cffi の組み合わせ、それぞれの典型として整理)
  - INDEX 更新
- [x] **Step 7 — 品質ゲート**
  - Stage 1: `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` 通過 + `bash .claude/tests/run-all.sh` 通過
  - Stage 2: `addf-code-review-agent` 通過 (Critical/High なし、Medium 以下は対応 or 記録)
  - `addf-contribution-agent` はスキップ条件「`.claude/` `docs/knowhow/ADDF/` `templates/` を含まない」に合致する見込み (knowhow 更新は本 repo の docs/knowhow/ 配下なのでスキップ可)
- [x] **Step 8 — phase15.5 (仮) を TODO 登録**
  - 「`getJson` を経路学習キャッシュ統合」を新 Plan ファイルに起票し TODO に追加 (将来検討メモではなく Plan としてバックログ化)
  - 着手トリガー: 同種ケース (TLS 配下 JSON API) が再発したとき、または `getJson` 利用箇所で経路学習キャッシュ統合の便益が見えたとき

## 完了条件 (Definition of Done)

- `https://www.nitori-net.jp/ec/product/<sku>/` で完璧な Summary (title / description / thumbnail / icon / sitename) が返る
- `name` 定数 + `skipRedirectResolution = true` が付与されている
- ユニットテスト (extractSku / buildApiUrl / buildSummaryFromApi / エラー系 / stripAndTruncate) が付いている
- config example 両ファイルに `nitori-net.jp` が追記されている
- dev サーバの sample-urls からワンクリックで動作確認できる
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- spa-dynamic-ogp-unfixable.md の nitori セクションが「救援可能」に更新されている

## リスク・注意点

1. **API 仕様変更リスク**: SAP Commerce Cloud 配下の `nitorinet/nitori` テナント設定が変わると `/occ/v2/...` 系 URL が消える可能性。`/occ/v2/sapnitori/...` (旧 path、現在 403) に変わったケースが過去にある。`buildSummaryFromApi` で `skuData.name` 欠如時は throw する設計で「いつ仕様が変わったか」を可視化
2. **TLS フィンガープリント追従コスト**: `curl_cffi` の `chrome120` impersonate が古くなって弾かれる可能性。yodobashi/sqex と同じ運用負担
3. **`curl_cffi` 未設定環境のデグレ**: Library 直接利用 / Fastify モードで `[scraping.curl_cffi]` 未設定 → プラグインが明示エラー throw する設計。silent fail を避けるが「設定したのに動かない」と思われない警告メッセージが必要 (e.g. `nitori plugin requires curl_cffi fallback to be enabled with "nitori-net.jp" in domains`)
4. **icon URL の陳腐化**: ニトリの brand logo URL は CDN 上の静的ファイル。陳腐化したら brand 動的取得に切り替えるか favicon フォールバックに変更
5. **PV カウント**: 公式 JSON API は商品詳細 PV と独立か不明 (恐らく独立、API は SAP Commerce 標準 endpoint)。アクセス頻度急増時にニトリ側で気付かれる可能性は低いが、Cache-Control が `no-cache, no-store` なので毎回叩く前提
6. **JSON エンコーディング契約**: `viaCurlCffi` は body を UTF-8 string で返す (Python `response.text` で decoded、Node 側で二重変換しない)。ニトリ API は `application/json;charset=UTF-8` で UTF-8 確定なので問題無し
7. **エラー response の category 分類**: `INVALID_PRODUCT` を `StatusError(404)` で投げる → `categorizeError` で `not_found` に分類される (`statusCode === 404` で判定)。phase11.6 の `FILTERED_CATEGORIES` で blocked candidate ログから除外されるべき (404 は救援不要)
