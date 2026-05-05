# Phase 11.5 — `/__diagnostics/parse-failures` 診断エンドポイントの廃止

> 状態: **未着手**
> 種別: 機能削除（破壊的変更 / オプトイン機能の撤去）
> サイズ: **S**
> 依存: なし
> 関連: [phase10.1](phase10.1-parse-failure-log.md)（追加した機能）、[phase11.6](phase11.6-blocked-failure-log.md)（並列に進めると整合）

## 目的・背景

[phase10.1](phase10.1-parse-failure-log.md) でプラグイン化候補発見器として導入した `/__diagnostics/parse-failures` エンドポイントを撤去する。

### 撤去理由

1. **プライバシーリスクが恒常的に残る** — 過去 preview 試行 URL（社内ブログ・個人ドメイン・短縮 URL の展開先）が in-memory に貯まる構造で、エンドポイントを公開している間、前段の nginx / firewall 設定をミスった瞬間に外部から JSON で全部読み取れる。「設定ミスで漏洩」が単発ではなく構造的に存在し続ける
2. **JSONL ファイルで代替できる** — 月次レビュー / プラグイン化候補発見の用途は `parseFailureLogJsonlPath` で書き出される JSONL を `cat | jq` するだけで足りる。ローカル dev で観察したいときも `tail -f` できる
3. **メンテ表面の縮小** — `parseFailureLogEndpoint` フラグ、起動時の組み合わせ検証 ([src/index.ts:401-405](../../src/index.ts#L401-L405))、ハンドラ実装 ([src/index.ts:546-557](../../src/index.ts#L546-L557))、config example の長文警告コメント、`CLAUDE.repo.md` / docs の説明、関連テストがまとめて消える

### 影響範囲

- 利用者（misskey 等）にとって API 互換性のある破壊的変更ではない（オプトイン機能で、デフォルト false）
- 既に `parseFailureLogEndpoint = true` を運用中のユーザーは、設定を消すか（`parseFailureLog = true` だけ残す）JSONL ファイル経由に切り替える必要あり
- CHANGELOG にて明示的に通知

---

## 現状分析

### 削除対象コード

- **[src/index.ts](../../src/index.ts)**
  - 154-161: `parseFailureLogEndpoint?: boolean` のプロパティ定義 (FastifyPluginOptions interface)
  - 401-405: 起動時の組み合わせ検証 (`endpoint && !parseFailureLog → 起動エラー`)
  - 546-557: `fastify.get('/__diagnostics/parse-failures', ...)` ハンドラ実装
- **[bin/summaly-server.ts](../../bin/summaly-server.ts)**
  - TOML から `parseFailureLogEndpoint` を読み取って options にマップしている箇所（要確認）
- **[bin/config-loader.ts](../../bin/config-loader.ts)** または同等
  - TOML スキーマ定義に `parseFailureLogEndpoint` がある場合、削除
- **[config.example.toml](../../config.example.toml)** [docs/deploy-examples/summaly-config.example.toml](../../docs/deploy-examples/summaly-config.example.toml)
  - 82-86 行近辺の `parseFailureLogEndpoint` のキーと「公開時は nginx で必ず制限」警告コメント全体
- **[CLAUDE.repo.md](../../CLAUDE.repo.md)**
  - `parseFailureLogEndpoint` の言及があれば削除
- **[docs/Library.md](../../docs/Library.md) / [docs/SETUP.md](../../docs/SETUP.md) / その他 docs**
  - 設定キー一覧から削除
- **[CHANGELOG.md](../../CHANGELOG.md)**
  - unreleased セクションに削除を破壊的変更として明記（既に当該機能を本番で使っている運用者向けの移行ガイド付き）
- **`test/`**
  - `parseFailureLogEndpoint` を有効化して `/__diagnostics/parse-failures` を叩いているテストがあれば削除

### `ParseFailureLog` クラス本体は残す

[src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) は in-memory 集約 + JSONL 書き込みを担当しており、撤去対象の endpoint とは独立。`snapshot()` メソッドはエンドポイントだけが呼んでいるが、テストや将来の用途を考えてクラス自体は残す（dead code としては残らないようテスト維持）。

---

## 設計方針

### 撤去のスコープ

「`/__diagnostics/parse-failures` HTTP ハンドラ」と「`parseFailureLogEndpoint` オプション」だけを消す。`ParseFailureLog` クラス、`parseFailureLog` フラグ、`parseFailureLogJsonlPath` 等の永続化・集約機能は維持する。

### 互換性の扱い

破壊的変更として明示する（minor バンプではなく次回 major バンプ予定の場合は major で）。`parseFailureLogEndpoint` という TOML キー / JS option を引き続き渡したユーザーは静かに無視されるか、起動時に警告を出すかの 2 択。

**推奨: 起動時に「未知のオプション」として TOML loader 側で警告を出す**（既存挙動と整合するなら）。silent ignore は気付けないので避ける。

### `parseFailureLog: true` 単体の用途明確化

エンドポイント無しになるので「`parseFailureLog: true` を有効化する意味」を README/docs で再整理:

- in-memory 集約のみ運用 → 効果無し（外部から読み出せない）
- JSONL 永続化と組み合わせ → ファイル経由でレビュー、これが正規の使い方

config.example.toml のコメントも「`parseFailureLogJsonlPath` と組み合わせて使う前提」と書き直す。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test && pnpm typecheck` を通す。

- [ ] **Step 1 — オプション定義 / 検証 / ハンドラ削除**
  - [src/index.ts](../../src/index.ts) の 154-161 / 401-405 / 546-557 を削除
  - 当該箇所で `parseFailureLogEndpoint` を参照しているコメントも掃除
- [ ] **Step 2 — bin / TOML 側のクリーンアップ**
  - [bin/summaly-server.ts](../../bin/summaly-server.ts) と関連 TOML loader から `parseFailureLogEndpoint` のマッピングを削除
  - 不明なオプションが TOML に残っていた場合の挙動を確認（warn にする / 無視する / エラーにする）
- [ ] **Step 3 — テスト更新**
  - `/__diagnostics/parse-failures` を呼んでいるテストがあれば削除
  - `parseFailureLog: true` だけで JSONL 書き込みが動く、という挙動のテストは維持/補強
- [ ] **Step 4 — config example 更新**
  - [config.example.toml](../../config.example.toml) と [docs/deploy-examples/summaly-config.example.toml](../../docs/deploy-examples/summaly-config.example.toml) から `parseFailureLogEndpoint` キーと警告コメント全体（5-6 行）を削除
  - 残った `parseFailureLog` ブロックのコメントを「JSONL を書き出してファイルベースでレビューする運用」に書き直す
- [ ] **Step 5 — ドキュメント更新（4.5 のドキュメント突き合わせ）**
  - [CLAUDE.repo.md](../../CLAUDE.repo.md) — `parseFailureLogEndpoint` の言及があれば削除
  - [docs/Library.md](../../docs/Library.md) / [docs/SETUP.md](../../docs/SETUP.md) — 同上
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased — `### Removed` または `### BREAKING` セクションに以下を追加:
    > - `parseFailureLogEndpoint` オプションと `/__diagnostics/parse-failures` HTTP エンドポイントを削除しました。プライバシーリスク（過去 preview 試行 URL の漏洩）を恒久的に避けるため、診断は `parseFailureLogJsonlPath` で書き出される JSONL ファイル経由で実施してください
- [ ] **Step 6 — 品質ゲート**
  - `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
  - `bash .claude/tests/run-all.sh`
  - `addf-code-review-agent` / `addf-contribution-agent`

---

## 完了条件 (Definition of Done)

- `/__diagnostics/parse-failures` HTTP ハンドラがコードから消えている
- `parseFailureLogEndpoint` オプションが型定義から消えている
- `parseFailureLog: true` + `parseFailureLogJsonlPath` の組み合わせは引き続き動く（JSONL に thin / 非フィルタ throw が記録される）
- config example から該当行が消え、コメントが「JSONL ベースの運用」に更新されている
- CHANGELOG に破壊的変更として記載されている
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る

---

## リスク・注意点

1. **既存ユーザーの設定で起動エラーになる可能性**: `parseFailureLogEndpoint = true` を本番運用で設定していた場合、TOML loader の挙動次第では「不明なキーで起動失敗」となる。CHANGELOG で明示し、TOML loader が unknown key を warn に留める実装になっていることを確認する
2. **`ParseFailureLog.snapshot()` の dead code 化**: endpoint だけが呼んでいたメソッドが orphan になる。phase11.6 のテストやデバッグ用途で再利用する想定なので残す。テストでカバレッジは維持
3. **将来再導入したくなった場合**: 「内部用 admin-only エンドポイント」として復活させたいケースが出る可能性はある。その場合は本フェーズの commit を git revert ベースで参照できるよう、削除コミットは単一にまとめる（フックは残さない）
