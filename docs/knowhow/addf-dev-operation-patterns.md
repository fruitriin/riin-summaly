# `/addf-dev` 運用パターン集

> phase14 / phase13.1 / phase11〜12 系を `/addf-dev` で連続自動運転 (cron 駆動 `/loop`) して蓄積した運用知見。各パターンは Feedback.md の個別記録から汎用化したもの。ADDF テンプレート (`ProgressTemplate.addf.md`) への寄与候補も含む。

## 大型 Plan の Step 分割運用

phase14 (M〜L) や phase13.1 (M〜L) のように 1 Plan に 7〜8 Step ある大型タスクは、**1 セッション 1 Step** で進めるのが最も安定する。

### パターン

- `docs/plans/` の Plan に `Step 1` 〜 `Step N` を実装順に列挙
- `/addf-dev` で「Plan 全体」ではなく **「Plan の最初の未完了 Step」** を選んで実施
- 実装後に Plan 内の Step 完了状況を更新 + TODO の状態欄を「進行中 (Step N 完了、Step N+1〜M 残)」に書き換え
- 次サイクルで `/addf-dev` が同 Plan の次の Step を継続

### 派生: Step の合体実施

以下の条件を満たす Step は **前後の Step と合体させて 1 セッションで完結** させる方が時間効率が良い:

- code 変更ゼロ (docs / knowhow / skill / Plan/TODO 更新のみ)
- 新規 export 無し
- 既存パターンの踏襲のみ

例: phase14 Step 6 (docs 仕上げ) + Step 7 (skill 更新) は併合実施した。phase13.1 Step 4 (テスト判断) + Step 6 (docs) + Step 7 (knowhow) も併合実施。

### 「自動化対象外」Step の扱い

UI 手動検証必要な Step (例: `pnpm dev` の UI で動作確認) は `/addf-dev` 自動運転の対象外。Plan を「ほぼ完了」状態に持ち込んで TODO に **「残 Step N (手動範囲)」** と明記する運用で良い。Plan の完了状況に手動 Step が残っていても、auto-run 可能な部分が全て終わっていれば次の Plan に移る。

### 派生: 半自動 Step の API / UI 切り分け

Plan の Step が「dev サーバ UI 統合」のように **API レイヤと UI work が混在** している場合、**API 部分だけ抽出して auto-runnable にする** と `/addf-dev` の対象が広がる。例: phase14 Step 5 を「`/api/strategy-cache` API 部分 (auto)」と「UI パネル + 目視検証 (manual)」に切り分けて API のみ実装した。

**Plan 起票時の示唆**: Step 設計の段階で **「self-contained で自動実装可能な部分」と「UI / 動作確認」を別 Step に切り分ける** と、後続の `/addf-dev` が進めやすい。

## Stage 1 ステップ 4.6 (ノウハウ再確認 + 自己レビュー)

`ProgressTemplate.addf.md` に新設した「Stage 1 → Stage 2 引き渡し前のノウハウ再確認 + 自己レビュー」ステップ (phase14 Step 1 セッション発で導入)。

### 発火条件

以下のいずれかを満たすときに実施:

- 新規ファイル / 新規 export 関数を追加した場合
- 既存ファイルに新しい責務カテゴリを足した場合 (URL 処理 / 永続化 / 子プロセス spawn / セキュリティ境界 / 暗号処理 等)

### Skip 条件 (3 条件すべて満たす場合)

- 責務が **既存パターンの踏襲のみ** (例: `parseFailureLog` 自動生成パターンを `domain-strategy-cache` 自動生成に転用するだけ)
- コード規模 S (数十行未満の追加 / 削除中心の変更)
- **新規 export 無し**

### 運用フロー

1. 実装内容を 1 文で説明し、その中の名詞句を **責務キーワード** として抽出
2. `addf-knowhow-filter` (or `addf-knowhow-agent`) に責務キーワードを渡して再フィルタ
3. 取り寄せた knowhow を「実装が同じ落とし穴を踏んでいないか」で自己照合
4. 落とし穴を踏んでいたら実装に差し戻し → ビルド・Lint・テスト再実行

