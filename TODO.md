# TODO

`docs/plans/` の完了状態・優先度をトラックする。
`docs/plans/` と TODO が一致しなければ TODO を編集する。

phase 番号は **着手順**（数値が小さいほど先）。同じ大番号内（例: 2.1 と 2.2）は並列着手可能。

## 現在のフェーズ: phase18 完了 (2026-05-10、phase18.1 派生まで)。auto-run 可能タスクは phase15.3 (DMM プラグイン、サイズ S) のみ残

> **次サイクル候補消化状況** (`docs/knowhow/addf-dev-operation-patterns.md` 「auto-run 可能タスクが尽きたときの運用」参照):
> 1. **Plan の半自動 Step を切り分けて API 部分だけ実装** — 候補なし (phase14 Step 5 API は実装済)
> 2. **累積 Feedback の knowhow 化** — 完了 (docs/knowhow/addf-dev-operation-patterns.md 新設、2026-05-08)
> 3. **既存負債の自動修正** — 完了 (2026-05-08、`general.ts` spread refactor + `followRedirects: undefined` 明示 override)
> 4. **将来検討メモ から Plan 起票** — 完了 (2026-05-08、Playwright モードを `phase15.1-playwright-fallback.md` として昇格)
> 5. **PushNotification + CronDelete でオーナーに通知して `/loop` 停止** — option 1〜4 すべて消化済。次サイクル以降に auto-runnable がなければ実行検討

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
| — | 12.5 | [docs/plans/phase12.5-curl-cffi-fetcher.md](docs/plans/phase12.5-curl-cffi-fetcher.md) — `curl_cffi` (libcurl-impersonate) で Chrome TLS フィンガープリントを偽装し、yodobashi 級の TLS layer bot block を救援 | M〜L | 完了 (Step 1+2+3 完了 2026-05-06、daemon 化検討のみ将来課題) |
| — | 12.6 | [docs/plans/phase12.6-sqex-store-proxy.md](docs/plans/phase12.6-sqex-store-proxy.md) — Square Enix e-STORE (`store.jp.square-enix.com`) 救援。`forceProxyFallback` フラグ新設 + sqex プラグイン追加。データセンター IP を CDN 段で広く弾く新パターン (HTTP 200 + 正規 404 ページボディ、エラーシグナル無し) を救援 | S〜M | 完了 (2026-05-07、本番デプロイ + 動作確認は運用者側) |
| 中 | 13.1 | [docs/plans/phase13.1-syosetu-embed.md](docs/plans/phase13.1-syosetu-embed.md) — 小説家になろうプラグイン + `/embed` エンドポイント基盤。プレイヤー iframe で作者・ジャンル・あらすじを表示（JS 一切なしのバニラ HTML+CSS、CSP `default-src 'none'`、XSS 全エスケープ）。なろう公式 API 直叩き、R-18 ドメインで `sensitive: true` | M〜L | ほぼ完了 (Step 1 + 2 + 3 + 4 部分 + 6 + 7 完了 2026-05-08。残 Step 5 dev 手動 — UI 検証必要のため自動化対象外) |
| 高 | 14 | [docs/plans/phase14-domain-strategy-cache.md](docs/plans/phase14-domain-strategy-cache.md) — 経路学習キャッシュ (host + path prefix 2段、JSONL 永続化、N 連続失敗で invalidate)。bootstrap JSONL 同梱で初回コスト回避。`forceCurlCffiFallback` / `forceProxyFallback` を廃止し、プラグインは「引き出し方の自在性」専用に整理。汎用パスでも自動最適化される | M〜L | ほぼ完了 (Step 1 + 2 系 + 3 + 4 + 6 + 7 + 5 部分 (`/api/strategy-cache` API) 完了 2026-05-08、残る UI パネル + 目視検証のみ — 手動範囲) |
| — | 15.6 | [docs/plans/phase15.6-nsfw-card-suppress-shared.md](docs/plans/phase15.6-nsfw-card-suppress-shared.md) — NSFW プラグイン共通: card 抑制 + embed フル表示の二層構造を `dlsite` / `iwara` / `komiflo` / `nijie` に横展開。`src/utils/nsfw-card-suppress.ts` + `nsfw-embed-html.ts` の共通 helper 化、5 プラグインで sensitive=true のときのみ抑制発火、`renderEmbed` 経由フル表示。dlsite `/comic/` / iwara `www.` 等の sensitive=false 経路は素通し維持 | M | 完了 (2026-05-11、本番デプロイは運用者側) |
| — | 15.5 | [docs/plans/phase15.5-dmm-card-suppress-embed.md](docs/plans/phase15.5-dmm-card-suppress-embed.md) — DMM プラグイン card 抑制 + embed フル表示の二層構造。phase15.3 の素朴実装で og:image / og:description が直球すぎた問題への対応。card は title 「【sitename】og:title」 / description 固定 「【R-18】 内容を伏せています」 / thumbnail null、`renderEmbed` で作品サムネ・あらすじをフル表示 (embed は明示展開原則)。XSS 防御 + CSP 多層防御 | M | 完了 (2026-05-10、本番デプロイは運用者側) |
| — | 15.3 | [docs/plans/phase15.3-plugin-dmm.md](docs/plans/phase15.3-plugin-dmm.md) — DMM (FANZA) プラグイン。`dmm.co.jp` 全サブドメインで age_check ゲートを `facebookexternalhit/1.1` UA allowlist 経由で素通し (fail mode G、nintendo-store と同型)。`skipRedirectResolution = true` で HEAD probe による gate 書き換えを回避、`sensitive: true` 固定、両 config example でコメントアウトデフォルト (NSFW 慣例) | S | 完了 (2026-05-10、本番デプロイ + 動作確認は運用者側) |
| 低 | 15.1 | [docs/plans/phase15.1-playwright-fallback.md](docs/plans/phase15.1-playwright-fallback.md) — Playwright モード (fail mode I 救援、SPA + JS 動的 OGP 注入対応)。phase14 経路学習キャッシュに `'playwright'` strategy を追加。`tools/playwright-fetcher/` 独立構成、allowlist 必須、メモリ要件あり (Vultr 拡張)。実ブラウザレンダリングのため最終手段位置付け | L〜XL | 未着手 (着手トリガー: fail mode I 発生頻度 月 N 件 / 個人的に preview したい SPA EC が増えた時) |
| — | 15.4 | [docs/plans/phase15.4-plugin-nitori.md](docs/plans/phase15.4-plugin-nitori.md) — ニトリ (nitori-net.jp) プラグイン。公式 JSON API + curl_cffi 経路で TLS bot block 迂回を試みたが、**Followup #2 (2026-05-10)** で fail mode J 確定 (datacenter IP 全般 block、CF Workers proxy AS13335 でも 520 を観測)。プラグイン本体は維持、両 config example の `[plugins].allowed` からはコメントアウト形式で外す。家庭用 IP / library 直接利用者は引き続き使える。Followup #1 の curl_cffi CLI `--header` 機構は他の JSON API ケース用に資産として残す | M | 完了 (2026-05-10、fail mode J で本番運用は救援不可、Playwright (phase15.1) または residential proxy 待ち) |
| — | 16.1 | [docs/plans/phase16.1-docs-route-strategy.md](docs/plans/phase16.1-docs-route-strategy.md) — ドキュメント網羅性更新 (経路優先システムを目玉特徴に位置づけ)。README に「経路優先システム」セクション新設 + 4 経路 (Summaly UA / SNS Bot UA / Proxy / curl_cffi) + 経路学習キャッシュの俯瞰、プラグイン表に kakuyomu 行 + 経路列追加、test/readme-plugins.test.ts で同期漏れを構造的にガード | S〜M | 完了 (2026-05-08) |
| — | 16.2 | [docs/plans/phase16.2-deprecated-md.md](docs/plans/phase16.2-deprecated-md.md) — 廃止された機能の経緯記述を `DEPRECATED.md` に集約。旧 fastify-cli / 診断エンドポイント / parseFailureLogEndpoint / forceX プラグインフラグの 4 機能について「旧 / 新 / 廃止理由 / 移行手順」を一貫構成で記載、各 docs からは 1 行サマリ + リンクに簡素化 | S〜M | 完了 (2026-05-09) |
| — | 16.3 | [docs/plans/phase16.3-config-cleanup.md](docs/plans/phase16.3-config-cleanup.md) — config 整理 + 経路依存 fail-fast (breaking)。`[server].publicUrl` → `[embed].publicUrl` 移動 / `[embed].allowedPlugins` 削除 / `[scraping.proxy]` / `[scraping.curl_cffi]` / `[scraping.fallback]` の `categories` / `domains` TOML キー削除 (コード側固定 + bootstrap 自動導出) / `expectKnownKeys` 全セクション起動失敗化 / 経路依存 fail-fast / `useRange` default true / `parseFailureLog` ペア + デフォルト | M〜L | 完了 (2026-05-09) |
| — | 16.4 | [docs/plans/phase16.4-startup-healthcheck.md](docs/plans/phase16.4-startup-healthcheck.md) — 起動時 healthcheck (placeholder + 疎通検証)。`enabled = true` の各機能設定値が placeholder のまま (`<your>` / `/path/to/` / `...`) や uv が PATH に無い等を起動時 fail-fast。example で必須キーを placeholder で残しておけるようにする UX 改善 | S〜M | 完了 (2026-05-09) |
| 低 | 16.5 | docs/SETUP.md の `[scraping.proxy]` / `[scraping.curl_cffi]` / `[scraping.fallback]` セクションの詳細表 (`categories` / `domains` 設定例) を全面整理。phase16.3 で表面的整合性のみ取った状態のため、内部仕様の説明として残すか / 削除するか判断 | S | 未着手 |
| 低 | 16.6 | proxy 実 HTTP 疎通テスト。Worker 側に `/health` endpoint 追加 + summaly 起動時に HMAC なしで GET → 200 確認。phase16.4 では placeholder 検出のみで止めた、実 HTTP は別 phase | S〜M | 未着手 |
| 低 | 17.1 | [docs/plans/phase17.1-addf-upstream-prune-stale-markers.md](docs/plans/phase17.1-addf-upstream-prune-stale-markers.md) — `prune-stale-markers` スキルを ADDF 本体に upstream。summaly 側で実証済 (src/+bin/ で 156→5 件、96.8% 削減)。ADDF 利用プロジェクト全般の履歴マーカー累積問題への横展開 | S〜M | 未着手 (着手トリガー: ADDF 本体への寄与タイミング、急がない) |
| — | 18 | [docs/plans/phase18-hedged-fallback.md](docs/plans/phase18-hedged-fallback.md) — Hedged fallback (champion / challenger 並列発火) で経路選定を全自動化。第一候補 (champion) 失敗 or 5 秒遅延で残り全 strategy を `Promise.any` 並列発火、最速 valid 結果を採用 + 即昇格 (1 回で promotion、N 連続要件なし、降格・除外なし)。Python 側 SSRF ガード追加 (`assert_public_ip`)。`[scraping.fallback].hedgedThresholdMs` 新規 (default 5000)。**経路問題だけのサイト (monotaro クラス) は plugin / config 編集なしで自動救援される**。phase18.1 で healthcheck `uv run fetch --help` / monotaro fail mode J 整理 / Worker `ALLOWED_DOMAINS` 撤廃まで派生対応済 | M〜L | 完了 (2026-05-10、Step 1〜7 + phase18.1 派生まで完了 619 件 pass。`domains` 物理撤廃 / プラグイン棚卸し / 本番デプロイ動作確認は将来 phase or 運用者範囲) |
| 中 | 19.1 | [docs/plans/phase19.1-plugin-google-drive.md](docs/plans/phase19.1-plugin-google-drive.md) — Google Drive プレビュープラグイン (iframe player)。`drive.google.com/file/d/<id>/...` を `…/preview` iframe player で返す (video / PDF / 画像 / Docs 全種別)。oEmbed 不在のため player URL を pure 構築、`skipRedirectResolution = true`、title/thumbnail は匿名メタ取得不可で null。**Google Photos は `x-frame-options: SAMEORIGIN` で iframe 不可のため本 phase スコープ外** (Playwright 導入後に card 表示で再検討) | S | 完了 (2026-06-01、Step 1〜4 + E2E 検証完了 677 件 pass。レビュー W-1/W-2/S-1/S-3 対応済。本番デプロイは運用者側) |

