# Phase 2.2 — mei23 fork の非プラグイン機能の取り込み（軽量版）

> 状態: **完了 (2026-05-03)**
> 種別: 機能拡張 / 取捨選択
> サイズ: **M**
> 依存: なし（[phase2.1](phase2.1-plugin-infrastructure.md) と並列で着手可）
> 関連: [phase5.1-pdf-support.md](phase5.1-pdf-support.md)（本フェーズから切り出した PDF 対応）

## 目的・背景

mei23 fork に存在し、upstream に存在しない / 実装が異なる「プラグイン以外」の機能を取捨選択し、価値の確認できたものを取り込む。**PDF 対応は規模が大きいため [phase5.1](phase5.1-pdf-support.md) に切り出して別フェーズ扱い**。本フェーズはそれ以外の軽量変更を扱う。

採用判断のマトリクスは「## 取捨選択の判定マトリクス」を参照。不採用としたものについても理由を残し、将来必要になったときに参照できる形で記録する。

---

## 現状分析

### mei23 fork のファイル構成（プラグイン以外）

[worktrees/mei-summaly/src/](worktrees/mei-summaly/src/) と [worktrees/mei-summaly/](worktrees/mei-summaly/) ルートを upstream [src/](src/) と比較:

| 領域 | mei23 のパス | upstream の対応 |
|:---|:---|:---|
| エントリ（API） | [src/index.ts](worktrees/mei-summaly/src/index.ts)（`Summary` クラス） | [src/index.ts](src/index.ts)（関数 `summaly(url, opts)`） |
| 型定義 | [src/summaly.ts](worktrees/mei-summaly/src/summaly.ts)（`medias?: string[]` 含む） | [src/summary.ts](src/summary.ts)（`medias` 無し） |
| 汎用処理 | [src/general.ts](worktrees/mei-summaly/src/general.ts)（PDF 対応、`useRange` 引数） | [src/general.ts](src/general.ts)（HTML only、Range なし） |
| HTTP 層 | [src/utils/got.ts](worktrees/mei-summaly/src/utils/got.ts)（PDF / `useRange` / `agent` import） | [src/utils/got.ts](src/utils/got.ts) |
| 結果サニタイズ | [src/utils/sanitize-url.ts](worktrees/mei-summaly/src/utils/sanitize-url.ts) | 無し（`getOEmbedPlayer` 内で部分実装） |
| HTTP Agent | [src/utils/agent.ts](worktrees/mei-summaly/src/utils/agent.ts)（keep-alive、`SUMMALY_FAMILY`） | 既定 agent 無し。`setAgent` で外部から注入 |
| エンコーディング | [src/utils/encoding.ts](worktrees/mei-summaly/src/utils/encoding.ts)（`jschardet` + `encoding-japanese`） | [src/utils/encoding.ts](src/utils/encoding.ts)（`chardet` + `iconv-lite`） |
| デプロイ補助 | nginx / systemd 例 | 無し |

---

## 取捨選択の判定マトリクス