### 効果

phase14 Step 2b 後半 セッションで `object-assign-mutable-target.md` (mutable parameter 競合観点) を「Plan 起点では出てこない knowhow」として 4.6 で発見できた。Plan-time pull は Plan に書かれた責務しか引けないため、4.6 の責務キーワード再フィルタが構造的弱点を補完する。

## Stage 2 (`addf-code-review-agent`) Skip 条件

code 変更ゼロの docs / skill / Progress 専用 Step では Stage 2 (code-review) を skip 可能:

- `docs/Plugins.md` / `docs/SETUP.md` / `docs/Library.md` のテキスト追加
- `.claude/commands/<skill>.md` の更新
- `CLAUDE.repo.md` 表行追加
- Plan / TODO / Progress / Feedback / CHANGELOG の更新

これらは code-review agent が見るものが無く、レビュー意義が薄い。`addf-knowhow-agent` での knowhow 整合性チェックも同様。

ただし **docs に scope-creep でコード変更が混入した場合** は通常通り Stage 2 を実施する。grep / git diff で `src/` / `bin/` / `test/` 配下に変更がないか確認してから skip 判断する。

## `addf-security-review-agent` 必須適用条件

phase13.1 Step 1+2 で初運用した security-review agent。**外部から HTML を返すエンドポイント新設** や **任意ヘッダ生成 / 外部入力を受ける** 変更で必須。phase13.1 では Critical/High ゼロだったが Medium 4 件が以下の観点で発見:

- **CSP / 任意ヘッダ生成のインジェクション攻撃**: TOML 値を `;` 区切りでヘッダに連結すると CSP ディレクティブ上書きが成立 (M-1 の発見、自己レビュー段階では気付けなかった)
- **opts / config が呼出経路で伝搬されない問題**: timeout / userAgent 等の設定が新エンドポイントで効かない (M-2)
- **デフォルト値の警告不在**: `frame-ancestors *` のような開発初期に楽な設定が商用に持ち出される運用リスク (M-3)
- **契約だけに依存しない defense-in-depth**: プラグイン側のエスケープ契約 + Fastify 側 sanity check (M-4)

### トリガー条件

以下のいずれかが含まれる変更ではセキュリティレビューを併用する:

- 外部から直接 fetch / iframe される HTML / JSON を返すエンドポイントの新設
- TOML / 環境変数 / 引数経由の値を HTTP ヘッダに反映する処理
- 任意 URL を fetch する経路 (SSRF 経路化リスク)
- 暗号 / 署名 / 認証関連の処理
- Cookie / セッション / CSRF 関連の処理

### Stage 2 への組み込み

通常の code-review agent と並列実行: code-review が「実装の正しさ」、security-review が「悪意ある運用者・悪意ある TOML 編集者」視点を持ち込む。発見観点が直交するため両方走らせる価値がある。

## 削除中心 Step のレビュー観点

phase14 Step 4 (`forceX` フラグ廃止) のような削除中心の変更では code-review agent の指摘が **「設計説明文書の同期」に集中** する傾向がある。実コードの問題は Critical/High に到達しにくいが、暗黙の前提が変わる箇所のドキュメント化漏れが Warning として出る。

### 観点

- 削除前に「特定の前提のもとで動作」していたコードのコメント / JSDoc を、削除後の前提に合わせて更新する
- 削除前のフラグ / オプションを言及していた docs / knowhow を「廃止」と annotate する (歴史的記述として残す価値はある)
- CHANGELOG に **breaking note** を書く (internal 型でも、library 利用者がカスタム拡張で使っている可能性に言及)

### Plan 起票時の示唆

