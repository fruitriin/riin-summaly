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
- **2026-05-05 phase8.1 セッション**: `addf-code-review-agent` が「過去のセッションで蓄積したノウハウ（`dev-server-tsx-pattern.md` の HOST 空文字検証）が同種の場所で再発している」ことを的確に指摘。新規実装でも過去 knowhow を参照して横展開できるか確認しないと知見が活きない、という良い学習。Plan 段階で関連 knowhow を `addf-knowhow-filter` で取り寄せる運用は機能しているが、レビュー段階でも knowhow との照合が役立つ事例
- **2026-05-05 phase8.1 セッション**: `addf-code-review-agent` が `src/config-loader.ts` の配置について「`src/` 配下だと将来的に `src/index.ts` から誤って import されて npm 公開 bundle に混入するリスクがある」と構造的な提案を行った。Plan 段階では「src/」と書かれていたが、レビューで `bin/` 配置に修正できた。Plan の文言は将来の知見を取り込んだ修正を許容する運用が大事（Plan を絶対視しない）
- **2026-05-05 phase8.1 で全アクティブフェーズが完了**: TODO のバックログが phase6.1 の保留のみになり、`/addf-dev` の次サイクルで「次タスクなし」状態になる見込み。`addf-dev` スキルが「未着手タスクなし」のときの挙動が定義されていない可能性がある（loop 継続が無意味になるが Cron は止まらない）。テンプレート側で「未着手タスクなしのときは PushNotification でオーナーに通知して loop を停止する」ガイドを追加する案
- **2026-05-05 phase10.1 セッション**: 「実装中にユーザー指摘で要件追加」のパターン（絶対失敗類型の除外を `isFilteredFailure` として後付け）が綺麗に組み込めた。`docs/plans/` の Plan を実装結果メモで「方針からの変更」として記録できる構造が活きた。レビュー W-1〜W-3 + S-1 + S-3 を一括で対応してから commit する流れも安定運用できている
- **2026-05-05 phase10.1 セッション**: `addf-code-review-agent` が **`URL.origin === "null"` （`data:` / `file:` スキーム時）** のコーナーケースを指摘した。これは仕様詳細を知らないと見逃しやすい部分。レビュー agent の知識ベースが日常的なコードレビューと別軸で深いことを再確認できた
- **2026-05-05 派生ドキュメント同期セッション**: 品質ゲートに「ドキュメントと実装の突き合わせ」チェック (ステップ 4.5) が無く、実装後にドキュメント更新漏れを catch する仕組みが脆弱だった。phase10.1 で `parseFailureLogJsonlPath` を後付けした際、Library.md の Fastify 専用オプション一覧が更新漏れになりかけた事例を契機に、`ProgressTemplate.addf.md` と `Progress.md` 両方にステップ 4.5 を追加。**ADDF フレームワーク本体への寄与候補**（ダウンストリーム版 `ProgressTemplate.md` にも同等のステップ追加が望ましい）

## phase11.1 (依存更新) ノウハウ

- **2026-05-05 phase11.1 セッション**: `pnpm update` だけだと固定バージョン記法 (`"x.y.z"` 形式、`^` `~` なし) の package.json は変わらない。`--latest` フラグ必須。pnpm の挙動として「version range 内で最新を取る」のがデフォルトで、固定バージョンならそもそも range が無いので何もしない。次回も同パターンで詰まりやすいので明示記録
- **2026-05-05 phase11.1 セッション**: eslint 10 への bump は `@misskey-dev/eslint-plugin@2.2.0` がまだ追従しておらず、`@eslint/eslintrc` の resolve エラー + `@stylistic/eslint-plugin@>=5` / `globals@>=16` の peer dep 不整合で fail。Plan の見送り条件「`@misskey-dev/eslint-plugin` が eslint 10 に追従していなければ次回送り」が機能した

## phase11.2 (エラーカテゴリ化) 知見

- **2026-05-05 phase11.2 セッション**: `categorizeError` の判定優先順位は **メッセージ高シグナル先 → statusCode 後** が正解。`Private IP rejected` / `Invalid IP` は内部で `StatusError(_, 400/500)` で投げられるため、statusCode を先に見ると `bot_blocked` / `origin_error` 誤判定。意味重視の優先順位を選ぶ
- **2026-05-05 phase11.2 セッション**: レビュー agent が「`SummalyErrorCategory` が npm 公開エントリから直接 import できない」を指摘。`SerializableError['category']` で間接参照は不格好。**type も `export type` で公開する**のが基本。built/index.d.ts のサーフェスを確認するレビュー agent の知識ベースが効いている
- **2026-05-05 phase11.2 セッション**: phase10.1 で導入した `isFilteredFailure` を `categorizeError` ベースに refactor したことで、エラー類型の判定ロジックが 1 箇所に集約され、新カテゴリ追加 (`content_too_large` 等) が `enum 追加 + パターン追加 + FILTERED_CATEGORIES に追加` の 3 行で済むようになった。**初期実装での共通基盤化が後続 phase の差分を小さくする**好例
