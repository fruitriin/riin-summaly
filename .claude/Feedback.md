# Process Feedback

開発プロセスの振り返りと改善を記録する。

## 記録方法

タスク完了時や問題発生時に、以下のいずれかのセクションに追記する。

## オーナーフィードバック

- **2026-06-01 phase19.1 (google-drive)**: 初版を「title/thumbnail は匿名取得不能なので null」と設計したが、オーナーの「縦動画を縦長プレビューできるか?」という追加質問を受けて再調査したところ、**前提が誤りだった**。`/view` を `facebookexternalhit` UA で叩くと `og:title` に file 名が入る + 公開 thumbnail エンドポイント (`/thumbnail?id=...`) が実アスペクト比の画像を返す、という 2 つの匿名取得経路が存在した。**教訓**: 「API が無いから取れない」と早期に結論づけず、`curl` で UA を変えた黒箱比較 (skill `/url-preview-check` の手法) を **実装前**に一通り回すべき。オーナーの「できるか?」という素朴な問いが再調査のトリガーになった = 実装を見せて早めにフィードバックをもらう価値が高い

## 問題の記録

- **2026-06-01 phase19.1**: `got` の `res.rawBody` は **`Uint8Array` であって `Buffer` ではない**。`Buffer.isBuffer(rawBody)` は false を返し、`rawBody.readUInt16BE` 等の Buffer ヘルパも無いため、画像ヘッダ寸法パーサに直接渡すと `TypeError: buf.readUInt16BE is not a function` で落ちる (E2E で発覚、typecheck/unit はすり抜けた)。対策: パーサ側で `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` (コピーなし view 共有、byteOffset 考慮必須) で wrap。同種の「`rawBody` をバイナリとして読む」新規コードで再発しうる。`docs/knowhow/embed-endpoint-design.md` に落とし穴として記録済

- **2026-05-05 phase11.4 / 6.1 派生バグ**: 新規プラグイン (`npmjs` / `twitter`) が両 example の `[plugins.allowed]` リストに反映されておらず、本番で **deploy example の通り設定すると新規プラグインが無効化される** 状態が露呈。現象: `https://www.npmjs.com/package/<pkg>` が `general()` 経由で Cloudflare に直叩きされ 403。CLAUDE.md ステップ 4.5「設定ファイル example の更新（特に修正漏れしやすい！）→ `config.example.toml`（ルート）と `docs/deploy-examples/summaly-config.example.toml`（デプロイ用）の **両方**」というチェックが既に明記されているが、phase6.1 / phase11.4 の品質ゲートで両ファイル更新が漏れた
  - 直接の原因: `[plugins.allowed]` がオプトイン許可リスト方式で、新規プラグインを足しても自動で有効にならない fail-close 仕様
  - 根本原因: example が **新規プラグイン追加コミットと連動していない**。実装フェーズの「ドキュメントと実装の突き合わせ」ステップが個別の項目を列挙してチェックする設計になっておらず、「example 2 ファイル」という具体名を出しているのに見落とされた
  - **改善アクション (実装済み 2026-05-05)**: [test/config-example-plugins.test.ts](../test/config-example-plugins.test.ts) を新設し、`src/plugins/*.ts` の `export const name = '...'` を全件抽出して `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` の **両方** にテキストとして言及されているか（コメントアウト行 `# "dlsite",` も「運用者が判断で活性化できる」のでパス扱い）を `pnpm test` で自動検証する。新規プラグイン追加時に example 反映漏れがあれば test fail する fail-close ガード。テンプレート側 (`ProgressTemplate.addf.md` ステップ 4.5) にも「新規プラグイン追加時の example 同期」を個別項目として明記する余地あり
  - **2026-05-05 修正**: 両 example に `npmjs` を追加、`docs/deploy-examples/...` には phase6.1 で漏れていた `twitter` および NSFW 系 (`dlsite` / `iwara` / `komiflo` / `nijie`) のコメントアウト行も合わせて追加（NSFW 系はテスト通過のためというよりデプロイ運用者に「意図的にデフォルト除外している」ことをシグナル化する目的）。本番運用者は `config.toml` の `[plugins.allowed]` に `"npmjs"` (および欠けていれば `"twitter"`) を追加することで解消する