削除 Step では「削除によって変わる暗黙の前提を明文化する」ことを Step 内タスクとして列挙すると、レビュー段階で見つかる前に対処できる。

## 「過去 Step で『予定』と書いた docs 表現」の grep チェック

phase14 Step 3 (bootstrap 同梱) の Stage 2 で W-1 (docs/SETUP.md) + W-2 (CHANGELOG) が 2 連続で発生 — どちらも「前 Step で `Step N で同梱予定` と書いた表現を完了形に更新する」漏れ。

### 4.5 ステップ「ドキュメントと実装の突き合わせ」への補強案

```bash
grep -rn "Step [0-9.]\+ で同梱予定\|Step [0-9.]\+ で実装予定\|TODO\|未着手" docs/ config.example.toml docs/deploy-examples/ src/ test/
```

機械的に「予定」表現を検出して、現フェーズで該当部分が完了したか確認する習慣にすると docs 内未来形 → 完了形の更新漏れが減る。

### 種類

- 「予定」「これから実装」など未来形の表現
- `TODO:` `FIXME:` `XXX:` 等のマーカー
- 完了状況テーブルの未チェック行 (Plan の `- [ ]`)

## utility ファイルを `src/plugins/` に置かない原則

phase13.1 Step 3 で `syosetu-genres.ts` (ジャンル ID マッピング) を `src/plugins/syosetu-genres.ts` として作成したところ、`test/index.test.ts` の「プラグイン name はファイル名と一致する」テストが失敗。

### 規約

- `src/plugins/*.ts` はすべて **`SummalyPlugin` interface (`name` / `test` / `summarize`) を実装** している前提
- utility / data file はファイル名命名で関連性を示す代わりに **`src/utils/<plugin-name>-<utility>.ts` で配置**

### 例

- ✗ `src/plugins/syosetu-genres.ts` (utility なのに plugins/ 配下、テスト規約違反)
- ✓ `src/utils/syosetu-genres.ts` (plugin から `import` するが配置は utils/)

Plan 起票時にもこの規約を意識して、`src/plugins/<name>.ts` 以外で配置先を考える。

## auto-run 可能タスクが尽きたときの運用

phase14 / phase13.1 が両方ほぼ完了状態で、TODO 上の残作業が手動範囲のみになったとき:

### 段階的選択肢

1. **Plan の半自動 Step を切り分けて API 部分だけ実装** (例: phase14 Step 5 の `/api/strategy-cache` API のみ)
2. **累積 Feedback の knowhow 化** (本ファイルがその例)
3. **既存負債の自動修正** (例: `general.ts` opts 個別列挙を spread refactor)
4. **将来検討メモ** から Plan を起票 (`docs/plans/phase<X>-...md`)
5. **PushNotification + CronDelete** でオーナーに通知して `/loop` 停止

### 判断基準

- 残作業の **「外部入力なしで完結する」** 度合いで上から選ぶ (1 が最も完結度高)
- knowhow 化はコンテキスト消費が大きい場合のみ実施 (15 ターン経過 system reminder 等)
- PushNotification は **3 サイクル連続で auto-runnable タスクなし** が続いたら検討

### 実運用ログ (2026-05-08)

phase14 / phase13.1 ほぼ完了後の 3 サイクルで以下のように消化:

- **サイクル N**: option 2 (knowhow 化) — `addf-dev-operation-patterns.md` 新設、Feedback 整理
- **サイクル N+1**: option 3 (既存負債修正) — `general.ts` spread refactor + `followRedirects: undefined` 防衛
- **サイクル N+2**: option 4 (将来検討メモから Plan 起票) — Playwright モードを `phase15.1-playwright-fallback.md` に昇格
- **サイクル N+3**: option 1〜4 すべて消化済 → option 5 (PushNotification + CronDelete) 実行

オーナー通知時のメッセージは「残作業の中で AI が判断できないもの」を要約する形が良い (例: 手動 UI 検証範囲 / 着手トリガー待ちの Plan / 外部リポ連携)。Mobile push が `Remote Control inactive` で送れない場合もあるが、本セッション側のログには残るのでオーナーが session 復帰時に把握できる。