| # | 項目 | 価値 | 採否 | 理由 / 備考 |
|:--|:---|:---:|:---:|:---|
| 1 | **PDF レスポンス対応** | 高 | **採用（本フェーズ外）** | 規模・リスクが大きいため [phase5.1](phase5.1-pdf-support.md) で別扱い |
| 2 | **`useRange` オプション** | 中 | **採用** | サーバ運用で帯域節約。`SummalyOptions.useRange?: boolean` を追加し、`scpaping` まで透過 |
| 3 | **keep-alive デフォルト agent** | 中 | **採用** | 高頻度プレビューでの遅延削減。**既存の `setAgent` API 互換は崩さない**（外部 agent が来たらそれを優先） |
| 4 | **`allowedPlugins` オプション** | 中 | **採用（オプトイン）** | 未指定なら全有効（互換）、配列指定で許可リスト適用、空配列で組み込み全 disable |
| 5 | **`Summary.medias?: string[]`** | 中 | **採用** | [phase6.1 twitter](phase6.1-plugin-twitter.md) と [phase3.2 amazon 拡張](phase3.2-plugin-dom.md) の前提。型と通り道を先に整備 |
| 6 | **`utils/sanitize-url.ts`** | 中 | **採用** | 結果 URL のプロトコル検査フィルタ。`https:`/`http:`/`data:`<size_limit> を許可。**`data:` は将来の PDF アイコン用途で必要**（[phase5.1](phase5.1-pdf-support.md) 採用時の前提） |
| 7 | **デプロイ補助ファイル** | 中 | **採用** | nginx 設定例 + systemd unit + 設定例。`docs/deploy-examples/` に配置 |
| 8 | **プラグインによる UA オーバーライド** | 中 | **採用（[phase2.1](phase2.1-plugin-infrastructure.md) で実施）** | コアにホストリスト不採用、プラグイン個別対応に。基盤は phase2.1 |
| 9 | **`utils/check-allowed-url.ts`** | 低 | **不採用** | upstream の `getResponse` 内 `ipaddr.js` 検査と機能的に重複 |
| 10 | **`utils/cleanup-url.ts`** | 低 | **不採用** | 既存処理で代替可能 |
| 11 | **`utils/decode-entities.ts`** | ゼロ | **不採用** | upstream は既に `html-entities` 使用 |
| 12 | **`client.ts` (browserUA 定数)** | 低 | **採用箇所変更**（[phase2.1](phase2.1-plugin-infrastructure.md) で `BROWSER_UA` として export） | 取り込み自体はする |
| 13 | **`Summary` クラス API** | 低 | **不採用** | 採用項目 4 の `allowedPlugins` を既存関数に追加すれば代替できる |
| 14 | **`SummalyEx.$` 拡張型** | — | **不採用** | 各プラグインが自前で `scpaping → parseGeneral → 後処理` する設計に統一 |
| 15 | **h3 ベースのスタンドアロンサーバ** | 低 | **不採用** | upstream の Fastify モード + `fastify-cli` でほぼ同等 |
| 16 | **`SUMMALY_LOG_CONSOLE`** | 低 | **不採用** | Fastify 側で構成可能 |
| 17 | **文字コード判定の強化** | 中 | **採用** | [misskey-dev/summaly#39](https://github.com/misskey-dev/summaly/issues/39) の修正。`chardet` → `jschardet`、ISO-2022-JP は `encoding-japanese` |

---

## 設計方針

### API 互換性

- **既存の `summaly(url, opts)` 関数 API を破壊しない**。新オプションは全て optional で追加
- 既存の `Summary` 型は破壊せず、`medias?: string[]` を optional フィールドとして追加
- `setAgent` の挙動は維持。外部 agent が `setAgent` で渡されたとき既定 keep-alive agent は使われない

### `allowedPlugins` のセマンティクス

- `opts.allowedPlugins` 未指定（または `undefined`）→ 全プラグイン有効（現状互換）
- `opts.allowedPlugins: string[]` 指定 → 配列に含まれる名前のプラグインのみ有効（オプトイン）
- 空配列 `[]` を渡したら組み込みプラグイン全 disable（汎用パスのみで動く運用が可能）
- プラグイン名は [phase2.1](phase2.1-plugin-infrastructure.md) で導入された `name` 定数を参照
- `opts.plugins` で外部から渡されたカスタムプラグインは **配列の `name` 比較対象外**（filter されない）

### `medias[]` のセマンティクス

- `Summary.medias?: string[]` を追加（optional、`null` ではなく未定義をデフォルト）
- 既存組み込みプラグインは未設定。汎用パスは `thumbnail` のみのときは `medias` を未設定にする（重複を避ける）
- 利用側は `medias` を最優先、無ければ `thumbnail` を使う形を期待する

### keep-alive agent の既定化

- [src/utils/agent.ts](src/utils/agent.ts)（新規）に `httpAgent` / `httpsAgent` を `keepAlive: true, keepAliveMsecs: 30000` で生成
- 環境変数 `SUMMALY_FAMILY=4` / `=6` で IP family を強制可能（mei23 互換）
- `getResponse` 内の `agent` 渡しは「外部 agent が `setAgent` 経由で来ていれば外部 agent、無ければ既定 agent」
- **プライベート IP ガードのセマンティクス維持**: 既定 agent 使用時は依然としてガードが効く

### sanitize-url の適用ポイント

- `summaly()` の最終リターン直前で `result.player.url` / `result.icon` / `result.thumbnail` / `result.medias?.[]` を `sanitizeUrl()` でフィルタ
- 許可プロトコル: `https:` / `http:` / **`data:`（長さ上限を設けて DoS 対策、デフォルト 10 KB）**
- フィルタで `null` になった場合はそのフィールドを `null` に置き換える（`medias[]` は配列から除外）

### 文字コード判定強化のスキーマ

参考: [misskey-dev/summaly#39](https://github.com/misskey-dev/summaly/issues/39)（ISO-2022-JP のページが文字化けする、mei23 報告）。再現例: `https://www.comiket.co.jp/info-c/C97/C97genre.html`。

#### ライブラリ選定の根拠（mei23 が issue #39 で実測）

| エンコーディング | ライブラリ | 時間 (ms) | 倍率 (iconv 基準) |
|---|---|---:|---:|
| Shift-JIS | iconv-lite | 4,782 | 0.70 |
| Shift-JIS | iconv (native) | 6,815 | 1.00 |
| Shift-JIS | encoding-japanese | 33,529 | 4.92 |
| ISO-2022-JP | iconv-lite | 未サポート | — |
| ISO-2022-JP | iconv (native) | 7,319 | 1.00 |
| ISO-2022-JP | encoding-japanese | 33,471 | 4.57 |

判断:
- **Shift-JIS（高頻度）は `iconv-lite` を継続使用**（最速、PureJS）
- **ISO-2022-JP（低頻度）のみ `encoding-japanese` で専用処理**（4〜5 倍遅いが頻度が低いため許容）
- `iconv`（ネイティブ）は採用しない（ネイティブ依存の導入コストに見合わない）

#### 実装

- 依存変更: **`chardet` を削除**、`jschardet` と `encoding-japanese` を追加（`iconv-lite` はそのまま）
- [src/utils/encoding.ts](src/utils/encoding.ts) を mei23 ベースに書き換え:
  - `detectEncoding`: `jschardet.detect(body, { minimumThreshold: 0.99 })` を第一選択、フォールバックは `<meta charset>` パース、最終フォールバックは `utf-8`
  - `toUtf8`: `encoding === 'ISO-2022-JP'` のときだけ `encoding-japanese` の `Encoding.codeToString(Encoding.convert(buf, 'UNICODE', encoding))` を使う。それ以外は `iconv.decode` 継続
  - `toEncoding`: 既存と同じ正規化（`shift_jis` / `windows-31j` / `x-sjis` → `cp932`）+ `ISO-2022-JP` の素通し

### deploy 補助ファイル

- `docs/deploy-examples/` を新設し、以下を配置:
  - `summaly.nginx.conf.example`（mei23 から取り込み、`proxy_pass` 先と `server_name` をプレースホルダ化）
  - `summaly.service.example`（systemd unit、`ExecStart` を `fastify-cli` 起動に書き換え）
  - `summaly-config.example.json`（`allowedPlugins` / `useRange` を JSON で例示）
- README に「Production deployment」節を新設してリンク

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。各ステップは互いに独立しており、worktree を分けて並列開発も可能。

- [x] **Step 1 — `medias?: string[]` 型追加**
  - [src/summary.ts](src/summary.ts) の `Summary` 型 + `SummalyResult` 型に追加
  - 既存テストが壊れないことを確認（optional なので影響なし想定）
- [x] **Step 2 — keep-alive agent の既定化**
  - [src/utils/agent.ts](src/utils/agent.ts) を新設、`httpAgent` / `httpsAgent` を export
  - [src/utils/got.ts](src/utils/got.ts) で `setAgent` 未呼び出し時は既定 agent を使う
  - `SUMMALY_FAMILY` 環境変数のテスト追加
  - **テスト後の cleanup**: `agent.destroy()` を `afterAll` で呼んでプロセスがハングしないこと
- [x] **Step 3 — `useRange` オプション**
  - `SummalyOptions.useRange?: boolean` を追加
  - `scpaping` で `range: bytes=0-<MAX-1>` ヘッダ付与
  - `content-range` レスポンスヘッダのパースは既存の `contentLengthLimit` 検査と統合
  - フィクスチャベースのテスト追加（テストサーバ側で Range レスポンスを返す）
- [x] **Step 4 — `allowedPlugins` オプション**
  - `SummalyOptions.allowedPlugins?: string[]` を追加（[phase2.1](phase2.1-plugin-infrastructure.md) の `name` 定数を利用）
  - [src/index.ts](src/index.ts) のディスパッチで `builtinPlugins` を `allowedPlugins` でフィルタ
  - テスト: `allowedPlugins: ['amazon']` のとき wikipedia URL が general パスに落ちることを確認、`[]` で組み込み全 disable を確認
- [x] **Step 5 — `sanitize-url` 結果フィルタ**
  - [src/utils/sanitize-url.ts](src/utils/sanitize-url.ts) を新設（`https:` / `http:` / `data:`<size_limit> を許可）
  - [src/index.ts](src/index.ts) の最終リターン前に `player.url` / `icon` / `thumbnail` / `medias` を一括フィルタ
  - `data:` の長さ上限テスト追加（過大 base64 を弾くこと）
- [x] **Step 6 — 文字コード判定強化**（参考: [misskey-dev/summaly#39](https://github.com/misskey-dev/summaly/issues/39)）
  - `package.json` の依存を更新: `chardet` を削除、`jschardet` / `encoding-japanese` を追加
  - [src/utils/encoding.ts](src/utils/encoding.ts) を mei23 ベースに書き換え
  - 既存テストが全パスすることを確認
  - Shift-JIS と ISO-2022-JP の HTML フィクスチャを `test/htmls/` に追加し、UTF-8 にデコードされて OG 抽出されることをテスト
- [x] **Step 7 — deploy 補助ファイル整備**
  - `docs/deploy-examples/` を新設
  - mei23 の nginx / systemd を upstream 構成（`fastify-cli`）に合わせて書き換え
  - README に「Production deployment」節を追加してリンク
- [x] **Step 8 — README / CHANGELOG 更新**
  - 新オプション (`useRange`, `allowedPlugins`) の説明
  - keep-alive デフォルト化の挙動説明（外部 agent が優先される旨も）
  - 文字コード判定強化のリリースノート（issue #39 の修正である旨を明記）

---

## 完了条件 (Definition of Done)

- 採用項目（マトリクス # 2〜7、# 17）が全て実装され、`pnpm build && pnpm eslint && pnpm test` が通る
- `allowedPlugins` のセマンティクスが「**未指定 = 全有効、指定 = オプトイン許可リスト**」で実装されている（空配列指定で組み込みプラグイン全 disable も動く）
- 不採用項目はこのプラン内で「不採用」と理由が記録されている
- 既存ユーザーの呼び出しが破壊的変更を受けていない
- Range / allowedPlugins / medias / sanitize-url / keep-alive / 文字コード判定 の各機能にテストが付いている
- README に新機能と deploy ガイドが反映されている

---

## リスク・注意点

1. **keep-alive のリーク**: keep-alive agent は接続をプロセス終了まで保持しうる。テストで cleanup（`afterAll` で `agent.destroy()`）を整備しないとプロセスがハングする
2. **`allowedPlugins` の名前管理**: ファイル名と `name` 定数のドリフトに注意（[phase2.1](phase2.1-plugin-infrastructure.md) の CI 一致テストで防止）
3. **`useRange` でサーバが Range を返さなかった場合**: `Range` ヘッダを送っても `200 OK` でフルボディが返るサーバが存在する。既存の `contentLengthLimit` ガードに任せて切り詰めれば致命的ではないが、想定挙動として README に明記する
4. **deploy 補助ファイルの陳腐化**: nginx 設定は OS / ディストリのデフォルト変更で動かなくなることがある。`docs/deploy-examples/` には「動作保証なし、参考用」の旨を冒頭に記載
5. **`SUMMALY_FAMILY` 環境変数の互換性**: mei23 と完全互換にするため、値は文字列で `'4'` / `'6'` を受け付け、それ以外は無視
6. **文字コード判定ライブラリの差**: `chardet` → `jschardet` 置換でごく稀に挙動差が出る可能性。`minimumThreshold: 0.99` で誤検出を抑制し、フォールバックチェーン（jschardet → meta → utf-8）で安全側に倒す。既存テストフィクスチャを全パスすることを採用条件とする
7. **`data:` URI を結果に許可する範囲**: 長さ上限（10 KB）を必ず設ける。さもないと巨大 base64 によるメモリ膨張のリスク
