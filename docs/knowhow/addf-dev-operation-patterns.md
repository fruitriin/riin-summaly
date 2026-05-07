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

## 関連

- [.claude/templates/ProgressTemplate.addf.md](../../.claude/templates/ProgressTemplate.addf.md) — 4.6 ステップ実装版
- [.claude/Feedback.md](../../.claude/Feedback.md) — 個別フィードバックの蓄積元
- [.claude/commands/addf-dev.md](../../.claude/commands/addf-dev.md) — `/addf-dev` スキル定義 (改善示唆の反映先)