### Plan 起票時に「着手トリガー」を明記する重要性

phase15.1 (Playwright モード) のような **発生頻度トリガー型 Plan** は、Plan ファイル自体を起票するのは AI 範囲だが、Step 1 (実機検証) 以降は「fail mode I 月 N 件 / preview したい SPA EC が増えた時」というオーナー判断トリガーが介在する。Plan 起票時にこの「着手トリガー」を明記しておくと、後続 `/addf-dev` サイクルで AI が誤って Step 1 に着手するのを防げる。option 4 で Plan 起票 → option 5 でオーナー通知、という連続消化パターンが綺麗に成立した。

## 既存負債修正 (option 3) の落とし穴: spread refactor 適用範囲

`/addf-dev` で auto-runnable 候補が尽きたときの「既存負債修正」(option 3) パターンで、`general.ts` の opts 個別列挙を spread に refactor した。次回類似 refactor を検討するときの判断材料:

### spread 化が安全な条件

- 呼出元と呼出先の型が **同一 (or 完全互換)**: `general()` は `GeneralScrapingOptions` を受け取り `scpaping()` も `GeneralScrapingOptions` を受け取る → `...opts` で安全
- 内部 / 危険フィールド (`_cacheRecording` 等) は **意図的に伝搬する設計** であることを JSDoc で明示済み

### spread 化できない条件

- 呼出元の型が呼出先より **広い** (例: `SummalyOptions` → `GeneralScrapingOptions` は `embedBaseUrl` / `embedConfig` / `parseFailureLogJsonlPath` 等が存在し、spread すると scpaping に余計なフィールドが伝わる)
- この場合は **手動列挙が正解**。ADDF テンプレートの「opts 伝搬チェック」項目で人間 (or レビュー agent) に同期義務を課す

### defensive override パターン

spread 後に意図的除外したいフィールドがあるなら、明示 override で構造的防衛:

```typescript
const res = await scpaping(url.href, {
  ...opts,
  lang: lang || undefined,
  followRedirects: undefined,  // phase11.3 bug 再発防止 (defense-in-depth)
});
```

`followRedirects` は型上 `GeneralScrapingOptions` に含まれるが現状すべての呼出経路で undefined。将来別経路が `followRedirects: false` を渡すリスクに対する明示 override。コメントで意図を明示すれば許容。

## 自信度評価は実装を Read してから答える

オーナーから「Phase X の実装の自信度」を聞かれたとき、**計画書 + コンパクション後記憶ベースで答えると不正確になる**。実装ファイルの存在は覚えていても、レビュー反映で改善された対処済みの懸念や、JSDoc に明記された設計判断は記憶から薄れている。

実体験 (2026-05-08 phase14 自信度評価):

1. **1 回目の評価**: 「writeFileSync + renameSync の EXDEV エラー、unlinkSync catch」の懸念を計画書記憶から列挙、自信度 75〜80% と回答
2. **オーナー指摘で実装を Read**: catch で `unlinkSync(tmpPath)` 済み、JSDoc に cross-device 対処が明記、`fetchByStrategy` の `null` vs `throw` 二値設計で gateFailedNeutral の neutrality 維持が読み取れる、HTTP 層 recordSuccess 削除という Step 2b 後半 設計修正の跡 (oscillation bug 根本解決)
3. **2 回目の評価**: 自信度 85〜90% に上方修正、コード品質単独なら 90%+

教訓:
- **自信度評価は本番未検証分とコード品質を分けて答える**: 「コード品質 90%+」「本番未検証分の不確実性で総合 85〜90%」のような分離回答が正確
- **実装を Read してから答える**: Plan-time の懸念リストには「実装で対処済みのもの」と「実装でしか見えないもの」が混在する。実装読み直し前に答えると前者を疑似懸念として混ぜてしまう
- **JSDoc は重要な設計判断の宝庫**: レビュー指摘 (S-1 / W-1 等) の reference 番号が JSDoc に残っているケースが多く、対処済み根拠として読める