## 改善アクション

> **2026-05-08 整理**: phase14 / phase13.1 で蓄積した運用パターン群を [docs/knowhow/addf-dev-operation-patterns.md](../docs/knowhow/addf-dev-operation-patterns.md) に昇格しました。本ファイルはセッション固有の問題記録に再フォーカスし、汎用化したパターンは knowhow 経由で参照する形に整理。以下は **当該 knowhow に未統合の項目** + **次回セッションで対処すべき個別アクション**。

### ADDF テンプレート寄与候補

- **`ProgressTemplate.addf.md` ステップ 4.5 への grep チェック追加**: `grep -rn "Step [0-9.]\+ で同梱予定\|Step [0-9.]\+ で実装予定\|TODO" docs/ config.example.toml` を機械的に走らせて、前フェーズの「予定」表現が完了したかを検出する。phase14 Step 3 で W-1 + W-2 が 2 連続発生した経緯から (詳細は addf-dev-operation-patterns.md 参照)
- **`ProgressTemplate.addf.md` ステップ 4.5 への opts 伝搬チェック追加**: `SummalyOptions` / `GeneralScrapingOptions` に新フィールドを追加した場合、`src/general.ts` の opts 再構築箇所も更新するチェック (phase14 Step 2b 後半 で `_cacheRecording` の伝搬漏れを発見した経緯)
- **`addf-code-review-agent` プロンプトへの追加**: 「動的 import で参照しているシンボルは元ファイルを Read して export 状態を確認すること」(phase12.6 セッションでの false positive 経験から)
- **`ProgressTemplate.md` (ダウンストリーム版) にも 4.6 ステップを追加**: phase14 Step 1〜3 で実証済の効果を本家にも波及

### 個別技術負債 (将来対処)

- **2026-05-08 完了 / 派生課題 1 件**: `general.ts` の opts 再構築を spread ベース (`{ ...opts, lang, followRedirects: undefined }`) に refactor 完了。`GeneralScrapingOptions` 拡張時の伝搬漏れリスクを構造的に解消。`followRedirects: undefined` を明示 override で phase11.3 bug 再発を防衛 (型上は含まれるが現状すべての呼出経路で undefined のため実害なし、defense-in-depth)。レビューで Medium Warning が出た「`src/index.ts` L525-539 の `scrapingOptions: GeneralScrapingOptions` 構築は明示列挙のまま」については、`SummalyOptions` 型が `GeneralScrapingOptions` より広く `embedBaseUrl` 等が存在するため spread refactor 不可。**手動列挙での維持が正解**で、ADDF テンプレート寄与候補に「opts 伝搬チェック」を残すことで対処
- **2026-05-07 phase12.6 セッション**: skill `/url-preview-check` の Phase 1 (本番 pino ログ確認) より前段に「**ローカル MacOS から curl + 本番 Vultr から curl の黒箱比較**」を置くと診断が **1 分で確定** することを再確認。今回は ローカル → 200 + 完璧な OGP / 本番 → 200 + 正規 404 ページボディ の差から fail mode B' (エラーシグナルなし IP block) を即特定。skill 側に fail mode B' セクションを追記済み
- **2026-05-07 phase12.6 セッション (レビュー agent の false positive)**: `addf-code-review-agent` が W-1 で「`matchesDomain` の export 確認が必要」と指摘したが、実は既に export 済み (proxy-fallback.ts L65) で `pnpm test` 405 件全パス状態だった。レビュー agent は **diff だけを見て元ファイル全体の状態を把握しきれない** ことがある (特に動的 import 経由のシンボル参照)。実害ゼロだが、ADDF レビュー agent プロンプトに「動的 import で参照しているシンボルは元ファイルを Read して export 状態を確認すること」を含めるとレビュー精度が上がる可能性 (ADDF テンプレート側への寄与候補)

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

