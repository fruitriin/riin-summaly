# TODO

`docs/plans/` の完了状態・優先度をトラックする。
`docs/plans/` と TODO が一致しなければ TODO を編集する。

phase 番号は **着手順**（数値が小さいほど先）。同じ大番号内（例: 2.1 と 2.2）は並列着手可能。

## 現在のフェーズ: phase13.1 + phase14 ともにほぼ完了 (2026-05-08)。残るは UI 手動検証範囲のみ。auto-run 可能タスク完了状態

## バックログ

| 優先度 | Phase | 計画ファイル | サイズ | 状態 |
|---|---|---|:---:|---|
| — | 11.2 | [docs/plans/phase11.2-error-category.md](docs/plans/phase11.2-error-category.md) — エラーレスポンスを `category` フィールドでカテゴリ化（[riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)） | S | 完了 (2026-05-05) |
| — | 11.4 | [docs/plans/phase11.4-plugin-npmjs.md](docs/plans/phase11.4-plugin-npmjs.md) — npmjs.com プラグイン（Cloudflare 配下の HTML を諦め Registry API 直叩き） | S | 完了 (2026-05-05) |
| — | 11.5 | [docs/plans/phase11.5-remove-diagnostics-endpoint.md](docs/plans/phase11.5-remove-diagnostics-endpoint.md) — `/__diagnostics/parse-failures` 診断エンドポイント廃止（プライバシーリスク撤去） | S | 完了 (2026-05-05) |
| — | 11.6 | [docs/plans/phase11.6-blocked-failure-log.md](docs/plans/phase11.6-blocked-failure-log.md) — 迂回候補ログ（4xx/5xx・timeout 等を別 JSONL に記録、別 API 発見器） | S〜M | 完了 (2026-05-05) |
| — | 11.7 | [docs/plans/phase11.7-favicon-thumbnail-fallback.md](docs/plans/phase11.7-favicon-thumbnail-fallback.md) — 汎用パスで OG 画像が無い場合 favicon を thumbnail に採用（[riin-summaly#3](https://github.com/fruitriin/riin-summaly/issues/3)） | S | 完了 (2026-05-05) |
| — | 11.8 | [docs/plans/phase11.8-fastify-error-logging.md](docs/plans/phase11.8-fastify-error-logging.md) — Fastify モードのエラー観測性回復（500 を pino ログに出す） | S | 完了 (2026-05-05) |
| — | 11.1 | [docs/plans/phase11.1-deps-update.md](docs/plans/phase11.1-deps-update.md) — 依存更新（patch/minor 安全帯 + major 個別検証） | S〜M | 完了 (2026-05-05、eslint 10 のみ次回送り) |
| — | 11.3 | [docs/plans/phase11.3-scpaping-follow-redirect.md](docs/plans/phase11.3-scpaping-follow-redirect.md) — Fastify モードで scpaping のリダイレクト follow が無効化されているバグ修正（[riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1) 真因） | S | 完了 (2026-05-05) |
| — | 11.9 | [docs/plans/phase11.9-bot-block-ua-retry.md](docs/plans/phase11.9-bot-block-ua-retry.md) — bot block 対策（複合 UA + フォールバック UA リトライ）。`SummalyBot` 文字列で WAF に弾かれるサイトを救援（実証 2/3 救える） | M | 完了 (2026-05-05、pino fallback フィールドは phase11.6 に廆す) |
| — | 12.1 | [docs/plans/phase12.1-cf-workers-proxy-fallback.md](docs/plans/phase12.1-cf-workers-proxy-fallback.md) — Cloudflare Workers Free を outbound proxy として使い、Amazon class の IP block を救援。実験ステップ (Step 1.3) で GO/NO-GO 判定する設計 | M〜L | 完了 (2026-05-05 GO 確定 → 2026-05-06 followup #1〜#4 で `Rejected by type filter undefined` / 長 query / bare hostname / amzn.asia 短縮 URL すべて本番救援動作確認済み。Step 5 pino fallback フィールドのみ phase11.6 deferral と合流予定) |
| 高 | 12.5 | [docs/plans/phase12.5-curl-cffi-fetcher.md](docs/plans/phase12.5-curl-cffi-fetcher.md) — `curl_cffi` (libcurl-impersonate) で Chrome TLS フィンガープリントを偽装し、yodobashi 級の TLS layer bot block を救援。Step 1 実験 GO 確定 (2026-05-06)、Step 2 Node IPC 統合は次サイクル | M〜L | 進行中 (Step 1 完了、Step 2/3 残) |
| — | 12.6 | [docs/plans/phase12.6-sqex-store-proxy.md](docs/plans/phase12.6-sqex-store-proxy.md) — Square Enix e-STORE (`store.jp.square-enix.com`) 救援。`forceProxyFallback` フラグ新設 + sqex プラグイン追加。データセンター IP を CDN 段で広く弾く新パターン (HTTP 200 + 正規 404 ページボディ、エラーシグナル無し) を救援 | S〜M | 完了 (2026-05-07、本番デプロイ + 動作確認は運用者側) |
| 中 | 13.1 | [docs/plans/phase13.1-syosetu-embed.md](docs/plans/phase13.1-syosetu-embed.md) — 小説家になろうプラグイン + `/embed` エンドポイント基盤。プレイヤー iframe で作者・ジャンル・あらすじを表示（JS 一切なしのバニラ HTML+CSS、CSP `default-src 'none'`、XSS 全エスケープ）。なろう公式 API 直叩き、R-18 ドメインで `sensitive: true` | M〜L | ほぼ完了 (Step 1 + 2 + 3 + 4 部分 + 6 + 7 完了 2026-05-08。残 Step 5 dev 手動 — UI 検証必要のため自動化対象外) |
| 高 | 14 | [docs/plans/phase14-domain-strategy-cache.md](docs/plans/phase14-domain-strategy-cache.md) — 経路学習キャッシュ (host + path prefix 2段、JSONL 永続化、N 連続失敗で invalidate)。bootstrap JSONL 同梱で初回コスト回避。`forceCurlCffiFallback` / `forceProxyFallback` を廃止し、プラグインは「引き出し方の自在性」専用に整理。汎用パスでも自動最適化される | M〜L | ほぼ完了 (Step 1 + 2 系 + 3 + 4 + 6 + 7 + 5 部分 (`/api/strategy-cache` API) 完了 2026-05-08、残る UI パネル + 目視検証のみ — 手動範囲) |

### 将来検討メモ (Plan は未起票)

| メモ項目 | 概要 | 検討トリガー |
|---|---|---|
| **Playwright モード (fail mode I 対策)** | SPA + JS 動的 OGP 注入 (nitori-net 等、`/url-preview-check` skill の fail mode I) を救援するために実ブラウザレンダリングを導入する。**設計方針**: yodobashi の `forceCurlCffiFallback` と同じく **「前段を丸ごとスキップして Playwright モード直行」** をプラグイン側で宣言できる形 (`forcePlaywrightFallback: true` を渡す) にする。CF Workers Browser Rendering ではなく **自前で Playwright を抱える** 方針 (個人運用で課金を増やさないため、Vultr のメモリ拡張が必要)。`tools/playwright-fetcher/` を curl_cffi と同じ tools 配下に分離して npm publish 対象外。allowlist 必須 (任意 URL での JS 実行は SSRF + RCE 経路の温床)。L 〜 XL サイズ | fail mode I の発生頻度が無視できないレベル (例: `parse-failure-log` で月 N 件) になってきた時、もしくは個人的に preview したい SPA EC が増えた時 |

### 外部リポ連携（summaly スコープ外）

| 項目 | 概要 | 状態 |
|---|---|---|
| Misskey fork: UrlPreview の `lang` を localStorage 生値ベースに変更 | `frontend-shared/js/config.ts` の `?? 'en-US'` ハードコードで未設定ユーザーが `lang=en-US` を summaly に送り続ける問題の根本対策 | 計画のみ（Misskey fork 側で実施） |
| Misskey fork: summaly の `error.category` を受け取って分岐表示 | phase11.2 が完了したら受け側を実装。「プレビューできませんでした」を timeout / bot block / 404 等に細分化 | 計画のみ（phase11.2 完了後に着手） |
| Misskey fork: Amazon プレビュー失敗の切り分け（[riin-summaly#1](https://github.com/fruitriin/riin-summaly/issues/1)） | summaly 単体では取れる URL (`amzn.asia/d/07Bh8rNE`) が Misskey 上で失敗する原因を Misskey クライアント・サーバのどこで弾いているか特定 | 調査タスク（Misskey fork 側） |

> 上記 3 件すべての詳細は [docs/plans/external-misskey-fork-urlpreview-lang.md](docs/plans/external-misskey-fork-urlpreview-lang.md) に集約。

### 並列実行マップ

```
phase1.1  完了
phase1.2  完了
phase2.1  完了
phase2.2  完了
   ↓
phase3.1  完了
phase3.2  完了
phase4.1  完了
phase4.2  完了
phase5.1  完了
phase7.1  完了
phase8.1  完了
phase6.1  完了
phase9.1  完了
phase10.1 完了
   ↓
phase11.1 完了（依存更新、eslint 10 のみ次回送り）
phase11.2 完了（エラーカテゴリ化）
phase11.4 完了（npmjs プラグイン）
phase11.5 完了（診断エンドポイント廃止）
phase11.6 完了（迂回候補ログ）
phase11.7 完了（favicon サムネ）
phase11.8 完了（エラーログ出力）
phase11.9 完了（bot block UA リトライ、pino fallback フィールドは phase11.6 に廆す）
   ↓
phase12.1 完了（CF Workers proxy fallback、Step 1〜7 + dev 統合 + E2E 検証済、pino fallback のみ phase11.6 と合流予定）
phase12.2 完了（youtube /live/ URL 対応）
phase12.3 完了（nintendo-store プラグイン、facebookexternalhit UA 固定）
phase12.4 完了（yodobashi プラグイン、proxy categories 拡張パターン）
phase12.5 進行中（curl_cffi TLS impersonation、Step 1 GO 確定、Step 2 Node IPC 統合は次サイクル）
phase12.6 完了（sqex プラグイン + forceProxyFallback 新設、エラーシグナルなし IP block 新パターン救援）
   ↓
phase13.1 ほぼ完了（Step 1+2+3+4 部分+6+7 完了 2026-05-08、Step 5 dev 手動のみ残）
phase14   ほぼ完了（Step 1+2+3+4+6+7+5 部分 (`/api/strategy-cache`) 完了 2026-05-08、残る Step 5 UI パネル + 目視検証のみ — 手動範囲）
```

---

## アーカイブ

| Phase | 計画ファイル | 状態 |
|---|---|---|
| 1.1 | [docs/plans/phase1.1-fastify-cache-control.md](docs/plans/phase1.1-fastify-cache-control.md) — Fastify Cache-Control 即修正 ([issue #27](https://github.com/misskey-dev/summaly/issues/27)) | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase1.1-fastify-cache-control.md](.claude/Progresses/2026-05-03-phase1.1-fastify-cache-control.md) |
| 1.2 | [docs/plans/phase1.2-options-mutation-fix.md](docs/plans/phase1.2-options-mutation-fix.md) — `summaly()` の opts mutation バグ修正 | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase1.2-options-mutation-fix.md](.claude/Progresses/2026-05-03-phase1.2-options-mutation-fix.md) |
| 2.1 | [docs/plans/phase2.1-plugin-infrastructure.md](docs/plans/phase2.1-plugin-infrastructure.md) — プラグイン基盤（getJson / name / UA / 短縮URL） | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase2.1-plugin-infrastructure.md](.claude/Progresses/2026-05-03-phase2.1-plugin-infrastructure.md) |
| 2.2 | [docs/plans/phase2.2-mei23-non-plugin.md](docs/plans/phase2.2-mei23-non-plugin.md) — mei23 非プラグイン軽量変更（PDF除く / [issue #39](https://github.com/misskey-dev/summaly/issues/39) 含む） | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase2.2-mei23-non-plugin.md](.claude/Progresses/2026-05-03-phase2.2-mei23-non-plugin.md) |
| 3.1 | [docs/plans/phase3.1-plugin-oembed.md](docs/plans/phase3.1-plugin-oembed.md) — oEmbed 系プラグイン（youtube / spotify） | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase3.1-plugin-oembed.md](.claude/Progresses/2026-05-03-phase3.1-plugin-oembed.md) |
| 3.2 | [docs/plans/phase3.2-plugin-dom.md](docs/plans/phase3.2-plugin-dom.md) — DOM 後処理系プラグイン（dlsite / iwara / komiflo / nijie） | 完了 (2026-05-04)、Progress: [.claude/Progresses/2026-05-04-phase3.2-plugin-dom.md](.claude/Progresses/2026-05-04-phase3.2-plugin-dom.md) |
| 4.1 | [docs/plans/phase4.1-fastify-in-memory-cache.md](docs/plans/phase4.1-fastify-in-memory-cache.md) — Fastify インメモリ LRU キャッシュ | 完了 (2026-05-04)、Progress: [.claude/Progresses/2026-05-04-phase4.1-fastify-in-memory-cache.md](.claude/Progresses/2026-05-04-phase4.1-fastify-in-memory-cache.md) |
| 4.2 | [docs/plans/phase4.2-inflight-dedup.md](docs/plans/phase4.2-inflight-dedup.md) — Fastify in-flight dedup（thundering herd 緩和） | 完了 (2026-05-04)、Progress: [.claude/Progresses/2026-05-04-phase4.2-inflight-dedup.md](.claude/Progresses/2026-05-04-phase4.2-inflight-dedup.md) |
| 5.1 | [docs/plans/phase5.1-pdf-support.md](docs/plans/phase5.1-pdf-support.md) — PDF 対応（オプトイン+ハング対策5層） | 完了 (2026-05-04)、Progress: [.claude/Progresses/2026-05-04-phase5.1-pdf-support.md](.claude/Progresses/2026-05-04-phase5.1-pdf-support.md) |
| 7.1 | [docs/plans/phase7.1-dev-server.md](docs/plans/phase7.1-dev-server.md) — Dev サーバ（動作確認 UI） | 完了 (2026-05-05)、Progress: [.claude/Progresses/2026-05-05-phase7.1-dev-server.md](.claude/Progresses/2026-05-05-phase7.1-dev-server.md) |
| 8.1 | [docs/plans/phase8.1-toml-config.md](docs/plans/phase8.1-toml-config.md) — TOML ベースの設定ファイルへの移行 | 完了 (2026-05-05)、Progress: [.claude/Progresses/2026-05-05-phase8.1-toml-config.md](.claude/Progresses/2026-05-05-phase8.1-toml-config.md) |
| 6.1 | [docs/plans/phase6.1-plugin-twitter.md](docs/plans/phase6.1-plugin-twitter.md) — twitter (X) プラグイン取り込み（mei23 fork ベース + player iframe 追加） | 完了 (2026-05-05) |
| 9.1 | [docs/plans/phase9.1-short-url-get-fallback.md](docs/plans/phase9.1-short-url-get-fallback.md) — 短縮 URL の HEAD 失敗時 GET フォールバック | 完了 (2026-05-05) |
| 10.1 | [docs/plans/phase10.1-parse-failure-log.md](docs/plans/phase10.1-parse-failure-log.md) — パース失敗ドメインのログ蓄積（プラグイン候補発見器） | 完了 (2026-05-05) |
