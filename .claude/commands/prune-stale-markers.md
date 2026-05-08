---
name: prune-stale-markers
description: |
  コメント・ドキュメント内に累積した「履歴マーカー」(phase 番号 / Step 番号 / 古い issue 参照等) を棚卸しして整理する盆栽手入れスキル。
  種別 A (純粋な履歴) / B (廃止経緯) は削除、種別 C (WHY 補強) / D (Plan 索引) は最新 1 個の phase 番号だけ残す。
  対象範囲はリポジトリごとに `prune-stale-markers.exp.md` で「ソースのみ」「ドキュメントのみ」「両方」を選択できる。
  ADD フレームワーク (phase 駆動開発) 利用プロジェクトで定期的 (週/月) に呼び出す。
user_invocable: true
---

# prune-stale-markers — コメント・ドキュメントの履歴マーカー棚卸し

ADD フレームワーク (phase 駆動開発) を採用していると、コメントやドキュメントに `phaseX.Y で追加` `phaseX.Y で修正` のような履歴マーカーが累積する。これは git blame / git log で trace 可能な情報をコメントに重複記録している状態で、コードの理解には寄与せず**コードベースを腐らせる**。

このスキルは累積したマーカーを 4 種別 (A/B/C/D) に分類し、**A/B を削除・C/D は最新 1 個だけ残す**棚卸しを実施する。

## 引数

- 引数なし: `prune-stale-markers.exp.md` の「基本対象」設定に従って棚卸しする
- `source`: ソースコードのみを対象 (`src/` `bin/` `lib/` 等)
- `docs`: ドキュメントのみを対象 (`docs/` `*.md`、ただし `CHANGELOG.md` `DEPRECATED.md` 等の時系列履歴ファイルは除外)
- `all`: ソース + ドキュメントの両方
- 任意のパス (例: `src/plugins/`): そのパス配下のみを対象

## 経験の活用

実行前に @prune-stale-markers.exp.md を読み、このリポジトリの「基本対象」設定 + 過去の棚卸し結果を確認する。

`.exp.md` が空 / 未存在の場合は、引数なしの実行時にユーザーに「このリポジトリでの基本対象 (source / docs / all) を何にするか」を尋ねて、決定後 `.exp.md` に記録する。

## 全体フロー

```
[対象決定] → [全件列挙] → [種別判定] → [編集計画提示] → [編集実行] → [品質ゲート] → [.exp.md 更新]
```

## Phase 1: 対象決定

1. 引数または `.exp.md` の「基本対象」を読む
2. 対象パスのリストを確定 (例: `src/ bin/`)
3. **除外ファイル** を確認:
   - `CHANGELOG.md` — 時系列の履歴記録なので対象外 (削るのは用途違反)
   - `DEPRECATED.md` — 廃止機能の経緯記述が本来の用途
   - `docs/plans/` — Plan ファイル自体に phase 番号が含まれるのは正常
   - `.claude/Progresses/` — 過去の進捗記録 (履歴アーカイブ)

## Phase 2: 全件列挙

```bash
# 履歴マーカーの全件抽出 (拡張子は対象に応じて変更)
grep -rnE 'phase[0-9]' <対象パス> --include="*.ts" --include="*.md" \
  | grep -vE '(CHANGELOG\.md|DEPRECATED\.md|docs/plans/|\.claude/Progresses/)'

# 重点候補: 1 行に phase 言及が 2 個以上 (経緯の累積記述)
grep -rnE '\(phase[0-9.]+.*phase[0-9.]+' <対象パス>
```

件数を整理前後で比較するため、開始時点の総件数を記録しておく。

## Phase 3: 種別判定

各箇所を 4 種別に分類する。

### 種別 A: 純粋な履歴マーカー → **削除**

**判定基準**: コメント本体を消しても WHAT/WHY が他から読み取れる。phase 番号がコメントの主成分。

例:
- `* X (旧 Twitter) プラグイン (phase6.1)。` — 「phase6.1」は git blame で trace 可能。本文の「X (旧 Twitter) プラグイン」は HTML フィクスチャ等から自明
- `// 経路学習キャッシュ記録 (phase14 Step 2b 後半)` — 「経路学習キャッシュ記録」自体はコードで自明、phase 番号が主成分

**処理**: コメント全体を削除、または phase 番号部分を削除しコメント本体だけ残す (本体が情報的なら残す)。

### 種別 B: 廃止経緯の累積記述 → **削除 + DEPRECATED.md リンク**

**判定基準**: 「以前は X、phaseY で Y に変更」のような経緯の累積。

例:
```
* **phase14 Step 4 での簡素化**: 以前は `forceProxyFallback: true` で「1〜2段目をスキップして
* proxy 直行」していたが、phase14 Step 3 で同梱した bootstrap に
```

**処理**:
1. 経緯記述を削除
2. 「現状の責務」だけ 1 行で残す
3. 必要なら `[DEPRECATED.md](../../DEPRECATED.md)` へのリンクを末尾に追加

