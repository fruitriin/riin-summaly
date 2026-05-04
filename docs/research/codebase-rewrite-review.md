# Codebase Rewrite Review — 機能と HTTP インターフェースを保ったまま全て作り直すなら

> 状態: **参考資料 / レビュー**
> 種別: アーキテクチャ評価
> サイズ: **L**（評価のみ、実装スコープなし）
> 想定読者: 本フォークのメンテナ、ゼロベース再設計を検討する人
> 作成日: 2026-05-04

このドキュメントは「現状の summaly コードベースを **HTTP インターフェース ( `GET /?url=...&lang=...` → `SummalyResult` JSON ) を保ちつつ全て作り直す**」場合の設計レビューです。実装計画ではなく **評価と提案**。

---

## 1. 前提・スコープ

### 凍結する外部インターフェース

#### HTTP

- `GET /?url=<encoded-url>[&lang=<lang>]`
- 200 OK — `Content-Type: application/json`、本文は下記 `SummalyResult` JSON
- 4xx/5xx — `{ "error": <message-or-object> }`
- レスポンスヘッダ:
  - `Cache-Control: public, max-age=<sec>` または `no-store`（`cacheMaxAge` / `cacheErrorMaxAge` 由来）
  - `X-Cache: HIT | MISS`（`inMemoryCache: true` 時のみ。phase4.2 後は `HIT-COALESCED` も）

#### `SummalyResult` JSON スキーマ

```jsonc
{
  "title": "string | null",
  "icon": "string | null",
  "description": "string | null",
  "thumbnail": "string | null",
  "sitename": "string | null",
  "player": {
    "url": "string | null",
    "width": "number | null",
    "height": "number | null",
    "allow": "string[]"
  },
  "sensitive": "boolean (optional)",
  "activityPub": "string | null",
  "fediverseCreator": "string | null",
  "medias": "string[] (optional)",
  "url": "string"
}
```

#### 動作要件（凍結）

- **OG / Twitter Card / oEmbed の優先順位** で抽出
- **サイト固有プラグインのマッチ順固定**（amazon → bluesky → wikipedia → branchio-deeplinks → youtube → spotify → dlsite → iwara → komiflo → nijie）
- **SSRF 既定挙動**: プライベート IP 拒否・10MiB 上限・URL スキームサニタイズ（`https/http/data:<10KB`）・HTTP/2 無効・no-retry
- **エンコーディング**: UTF-8 / Shift_JIS / ISO-2022-JP のサポート（issue #39 由来）
- **PDF**: オプトイン (`enablePdf` または `SUMMALY_ENABLE_PDF=true`) で 5 秒 hard timeout の document-level metadata 取得
- **`KNOWN_SHORT_HOSTS`**: `followRedirects: false` でも HEAD で解決する公式短縮 URL 集合
- **Cache-Control**: 200 と 4xx/5xx のデフォルト値・`0 → no-store` 規約

### フォーク stance とメンテナンス前提

本フォークの設計判断に直接影響する前提:

1. **upstream へのバックポートは考慮不要**: 設計の純度・読みやすさを最優先してよい。upstream の慣習に合わせる必要なし。
2. **メンテナーは fork オーナー自身のみ**: 「外部プラグイン作者向けの破壊的変更回避」「カスタム拡張ユーザーへの配慮」は **不要**。`SummalyPlugin.name` 必須化や `PluginContext` 導入のような破壊的 API 変更を遠慮なくやってよい。
3. **取り込みは upstream / 他 fork → 自分たちの一方向のみ**: 上流で開発が進んだ機能・バグ修正を cherry-pick できる構造は維持したい。**rewrite 後は cherry-pick 容易性は失う**前提で設計してよい（「上流のどのコミットを取り込んだか」を doc 台帳で管理する規律は残す）。
4. **中間デプロイなし**: 段階的リリースを挟まないので、**big-bang rewrite で OK**。phase 分割や後方互換 shim 一切不要。
5. **LLM 駆動でビッグバン書き換え**: 期間見積もりは不要。「人間月数」概念を本ドキュメント全体から排除する。
6. **凍結対象は HTTP のみ**: HTTP リクエスト形式 (`GET /?url=...&lang=...`) と `SummalyResult` JSON のスキーマだけ凍結。それ以外（ライブラリ API / プラグイン interface / 環境変数 / 内部型）は全て自由に再設計可能。

### スコープ外

- npm パッケージ名 `@misskey-dev/summaly` の維持を**前提としない**（fork なので独自配布で構わない）。
- 本ドキュメントは設計指針のみで、実装手順 / TODO / phase 分割は別ドキュメントの責務。

---

## 2. 現コードベースの構造的特徴

> このセクションは rewrite で**全捨てる前提**だが、再設計時の対比資料として残す。

### サイズ感

```
src/                        2,803 行 (TypeScript only, blank/comment 含む)
├─ index.ts                  373 行  ← summaly() + Fastify default export
├─ general.ts                347 行  ← OG / Twitter Card / oEmbed 抽出
├─ utils/got.ts              351 行  ← HTTP 層（SSRF / size limit / PDF / agent）
├─ utils/encoding.ts          59 行  ← jschardet + iconv-lite + encoding-japanese
├─ utils/sanitize-url.ts      40 行  ← https/http/data: のフィルタ
├─ utils/agent.ts             39 行  ← keep-alive Agent + family
├─ utils/cleanup-title.ts     26 行  ← 「タイトル | サイト名」末尾の剥がし
├─ utils/{clip,short-urls,player-allow,status-error,null-or-empty,pdf-icon,user-agents}.ts 計 ~94 行
├─ summary.ts                 85 行  ← 型定義
├─ iplugin.ts                 13 行  ← SummalyPlugin 型
└─ plugins/ (10 個)           ~510 行 ← サイト固有

test/index.test.ts          1,871 行 (単一ファイル)
docs/plans/                  2,097 行 (12 個の phase ドキュメント)
```