### 将来検討メモ (Plan は未起票)

> **2026-05-08**: Playwright モード (fail mode I 対策) は [docs/plans/phase15.1-playwright-fallback.md](docs/plans/phase15.1-playwright-fallback.md) に Plan 昇格しました。phase14 経路学習キャッシュに統合する設計方針 (旧 `forcePlaywrightFallback` フラグ案は廃止、`'playwright'` strategy を bootstrap JSONL に追加する形に変更)。着手トリガーは引き続き「fail mode I の発生頻度が無視できないレベル」または「個人的に preview したい SPA EC が増えた時」。

- **phase15.5 候補 (Plan 未起票): `getJson` の経路学習キャッシュ統合**: phase15.4 (nitori) で「JSON API も TLS layer block 配下にあり curl_cffi 経由が必要」というパターンが発見された。現状 `getJson` は `getResponse` 直接呼びで経路学習キャッシュ非統合のため、ニトリプラグインは `viaCurlCffi` 直接呼びの個別 hardcode 方式を取った。同種ケース (TLS 配下 JSON API) が再発したり、`getJson` 利用箇所 (spotify / komiflo / twitter / npmjs / youtube / syosetu) で経路学習キャッシュの便益が見えたら、`getJson` 内部を `fetchResponse` 経路 (typeFilter を JSON 用に上書き) に書き換えることで全プラグイン透過的に経路学習キャッシュ恩恵を受けられる。**着手トリガー**: 同種ケース再発 / `getJson` 利用箇所での経路問題発覚 (e.g. komiflo の `api.komiflo.com` 経由が将来 bot block されるケース等)。サイズ M (`getJson` 改修 + 6 プラグインの副作用評価)

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
phase12.5 完了（curl_cffi TLS impersonation、Step 1+2+3 完了 2026-05-06、daemon 化検討のみ将来課題）
phase12.6 完了（sqex プラグイン + forceProxyFallback 新設、エラーシグナルなし IP block 新パターン救援）
   ↓
phase13.1 ほぼ完了（Step 1+2+3+4 部分+6+7 完了 2026-05-08、Step 5 dev 手動のみ残）
phase14   ほぼ完了（Step 1+2+3+4+6+7+5 部分 (`/api/strategy-cache`) 完了 2026-05-08、残る Step 5 UI パネル + 目視検証のみ — 手動範囲）
   ↓
phase15.1 未着手（Playwright モード、fail mode I 救援。着手トリガー: 発生頻度月 N 件 / 個人的に preview したい SPA EC 増加）
   ↓
phase18   完了（Hedged fallback、champion / challenger 並列発火で経路選定全自動化、BREAKING、phase18.1 派生対応含む）
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