## phase11.8 (Fastify エラーログ pino 出力) 知見

- **2026-05-05 phase11.8 セッション**: phase11.2 で導入した `categorizeError` を `chooseLogLevel(e)` の派生実装基盤として再利用できた。`LOG_LEVEL_BY_CATEGORY: Record<SummalyErrorCategory, LogLevel>` テーブル 1 箇所でカテゴリと level の整合を保つ。**過去フェーズの共通基盤化が後続 phase の差分を小さくする**好例 (phase11.2 セッションの knowhow とも合致)
- **2026-05-05 phase11.8 セッション**: レビュー agent が「pino の `errSerializer` が got の `RequestError.options.url` を列挙して出力する → スクレイピング先 URL のクエリ漏洩」という具体的な PII 漏洩経路を指摘した。仕様詳細を知らないと見逃しやすい。`err` を手動シリアライズ (`{ name, message, stack, statusCode? }`) に変更して根本対処
- **2026-05-05 phase11.8 セッション**: Fastify 6 の `loggerInstance` 型 (`FastifyChildLoggerFactory<RawServer, ...>`) は厳しく、テスト注入で `as any` 経由の `as unknown as FastifyInstance` 二重キャストが必要。pino 互換 mock を任意に作るのは難しい型負荷がある。代替案として「pino を本物で回しつつ stream を捕まえる」方が型は綺麗だが実装コストが高い。テストでの mock pino は知見に追記 (`docs/knowhow/fastify-plugin-error-logging.md`)
- **2026-05-05 phase11.8 セッション**: parse_error カテゴリのテストは「空 HTML 経由」では general() が title=hostname で summary を返してしまうため発火しない。**カスタムプラグインで `summarize: async () => null` を強制**する経路にすれば確実。テスト名と実挙動の乖離は review agent が指摘してくれた (W-3)

## phase12.5 followup (本番チューニング + fail mode 拡張) 知見

- **2026-05-06 phase12.5 followup チューニングセッション**: 本番 21 秒の根本原因切り分けで「**段階的フォールバックは累積コストが見えにくい**」教訓。1 段ずつ消費時間を測らないと、どの段がボトルネックか判別できなかった。phase12.1 で proxy fallback、phase12.5 で curl_cffi を入れた結果「無駄な前段が 2 つ重なる」状況になっていた。本来「サイト特性が確定したらプラグイン側で経路を skip」する設計を最初から組み込むべきだったが、汎用基盤を先に作り「特性確定後にプラグインで上書き」する流れも実用上は機能した。後付け OK だが「**段階的フォールバックは確実に発火する段だけ残す**」原則は記録に値する → `docs/knowhow/curl-cffi-tls-impersonation.md` に「3 重スキップパターン」として反映済
- **2026-05-06 phase12.5 followup チューニングセッション**: ユーザー (オーナー) が **`time curl` の単純計測** で「(a) 爆速、(b) 20.93秒」というシンプルな比較を提示してくれたことで切り分けが一気に進んだ。pino の段ごとログを増やして測るより、**外側から黒箱比較する** ほうが情報密度が高い。skill `/url-preview-check` に「比較計測の最小コマンド」を増やす価値あり (現状の skill は対症療法 fail mode 別の対処に寄っている)
- **2026-05-06 fail mode I 発見セッション**: nitori-net.jp で「**ブラウザでは見えるのにサーバ HTML には OGP が無い**」パターンを fail mode I として確定。SAP Commerce Cloud SPA + react-helmet 等での JS 動的 OGP 注入は **誰一人として展開できない実装** (全 SNS bot は JS 実行しない)。サイト側の実装ミスとして整理し、summaly では救援不可と判断 → `docs/knowhow/spa-dynamic-ogp-unfixable.md` に切り分けチェックリスト + サイト側に要望すべき正攻法を記録。**「ブラウザで見えるからといって取れるとは限らない」** は今後の URL preview 案件の前提知識として再利用可
- **2026-05-06 journalctl + jq 落とし穴セッション**: skill 改善で再発しがちな 2 落とし穴 (① journalctl `-o cat` でも環境によりプレフィックスが残る、② `select(.x | contains(...))` が null フィールドで parse error) を skill `/url-preview-check` の独立セクションとして抽出。skill は「fail mode 別の対処」だけでなく「ツール固有の落とし穴」も組み込むほうが反復作業の質が上がる

