# Phase 8.1 — TOML ベースの設定ファイル (`config.toml`) への移行

> 状態: **未着手**
> 種別: 運用基盤 / 設定 UX
> サイズ: **M**
> 依存: なし（[phase4.1](phase4.1-fastify-in-memory-cache.md) / [phase5.1](phase5.1-pdf-support.md) で導入された Fastify オプション群を流し込む対象として利用）

## 目的・背景

現状、Fastify モードの設定は **fastify-cli の `--options config.json`** で渡しているが、以下の不満点がある:

1. **JSON はコメントが書けない**: 「なぜこの値か」を残せない（`cacheMaxAge` の運用根拠など）
2. **JSON はセクション分割の表現が弱い**: フラットな key-value で並べるしかなく、「サーバ設定」「キャッシュ設定」「PDF 設定」「プラグイン別設定」のグルーピングが視覚的に分かりにくい
3. **将来のプラグイン別設定の拡張**（[komiflo の `preferredVariant`](../knowhow/plugin-infrastructure-patterns.md) や [iwara の description 長等](../Plugins.md#iwara)）を見据えると、**`[plugins.komiflo]` のようなセクション** が表現できる方が自然

Misskey 本体や類似 OSS プロジェクトでも TOML が選ばれる流れがある（人間が読み書きする設定としては JSON より優位）。本フェーズで **TOML ベースに移行** し、`config.example.toml` をリポジトリにコミットしてサンプル兼ドキュメントとして機能させる。

---

## 現状分析

### 現在の設定経路（[CLAUDE.md 現状チェック](../../CLAUDE.md) も参照）

1. **関数オプション**: `summaly(url, opts)` / `fastify.register(Summaly, opts)`
2. **fastify-cli `--options config.json`**: fastify-cli が JSON を読んで register の第 2 引数に注入（[docs/deploy-examples/summaly-config.example.json](../deploy-examples/summaly-config.example.json) に現行サンプル）
3. **環境変数**: `SUMMALY_ALLOW_PRIVATE_IP` / `SUMMALY_ENABLE_PDF` / `SUMMALY_FAMILY`
4. **グローバル mutable**: `setAgent()`

本フェーズでは **2 を JSON → TOML に置き換える**。1 / 3 / 4 は変更なし。

### 既存サンプル ([summaly-config.example.json](../deploy-examples/summaly-config.example.json))

```json
{
  "useRange": true,
  "allowedPlugins": ["amazon", "bluesky", "wikipedia", "branchio-deeplinks"],
  "cacheMaxAge": 604800,
  "cacheErrorMaxAge": 3600,
  "contentLengthLimit": 10485760,
  "responseTimeout": 20000,
  "operationTimeout": 60000
}
```

フラットで、コメントなし、セクション分割なし、将来の拡張余地が見えない。

---

## 設計方針

### TOML スキーマ（提案）

```toml
# config.example.toml
# summaly Fastify モードの設定例。コメント付きでそのまま config.toml にコピーして編集する想定。

[server]
# Fastify サーバの bind 設定。fastify-cli の --address / --port にも引き継ぐ想定。
host = "127.0.0.1"
port = 3000

[summaly]
# 共通 SummalyOptions（リクエスト個別の挙動）
userAgent = "SummalyBot/5.4"
responseTimeout = 20000      # ミリ秒。フェーズごと（DNS解決・接続・レスポンス各々）
operationTimeout = 60000     # ミリ秒。リクエスト全体
contentLengthLimit = 10485760 # 10 MiB。Range 上限としても利用される
contentLengthRequired = false
useRange = false             # true で Range: bytes=0-N-1 を送る（帯域節約）

[summaly.cache]
# Cache-Control ヘッダ + プロセス内 LRU キャッシュ
maxAge = 604800              # 成功レスポンスの max-age (秒、デフォルト 1 週間)
errorMaxAge = 3600           # エラーレスポンスの max-age (秒、デフォルト 1 時間)
inMemory = true              # プロセス内 LRU キャッシュを有効化
inMemoryMaxEntries = 1000

[summaly.pdf]
# PDF レスポンスのタイトル取得（オプトイン）
enabled = false              # 環境変数 SUMMALY_ENABLE_PDF=true よりこちらが優先される

[plugins]
# 利用許可するプラグイン名の配列。
#   undefined / 省略 → 全プラグイン有効（互換）
#   配列 → オプトイン許可リスト
#   [] → 組み込み全 disable（汎用パスのみで動作）
allowed = [
  "amazon",
  "bluesky",
  "wikipedia",
  "branchio-deeplinks",
  "youtube",
  "spotify",
  # "dlsite", "iwara", "komiflo", "nijie",  # 性的コンテンツを含むサイト。除外する場合はコメントアウトのまま
]

# プラグイン別の設定セクション（将来拡張用）。
# 現状の組み込みプラグインは全てハードコードのため、これらのセクションは
# **本フェーズでは何も読まない**（schema の placeholder として残す）。
# 将来の plugin-options 受け渡し機構（plugins.<name>.options を SummalyPlugin に渡す）が
# 実装されたタイミングで読み始める。

# [plugins.komiflo]
# preferredVariant = "346_mobile"
# apiBaseUrl = "https://api.komiflo.com"

# [plugins.iwara]
# descriptionMaxLength = 500
# sensitiveHosts = ["ecchi.iwara.tv"]
```

### TOML パーサ

候補:
- **`smol-toml`** (推奨): 純 JS、依存なし、小さい (~40KB)、TOML 1.0 完全対応
- `@iarna/toml`: 古い、メンテナンスが滞っている
- `@ltd/j-toml`: 高速だがやや重い

→ **`smol-toml` を採用**（依存追加最小、メンテ活発）。

### ロード経路の変更

#### 選択肢 A: fastify-cli の `--options` を維持し、TOML を読んだ object を返すラッパーを書く

fastify-cli は `.js` / `.cjs` / `.mjs` をオプションファイルとして受け付ける（`module.exports = { ... }` を期待）。**TOML を読んでオブジェクトとして export する小さな JS** を `--options` に渡す。

```js
// summaly-config-loader.cjs
const fs = require('node:fs');
const TOML = require('smol-toml');
const cfg = TOML.parse(fs.readFileSync(process.env.SUMMALY_CONFIG_PATH ?? './config.toml', 'utf-8'));
module.exports = flattenForFastify(cfg);  // [summaly], [summaly.cache] 等を SummalyOptions にマージ
```

→ fastify-cli を残せて互換性が高いが、**ローダーが間に挟まる** ため設定パス指定が `SUMMALY_CONFIG_PATH` 環境変数経由になる（fastify-cli の `--options` には JS ファイル固定）。

#### 選択肢 B: 専用の起動エントリ (`bin/summaly-server.ts`) を作り、fastify-cli を置き換える

```ts
// bin/summaly-server.ts
import fastify from 'fastify';
import Summaly from '@misskey-dev/summaly';
import { parse as parseToml } from 'smol-toml';
import { readFileSync } from 'node:fs';

const cfg = parseToml(readFileSync(process.argv[2] ?? 'config.toml', 'utf-8'));
const summalyOpts = mapTomlToSummalyOptions(cfg);
const app = fastify();
await app.register(Summaly, summalyOpts);
await app.listen({ host: cfg.server?.host ?? '127.0.0.1', port: cfg.server?.port ?? 3000 });
```

→ `pnpm serve config.toml` のような直感的な CLI が組める。**fastify-cli への依存が消える**（既存 `pnpm serve` script が変わる）。`[server]` セクション（host / port）も自然に扱える。

**採用: B**。設定 UX を主目的とするなら、起動コマンドも自然に `pnpm serve ./config.toml` で完結する形が良い。fastify-cli の依存削減も副次効果。

### マッピング: TOML → `SummalyOptions`

```ts
function mapTomlToSummalyOptions(cfg: TomlRoot): SummalyOptions {
  const s = cfg.summaly ?? {};
  const cache = s.cache ?? {};
  const pdf = s.pdf ?? {};
  const plugins = cfg.plugins ?? {};
  return {
    userAgent: s.userAgent,
    responseTimeout: s.responseTimeout,
    operationTimeout: s.operationTimeout,
    contentLengthLimit: s.contentLengthLimit,
    contentLengthRequired: s.contentLengthRequired,
    useRange: s.useRange,
    cacheMaxAge: cache.maxAge,
    cacheErrorMaxAge: cache.errorMaxAge,
    inMemoryCache: cache.inMemory,
    inMemoryCacheMaxEntries: cache.inMemoryMaxEntries,
    enablePdf: pdf.enabled,
    allowedPlugins: plugins.allowed,
  };
}
```

スキーマの不正値は **読み込み時に zod 等で検証** して early fail する（型違いで cryptic な runtime エラーになるのを防ぐ）。zod 依存を増やしたくなければ手書き検証でも可（`typeof cfg.summaly?.responseTimeout === 'number'` 等）。本フェーズは依存最小化を優先して **手書き検証** を採用。

### `config.example.toml` の位置

[`docs/deploy-examples/`](../deploy-examples/) に既存サンプルがあるが、TOML 採用後は **リポジトリルートに `config.example.toml`** を置くのが自然（運用者が `cp config.example.toml config.toml` で開始するため）。`config.toml` 自身は `.gitignore` に追加（個別環境の設定をコミットしない）。

旧 `summaly-config.example.json` はリリース 1 サイクル後に削除予定とし、`docs/deploy-examples/README.md` にマイグレーションメモを残す。

### 環境変数との関係

- `SUMMALY_CONFIG_PATH`（任意）: TOML パスを上書き。デフォルトは CLI 引数 → `./config.toml` の順
- `SUMMALY_ENABLE_PDF` / `SUMMALY_ALLOW_PRIVATE_IP` / `SUMMALY_FAMILY`: TOML より **環境変数優先** にしない（既存挙動を維持）。`enablePdf` は TOML > env（関数オプションが env より優先される既存仕様と整合）
- 環境変数で TOML 値を上書きする機能は **本フェーズでは実装しない**（要望が出れば別フェーズ）

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

- [ ] **Step 1 — `smol-toml` 依存追加**
  - `pnpm add smol-toml`
- [ ] **Step 2 — TOML スキーマと loader 実装**
  - [`src/config-loader.ts`](../../src/config-loader.ts) を新設
    - `parseTomlConfig(path: string): SummalyOptions & { server?: ServerOptions }`
    - 不正値は `RangeError` / `TypeError` で early fail（メッセージで該当キーを明示）
  - 単体テスト: 正常系・空ファイル・型違い・未知キーは無視・[plugins.<name>] セクションは現状無視
- [ ] **Step 3 — 起動エントリ `bin/summaly-server.ts`**
  - 引数 `process.argv[2]` または `process.env.SUMMALY_CONFIG_PATH` から TOML パス読み込み
  - `[server]` の host / port で listen
  - graceful shutdown (`SIGTERM` / `SIGINT` → `app.close()`)
- [ ] **Step 4 — `pnpm serve` script の置換**
  - `package.json` の `scripts.serve` を `tsx bin/summaly-server.ts` に変更
  - 旧 fastify-cli は **devDependencies からは外さない**（テスト等で利用している場合に備えて）。実運用パスから外すだけ
- [ ] **Step 5 — `config.example.toml` をリポジトリルートに配置**
  - スキーマ全項目をコメント付きで列挙
  - `config.toml` を `.gitignore` に追加
- [ ] **Step 6 — `docs/deploy-examples/` の更新**
  - 旧 `summaly-config.example.json` は残しつつ `summaly-config.example.json` 冒頭にコメントで「TOML への移行を推奨」と明記
  - nginx 設定例 / systemd 設定例から `--options ...json` を削除して `tsx bin/summaly-server.ts /etc/summaly/config.toml` 等に書き換え
- [ ] **Step 7 — テスト**
  - TOML パース正常系 / 異常系
  - mapTomlToSummalyOptions が SummalyOptions に正しくマッピングされる
  - `[plugins.<name>]` セクションが存在しても現状はスルーされる（将来拡張のための placeholder）
- [ ] **Step 8 — README / SETUP.md 更新**
  - [`docs/SETUP.md`](../SETUP.md) の「最小起動」と「Fastify モード固有のオプション」を TOML 例に書き換え
  - [`README.md`](../../README.md) の「Misskey 管理人として導入する場合」も更新
  - 環境変数との優先順位を表で整理

---

## 完了条件 (Definition of Done)

- `pnpm serve config.toml` で TOML を読んで Fastify が起動する
- TOML の各セクション（`[server]` / `[summaly]` / `[summaly.cache]` / `[summaly.pdf]` / `[plugins]`）が正しく `SummalyOptions` にマッピングされる
- 不正値（型違い・負数等）は起動時に early fail し、エラーメッセージで該当キーが分かる
- `config.example.toml` がリポジトリルートに配置され、コメント付きで全項目を列挙している
- `[plugins.<name>]` セクションが将来拡張用 placeholder として TOML に書けるが、現状は無視される
- 既存の関数オプション（`fastify.register(Summaly, opts)`）の挙動は変わらない
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る

---

## リスク・注意点

1. **fastify-cli を辞める影響**: 既存ユーザーが `fastify start ... --options config.json` で運用している場合、本フェーズで `pnpm serve` の意味が変わる（CLI 引数が TOML パスを期待するように）。**Breaking Change** として CHANGELOG に明記し、旧 JSON サンプルからのマイグレーション手順を SETUP.md に書く
2. **TOML の表現力**: TOML は配列内のテーブル混在で罠がある（`allowed = ["a", "b"]` は配列、`[[plugins]]` は table の配列）。スキーマは flat なテーブルに留めて TOML 仕様の罠を避ける
3. **設定の検証タイミング**: 起動時 early fail するので、**設定ミスがあるとプロセスが起動しない**。Misskey 管理人視点では「設定変更時に試運転 → 起動確認」の運用が必要
4. **`config.toml` のパーミッション**: 機密情報を含めないが、運用者がうっかりプロキシ認証情報を入れる可能性。ドキュメントで「機密はコードに直接書かず env から流す」を推奨
5. **`smol-toml` のバージョン固定**: TOML パーサは仕様準拠が重要。マイナーアップデートで挙動が変わらないようバージョンは固定で良い

---

## オープンクエスチョン

- **A. zod を導入するか**: 不正値検出の堅牢さでは有利だが依存サイズ増。本フェーズでは手書き検証で済ませ、要望が出たら別フェーズで検討
- **B. TOML から `[server]` 以外の Fastify 設定（logger / trustProxy 等）も読むか**: 本フェーズでは host / port だけ。本格的な Fastify 設定流し込みは別フェーズ
- **C. プラグイン別設定の機構を本フェーズで完成させるか**: スキーマ placeholder のみで、`SummalyPlugin` への options 渡し機構は本フェーズではスコープ外（読み込みロジックは将来追加）。理由は「機構を作っても現状の組み込みプラグインで使うフィールドがほぼ無い」「機構の design 議論を別フェーズで深掘りした方が良い」
