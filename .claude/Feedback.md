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
  - **phase2.1 でこのスキップ条件を適用**: プラグイン基盤整備の変更も `src/` `test/` のみで条件を満たしたためスキップ。判断は明確で迷いなく運用できた。ProgressTemplate.addf.md にこのスキップ条件を組み込む価値あり
- **2026-05-03**: ADDF テンプレートの `.gitignore` ブロックに `.claude/scheduled_tasks.lock` が含まれていない。`/loop` で CronCreate を使うと自動生成される runtime artifact なので、テンプレート側に追加すべき（本リポでは個別に追加済み）
- **2026-05-04 phase4.2 セッション**: `addf-contribution-agent` のスキップ条件「`.claude/` `docs/knowhow/ADDF/` `templates/` を含まない場合はスキップ可」について、変更ファイルに `.claude/settings.json`（権限追加・ブロック順序整理）が含まれていたが、コントリビューション agent は「フレームワーク機能（スキル・エージェント・フック・テンプレート）に影響しない権限設定変更」をスキップ妥当と判断した。スキップ条件は文字通りの `.claude/` 全体ではなく**意図ベース（フレームワーク機能への影響）**で運用するのが正しいと確認できた。テンプレート側で「`.claude/settings.json`（permissions のみの変更）はスキップ可」と明示する余地あり
- **2026-05-04 phase4.2 セッション**: `addf-code-review-agent` が `try/finally` 内 `let` 変数の definite-assignment を ESLint の `no-non-null-assertion` 違反として正しく指摘。改善案として「`Promise` の resolve 値にエラーを埋め込んで finally 不要の線形フローに書き換える」パターンが綺麗に効いた。本パターンは `docs/knowhow/inflight-dedup-pattern.md` に記録済み。レビュー agent → ESLint 静的解析 → リファクタリングの流れがうまく回る事例
- **2026-05-05 phase7.1 セッション**: `addf-code-review-agent` が dev サーバの `process.env.HOST ?? '127.0.0.1'` を「`HOST=''` で IPv6 全インターフェースバインドになり SSRF リレーになる」という具体的なセキュリティリスクで指摘。`??` の挙動と Node.js の `net.Server` 仕様まで踏み込んだ指摘で、レビュー agent のセキュリティ観点が dev サーバ構築時にも有効と確認できた。`docs/knowhow/dev-server-tsx-pattern.md` に「HOST/PORT の defensive validation」として一般化して記録
- **2026-05-05 phase7.1 セッション**: `addf-contribution-agent` のスキップ条件は引き続き安定運用できている。phase7.1 は dev/ 配下の新規ファイル群 + `package.json` / `eslint.config.js` 変更だが ADDF 由来ファイル（`.claude/`, `docs/knowhow/ADDF/`, `templates/`）はゼロのため、agent は迷いなく「contribution 候補なし、スキップ妥当」と判断した。スキップ条件が「変更目的が ADDF フレームワーク機能か否か」で意図ベースに整理できているのが効いている
