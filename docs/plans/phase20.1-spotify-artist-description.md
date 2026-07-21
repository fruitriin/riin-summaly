# phase20.1 — Spotify アーティスト名補完 (description フィールド)

> **追認 Plan**: 本 Plan は外部コントリビューター shika さん ([@t1nyb0x](https://github.com/t1nyb0x)) の [PR #6](https://github.com/fruitriin/riin-summaly/pull/6) として**実装が先行**し、レビュー・品質ゲート通過後に実装内容から遡って起票したもの。コントリビューションモデル（「コードではなく計画をレビューする」）の設計記録として残す。

## 背景

spotify プラグイン（phase3.1）は oEmbed API (`open.spotify.com/oembed`) 直叩きで title / thumbnail / player を取得するが、**oEmbed レスポンスにはアーティスト情報が含まれない**ため `description: null` 固定だった。Misskey のプレビューカードで「曲名だけ表示され誰の曲か分からない」状態になる。

### 調査結果（黒箱確認、実ページ curl 検証済み）

`facebookexternalhit/1.1` UA でページ本体を叩くとフル OGP が返る（nintendo-store / dmm と同型の SNS bot UA allowlist パターン）:

| ページ種別 | og:type | アーティスト名の所在 |
|---|---|---|
| 楽曲 `/track/<id>` | `music.song` | `<meta name="music:musician_description" content="Ed Sheeran">` |
| アルバム `/album/<id>` | `music.album` | `musician_description` **無し**。`og:description="Ed Sheeran · album · 2017 · 16 songs"` の先頭セグメント |
| プレイリスト `/playlist/<id>` | `music.playlist` | 無し（`og:description` 先頭は `"Playlist"`） |
| アーティスト `/artist/<id>` | `profile` | ページ自体がアーティスト（抽出対象外） |

重要な発見 2 点:

1. **`musician_description` は `property=` ではなく `name=` 属性**で出力される（OGP 標準からは外れた出し方）。`meta[property=...]` セレクタでは取得できない
2. **locale プレフィックス URL** (`/intl-ja/track/...` 等) も同構造で、`musician_description` がローカライズされて返る（例: 「エド・シーラン」）

## ゴール

`open.spotify.com` の track / album URL について、`SummalyResult.description` にアーティスト名を格納する。

- oEmbed 取得とページ本体取得を `Promise.all` で並行発火し、レイテンシ増加を最小化
- ページ本体取得が bot block / timeout 等で失敗しても **oEmbed ベースの summary はそのまま返す**（`description: null`）フェイルセーフ
- 補助 fetch（description は「あれば嬉しい」情報）を本体経路から分離し、既存機構への副作用を出さない

## 設計詳細

### アーティスト抽出 (`extractArtist`, pure 関数 export)

1. `og:type` が `music.song` / `music.album`（`ARTIST_BEARING_OG_TYPES`）以外は null
2. `meta[name="music:musician_description"]` があれば優先（track のみ存在）
3. 無ければ `og:description` の `·` split 先頭セグメント（album フォールバック）

### 補助 fetch (`fetchArtist`) — 本体経路からの分離 3 点セット

```typescript
const { $ } = await scpaping(url.href, {
	...opts,
	userAgent: FB_BOT_UA,
	responseTimeout: 5000,        // 本体 (20s) より短く。Promise.all 全体を引きずらない
	operationTimeout: 10000,
	fallbackUserAgent: undefined,        // FB UA 固定が fallback UA に上書きされるのを防止
	fallbackRetryCategories: undefined,
	proxyFallback: undefined,            // 補助 fetch は default 経路のみ。外部経路 quota を消費しない
	curlCffiFallback: undefined,
	_cacheRecording: undefined,          // 経路学習キャッシュ記録と混線させない
});
```

**`_cacheRecording` 遮断の理由**（レビューで発見された構造問題）: spotify の主経路 (oEmbed `getJson`) は経路学習キャッシュ非統合で recordKey を書かないため、opts を素通しすると共有 state には**補助 fetch の結果だけ**が書き込まれる。具体的な実害 3 経路 — ①補助 fetch の hedge 発火で proxy / curl_cffi が champion 昇格して常用される、②メイン成功なのに hedge 全滅ログが pino に出る誤帰属、③oEmbed 障害がページ fetch 経路の連続失敗カウント（N 連続で entry 破棄）に計上される。

**同型パターンへの一般教訓**: プラグイン内で本体とは別の補助 scpaping を行う場合、`...opts` spread は fallback UA 系だけでなく **`proxyFallback` / `curlCffiFallback` / `_cacheRecording` も明示打ち消し**が必要。

### パス事前ゲート (`isArtistBearingPath`, pure 関数 export)

```typescript
const ARTIST_BEARING_PATH = /^\/(?:intl-[a-z-]+\/)?(?:track|album)\//;
```

playlist / artist / show / episode は og:type 判定で必ず null になるため **fetch 自体を省く**（外部リクエストが恒常的に 2 倍になるのを防止）。

### summarize の合成

`Promise.all([getJson(oEmbedUrl), fetchArtist(url)])` → `buildSummaryFromOEmbed` の結果に `summary.description = artist` を代入。oEmbed が null なら従来通り null を返す。

## ステップと完了状況

- [x] Step 1: `extractArtist` 実装 + `summarize` の Promise.all 統合（PR #6 初版 243284e、shika さん）
- [x] Step 2: 単体テスト 4 件（music.song 優先 / music.album フォールバック / playlist・profile 対象外 / メタ欠落）
- [x] Step 3: docs/Plugins.md / CHANGELOG 更新（同上）
- [x] Step 4: レビュー + 品質ゲート（build / eslint / typecheck / test / ADDF テスト全パス、一次 + 二次レビューで指摘 8 件）
- [x] Step 5: レビュー対応コミット 2a178e9（パス事前ゲート / 短縮タイムアウト / 経路分離 3 打ち消し / `name=` 根拠コメント / README 同期 / `isArtistBearingPath` テスト追加、計 722 件 pass）
- [x] Step 6: E2E 検証 — track `/intl-ja/track/7qiZfU4dY1lWllzX7mPBI3` → `description: "エド・シーラン"`（約 1.2s）、playlist → `null` + 補助 fetch 不発火（約 0.7s）

## レビュー指摘と対応

| # | Severity | 指摘 | 対応 |
|---|---|---|---|
| 1 | Medium | Promise.all で補助 fetch のハングが summarize 全体のレイテンシを引きずる | ✅ 短縮タイムアウト (5s/10s) |
| 2 | Medium | playlist / artist / show 等でも常にページ fetch が発火 | ✅ `isArtistBearingPath` 事前ゲート |
| 3 | Medium | `proxyFallback` / `curlCffiFallback` / `_cacheRecording` 素通しによる経路学習キャッシュ混線（escalate / hedge ログ誤帰属 / 失敗誤帰属） | ✅ 3 フィールド明示無効化 |
| 4 | Medium | README のプラグイン表・抽出戦略記述が未更新（`readme-plugins.test.ts` は名前言及のみ検証のため素通し） | ✅ 両箇所同期 |
| 5 | Low | 経路学習キャッシュへの entry 記録副作用 | ✅ #3 で構造的に解消 |
| 6 | Low | `og:description` の `·` split はアーティスト名に `·` を含むケースで誤分割（album フォールバックのみ、track は musician_description 優先で影響なし） | 許容（実害稀） |
| 7 | Low | summarize 統合経路（合成 + フェイルセーフ）が未テスト。`composeSummary(oEmbed, artist)` 切り出しでテスト可能化する案 | 将来検討（下記） |
| 8 | Info | `name=` 属性選択の根拠コメント無し | ✅ 実ページ確認済みの旨をコメント化 |

## 将来検討

- **`composeSummary` pure 関数切り出し**: 「fetchArtist 失敗時に description: null で返す」契約の自動テスト担保。phase11.4 の「動詞 + 名詞句」pure 関数命名テンプレと整合。実装コスト S、必須ではない
- **show / episode (podcast) のクリエイター名対応**: 本 phase は music 系 og:type のみ。podcast の og:description 構造を確認すれば同パターンで拡張可能