依存（runtime）:
- `cheerio` 1.2.0 / `got` 15.0.3 / `iconv-lite` 0.7.2 / `jschardet` 3.1.4 / `encoding-japanese` 2.2.0
- `escape-regexp` 0.0.1 / `html-entities` 2.6.0 / `ipaddr.js` 2.3.0 / `lru-cache` 11.3.5 / `pdf-parse` 2.4.5
- optional: `fastify` 5.8.5

### 良い点（rewrite 後も継承したい）

1. **責務分離が明確な utils**: 単機能の小さなユーティリティ群（10〜50 行）が並びテスタビリティが高い
2. **SSRF 多段防御**: ヘッダ / ストリーミング / IP / type / sanitize / HTTP/2 / no-retry が一通り入っている
3. **PDF 隔離設計の意識**: opt-in、5 秒 hard timeout、`getInfo()` のみ、`finally` での `destroy()`
4. **テストフィクスチャ群**: HTML / oEmbed JSON / PDF が揃っており、挙動互換テストとして再利用可能
5. **`docs/plans/` で意思決定が言語化**: 12 個の phase ドキュメントが「なぜそう設計したか」を残しており、rewrite 時の指針として価値が高い

### 構造的な弱点（rewrite で解消すべき）

1. **`src/index.ts` が肥大化** (373 行、4-5 個の責務同居): ライブラリ本体と Fastify ルートの境界が曖昧
2. **`src/utils/got.ts` も肥大化** (351 行): HTTP / SSRF / PDF / JSON / agent / timeout が集約されすぎ。`scpaping` のタイポも含めて拡散
3. **モジュールレベルの可変状態**: `let agent: Got.Agents = {};` がモジュールスコープに。テスト並列実行や複数インスタンス共存に致命的
4. **`SummalyOptions` の責務混在**: per-request / Fastify 専用 / 機能フラグが flat に同居 → phase8.1 TOML 設計の苦労の原因
5. **プラグインインターフェースの素朴さ**: `name` optional、config 渡し口なし、サイト別定数がコード内ハードコード
6. **`scpaping` 誤字の固定化**: 半ば公開 API として固定、内部リネームすら避けられている
7. **`getOEmbedPlayer()` の `general.ts` 内ハードコード**: oEmbed DOM 検証が汎用パスに紛れ込んでテスト困難
8. **`Summary` / `SummalyResult` の関係曖昧**: default export と named export が混在、プラグイン側で `Summary` を `summary` (lowercase) で import する不健全パターンあり
9. **エラーハンドリングが粗い**: string error / `StatusError` / Fastify 層 `serializableError` patch が体系化されていない
10. **テストファイル単一**: 1,871 行 1 ファイルでメンテナンス困難
11. **HTTP インターフェースの型定義なし**: `?url=...&lang=...` や JSON レスポンスのスキーマが TS 型として独立して存在しない（OpenAPI も無し）

---

## 3. 観点 1: TypeScript を維持して作り直すなら

### 3.1 依存ライブラリの見直し

**評価軸**: 「**実行速度** (throughput / parse 速度 / latency)」と「**できることの品質** (機能の正確性・カバレッジ・エッジケース対応)」のバランス。**コードベース / 依存サイズは判断材料から除外**。