### 種別 C: WHY 説明 + 索引としての phase 番号 → **最新 1 個だけ残す**

**判定基準**: コメント本体は設計判断や非自明な制約を伝えていて削除不可。phase 番号は索引としての副次情報。

例:
```ts
// `followRedirects: undefined`: scpaping には伝播させない (phase11.3)。summaly レイヤの
// 呼出経路が `followRedirects: false` を渡したときに phase11.3 の bug が再発しないよう、
```

**処理**:
1. コメント本体は残す
2. **最後に意味のある変更を受けた phase 番号 1 個** だけ残す (粒度は Step 単位 `phase14 Step 4`)
3. 重複した phase 言及は削除

「最新」の定義: そのコメントが説明している現在の挙動を**確立した phase**。修正・改善が複数 phase に渡る場合は、最後に責務を変えた phase。

### 種別 D: Plan ファイルへの直リンク → **そのまま残す**

**判定基準**: `docs/plans/phaseX.Y-*.md` へのファイルパス参照。

例:
- `* 設計詳細: docs/plans/phase13.1-syosetu-embed.md`
- `* 詳細は \`docs/plans/phase14-domain-strategy-cache.md\` 参照。`

**処理**: 不変。ファイル名の一部なので phase 番号を消すと参照が壊れる。

## Phase 4: 編集計画提示

ユーザーへの提示前に**ファイル単位**で集計する:

```markdown
## 棚卸し計画

| ファイル | 開始件数 | 削除 (A) | 簡素化 (B) | 集約 (C) | 残置 (D) | 終了件数 |
|---|---:|---:|---:|---:|---:|---:|
| src/plugins/yodobashi.ts | 6 | 1 | 3 | 1 | 0 | 2 |
| src/plugins/sqex.ts | 5 | 0 | 4 | 1 | 0 | 1 |
| ... | ... | ... | ... | ... | ... | ... |
| **合計** | **156** | **52** | **30** | **24** | **6** | **~50** |
```

ユーザー承認後に編集実行。承認前に進めない。

## Phase 5: 編集実行

1. ファイル単位で Edit (バッチ編集が望ましい)
2. 編集後ファイルを確認するときは Read を再度使わず、Edit のレスポンスで状態が反映されたと信頼する
3. 同種パターンがある場合は `replace_all` を活用 (誤爆防止のため十分な context を含む)

## Phase 6: 品質ゲート

コメント・ドキュメントのみの変更でも以下を実行:

```bash
pnpm build      # tsdown のビルド (コメント変更でも tsdown は走らせる)
pnpm eslint     # コメント整理で lint 違反 (空行/不要コメント) が出ないか
pnpm typecheck  # JSDoc に型情報を含めている場合 typecheck で発覚
pnpm test       # 機能差分なしを確認 (全件パス想定)
```

ドキュメントのみの変更なら build/typecheck はスキップ可。

## Phase 7: `.exp.md` 更新

このリポジトリでの「基本対象」と棚卸し履歴を `.exp.md` に追記:

```markdown
## このリポジトリでの基本対象
- source: src/ bin/
- docs: docs/ README.md DEPRECATED.md (CHANGELOG.md は除外)
- 基本: all (ソース + ドキュメント)

## 棚卸し履歴
- 2026-05-XX: 初回。src/+bin/ で 156 → 52 件。種別 B (廃止経緯) は DEPRECATED.md 集約 (phase16.2) で既に整理済の領域が多かった
- 20XX-XX-XX: 次回棚卸しトリガー: 1 ファイルあたり 5 件超 / 1 コメントブロック内に 3 個以上の phase 言及

## 学んだパターン
- (実行を重ねて気づいたパターンを追記)
```

## エラーケース

- 引数のパスが存在しない → 「<path> が見つかりません」と報告して停止
- `.exp.md` が空 + 引数なし → ユーザーに対象を尋ねる
- 棚卸し対象が 0 件 → 「棚卸し対象なし、最後の整理から増えていません」と報告
- 編集計画段階でユーザーが拒否 → 中断、編集はしない

## 設計の精神

- **盆栽運用**: 完璧に管理しようとせず、定期的に手入れする発想。CI ガードで強制すると逆効果 (改修者が phase 番号を書きにくくなる)
- **判断を強制しない**: 種別 C/D の境界は曖昧なケースがあるので、迷ったら**残す**側に倒す。次回棚卸しで再検討すれば良い
- **書き手の自己抑制が第一義**: スキルはあくまで補助。`CLAUDE.repo.md` の「コメント・ドキュメント内の phase 番号参照ルール」を書き手が意識することが本筋

## 参照

- [CLAUDE.repo.md](../../CLAUDE.repo.md) — このリポでの phase 番号参照ルール
- [DEPRECATED.md](../../DEPRECATED.md) — 廃止経緯の集約先 (種別 B の移動先)
- [docs/knowhow/addf-dev-operation-patterns.md](../../docs/knowhow/addf-dev-operation-patterns.md) — ADDF 利用全般の運用パターン
