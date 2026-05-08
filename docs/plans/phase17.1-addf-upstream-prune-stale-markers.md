# phase17.1 — `prune-stale-markers` スキルを ADDF 本体に upstream

## 背景

phase17.0 セッション (本 phase の準備として実施) で、riin-summaly プロジェクトに **コメント・ドキュメント内の履歴マーカー** (`phaseX.Y で追加`、`phaseX.Y で修正`、`phaseY 変更:` 等) が累積する問題を確認した。

ADD フレームワーク (phase 駆動開発) を採用しているプロジェクト全般で同種の累積が起きる **構造的問題** であり、summaly 固有の話ではない。次の 3 点を summaly 側で実証済:

1. **CLAUDE.repo.md にコメント整理方針を追記** ([CLAUDE.repo.md](../../CLAUDE.repo.md) の「コメント・ドキュメント内の phase 番号参照ルール」セクション) — 書き手の自己抑制ガイド
2. **`prune-stale-markers` スキルを実装** ([.claude/commands/prune-stale-markers.md](../../.claude/commands/prune-stale-markers.md)) — 定期的な棚卸し手順
3. **一回目の棚卸しを実行** — `src/` + `bin/` で 156 件 → 5 件 (96.8% 削減、残った 5 件はすべて Plan ファイルへの索引リンク)

これらが実用に耐えると確認できたため、ADDF 本体 (upstream) に寄与して他のダウンストリームプロジェクトでも利用可能にする。

## 目的

1. **`prune-stale-markers` スキルを ADDF 本体の templates/skills/ に upstream**
2. **`addf-init` の初期セットアップ手順に組み込む** — 新規 ADDF プロジェクトで自動的にスキルが配置される
3. **CLAUDE.md テンプレート (本家) にコメント整理方針セクションを追加** — 個別プロジェクト ([CLAUDE.repo.md](../../CLAUDE.repo.md)) ではなくテンプレート側で配布
4. **knowhow に「履歴マーカー累積」パターンを記録** — `addf-dev-operation-patterns.md` の該当セクションに追記

## Step 1: スキル本体の upstream

ADDF 本体リポ (アクセスは別途確認) の `templates/skills/prune-stale-markers/` に以下をコピー:

- `templates/skills/prune-stale-markers/SKILL.md` (= summaly の `.claude/commands/prune-stale-markers.md`)
- `templates/skills/prune-stale-markers/SKILL.exp.md` (= summaly の `.exp.md` の **テンプレート版**、リポ固有の「基本対象」セクションは空)

**summaly 固有の記述を除去**:
- 「riin-summaly での」のような特定リポ名の言及 → 「このリポジトリで」のような汎用表現に
- 除外ファイルの個別例 (`docs/knowhow/ADDF/` 等) → 「ADDF 本体ノウハウ等」のような汎用表現

## Step 2: `addf-init` への統合

`templates/.claude/commands/` 等のディレクトリに `prune-stale-markers.md` + `prune-stale-markers.exp.md` を含める。

`addf-init` 実行時 (新規プロジェクトのセットアップ時) に他のスキル (`addf-dev` / `addf-knowhow` 等) と並んで自動配置される形にする。

**配置先確認**: ADDF 本体の既存スキル (`addf-dev.md` 等) がどのテンプレート構造で配布されているかを確認し、同じ仕組みに乗せる。

## Step 3: CLAUDE.md テンプレートへの方針追記

ADDF 本体の `templates/CLAUDE.md` (もしくは `templates/CLAUDE.repo.md`) に「コメント・ドキュメント内の phase 番号参照ルール」セクションを追加する。

summaly 側で実証済の記述 ([CLAUDE.repo.md](../../CLAUDE.repo.md) の該当セクション) をテンプレートに反映:

```markdown
### コメント・ドキュメント内の phase 番号参照ルール

ADD フレームワーク (phase 駆動開発) を採用しているため、コメントやドキュメントに `phaseX.Y` の参照が
累積しやすい。ノイズ蓄積を抑えるため以下のルールに従う:

- **削除対象 (種別 A: 純粋な履歴マーカー)**: ...
- **削除対象 (種別 B: 廃止経緯の累積記述)**: DEPRECATED.md に集約済 (もしくは集約候補)
- **保持対象 (種別 C: WHY 説明 + 索引としての phase 番号)**: 最新 1 個だけ残す
- **保持対象 (種別 D: Plan ファイルへの直リンク)**: 不変

**書き方**: `**phaseX.Y 変更**:` ではなく `(phaseX.Y)` で**現状の責務だけ書く**。

**棚卸し**: `/prune-stale-markers` スキルで定期的に手入れ (盆栽運用)。
```

## Step 4: knowhow への追記

ADDF 本体の `docs/knowhow/addf-dev-operation-patterns.md` (もしくは別 knowhow) に以下を追記:

```markdown
## 履歴マーカー累積パターン

ADD フレームワーク利用プロジェクトでは、コメントに `phaseX.Y で追加` のような履歴マーカーが
累積する傾向がある。このマーカーは `git blame` / `git log` で trace 可能な情報を重複記録している
状態で、コードの理解には寄与せず**コードベースを腐らせる**。

**具体的な事例 (riin-summaly phase17.0)**: src/ + bin/ で 156 件累積していた phase 言及を、
`/prune-stale-markers` スキルで 5 件まで削減 (96.8%)。残った 5 件はすべて Plan ファイルへの
索引リンクで、削除すると trace 経路を失うため意図的に保持。

**運用パターン**:
1. CLAUDE.md / CLAUDE.repo.md に「書き手の自己抑制ルール」を明記
2. `/prune-stale-markers` で定期的に棚卸し (盆栽運用)
3. CI ガード等で強制すると逆効果 (改修者が phase 番号を書きにくくなる)

**判断ルール**: 種別 A (純粋な履歴) / B (廃止経緯) は削除、C (WHY 補強) / D (Plan 索引) は最新
1 個の phase 番号だけ残す。詳細は `prune-stale-markers` スキル定義参照。
```

## Step 5: 動作確認

ADDF 本体の `tests/` 配下で `prune-stale-markers` スキルの最低限の動作確認:

- スキル定義のフロントマター (name / description / user_invocable) が正しく parse される
- `.exp.md` テンプレートが `@メンション` 展開される
- `addf-init` 実行後にダミーリポでスキルが認識される

## サイズ

S〜M (新規 1 スキル + テンプレート修正 + knowhow 追記)

## 着手トリガー

ADDF 本体への upstream コントリビューションを行うタイミング (まとめて複数の改善を上げる時、または
ADDF 本体オーナーから依頼があった時)。**急がない** — summaly 側でスキルを使い続けることで
適宜ブラッシュアップしてから upstream する方が品質が高くなる。

## 関連

- summaly 側の実装: [.claude/commands/prune-stale-markers.md](../../.claude/commands/prune-stale-markers.md)
- 方針記述: [CLAUDE.repo.md](../../CLAUDE.repo.md) の「コメント・ドキュメント内の phase 番号参照ルール」
- 棚卸し履歴: [.claude/commands/prune-stale-markers.exp.md](../../.claude/commands/prune-stale-markers.exp.md)