## phase12.5 (curl_cffi Node IPC 統合) 知見

- **2026-05-06 phase12.5 Step 2 セッション**: `child_process.spawn` 経由の Promise を作るとき、`error` と `exit` の両方が発火するケース (signal 終了等) で resolve/reject が二重に呼ばれる潜在バグを review agent が **W-3** で指摘した。`let settled = false; const settle = fn => { if (settled) return; settled = true; clearTimeout(...); fn(); }` のガードパターンで対処。Node の event-driven IPC では「単一発火を保証する手段」が言語に組み込まれていないため、この種のガードは spawn ベースのブリッジで必須。`docs/knowhow/curl-cffi-tls-impersonation.md` の「spawn-per-request の防衛パターン」セクションに記録
- **2026-05-06 phase12.5 Step 2 セッション**: review agent が **W-1 エンコーディング契約の非明示** を指摘。`got` 経路は `rawBody` → `detectEncoding` → `toUtf8` で encoding 再判定するが、curl_cffi 経路では Python 側 (`response.text`) で既にデコード済みのため二重変換しない設計選択を **無言で** 採用していた。non-UTF-8 サイトで化ける可能性があり、コメントとして明示する必要がある。`Buffer.from(body, 'utf8')` の前にエンコーディング契約セクションを書いて、CLI 側との約束 (CLI が UTF-8 で出す責任 / Node 側は二重変換しない責任) を明示化
- **2026-05-06 phase12.5 Step 2 セッション**: contribution agent が「**外部プロセス依存を追加した場合は SETUP.md / Library.md の依存宣言と package.json の optionalDependencies 有無を確認する**」というテンプレート改善を提案。これは ADDF テンプレート (`ProgressTemplate.addf.md` ステップ 4.5「ドキュメントと実装の突き合わせ」) に追加すべき汎用項目。本フェーズでは npm publish 対象外設計 (`tools/` 配下) で `optionalDependencies` 追加は不要だったが、将来 Python 以外の外部 CLI を Node から呼ぶ機会があれば類似の選択を迫られる。**ADDF 本体への寄与候補**として記録 (テンプレートの「外部プロセス依存追加時」項目)
- **2026-05-06 phase12.5 Step 2 セッション**: review agent が **import バグ (`getResponseWithProxyFallback` を `proxy-fallback.js` ではなく `got.js` から import していた)** をテスト失敗経由で検出。typecheck も eslint も通っていた (`got.ts` には同名の export がないが、type だけ通る形だった)。**「typecheck が通るのに runtime で `is not a function`」** はテストでしか catch できないクラスのバグ。spawn 統合のテストを書く価値が改めて確認できた

## phase12.1 dev サーバ統合 (E2E 完了後) 知見