## 本番 fix と E2E テスト追加の分業

オーナーが本番デプロイ (実環境ログ確認 + 再現確認 + 修正効果観察) を担当する裏で、AI が **本来あるべきだった E2E テストを 1 本追加** する分業パターン。

実体験 (2026-05-08 phase14 cascade fallback E2E):

- 初期実装で「default UA 失敗 → fallback UA で取れる → fallback_ua 学習」の E2E テストが欠落していた
- オーナー指摘 (「他の優先経路にフォールバックされていく → 2 回目以降 OK になっていれば OK」) で発覚
- AI が tracker 機構の構造的確認 + 専用 E2E テスト 1 本追加、オーナーは並行で本番投入

メリット:
- **本番投入の意思決定は人間**、E2E テスト追加 (auto-runnable) は AI、で時間並列化
- E2E テストが回帰防止層として残るので **将来の構造変更で同種バグが再発しない**
- 本番修正コミット ≠ E2E テスト追加コミット で分離 (revert 容易)

注意:
- AI 追加の E2E は「成功パス」だけでなく「失敗カウント増加 → cascade 移行」のような中間状態も assert すること
- E2E が通っただけで本番が動く保証にはならない (Mock の限界、本番は Mock 化できないネットワーク要素を含む)

## 本番ログから始まる即時 fix の作業順序

オーナーが本番 pino ログをペーストして「ここで failed しているのを見て」と渡してくる場合の作業順序:

1. **エラー stack を読み解いて該当コード箇所を特定** (file:line から逆引き)
2. **再現条件を実 API / 実 HTML で確認** (curl 等で本番と同じレスポンスを取得し、再現確認)
3. **どこで null / throw が発生するか具体的なエッジケースを特定** (`allcount=0` 等の具体値)
4. **設計選択肢を整理** (3 〜 5 選択肢、各々のトレードオフ): 例
   - A. 取り消す
   - B. fallback path を追加
   - C. オプション flag で利用者制御
5. **オーナー判断仰ぎ or 推奨 + 動く実装**: シンプルな case は推奨案で進めて事後確認、複雑な case は選択肢提示で判断仰ぎ
6. **実装 + テスト** (pure 関数化 + cheerio.load 経由で fixture HTML テストすると小さく書ける)
7. **コミット → オーナーが本番投入** (並列で AI が次の補強テストを書く分業へ)

実体験 (2026-05-08 syosetu n3862be 本番修正):

- ログから `failed summarize at src/index.ts:556` を特定
- curl で実 API 確認 → `[{"allcount":0}]` を得て allcount=0 ケースを特定
- 選択肢 3 つを整理、初手は最小修正 (general fallback) で進め、オーナー指摘 (「SNS bot UA」) → 改善 (`Twitterbot/1.0` UA)、さらに指摘 (「HTML scrape で API 同等情報」) → 専用 scraper 実装
- 段階的に修正コミットを積み重ね、各段でオーナーが本番投入できる状態を維持

教訓: **「本番 fix の即時性」と「設計の正しさ」のバランスは、まず最小修正で本番を動かし、改善を後続コミットで重ねる**。1 回で完璧を目指して数時間止めるより、3 回 commit して各々で本番反映する方が運用上安全。

## 関連

- [.claude/templates/ProgressTemplate.addf.md](../../.claude/templates/ProgressTemplate.addf.md) — 4.6 ステップ実装版
- [.claude/Feedback.md](../../.claude/Feedback.md) — 個別フィードバックの蓄積元
- [.claude/commands/addf-dev.md](../../.claude/commands/addf-dev.md) — `/addf-dev` スキル定義 (改善示唆の反映先)