| 現状 | 速度 | 品質 | 総評 / 推奨アクション |
|---|---|---|---|
| **got** 15.0.3 | △ | ◎ | **置換: `undici`**。got は機能豊富 (retry / hooks / pagination 等) だが summaly は使っていない。`undici` は Node 18+ の `fetch` 内部実装で **request/sec が got の 1.5〜2x 高い** (公式ベンチ 60-70K vs 35-40K req/s)。AbortController / Dispatcher で agent 制御も細かい。 |
| **cheerio** 1.2.0 | △ | ◎ | **置換: `linkedom`**。cheerio は jQuery 風表現力が高いが selector パフォーマンスは中程度。`linkedom` は実 DOM (Window/Document) を再現し **selector が cheerio の 2-3x 速い**（特に大きい HTML）。プラグイン全書き直し前提なので rewrite で採用。 |
| **iconv-lite** 0.7.2 | ○ | ◎ | **現状維持**。pure JS で `iconv` (native) より 30% 遅いが安定。Node `TextDecoder` は ICU full ビルドが必要で配布環境を縛る。「速度最大化」したいなら `TextDecoder` try → iconv-lite フォールバックの 2 段。 |
| **jschardet** 3.1.4 | △ | △ | **置換: `chardetng-js` (wasm)**。Firefox 同梱の Rust 実装の wasm port。**実 Web ページに対する検出精度が圧倒的**（Firefox 同等）。本フォークは `confidence: 0.99` 縛りで実質ほぼ採用されない設定 → 品質改善でこの workaround を外せる。 |
| **encoding-japanese** 2.2.0 | ✕ | ✕ | **削除**。ISO-2022-JP の decode 速度が **iconv-lite の 4〜5 倍遅い** ([phase2.2 計画ファイル実測表](../plans/phase2.2-mei23-non-plugin.md))。**iconv-lite 0.7.x は ISO-2022-JP を公式サポート済み**。速度・品質の両軸で iconv-lite に統合。 |
| **fastify** 5.8.5 | ◎ | ◎ | **現状維持**。Express の 2-3x 速い (公式ベンチ 65K req/s)、JSON Schema による fast-json-stringify、route plugins の encapsulation、Cache-Control / ETag フックが summaly に完全マッチ。Bun 系なら `Hono` 検討。 |
| **lru-cache** 11.3.5 | ◎ | ◎ | **現状維持**。TTL / maxSize / dispose / size calculation 全部入り、O(1) 高速。代替なし。 |
| **pdf-parse** 2.4.5 | ✕ | ◎ | **置換: 自前 PDF Trailer parser + `pdfjs-dist` 直叩きフォールバック**。pdf-parse は metadata 取得だけで pdfjs-dist 全体ロード + parse フルパス (~50-200 ms)。**PDF Trailer Dictionary 直読みで数 ms に短縮 (10-50x)**。エッジケース (encoding 違い・compressed metadata) は pdfjs-dist フォールバックで品質担保。worker_threads 隔離もセット。 |
| **ipaddr.js** 2.3.0 | ◎ | ◎ | **現状維持**。IPv4/IPv6 統合 + range 判定 (`unicast` / `private` / `loopback`) を pure JS で高速。SSRF ガード用途に必須。 |
| **html-entities** 2.6.0 | ◎ | ◎ | **現状維持**。v2 は Trie ベースで `he` の 2-3x 速い、HTML5 仕様完全対応。 |
| **escape-regexp** 0.0.1 | ○ | △ | **置換: 自前 1 行**。中身は 1 行なので依存にする必要なし。`escape-string-regexp` でも可。 |

#### 推奨入れ替え方針 (ROI 順)

1. **encoding-japanese → 削除 (iconv-lite 一本化)**: 速度 4-5x 改善、リスクなし
2. **pdf-parse → 自前 PDF Trailer parser + pdfjs-dist フォールバック**: 速度 10-50x 改善
3. **jschardet → chardetng-js (wasm)**: 検出精度が Firefox 同等に向上
4. **got → undici Dispatcher**: throughput 1.5-2x、機能ロスなし
5. **cheerio → linkedom**: selector 速度 2-3x、プラグイン全書き直し前提
6. **escape-regexp → 自前**: 速度品質変化なし、依存信頼性向上のみ

その他 (fastify / lru-cache / ipaddr.js / html-entities / iconv-lite) は速度・品質の両軸で**現状が最適解**。

### 3.2 ファイル構成の見直し

```
src/
├─ index.ts                      ← public re-export のみ（型 + summaly + Fastify plugin）
├─ types/
│   ├─ summary.ts                ← Summary / SummalyResult / Player
│   ├─ options.ts                ← RequestOptions / SummalyOptions
│   ├─ server-options.ts         ← SummalyServerOptions（cache/PDF/inMemory 等）
│   └─ plugin.ts                 ← SummalyPlugin (name 必須化、config 渡し追加)
│
├─ core/
│   ├─ summaly.ts                ← summaly(url, opts) 本体
│   ├─ dispatcher.ts             ← プラグイン解決 + KNOWN_SHORT_HOSTS HEAD
│   ├─ general.ts                ← parseGeneral (純粋関数)
│   └─ oembed.ts                 ← oEmbed 抽出 (general から切り出し)
│
├─ http/
│   ├─ client.ts                 ← undici fetch + timeout + abort
│   ├─ ssrf.ts                   ← private IP guard (ipaddr.js)
│   ├─ size-limit.ts             ← content-length + streaming guard
│   ├─ type-filter.ts            ← typeFilter / Accept ヘッダ生成
│   ├─ encoding.ts               ← detect (chardetng-js) + toUtf8 (iconv-lite)
│   ├─ agent.ts                  ← per-request Dispatcher（mutable global を排除）
│   └─ pdf.ts                    ← PDF metadata（worker_threads で隔離）
│
├─ server/
│   ├─ fastify-plugin.ts         ← GET / の Fastify plugin
│   ├─ cache.ts                  ← LRU + キー正規化
│   ├─ inflight-dedup.ts         ← phase4.2 の dedup Map
│   └─ error-payload.ts          ← serializableError 等
│
├─ utils/
│   ├─ clip.ts / cleanup-title.ts / sanitize-url.ts / short-urls.ts
│   ├─ player-allow.ts / pdf-icon.ts / user-agents.ts
│   └─ escape-regexp.ts / status-error.ts
│
└─ plugins/
    ├─ index.ts
    ├─ <name>/
    │   ├─ index.ts
    │   ├─ fixture.html (or oEmbed.json)
    │   └─ test.ts
    └─ shared/                   ← プラグイン共通 (oembed builder, sensitive 判定)
```

#### 設計判断のポイント