- **2026-05-06 phase12.1 dev 統合セッション**: 本番 E2E 成功 → dev サーバで手元再現できる UI を後追いで追加するパターン。実装規模としては server.ts に env 読み込み + `/api/dev-config` エンドポイント追加 + `?proxy=1` クエリ処理、UI に hidden checkbox + JS で動的表示。**「本番が動いた → 開発者が手元で再現できないと改善サイクルが回らない」** という観点で、E2E 後の dev 整備は重要
- **2026-05-06 phase12.1 dev 統合セッション**: レビュー agent が **`/api/dev-config` で secret を返さない（proxyHost だけ返す）** 設計を good practice として追認。env から secret を読む UI のお手本パターン: 「**boolean availability + 識別子（host）だけ返し、secret は絶対に返さない**」。`secret` 文字列が JSON / ログ / エラー文字列に混入する経路を網羅的に閉じる必要があり、Fastify logger の `redact` 設定や呼出側コメントで「`proxyEnv.url` だけを渡す」を明示するのが防衛的
- **2026-05-06 phase12.1 dev 統合セッション**: **allowlist の二重管理問題** (W-3) — Worker 側 (`wrangler.toml` の `ALLOWED_DOMAINS`) と summaly 側 (`[scraping.proxy].domains` / dev server のハードコード) で独立に persist する。Worker 側が最終防衛なので機能影響は小さいが、**片方だけ更新すると UX 上の混乱を招く**。コメントで明示同期義務を書くか、将来 `/api/config-check` で Worker から allowlist を fetch する選択肢
- **2026-05-06 phase12.1 dev 統合セッション**: dev サーバの `SUMMALY_ALLOW_PRIVATE_IP=true` + proxy 経由は **defense-in-depth が効きにくい組み合わせ**。`viaProxyWorker` が `ip: undefined` で返すのでそもそも summaly 側の private IP ガードは発火しない。`HOST=127.0.0.1` バインドが暗黙の最終防御になっており、`HOST=0.0.0.0` 等への変更は禁忌。SETUP.md と server.ts コメントで明示

## phase12.1 Step 3〜7 (summaly 側組み込み) 知見

- **2026-05-05 phase12.1 Step 3-7 セッション**: レビュー agent が指摘した **C-1 (amazon プラグインの opts 受け渡し漏れ)** が phase12.1 の主目的そのものを破壊する痛い穴だった。`amazon.ts` の `summarize(url: URL)` シグネチャに `opts` が無く、`scrapingOptions` の `proxyFallback` が無視される構造。**目的のサイトで動作確認するテスト**（Plan の Step 4.3 E2E）が無いとこの種のバグは検出困難。今回は手動 E2E がまだなのでレビュー agent が机上で発見してくれた
- **2026-05-05 phase12.1 Step 3-7 セッション**: レビュー agent が **C-2 (`got` の `throwHttpErrors: true` デフォルト)** を指摘。proxy が 4xx/5xx を返したとき `Got.HTTPError` が throw されて、自前で書いた `if (statusCode >= 400)` のチェックは dead code だった。**「実装が動くテストを書いた → でも実は別経路で同じ結果が出ているだけ」** のパターンで、テストが「正しい理由で通っている」かを意識しないと見逃す
- **2026-05-05 phase12.1 Step 3-7 セッション**: 動的 import で循環参照を回避するパターン: `await import('@/utils/proxy-fallback.js')` を `scpaping()` 内で 1 回呼ぶ。Node.js のモジュールキャッシュにより初回ロード後はほぼ同期解決でコスト無視できる。**循環参照の解消には型レベル分割か動的 import の 2 択**で、後者の方が type 簡潔
- **2026-05-05 phase12.1 Step 3-7 セッション**: Worker レスポンスを `Got.Response<string>` に整形する透過プロキシパターンで、`scpaping` が見るのは `rawBody` (encoding 検出) / `headers.content-type` / `statusCode` / `url` のみ。型を `as unknown as Got.Response<string>` で擬装するのは debt だが、ライブラリ書き換えコスト対比で許容範囲。**「見える属性を最低限揃える擬装」はライブラリ統合の常套手段**
- **2026-05-05 phase12.1 Step 3-7 セッション**: シークレット未設定時に **起動失敗ではなく warning + 機能無効化** する設計。「config.toml をうっかり public にコミットしても安全」という運用ニーズを satisfy。レビュー agent も「設定したのに動かないと気付きにくい」というトレードオフを指摘したが、設計判断として明記して採用。**「default-on で危険」と「default-off で安全」のバランスは運用モデル次第**

## phase12.1 (CF Workers proxy 実験フェーズ) 知見

