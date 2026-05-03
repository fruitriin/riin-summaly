# Process Feedback

開発プロセスの振り返りと改善を記録する。

## 記録方法

タスク完了時や問題発生時に、以下のいずれかのセクションに追記する。

## オーナーフィードバック

## 問題の記録

## 改善アクション

## ADDF 推進エンジンに関する記録

- **2026-05-03**: ADDF 導入直後のセッションでは `/addf-dev` slash コマンドおよび `addf-code-review-agent` / `addf-contribution-agent` などの subagent type が Claude Code の register 対象に**まだ載っていない**。`Skill` ツール経由でも、`Agent({ subagent_type: 'addf-*' })` でも認識されない。
  - 暫定回避: スキル定義ファイル (`.claude/commands/addf-dev.md`、`.claude/agents/addf-code-review-agent.md`) を Read してその指示を手動で実行、または `general-purpose` subagent に definition の内容をプロンプトとして渡す
  - 改善案: ADDF の README または `addf-init` の完了レポートに「セットアップ完了後 Claude Code を再起動するか `/reload` を実行してください」を明示する。さらに導入後の最初の `/loop X /addf-dev` 試行で skill が認識されなかったときの diagnostic を出すようにする
  - **2026-05-03 phase1.2 セッションでの追記**: 同じセッション内で `/loop 30m /addf-dev` 再登録後、`addf-code-review-agent` / `addf-contribution-agent` は認識された（再起動を経たため）。`/addf-dev` も Skill として認識された。phase1.1 完了後にこれらが未認識だったのは初回セッションの ADDF 導入直後限定の問題と確認できる。テンプレートに「導入直後のセッションのみ未認識、次回セッションで解消」を補足するとより親切
- **2026-05-03**: `/loop 30m /addf-dev` で cron は登録できたが、cron 発火時に `/addf-dev` が認識されていないと no-op になる懸念あり。次回セッション以降では再登録か再起動が必要
- **2026-05-03**: phase1.1 完了処理で `addf-contribution-agent` をスキップした。理由: 本フェーズの変更（Cache-Control ヘッダ追加）は ADDF 本体への影響が無く contribution 候補が出ないと判断。スキップ判断のガイドラインがあれば運用者が一貫した判断をできる（テンプレートに「contribution agent をスキップしてよい条件」を追記する案）
  - **phase1.2 で contribution agent を実行した結果**: 「変更が `src/` `test/` `CHANGELOG.md` のみで `.claude/` `docs/knowhow/ADDF/` を触らないバグ修正」は予想通り contribution 候補なしという結果になった。スキップ条件として「変更ファイルが `.claude/` `docs/knowhow/ADDF/` `templates/` を含まない場合はスキップ可」が機能しそう
- **2026-05-03**: ADDF テンプレートの `.gitignore` ブロックに `.claude/scheduled_tasks.lock` が含まれていない。`/loop` で CronCreate を使うと自動生成される runtime artifact なので、テンプレート側に追加すべき（本リポでは個別に追加済み）