- **`core` / `http` / `server` の三層分離**: ライブラリ呼び出しは `core` だけで成立、Fastify サーバは `server` を上に乗せる。HTTP 層 (`http/`) はテスト時にモック可能
- **`http/agent.ts` の mutable global を排除**: `setAgent()` を「`summaly()` 呼び出し時に opts.agent を毎回受け取り、その都度 Dispatcher を構築」する関数型に変える（per-request agent）。**`setAgent` は廃止** (fork stance なので破壊的変更可)
- **`server/cache.ts` と `server/inflight-dedup.ts` の独立**: phase4.2 を rewrite で先取り
- **プラグインを 1 ディレクトリ単位で閉じ込め**: `plugins/<name>/{index,fixture,test}.ts` で「新規プラグイン追加 = 1 ディレクトリ追加」に。upstream cherry-pick 時の merge 単位もシンプルに
- **テスト分割**: `test/core/`、`test/http/`、`test/server/`、`test/plugins/<name>/` のレイヤー対応

### 3.3 型設計の見直し

```ts
// types/options.ts — per-request (ライブラリ・Fastify 両用)
export type RequestOptions = {
  lang?: string | null;
  followRedirects?: boolean;
  userAgent?: string;
  responseTimeout?: number;
  operationTimeout?: number;
  contentLengthLimit?: number;
  contentLengthRequired?: boolean;
  useRange?: boolean;
  enablePdf?: boolean;
};

// types/options.ts — library only
export type SummalyOptions = RequestOptions & {
  plugins?: SummalyPlugin[];
  allowedPlugins?: string[];
  agent?: HttpAgent;            // per-call、global mutable は廃止
};

// types/server-options.ts — Fastify サーバ専用
export type SummalyServerOptions = {
  request?: RequestOptions;     // 個別リクエスト時のデフォルト
  plugins?: {
    custom?: SummalyPlugin[];
    allowed?: string[];
    config?: Record<string, unknown>;  // [plugins.<name>] TOML から流し込み
  };
  cache?: {
    maxAge?: number;
    errorMaxAge?: number;
    inMemory?: boolean;
    inMemoryMaxEntries?: number;
    inFlightDedup?: boolean;    // phase4.2
  };
};

// types/plugin.ts — name 必須化、config + http context 渡し
export interface SummalyPlugin<C = unknown> {
  name: string;
  configSchema?: ConfigSchema<C>;   // zod / typebox（プラグイン別 config 検証）
  test: (url: URL) => boolean;
  summarize: (url: URL, ctx: PluginContext<C>) => Promise<Summary | null>;
}

export interface PluginContext<C = unknown> {
  options: RequestOptions;
  config?: C;
  http: PluginHttpClient;       // scpaping / getJson の代わり、新名前
}
```

#### `Summary` / `SummalyResult`

- **`default export` を廃止**: `import type { Summary, SummalyResult } from '@misskey-dev/summaly'` で揃える
- **`SummalyResult = Summary & { url: string }`** の関係を型で明示し、プラグインは `Summary` を返し、ラッパが `url` を補う規約を強制
- **JSON Schema 自動生成**: `zod` または `@sinclair/typebox` で `SummalyResult` を定義し、Fastify の `schema.response` に渡す。OpenAPI 自動出力もここから

### 3.4 ツールチェーンの選択肢

rewrite 規模なので **「現状維持」は採らない**。以下 3 候補から選ぶ:

#### 候補 A: Vite Plus（Node 前提）