- **2026-05-05 phase12.1 セッション**: 「**実機検証が必要なフェーズ**」を AI 自律実行する場合の良いパターン: **Step 1.1 (Worker スケルトン) + Step 1.2 (署名ヘルパ) + Step 1.3 (実験手順書) までを実装し、Step 1.3 (実機 GO/NO-GO 判定) はオーナーに引き渡す**。Cloudflare アカウントの紐付き・実 IP からの実 Amazon アクセスが必要な工程は AI には決定できないため、ここで止めるのが正しい。Plan の Step 2 以降は GO 判定が出てから着手
- **2026-05-05 phase12.1 セッション**: `tools/` ディレクトリに独立 npm package (`cf-proxy-worker`) を置き、main の `package.json` `files: ["built", "LICENSE"]` で **publish 対象から自動的に除外** される構造を採用。利用者が `npm install summaly` しても Worker コードは降りない。さらに `eslint.config.js` に `tools` を ignore 追加して main eslint からも分離（workers-types の `Response` 型と main の DOM types が衝突するため）
- **2026-05-05 phase12.1 セッション**: HMAC 検証で **Worker 側 (Web Crypto API) と Node 側 (`crypto.createHmac`) を相互運用** する設計。両方とも HMAC-SHA256 標準なので message format (`${url}\n${ts}`) を一致させれば動く。Web Crypto は async (`await crypto.subtle.sign`) で Node std は sync (`createHmac().digest()`) という API 差は呼出側で吸収。**「アルゴリズム標準化された crypto は cross-runtime で相互運用可能」**
- **2026-05-05 phase12.1 セッション**: オープンプロキシ化を防ぐため **8 層防御** を採用 (HTTPS only / HMAC-SHA256 / タイムスタンプ窓 ±5 分 / Worker 側 allowlist / summaly 側 allowlist / 受信 cap / 定数時間比較 / 403 で詳細を返さない)。「個人運用 summaly のリスクモデル」としては許容範囲だが、商用運用には IP allowlist 等の追加層が必要。設計教訓は `tools/cf-proxy-worker/README.md` に記録

## phase11.6 (迂回候補ログ) 知見

- **2026-05-05 phase11.6 セッション**: 「機能追加と既存機能のリファクタリングを同時にやる」フェーズの好例。`JsonlAppender` を `ParseFailureLog` から内部クラスとして抽出（cap・I/O エラー連発抑制ロジックを class 化）して、candidate / blocked の 2 系統を綺麗に共存させた。Plan の Step 1 が「`analyzeFailure()` 統合」を提案していたが、実装段階で「`categorizeError` + `FILTERED_CATEGORIES` の組み合わせで十分」と判断して deviation。Plan は方向性として参考になるが具体実装は実装段階で再検討する余地を残す
- **2026-05-05 phase11.6 セッション**: `record()` のシグネチャ拡張（`errorMessage?, errorName?, statusCode?` の optional 3 連）は **位置引数 5 つ**になって読みにくくなったが、互換性維持のため譲歩。レビュー agent の S-1（`reason === 'thin'` で `errorName` 渡す誤呼び出し）はオーバーロード型で防げるが、実装複雑化対実害ゼロでスキップ判断。**「型安全性 vs 実装複雑度」** のトレードオフで、利用者が 1 箇所しかない場合は型シグネチャの簡潔さ優先
- **2026-05-05 phase11.6 セッション**: レビュー agent が **「`isFilteredFailure` と `categorizeError` の二重呼び出し」**(W-1) を指摘。`record()` 内部で `isFilteredFailure(...)` → `categorizeError(...)` の順で 2 回計算していた（`isFilteredFailure` 自身が内部で `categorizeError` を呼ぶため）。直接 `FILTERED_CATEGORIES` を参照する形に修正して 1 回呼び出しに統合。**「同じデータを 2 回計算するな」** のレビュー指摘は ホットパスでなくても読みやすさで効く
- **2026-05-05 phase11.6 セッション**: `groupKeyOf('https://www.npmjs.com/package/mfm')` は **2 セグメント取って `www.npmjs.com/package/mfm`** を返す（plan の例 `www.npmjs.com/package` は 1 セグメントになっていて誤り）。Plan の例文を信じると test の expectation がズレる。**Plan の具体例は実装で必ず実機確認する**

