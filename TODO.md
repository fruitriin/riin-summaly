# TODO

`docs/plans/` の完了状態・優先度をトラックする。
`docs/plans/` と TODO が一致しなければ TODO を編集する。

phase 番号は **着手順**（数値が小さいほど先）。同じ大番号内（例: 2.1 と 2.2）は並列着手可能。

## 現在のフェーズ: phase11.1 待ち

## バックログ

| 優先度 | Phase | 計画ファイル | サイズ | 状態 |
|---|---|---|:---:|---|
| 中 | 11.1 | [docs/plans/phase11.1-deps-update.md](docs/plans/phase11.1-deps-update.md) — 依存更新（patch/minor 安全帯 + major 個別検証） | S〜M | 未着手 |
| 中 | 11.2 | [docs/plans/phase11.2-error-category.md](docs/plans/phase11.2-error-category.md) — エラーレスポンスを `category` フィールドでカテゴリ化（[riin-summaly#2](https://github.com/fruitriin/riin-summaly/issues/2)） | S | 未着手 |

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
phase11.1 未着手（依存更新）
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