[Vite Plus](https://viteplus.dev/guide/) は Vite / Vitest / Oxlint / Oxfmt / Rolldown / **tsdown** / Vite Task を統合した「**統一ツールチェーン**」。**公式ドキュメントが「Vite+ will manage your global Node.js runtime and package manager」と明記している通り、Node ランタイム前提**（Bun / Deno のサポートは公式記述なし）。

| 領域 | 採用後 |
|---|---|
| runtime | **Node 固定**（Vite Plus が管理対象としている） |
| bundler | tsdown (Vite Plus 経由) |
| test | vitest (Vite Plus 経由) |
| lint | **Oxlint** (Rust 製、ESLint の **50-100x 速い**) |
| format | **Oxfmt** (Rust 製) |
| dev server | Vite (phase7.1 dev サーバが HMR 付きで自然に組める) |
| task runner | Vite Task |
| package manager | pnpm (現状維持) |

**強み**:
- 既存 tsdown / Vitest を維持できる（rewrite 後の親和性が最も高い）
- Oxlint で lint が桁違いに速い → CI 時間圧縮
- phase7.1 dev サーバが Vite ベースで HMR 効く
- Oxlint は **ESLint plugin の rule を一部互換** で読める（`@misskey-dev/eslint-plugin` の継承容易性が高い）
- Node ランタイム維持 → upstream cherry-pick 容易性が比較的高い

**弱み**:
- **Bun ランタイムを runtime に取れない**（Vite Plus 自体が Node 管理を前提）。Bun の runtime 速度メリットを取るなら候補 C へ
- Oxlint の rule カバレッジは ESLint 8/9 の全 rule をカバーしていない → fallback で eslint も併走させる選択肢あり
- 新興ツールのため Misskey エコシステムでの採用例は少ない

> **補足**: 中身の個別ツール（Vite / Vitest / tsdown / Oxlint / Oxfmt）は単体なら Bun でも動かせるので、「Vite Plus というメタキットを使わずに、同じ構成を Bun ランタイムで組む」ことは可能 → それが候補 C に相当する。Vite Plus を使う = Node 固定。

#### 候補 B: Bun + Biome

| 領域 | 採用後 |
|---|---|
| runtime | **Bun** (起動 -50%、fetch throughput +20-30%) |
| bundler | **`bun build`** (esbuild ベース、超高速) |
| test | **`bun test`** (jest 互換 API) |
| lint | **Biome** (Rust 製、ESLint + Prettier 相当を一括、ESLint の **25x 速い**) |
| format | **Biome** (lint と一体管理) |
| dev server | Bun の HTTP サーバ (Hono 推奨) |
| package manager | **`bun install`** (npm の 10-30x 速い) |

**強み**:
- ツールチェーン全体が native ベースで CI 時間が劇的に短縮（体感 5-10x）
- Biome は **lint + format を 1 設定で扱え**、設定ファイル数を最小化できる
- `bun install` の速度はビルド/テスト loop を快適に

**弱み**:
- Biome は **独自 rule** で `@misskey-dev/eslint-plugin` を直接継承できない → 相当 rule の手動再現が必要
- pdf-parse / pdfjs-dist の Bun 互換性は要検証（worker_threads 経由で回避は可能）
- Bun ランタイム要件が増える → upstream Node コードの cherry-pick で挙動差を踏む可能性

#### 候補 C: Bun + Oxlint + Oxfmt

| 領域 | 採用後 |
|---|---|
| runtime | **Bun** |
| bundler | **`bun build`** |
| test | **`bun test`** |
| lint | **Oxlint** (ESLint 互換 rule を活かしやすい) |
| format | **Oxfmt** |
| dev server | Bun の HTTP サーバ |
| package manager | **`bun install`** |

**強み**:
- Bun の速度メリットを取りつつ、**Oxlint で ESLint 移行コスト最小**（`@misskey-dev/eslint-plugin` の継承容易性が Biome より高い）
- 候補 A と候補 B の中間で、「Bun の速度」と「Vite Plus と同じ Oxlint/Oxfmt」を両取り
- lint と format の責務が分離（Biome 一体型より柔軟）

**弱み**:
- Bun + Vite/Oxlint の組合せは**運用例が少ない**（Bun 公式は Biome 推し、Vite Plus は Node 前提）
- 候補 A の「Vite dev server で phase7.1 を組む」便益が薄れる（Bun の HTTP サーバで代替）
- 設定ファイルが Biome より 1 つ多い

#### 比較サマリー

| 軸 | A: Vite Plus | B: Bun + Biome | C: Bun + Oxlint |
|---|---|---|---|
| runtime | **Node 固定** | Bun | Bun |
| runtime 速度 | ○ Node | ◎ Bun | ◎ Bun |
| CI 速度 | ○ | ◎ | ◎ |
| 既存 ESLint config の継承 | ○ Oxlint 互換 | △ Biome 独自 | ○ Oxlint 互換 |
| dev server 体験 (phase7.1) | ◎ Vite HMR | △ 自前 Bun HTTP | △ 自前 Bun HTTP |
| upstream Node cherry-pick | ◎ | △ Bun 差分 | △ Bun 差分 |
| 運用実績 | △ 新興 | ○ 増加中 | △ 少ない |
| 設定ファイル数 | 複数 (Vite Plus 統合) | 最小 (Biome 一体) | 中 |

> **「Vite Plus + Bun runtime」は採れない**（Vite Plus が Node を管理対象として明記）。Bun runtime + Vite/Vitest/Oxlint 個別構成にしたいなら候補 C を選ぶ。

#### 推奨

- **第一候補: A (Vite Plus)** — 既存 tsdown/Vitest をそのまま継承、Oxlint で ESLint 移行容易、phase7.1 dev サーバを Vite で自然に組める、upstream cherry-pick も比較的容易
- **第二候補: C (Bun + Oxlint)** — runtime 速度を最優先しつつ、ESLint 移行コストを最小化したい場合
- **第三候補: B (Bun + Biome)** — Biome の lint+format 一体管理を強く好む場合のみ

### 3.5 アーキテクチャ強化

#### a. in-flight dedup（phase4.2 を rewrite で先取り）

`server/inflight-dedup.ts` を独立モジュールに:

```ts
export class InFlightDedup<K, V> {
  private map = new Map<K, Promise<V>>();
  async run(key: K, fn: () => Promise<V>): Promise<{ value: V; coalesced: boolean }> {
    const existing = this.map.get(key);
    if (existing) return { value: await existing, coalesced: true };
    const promise = fn();
    this.map.set(key, promise);
    try {
      return { value: await promise, coalesced: false };
    } finally {
      this.map.delete(key);
    }
  }
}
```

phase4.2 の DoD（5 並列で origin 1 ヒット、`X-Cache: HIT-COALESCED`）をそのまま満たす。

#### b. worker_threads / 別プロセスによる PDF 隔離

**現状の弱点**: PDF パースが in-process で、悪意ある PDF で `pdfjs-dist` が CPU を吸ったり OOM すると **Fastify サーバ全体が止まる**。

**rewrite 提案**:

- `http/pdf.ts` を **`worker_threads.Worker`** で起動する別スレッドに切り出し、Buffer を `transferList` で渡す
- Worker は warm 維持、5 秒で `worker.terminate()` 可能
- `resourceLimits: { maxOldGenerationSizeMb: 128 }` でメモリ hard cap
- 堅実版なら **`child_process` で別 PID** にして OOM kill が main を巻き込まない構成に

**コスト**: 起動オーバーヘッド（warm 化で吸収）、メッセージング遅延（数 ms）。**価値**: PDF パーサのバグで Fastify が落ちない。

#### c. OpenTelemetry / 構造化ロギング

- **`@opentelemetry/api`** + auto-instrumentation で `summaly()` の各段階に span を張る（HEAD redirect / scpaping / plugin / oEmbed / sanitize）
- **`pino`** で構造化ログ。`{ url, plugin, latency, cacheStatus, sizeBytes }` を JSON line で出力
- 「どのプラグインが遅い / どのサイトが落ちている」が dashboard で見える

#### d. プラグイン別 config 機構

phase8.1 の TOML スキーマで placeholder されている `[plugins.komiflo]` を**本格対応**:

```ts
export const komiflo: SummalyPlugin<{ preferredVariant: string; apiBaseUrl: string }> = {
  name: 'komiflo',
  configSchema: z.object({
    preferredVariant: z.string().default('346_mobile'),
    apiBaseUrl: z.string().url().default('https://api.komiflo.com'),
  }),
  test: (url) => url.hostname === 'komiflo.com',
  summarize: async (url, ctx) => {
    const variant = ctx.config?.preferredVariant ?? '346_mobile';
    // ...
  },
};
```

→ `346_mobile` 等のサイト固有値を **コード変更なしで TOML から差し替え可能**。

#### e. キャッシュ層の階層化

- L1: in-flight dedup（同時リクエスト 1 本化）
- L2: in-memory LRU（プロセス内）
- L3: Redis / Memcached（オプション、複数 Fastify インスタンス間で共有）
- L4: HTTP `Cache-Control` → 前段 nginx / CDN

L3 は plugin として `cache: SummalyCacheBackend` interface を渡せる形に。

#### f. リクエスト並列度制限

phase4.2 の open question にある「異なる URL の同時数は無制限」を、**per-host concurrency** (`p-queue` 相当) で制限すると堅牢:

```ts
const hostQueue = new Map<string, PQueue>();   // 同一ホストへの同時リクエストは N 本まで
```

「YouTube に同時 100 リクエスト」のような状況でも origin に優しい。

#### g. URL 正規化の精度向上

`normalizeCacheKey` に **`utm_*` / `?ref=...` 等のトラッキングパラメータ削除を opt-in で追加** すればキャッシュヒット率向上。過剰正規化リスクは phase4.1 の議論通りなので opt-in で。

---

## 4. 観点 2: 他言語で作り直すなら

### 4.1 候補言語マトリクス

fork stance により「外部プラグイン作者参入障壁」「Misskey エコシステム合意形成」は判断軸から外す。残る判断軸: **実行性能 / 開発速度 / upstream cherry-pick の取り回し / PDF 隔離のしやすさ**。

| 言語 | フィット度 | HTTP | HTML パース | charset 検出 | PDF metadata | ハング隔離 | upstream cherry-pick |
|---|---|---|---|---|---|---|---|
| **Bun** (TS のまま) | ★★★★★ | `Bun.fetch` 標準 | cheerio / linkedom | iconv-lite 動く | pdf-parse 互換性要検証 | `Bun.Worker` 可 | ◎ TS なのでほぼ可 |
| **Node 24** (TS のまま) | ★★★★★ | undici | cheerio / linkedom | iconv-lite | 自前 + pdfjs-dist | `worker_threads` | ◎ |
| **Deno** | ★★★ | `fetch` 標準 | `linkedom` | TextDecoder (ICU full) | pdfjs-dist 動かしにくい | Worker | ○ npm: 互換、要検証 |
| **Go** | ★★★★ | net/http | `goquery` | `golang.org/x/text/encoding` | `pdfcpu` (重い) → 別プロセス | `os/exec` で別 process | ✕ 完全途絶 |
| **Rust** | ★★ | reqwest / hyper | `scraper` | `encoding_rs` | `lopdf` / 別プロセス | tokio task + 別プロセス | ✕ 完全途絶 |
| **Python** | ★★ | `httpx` | parsel / lxml | `chardet` | `pypdf` | プロセス分離 | ✕ 完全途絶 |

### 4.2 各言語の総評（fork stance 反映後）

#### Bun (TS のまま runtime 変更) — ★★★★★

**rewrite で最も現実的な runtime 候補**。コードベースをほぼそのまま移行可、起動時間 / 起動メモリ / fetch スループットで明確に勝つ。pnpm 互換、Vitest 互換、tsc 互換。

懸念: pdf-parse / pdfjs-dist の Bun 互換性検証必要（worker 経由で回避可能）。`Bun.Worker` で PDF 隔離は十分。

→ **シナリオ B 候補（Bun + Biome or Bun + Oxlint）**。

#### Node.js (TS のまま) — ★★★★★

**無難で安全な runtime**。エコシステム最大、upstream cherry-pick が一番容易。

→ **シナリオ A 候補（Node + Vite Plus）**。

#### Deno — ★★★

ランタイム安全性 (`--allow-net=...`) で SSRF 防御の追加層を作れるが、`pdfjs-dist` の動作不確実性が痛い。Misskey エコシステムからやや遠い。

→ **採用しない**（Bun の方が同じ TS runtime として安全選択肢）。

#### Go — ★★★★ (fork stance では上方修正)

single binary 配布が最大の強み。fork stance では「Misskey コミュニティ合意形成」「プラグイン作者参入障壁」が判断軸から外れるため、**過去レビューより 1 段階高評価**。残る最大の懸念は **upstream cherry-pick が完全に途絶える** こと。

→ **「Go バイナリで配布したい」要件が独立価値として明確に立つ場合のみ**。upstream の進化を取り込みたいなら不利。

#### Rust / Python / Elixir — ★★ 以下

- **Rust**: 学習コスト・開発速度が summaly のスクレイピングプロダクト性質に合わない（サイト挙動変化への追従頻度が高い）
- **Python**: 静的型と並列性能で TS / Bun に劣る
- **Elixir**: BEAM の障害分離は魅力的だが、PDF / scraping エコシステムの薄さで開発体験が劣る

→ **採用しない**。

### 4.3 パフォーマンス vs upstream cherry-pick のトレードオフ

| 軸 | Node (TS) | Bun (TS) | Go |
|---|---|---|---|
| 起動時間 | 100-300 ms | 50-150 ms | 5-50 ms |
| 並列リクエスト捌き | 高 | 高 | 最高 |
| メモリ常駐 | 50-100 MB | 30-70 MB | 20-50 MB |
| 開発スピード | 最高 | 最高 | 中 |
| PDF 隔離 | worker_threads | Bun.Worker | os/exec 別 process |
| デプロイ容易性 | npm / Docker | Bun bin / Docker | **single binary 最強** |
| upstream cherry-pick | ◎ | ○ | ✕ |

→ **runtime の選択は「upstream cherry-pick 維持の必要性」と「single binary 配布要件」の二択でほぼ決まる**。

---

## 5. 統合レコメンド

前提: 1 章「フォーク stance」のとおり、**big-bang rewrite + LLM 一気書き** を想定。期間見積もり / 段階的移行 / 後方互換 shim はいずれも不要。**HTTP インターフェース凍結だけ**を満たせばよい。

### シナリオ A（第一候補）: Node + Vite Plus + 観点 1 の TS 再設計

- runtime: Node.js (現状維持)
- ツールチェーン: **Vite Plus**（tsdown + Vitest + Oxlint + Oxfmt + Vite dev server + Vite Task の統合）
- 既存テスト 1,871 行 + 既存 plugin 10 個を **挙動互換テストとして読み直し**、新構造でゼロから書き起こす（big-bang rewrite）
- 依存入れ替え: got → undici / encoding-japanese 削除 / jschardet → chardetng-js / pdf-parse → 自前 + pdfjs-dist フォールバック / cheerio → linkedom / escape-regexp → 自前
- ファイル構成を `core` / `http` / `server` 三層分離（プラグインはディレクトリ単位独立）
- worker_threads で PDF 隔離
- in-flight dedup（phase4.2）/ プラグイン別 config（phase8.1 解消）/ OpenTelemetry / pino / OpenAPI 自動化
- **`SummalyPlugin` interface の破壊的変更を遠慮なく実施**（`name` 必須化、`PluginContext` 導入、`scpaping` リネーム、`setAgent` 廃止）

### シナリオ B（次点）: Bun + Oxlint + 観点 1 の TS 再設計

- シナリオ A の TS / アーキテクチャ設計をそのまま、**ランタイム = Bun、ツールチェーン = Bun + Oxlint + Oxfmt** に置換
- `bun build` / `bun test` / Oxlint + Oxfmt / `bun install` で CI 時間 5-10x 短縮
- got → Bun ネイティブ fetch、`Bun.Worker` で PDF 隔離（pdf-parse 互換性要検証）
- パフォーマンス改善（起動時間 -50%、並列スループット +20-30%）
- 配布環境に Bun 要件追加（fork stance では許容）
- ESLint config（`@misskey-dev/eslint-plugin`）の継承容易性を保ちたいので **Biome ではなく Oxlint** を選ぶ
- dev server (phase7.1) は Bun の HTTP サーバ + Hono で構築

### シナリオ B'（変種）: Bun + Biome

- B の構成のうち lint/format を **Biome 一体型** に。設定ファイル数を最小化
- ESLint config 継承を諦めて Biome 独自 rule に**書き直す覚悟**が必要
- 「設定の見通しのよさ」を最優先する場合のみ

### シナリオ C: Go single binary 化

- 配布性 (single binary) とパフォーマンスが最高
- プラグインの動的追加性を諦め、組み込み 10 個 + 「カスタムプラグインは webhook」モデル（fork stance ではカスタム拡張ユーザーを考慮しなくてよいので障壁低）
- `SummalyResult` を Go の構造体に手で再定義（TS 型からの自動生成不可）
- **upstream cherry-pick が完全に途絶える** → 上流の進化を取り込みたいなら不利
- ツールチェーンは Go 標準 (`go build` / `go test` / `gofmt` / `golangci-lint`)

### 採用判断のフローチャート（fork スタンス前提）

```
Q1. upstream / 他 fork からの cherry-pick を将来も使いたいか？
  Yes → Q2 (TS 系のみ検討)
  No  → Q2 と Q3 両方検討可

Q2. ランタイム速度を runtime レベルで稼ぎたいか？
  Yes → Q2a (Bun 系)
  No  → シナリオ A (Node + Vite Plus)

  Q2a. ESLint config の継承容易性 vs Biome の lint+format 一体管理、どちらを優先？
    継承容易性 → シナリオ B (Bun + Oxlint)
    一体管理   → シナリオ B' (Bun + Biome)

Q3. 配布バイナリ 1 つで完結させたい運用要件があるか？
  Yes → シナリオ C (Go)
  No  → A or B/B'
```

→ **fork スタンスの第一候補は シナリオ A（Node + Vite Plus）**。upstream cherry-pick の容易性を維持しつつ最大限の構造改善が得られる。**runtime 速度を取りに行くなら シナリオ B（Bun + Oxlint）**。

### fork メンテナンス容易性のための設計指針

big-bang rewrite 後に upstream / 他 fork からの cherry-pick を続けるための注意:

1. **`docs/upstream-sync.md` 台帳**: 「upstream のどのコミットまで取り込んだか」を記録。rewrite で diff が乖離するため、cherry-pick は「コミットの意図を読んで自分たちの構造に手で適用」する形になる
2. **upstream 由来のテストケース名にコミット参照**: 例 `test('mei23 #39: ISO-2022-JP decode (upstream commit abc123 から取り込み)')`
3. **プラグイン単位の独立性を最大化**: `src/plugins/<name>/{index.ts, fixture.html, test.ts}` のディレクトリに閉じ込める
4. **依存ライブラリは upstream とのバージョン乖離を年 1 回程度棚卸し**: `cheerio` / `iconv-lite` 等のメジャー更新時に挙動差を確認

---

## 6. 参考資料 / 関連 issue / リンク集

### 内部ドキュメント

- [README.md](../../README.md) — Misskey 利用シナリオ中心の概要
- [docs/SETUP.md](../SETUP.md) — Fastify サーバ運用ガイド
- [docs/Plugins.md](../Plugins.md) — プラグイン仕様
- [docs/Library.md](../Library.md) — ライブラリ用途リファレンス
- [docs/plans/phase4.1-fastify-in-memory-cache.md](../plans/phase4.1-fastify-in-memory-cache.md) — 既存 LRU 設計
- [docs/plans/phase4.2-inflight-dedup.md](../plans/phase4.2-inflight-dedup.md) — thundering herd 対応計画
- [docs/plans/phase5.1-pdf-support.md](../plans/phase5.1-pdf-support.md) — PDF サポート設計（隔離戦略の元ネタ）
- [docs/plans/phase7.1-dev-server.md](../plans/phase7.1-dev-server.md) — dev UI（rewrite でも持ち越したい）
- [docs/plans/phase8.1-toml-config.md](../plans/phase8.1-toml-config.md) — TOML config（プラグイン別 config 議論）
- [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) — プラグイン設計指針
- [docs/knowhow/sanitize-and-agent-patterns.md](../knowhow/sanitize-and-agent-patterns.md) — SSRF / agent 設計

### コードへの参照（rewrite 対象）

- [src/index.ts](../../src/index.ts) — 凍結すべき HTTP インターフェース定義箇所
- [src/general.ts](../../src/general.ts) — OG / Twitter Card / oEmbed 抽出（再設計しても挙動を保つ）
- [src/utils/got.ts](../../src/utils/got.ts) — HTTP 層・SSRF・PDF（最も再構成すべきモジュール）
- [src/plugins/](../../src/plugins/) — 10 個の plugin の挙動互換を維持

### 外部参考

- **Misskey 本体の URL プレビュー実装**: `packages/frontend-shared/js/url-preview.ts` / `packages/frontend/src/components/MkUrlPreview.vue` — HTTP インターフェース凍結の根拠
- **Mastodon link-preview DDoS issue**: https://github.com/mastodon/mastodon/issues/23662 — エラーキャッシュ短期 TTL の根拠
- **OWASP SSRF Prevention Cheat Sheet** — private IP guard 設計の根拠
- **Vite Plus**: https://viteplus.dev/guide/ — シナリオ A のツールチェーン候補
- **Bun**: https://bun.sh — シナリオ B のランタイム候補
- **Oxlint**: https://oxc.rs/docs/guide/usage/linter — Vite Plus / シナリオ B 共通の lint 候補
- **Biome**: https://biomejs.dev — シナリオ B' の lint+format 一体候補
- **`undici`**: https://undici.nodejs.org — got からの移行候補
- **`linkedom`**: https://github.com/WebReflection/linkedom — cheerio からの移行候補
- **`chardetng-js`**: https://github.com/akinomyoga/chardetng-js — jschardet からの移行候補
- **`smol-toml`**: https://github.com/squirrelchat/smol-toml — phase8.1 TOML パーサ候補
- **OpenTelemetry Node SDK**: https://opentelemetry.io/docs/instrumentation/js/
- **`@sinclair/typebox`** / **`zod`**: HTTP インターフェースのスキーマ定義（OpenAPI 自動化）

### 関連 issue

- misskey-dev/summaly#39 — 文字エンコーディング検出（Shift_JIS / ISO-2022-JP の経緯）
- 本フォークの phase ドキュメント全 12 件 — 過去の意思決定履歴

---

**結論**: fork スタンス（big-bang rewrite + LLM 一気書き + 後方互換は HTTP のみ + upstream → 自分たちの cherry-pick だけ維持）を踏まえると、**第一候補は シナリオ A（Node + Vite Plus）**。upstream cherry-pick 容易性と既存ツールチェーンの親和性を保ちつつ、Oxlint で CI 速度・Vite で dev 体験を底上げできる。**runtime レベルで速度を稼ぎたいなら シナリオ B（Bun + Oxlint）** へ拡張、「single binary を別途配布する」独立価値があるなら シナリオ C（Go）。シナリオ B'（Bun + Biome）は ESLint config 継承を諦めても良い場合の選択肢。