## phase11.7 (favicon thumbnail fallback) 知見

- **2026-05-05 phase11.7 セッション**: 機能追加に伴って **観測機構 (`isThinSummary`) の純度を維持する補正** が必須になるパターン。新機能 `thumbnail = image ?? icon?.href ?? null` を入れただけだと、phase10.1 の thin 検出器が「favicon あり = thin ではない」と誤判定してしまい、プラグイン化候補の取りこぼしが発生する。`thumbnail !== icon` の補正で復旧。**機能と観測機構をセットでメンテしないと検出器が静かに腐る** という教訓。`docs/knowhow/plugin-infrastructure-patterns.md` に記録
- **2026-05-05 phase11.7 セッション**: レビュー agent が **JSDoc 冒頭の説明と補正後の挙動の食い違い** (W-1) を指摘。新しい条件を入れたとき、JSDoc 全体を読み直して整合性チェックする習慣を持たないと、後で読む実装者が古い説明を信じて誤った変更を入れる。**「補正」を `**phase11.7 補正**` セクションで追記したつもりでも、冒頭の箇条書きが古いままでは効果半減**
- **2026-05-05 phase11.7 セッション**: 既存 thin テスト（phase10.1 / 11.5）が `<title>localhost</title>` のみの HTML で `/favicon.ico` を mock していなかったため、fastify のデフォルト 404 に暗黙依存していた。phase11.7 実装後も `icon: null → thumbnail: null` で従来挙動が偶然維持された。**「動いているテストが暗黙の前提に依存している」可能性をレビュー agent が指摘** (S-1) → 該当テストでは `app.get('/favicon.ico', (_, reply) => reply.status(404).send())` を明示する形にした。読みやすさ + 将来 fastify の挙動変更耐性

## phase11.9 (bot block UA リトライ) 知見

- **2026-05-05 phase11.9 セッション**: M サイズフェーズで Plan の 11 ステップを完遂すると実装規模が大きくなりがち。Step 8（pino fallback フィールド追加）は実装規模対観測コストが見合わないと判断して **別 phase (phase11.6) に廆す deferral 判断** を実装途中で行った。Plan に「方針からの変更」として記録 + CHANGELOG ではこの分は触れず、phase11.6 完了時に合流させる前提。**Plan 完了率より「動くものを出す」優先** の判断。phase11.4 の `dist-tags.latest` null フォールバックと同種の deferral パターン
- **2026-05-05 phase11.9 セッション**: ユーザーから実装途中で「UAデフォルトは riin-summaly がいいかも」という指摘。`misskey-dev/summaly` ではなく fork URL を指す方が運用的に正しい（運用者が問い合わせ可能な場所）。**指摘を即反映 + 倫理判断（fork なのに upstream URL を名乗るのは fork 側の責任を曖昧にする）として knowhow に記録**
- **2026-05-05 phase11.9 セッション**: フォールバック UA リトライのテストで `summaly()` 全体経路を動かすと **HEAD/GET probe (resolveRedirect) が attempts カウントに混入** する。`followRedirects: false` を明示してリトライ機構の挙動だけを切り出すのが綺麗。テスト戦略として `docs/knowhow/bot-block-ua-retry.md` に記録
- **2026-05-05 phase11.9 セッション**: レビュー agent が **「`enabled = true` + `userAgent` 未指定がサイレントに無効化される」** という診断困難な運用バグを W-2 で指摘。`DEFAULT_FALLBACK_UA` をデフォルトとして埋める形で修正。同時に **「`DEFAULT_FALLBACK_UA` がどこからも参照されていない」(S-2)** も解消（W-2 修正で参照するようになった）。**「export しているがどこからも参照されていない定数」のレビュー観点が良い**
- **2026-05-05 phase11.9 セッション**: TOML パーサーで `categories = ["bot_blocked", "typo_category"]` のような typo を許容する潜在バグをレビュー agent が S-3 で指摘。`VALID_ERROR_CATEGORIES` セットを `bin/config-loader.ts` に追加して typo 検出。ただし **`SummalyErrorCategory` ユニオンとの手動同期** が必要になり、新カテゴリ追加時の保守箇所が分散する。`as const` + `Object.values` でカテゴリ一覧を単一ソース化するリファクタ案は別 phase 候補（軽い負債として記録）

