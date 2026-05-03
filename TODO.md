# TODO

`docs/plans/` の完了状態・優先度をトラックする。
`docs/plans/` と TODO が一致しなければ TODO を編集する。

phase 番号は **着手順**（数値が小さいほど先）。同じ大番号内（例: 2.1 と 2.2）は並列着手可能。

## 現在のフェーズ: phase2.1 / phase2.2（次に並列着手可）

## バックログ

| 優先度 | Phase | 計画ファイル | サイズ | 状態 |
|---|---|---|:---:|---|
| 2 | 2.1 | [docs/plans/phase2.1-plugin-infrastructure.md](docs/plans/phase2.1-plugin-infrastructure.md) — プラグイン基盤（getJson / name / UA / 短縮URL） | S | 未着手 |
| 2 | 2.2 | [docs/plans/phase2.2-mei23-non-plugin.md](docs/plans/phase2.2-mei23-non-plugin.md) — mei23 非プラグイン軽量変更（PDF除く / [issue #39](https://github.com/misskey-dev/summaly/issues/39) 含む） | M | 未着手 |
| 3 | 3.1 | [docs/plans/phase3.1-plugin-oembed.md](docs/plans/phase3.1-plugin-oembed.md) — oEmbed 系プラグイン（youtube / spotify） | S | 未着手 |
| 3 | 3.2 | [docs/plans/phase3.2-plugin-dom.md](docs/plans/phase3.2-plugin-dom.md) — DOM 後処理系プラグイン（dlsite / iwara / komiflo / nijie） | M | 未着手 |
| 4 | 4.1 | [docs/plans/phase4.1-fastify-in-memory-cache.md](docs/plans/phase4.1-fastify-in-memory-cache.md) — Fastify インメモリ LRU キャッシュ | M | 未着手 |
| 5 | 5.1 | [docs/plans/phase5.1-pdf-support.md](docs/plans/phase5.1-pdf-support.md) — PDF 対応（オプトイン+ハング対策5層） | M〜L | 未着手 |
| — | 6.1 | [docs/plans/phase6.1-plugin-twitter.md](docs/plans/phase6.1-plugin-twitter.md) — twitter プラグイン | S | 保留（運用判断待ち） |

### 並列実行マップ

```
phase1.1  完了
phase1.2  完了
   ↓
phase2.1  ─┐
phase2.2  ─┤  並列可（次に着手可能）
           ↓
phase3.1  ─┐  phase2.1 完了後、並列可
phase3.2  ─┤
           ↓
phase4.1  ← phase1.1 完了後（cacheMaxAge 利用）
           ↓
phase5.1  ← phase2.2 完了後（useRange / sanitize-url 利用）
           ↓
phase6.1  ← 採用判断後（保留）
```

---

## アーカイブ

| Phase | 計画ファイル | 状態 |
|---|---|---|
| 1.1 | [docs/plans/phase1.1-fastify-cache-control.md](docs/plans/phase1.1-fastify-cache-control.md) — Fastify Cache-Control 即修正 ([issue #27](https://github.com/misskey-dev/summaly/issues/27)) | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase1.1-fastify-cache-control.md](.claude/Progresses/2026-05-03-phase1.1-fastify-cache-control.md) |
| 1.2 | [docs/plans/phase1.2-options-mutation-fix.md](docs/plans/phase1.2-options-mutation-fix.md) — `summaly()` の opts mutation バグ修正 | 完了 (2026-05-03)、Progress: [.claude/Progresses/2026-05-03-phase1.2-options-mutation-fix.md](.claude/Progresses/2026-05-03-phase1.2-options-mutation-fix.md) |