## phase11.4 (npmjs プラグイン / Cloudflare 配下 JSON API 直叩き) 知見

- **2026-05-05 phase11.4 セッション**: 「Cloudflare Bot Management で蓋されているサイトでも公式 JSON API は素通し」というパターンが発見器として有効。npm の `www.npmjs.com` (HTML 403) ↔ `registry.npmjs.org` (JSON 200) は典型例。Plan で `curl -A SummalyBot/x.y.z` の事前検証コマンドを記録しておくと、レビュー段階で「実装前に検証済み」と確認できる。`docs/knowhow/plugin-infrastructure-patterns.md` に汎用化したパターンを追記済み
- **2026-05-05 phase11.4 セッション**: `pkg.replace('/', '%2F')` の非 global `replace` がコードレビューで「`replaceAll` でない理由が自明でない」と指摘された。**呼出元の `extractPackageName` 正規表現で構造的に `/` が最大 1 件であることが保証されている**ためバグではないが、コメントで意図を補足することで将来のリファクタリング事故を防げる。「ロジック整合性は保証されているが知識が分散しているコード」へのコメント追加が有効
- **2026-05-05 phase11.4 セッション**: Plan の方針からの逸脱（`dist-tags.latest` 不在時に throw ではなく null フォールバック）を実装段階で判断したが、Plan に書かれた選択肢を最終決定にしないこと自体は問題なし。**逸脱を Plan 完了状況更新時に明記する**（Step に「方針からの変更」と書く）と、後から trace できる。phase10.1 で `isFilteredFailure` を追加した時のパターンと同じ
- **2026-05-05 phase11.4 セッション**: pure 関数の命名 (`extractPackageName / buildRegistryUrl / buildSummaryFromRegistry`) を「動詞 + 名詞句」で揃えると、テストの describe 名と export 名が綺麗に対応する。spotify の `buildSummaryFromOEmbed` も同パターン。新規プラグインの命名テンプレとして再利用できる

## phase11.5 (診断エンドポイント廃止) 知見

- **2026-05-05 phase11.5 セッション (機能削除フェーズ)**: 「機能を撤去する」フェーズで `addf-code-review-agent` が「削除漏れチェック」を網羅的に実行できることを確認。`grep -rn parseFailureLogEndpoint\|__diagnostics` で全リポ走査して残存箇所を意図的（コメント / 履歴 / forward-compat テスト）と未削除に分類して報告するワークフローが綺麗に効いた。レビュー agent は「追加・変更」だけでなく「削除フェーズの検証」にも有効
- **2026-05-05 phase11.5 セッション**: TOML loader の **smol-toml が unknown key を silent ignore する** 挙動を意図的に活用して、削除した `parseFailureLogEndpoint` 設定が残っている既存ユーザーの起動失敗を回避。「Breaking change だが silent migration を許容する」設計パターン。`test/config-loader.test.ts` に「`parseFailureLogEndpoint = true` を渡しても `(cfg.summaly).parseFailureLogEndpoint` が undefined になる」forward-compat テストを追加することで、smol-toml の挙動変更で気付けない壊れ方を防いでいる。**3 点セット**: silent ignore + forward-compat テスト + CHANGELOG での明示的 BREAKING 記録
- **2026-05-05 phase11.5 セッション**: 「外部 HTTP インターフェース vs ファイル経由」の運用設計トレードオフ。機微データ（preview 試行 URL）の集約を HTTP エンドポイントで露出すると nginx 設定ミスで構造的にプライバシー漏洩リスクが残る。**JSONL ファイル + ファイルシステム権限 (`chmod 600`)** に置き換えると攻撃面が大幅に縮小。`docs/knowhow/observability-parse-failure-log.md` に設計教訓として追記済み
