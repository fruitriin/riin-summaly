# Codebase Rewrite Review — 機能と HTTP インターフェースを保ったまま全て作り直すなら

> 状態: **参考資料 / レビュー**
> 種別: アーキテクチャ評価
> サイズ: **L**（評価のみ、実装スコープなし）
> 想定読者: 本リポジトリのメンテナ、将来 fork してゼロベース再設計を検討する人
> 作成日: 2026-05-04

このドキュメントは「現状の summaly コードベースを **機能と Misskey 側から見える HTTP インターフェース ( `GET /?url=...&lang=...` → SummalyResult JSON ) を完全に保ちつつ全て作り直す**」場合の設計レビューです。実装計画ではなく、**評価と提案** が目的。

---

## 1. 前提・スコープ

### 凍結する外部インターフェース

以下は「Misskey から見える契約」であり、**いかなる rewrite シナリオでも変えない**:

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

#### 動作要件（変えない）

- **OG / Twitter Card / oEmbed の優先順位** で抽出
- **サイト固有プラグインのマッチ順固定**（amazon → bluesky → wikipedia → branchio-deeplinks → youtube → spotify → dlsite → iwara → komiflo → nijie）
- **SSRF 既定挙動**: プライベート IP 拒否・10MiB 上限・URL スキームサニタイズ（`https/http/data:<10KB`）・HTTP/2 無効・no-retry
- **エンコーディング**: UTF-8 / Shift_JIS / ISO-2022-JP のサポート（issue #39 由来）
- **PDF**: オプトイン (`enablePdf` または `SUMMALY_ENABLE_PDF=true`) で 5 秒 hard timeout の document-level metadata 取得
- **`KNOWN_SHORT_HOSTS`**: `followRedirects: false` でも HEAD で解決する公式短縮 URL 集合
- **Cache-Control**: 200 と 4xx/5xx のデフォルト値・`0 → no-store` 規約

### スコープ外

- ライブラリ用の `summaly()` 関数 API は「**HTTP インターフェース凍結だけ**」が要件であり、ライブラリ API は完全互換でなくてもよい（rewrite 時に同等機能を別 API で提供してよい）。ただし「現実的な移行コスト」の観点からは互換性が高い方が良い。
- npm パッケージ名 `@misskey-dev/summaly` は維持を**前提としない**（fork なので独自配布で構わない）。

---

## 2. 現コードベースの構造的特徴

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
├─ utils/clip.ts              16 行  ← 文字列クリップ
├─ utils/short-urls.ts        17 行  ← 公式短縮 URL の Set
├─ utils/player-allow.ts      18 行  ← oEmbed 用 allow safelist
├─ utils/status-error.ts      14 行
├─ utils/null-or-empty.ts     12 行
├─ utils/pdf-icon.ts           8 行  ← SVG data URL
├─ utils/user-agents.ts        9 行  ← Chrome UA
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

### 良い点

1. **責務分離が明確**: `utils/*` は単機能の小さなユーティリティ群（10〜50 行）が並び、テスタビリティが高い。`general.ts` の `parseGeneral` は plugin から再利用される正しい粒度。
2. **SSRF 多段防御**: ヘッダで size 確認、ストリーミング中 `downloadProgress` で size 監視（AbortController）、レスポンス IP の private 判定、type filter、結果 URL の sanitize、HTTP/2 無効、no-retry ── 一通り入っている。
3. **PDF 隔離設計**: opt-in、5 秒 hard timeout、`getInfo()` のみ（本文解析しない）、`finally` で `destroy()`。「危険物の扱い方」を意識して設計されている。
4. **テスト網羅性**: 1,871 行の単一テストファイルにフィクスチャ HTML / oEmbed JSON / PDF が揃っている。プラグインごと・SSRF・キャッシュ・エンコーディングを広くカバー。
5. **ESM + tsdown**: 現代的な ESM only 構成、tsdown で `.d.ts` ごと出力する小さい bundle。
6. **`docs/plans/` で意思決定が言語化されている**: 12 個の phase ドキュメントが「なぜそう設計したか」「リスクと open question」を残しており、保守者の認知負荷が低い。

### 構造的な弱点

1. **`src/index.ts` が肥大化**: `SummalyOptions` 型定義 + `summaly()` 関数 + Fastify ルート + LRU キャッシュロジック + キャッシュキー正規化 + エラー直列化 ── 4 〜 5 個の責務が 1 ファイルに同居（373 行）。**「ライブラリの本体」と「Fastify ルートハンドラ」の境界が曖昧**。
2. **`src/utils/got.ts` も肥大化**: HTTP 層 + SSRF + PDF パース + JSON ヘルパ + agent 管理 + timeout race ── 351 行に集約されすぎている。`scpaping` のタイポを含めて「公開 API」が拡散している。
3. **モジュールレベルの可変状態**: `let agent: Got.Agents = {};` がモジュールスコープにある。`setAgent()` で書き換え、`isExternalAgentSet()` でその副作用として SSRF ガードまで切れる。**テスト並列実行や複数インスタンス共存に致命的**。
4. **`SummalyOptions` の責務混在**: `lang` / `userAgent` のような per-request オプションと、`cacheMaxAge` / `inMemoryCacheMaxEntries` のような Fastify サーバ設定、`enablePdf` のような機能フラグが flat に並ぶ。phase8.1 で TOML 化するときにグループ分けで悩むのはこれが原因。
5. **プラグインインターフェースが素朴すぎる**: `name` が optional、`test/summarize` だけ。プラグイン別 config（komiflo の `preferredVariant` 等）の渡し口がなく、定数がコード内ハードコード。
6. **誤字 `scpaping` の固定化**: 半ば公開 API として固定されており、外部プラグインからも参照されている可能性。CLAUDE.repo.md にも「リネームしないこと」と明記されている。
7. **`getOEmbedPlayer()` が `general.ts` 内にハードコード**: oEmbed の DOM 検証ロジックが汎用パスに紛れ込んでいて、テストや差し替えが難しい。`utils/oembed.ts` のような独立モジュールに切り出すべき。
8. **`Summary` と `SummalyResult` の関係が曖昧**: `default export` で `Summary`、named export で `SummalyResult`。プラグイン作者は `default export` 名 `Summary` を `summary` (lowercase) で import するパターンが既存プラグインにある（amazon.ts）── TypeScript 的に不健全。
9. **エラーハンドリングが粗い**: `failed summarize` という string error、`StatusError` 一種、Fastify 層で `JSON.stringify(Error) → {}` 問題に対する patch（`serializableError`）── 体系化されていない。
10. **テストファイル単一**: 1,871 行 1 ファイルでメンテナンス困難。プラグイン単位 / レイヤー単位での分割が遅れている。
11. **「呼ばれたときの HTTP インターフェース」の型がない**: ライブラリ側 `SummalyOptions` と Fastify サーバの設定が混在し、HTTP リクエスト形式 (`?url=...&lang=...`) や JSON レスポンスのスキーマが TypeScript 型として独立して切り出されていない。OpenAPI / JSON Schema もない。

---

## 3. 観点 1: TypeScript を維持して作り直すなら

### 3.1 依存ライブラリの見直し

| 現状 | 評価 | 入れ替え候補 / 推奨アクション |
|---|---|---|
| **got** 15.0.3 | △ | undici (Node 18+ ビルトイン `fetch` 相当) に置換検討。got は機能豊富だが 1MB 弱と重い。ストリーミング / abort / timeout は `undici` で十分。ただし retry / hooks / pagination は失う → summaly はそれらを使っていないので問題なし。**推奨: undici fetch + AbortController + Dispatcher**（agent 相当）。 |
| **cheerio** 1.2.0 | ○ | 妥当。代替 `parse5` + `domhandler` は低レベルすぎる。`linkedom` は速いが API 互換性で乗り換えコストが高い。**現状維持** 推奨。 |
| **iconv-lite** 0.7.2 | ○ | Node の `TextDecoder` は ISO-2022-JP / Shift_JIS をサポートする実装 (ICU full data ビルド) もあるが、配布バイナリ依存で不安定。`iconv-lite` は安定。**現状維持**。 |
| **jschardet** 3.1.4 | △ | 検出精度に課題（confidence 0.99 縛りで実質ほぼ採用されていない可能性）。**chardetng (Rust 由来 wasm)** や `chardetjs` も候補だが大差ない。`<meta charset>` 優先でも実用十分。**現状維持で構わないが優先度低**。 |
| **encoding-japanese** 2.2.0 | △ | ISO-2022-JP のためだけに 60KB 抱える。`iconv-lite` 0.7.x は ISO-2022-JP をサポートしている（過去バージョンで未対応だった）。**lock しているならテスト後に削除可能**。 |
| **fastify** 5.8.5 | ○ | 妥当。Hono / Elysia は Bun 系、Express 5 はやや重い。Fastify は HTTP Cache 制御 / プラグイン機構が summaly の用途と相性良い。**現状維持**。 |
| **lru-cache** 11.3.5 | ○ | 妥当。代替 `mnemonist/LRUCache` (依存ゼロ) もあるが TTL 機構の充実度で `lru-cache` が優位。**現状維持**。 |
| **pdf-parse** 2.4.5 | ✕ | **要再検討**。`pdf-parse` は `pdfjs-dist` (~30MB) を抱える肥大依存。`pdf-lib` の `getTitle()` か、自前で PDF 先頭 1KB から `/Title (xxx)` を正規表現抽出する方が軽い。**worker_threads / 別プロセス隔離** とセットで再設計が望ましい。 |
| **ipaddr.js** 2.3.0 | ○ | 妥当。Node 18+ の `net.isIP` だけでは range 判定が出来ないため依存は必要。**現状維持**。 |
| **html-entities** 2.6.0 | ○ | 妥当。`he` でも代替可能だが大差なし。**現状維持**。 |
| **escape-regexp** 0.0.1 | ✕ | バージョン 0.0.1 で 11 年放置。中身は `s => s.replace(/[\-\/\\^$*+?.()|[\]{}]/g, '\\$&')` の 1 行。**自前実装に置き換え** で依存削減（`utils/escape-regexp.ts` 8 行で済む）。 |
| **tsdown** 0.21.10 | ○ | 妥当。Vite 系の builder で `.d.ts` 含めて出力できる。**現状維持**。 |
| **vitest** 4.1.5 | ○ | 妥当。**現状維持**。ただし test ファイルは分割推奨。 |
| **eslint** 9.39.2 + `@misskey-dev/eslint-plugin` | ○ | 妥当。flat config 採用済み。**現状維持**。 |
| **typescript** 6.0.3 | ○ | 妥当。**現状維持**。 |
| **@types/encoding-japanese** | △ | encoding-japanese を外せば不要。 |

#### 推奨入れ替え方針

- **got → undici fetch**（依存サイズ削減・Node ネイティブ寄り）
- **encoding-japanese → 削除**（iconv-lite 0.7.x は ISO-2022-JP 対応済みのはず、要検証）
- **pdf-parse → 自前 + worker_threads 隔離 or pdf-lib + worker_threads**
- **escape-regexp → 自前 1 行**

このスリム化で `node_modules` サイズが半減〜2/3 になる見込み。

### 3.2 ファイル構成の見直し

#### 提案ディレクトリツリー

```
src/
├─ index.ts                      ← public re-export のみ（型 + summaly + Fastify plugin）
├─ types/
│   ├─ summary.ts                ← Summary / SummalyResult / Player
│   ├─ options.ts                ← SummalyOptions（per-request）
│   ├─ server-options.ts         ← FastifyServerOptions（cache/PDF/inMemory 等）
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
│   ├─ encoding.ts               ← detect + toUtf8
│   ├─ agent.ts                  ← keep-alive Dispatcher (mutable global を排除)
│   └─ pdf.ts                    ← PDF metadata（worker_threads で隔離）
│
├─ server/
│   ├─ fastify-plugin.ts         ← GET / の Fastify plugin
│   ├─ cache.ts                  ← LRU + キー正規化
│   ├─ inflight-dedup.ts         ← phase4.2 の dedup Map
│   └─ error-payload.ts          ← serializableError 等
│
├─ utils/
│   ├─ clip.ts
│   ├─ cleanup-title.ts
│   ├─ sanitize-url.ts
│   ├─ short-urls.ts
│   ├─ player-allow.ts
│   ├─ pdf-icon.ts
│   ├─ user-agents.ts
│   ├─ escape-regexp.ts          ← 自前実装
│   └─ status-error.ts
│
└─ plugins/
    ├─ index.ts
    ├─ amazon.ts
    ├─ bluesky.ts
    ├─ ... (10 個)
    └─ shared/                   ← プラグイン共通 (oembed builder, sensitive 判定)
```

#### 設計判断のポイント

- **`core` / `http` / `server` の三層分離**: ライブラリ呼び出しは `core` だけで成立、Fastify サーバは `server` を上に乗せる。HTTP 層 (`http/`) はテスト時にモック可能。
- **`http/agent.ts` の mutable global を排除**: `setAgent()` を「`summaly()` 呼び出し時に opts.agent を毎回受け取り、その都度 Dispatcher を構築」する関数型に変える（per-request agent）。**`setAgent` は deprecated にして残し、内部で warning**。
- **`server/cache.ts` と `server/inflight-dedup.ts` の独立**: phase4.2 で本来やる分離を rewrite で先取り。
- **`http/pdf.ts` を完全に隔離**: 後述「3.5 worker_threads」で詳細。
- **テスト**: `test/` も `test/core/`、`test/http/`、`test/server/`、`test/plugins/` にレイヤー対応で分割。1,871 行を 200 〜 400 行 × 5 〜 8 ファイル相当に。

### 3.3 型設計の見直し

#### 現状の問題

```ts
// 現状
export type SummalyOptions = {
  lang?: string | null;
  followRedirects?: boolean;
  plugins?: SummalyPlugin[];
  agent?: GotAgents;
  userAgent?: string;
  // ...
  cacheMaxAge?: number;          // ← Fastify only
  cacheErrorMaxAge?: number;     // ← Fastify only
  inMemoryCache?: boolean;       // ← Fastify only
  inMemoryCacheMaxEntries?: number; // ← Fastify only
  // ...
};
```

→ ライブラリ用と Fastify 用が混在。phase8.1 の TOML 設計でも groupings に苦労する。

#### 提案

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
  };
  cache?: {
    maxAge?: number;
    errorMaxAge?: number;
    inMemory?: boolean;
    inMemoryMaxEntries?: number;
    inFlightDedup?: boolean;    // phase4.2
  };
};

// types/plugin.ts — name 必須化、config 渡し追加 (将来拡張)
export interface SummalyPlugin<C = unknown> {
  name: string;                 // 必須化
  test: (url: URL) => boolean;
  summarize: (
    url: URL,
    ctx: PluginContext<C>,
  ) => Promise<Summary | null>;
}

export interface PluginContext<C = unknown> {
  options: RequestOptions;
  config?: C;                   // プラグイン別 config (TOML から流し込み可能)
  http: PluginHttpClient;       // scpaping / getJson の代わり
}
```

#### `Summary` / `SummalyResult` の整理

- **`default export` をやめる**: `import type { Summary } from '@misskey-dev/summaly'` で揃える
- **`SummalyResult = Summary & { url: string }`** の関係を明示し、プラグインは `Summary` を返し、ラッパが `url` を補う規約を型で表現
- **JSON Schema 自動生成**: `zod` または `@sinclair/typebox` で `SummalyResult` を定義し、Fastify の `schema.response` に渡す。OpenAPI 出力も自動化。

### 3.4 ツールチェーンの見直し

| ツール | 現状 | 見直し提案 |
|---|---|---|
| **bundler** | tsdown | **現状維持**。`.d.ts` 含めて高速、ESM 出力に強い。 |
| **test runner** | vitest | **現状維持**。ただし test ファイルを分割し、`coverage` (`@vitest/coverage-v8`) を CI 必須に。 |
| **lint** | ESLint 9 (flat config) + `@misskey-dev/eslint-plugin` | **現状維持**。`eslint-plugin-import` の rule で循環依存を catch するルールを足すと層分離が劣化しない。 |
| **typecheck** | `tsc --noEmit` × 2 (src + test) | **現状維持**。`isolatedModules: true` も継続。 |
| **runtime** | Node.js (ESM) | **Node 22 LTS + `--experimental-permission`** で ファイル / network を制限する案あり。本番運用時に SSRF とは別の防御層になる。 |
| **format** | （Prettier 等の設定なし、editorconfig のみ） | **`@biomejs/biome`** か `prettier` 導入検討。lint/format 統合で開発体験向上。 |
| **CI** | （設定確認していない） | **GitHub Actions** で `pnpm typecheck` + `pnpm test` + `pnpm eslint` + `pnpm build` の matrix（Node 20 / 22 / 24）。`pnpm audit` も。 |
| **bench** | なし | **mitata** や **vitest bench** で `summaly()` の HTML サイズ別 latency を track。phase4.2 で dedup の効果を可視化。 |
| **コンテナ** | なし | **`Dockerfile` + multi-stage build** を `docs/deploy-examples/` に追加。Misskey デプロイ環境（k8s / docker-compose）への配布が容易になる。 |

### 3.5 アーキテクチャ強化

#### a. in-flight dedup（phase4.2 を rewrite で先取り）

`server/inflight-dedup.ts` を独立モジュールに。

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

**現状の弱点**: `pdf-parse` は in-process で動き、5 秒 timeout はあるものの、悪意ある PDF で `pdfjs-dist` が CPU を吸ったり OOM を引き起こすと **Fastify サーバ全体が止まる**。

**rewrite 提案**:

- `http/pdf.ts` を **`worker_threads.Worker`** で起動する別スレッドに切り出し、Buffer を `transferList` で渡す
- Worker は 1 プロセスに 1 個固定 (warm worker)、5 秒で `worker.terminate()` できる
- メモリ上限を `resourceLimits: { maxOldGenerationSizeMb: 128 }` で hard cap
- さらに堅実なら **child_process で別 PID** にして OOM kill が main を巻き込まない構成に

**コスト**: 起動オーバーヘッド（warm 化で吸収）、メッセージング遅延（数 ms）。**価値**: PDF パーサのバグで Fastify が落ちなくなる。

#### c. OpenTelemetry / 構造化ロギング

- **`@opentelemetry/api`** + auto-instrumentation で `summaly()` の各段階（HEAD redirect / scpaping / plugin / oEmbed / sanitize）に span を張る
- **`pino`** （Fastify と相性良い）で構造化ログ。`{ url, plugin, latency, cacheStatus, sizeBytes }` を JSON line で出す
- Misskey 運用視点で「どのプラグインが遅い / どのサイトが落ちている」が dashboard で見える

#### d. プラグイン別 config 機構

phase8.1 で TOML スキーマに placeholder されている `[plugins.komiflo]` を **rewrite では本格対応**:

```ts
// types/plugin.ts
export interface SummalyPlugin<C = unknown> {
  name: string;
  configSchema?: ConfigSchema<C>;   // zod / typebox
  test: (url: URL) => boolean;
  summarize: (url: URL, ctx: PluginContext<C>) => Promise<Summary | null>;
}

// plugins/komiflo.ts
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

これで komiflo の `346_mobile` 変更や iwara の `descriptionMaxLength` を **コード変更なしで TOML から差し替え可能** になる。

#### e. キャッシュ層の階層化

- L1: in-flight dedup（同時リクエスト 1 本化）
- L2: in-memory LRU（プロセス内）
- L3: Redis / Memcached（オプション、複数 Fastify インスタンス間で共有）
- L4: HTTP `Cache-Control` → 前段 nginx / CDN

L3 は plugin として `cache: SummalyCacheBackend` interface を渡せる形にしておくと、Misskey 管理人が選択可能。

#### f. リクエスト並列度制限

phase4.2 の open question にある「異なる URL の同時数は無制限」を、`p-queue` 相当で **per-host concurrency** を導入するとさらに堅牢。

```ts
// 同一ホストへの同時リクエストは 4 本まで
const hostQueue = new Map<string, PQueue>();
```

「YouTube に同時 100 リクエスト」のような状況でも origin に優しい挙動になる。

#### g. URL 正規化の精度向上

現状 `normalizeCacheKey` は fragment 除去 + lang のみ。**utm_*** や `?ref=...` のようなトラッキングパラメータを削除するオプションを足すとキャッシュヒット率が向上する。**過剰正規化のリスク**は phase4.1 のコメントが指摘している通りなので、**opt-in** で。

---

## 4. 観点 2: 他言語で作り直すなら

### 4.1 候補言語マトリクス

| 言語 | フィット度 | HTTP | HTML パース | oEmbed JSON | DOM 操作 | charset 検出 | PDF metadata | private IP 拒否 | keep-alive | LRU | プラグイン dispatch |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Bun (TS のまま)** | ★★★★★ | `Bun.fetch` 標準 | cheerio そのまま | 標準 | cheerio | iconv-lite が動く | pdf-parse がそのまま動く（ESM 互換注意） | ipaddr.js 動く | Bun の HTTP keep-alive 自動 | lru-cache 動く | 既存コードほぼそのまま |
| **Deno** | ★★★★ | `fetch` 標準 | `deno-dom` / `linkedom` | 標準 | `deno-dom` | `TextDecoder` (Deno は ICU full) | `pdfjs-dist` 動かしにくい | npm: 互換で `ipaddr.js` 動く | 自動 keep-alive | npm 互換 | TS そのまま |
| **Node 24 (現状)** | ★★★★★ | got / undici | cheerio | 標準 | cheerio | iconv-lite | pdf-parse | ipaddr.js | http.Agent | lru-cache | 既存通り |
| **Go** | ★★★ | net/http | `golang.org/x/net/html` + `goquery` | encoding/json | goquery (cheerio に近い) | `golang.org/x/text/encoding` | `pdfcpu` / `unipdf` (重い) | net package で判定 | Transport で keep-alive | `hashicorp/golang-lru` | interface + factory pattern |
| **Rust** | ★★ | reqwest / hyper | `scraper` (cheerio 風) / `html5ever` | serde_json | scraper | `encoding_rs` | `lopdf` (低レベル) / `pdf-extract` | `ipnet` crate | reqwest 自動 | `mokr` / `lru` | trait + dyn dispatch |
| **Python** | ★★ | `httpx` (async) | `beautifulsoup4` / `lxml` / `parsel` | 標準 | parsel | `chardet` | `pypdf` / `pdfplumber` | `ipaddress` 標準 | httpx の Client で keep-alive | `cachetools` | abstract base class |
| **Elixir** | ★★ | `Finch` / `Mint` | `Floki` | Jason | Floki | `chardetex` (薄い) | 弱い、Python 経由 | `:inet` で確認 | Finch pool | `Cachex` | behaviour |

### 4.2 各言語の総評

#### Bun (TS のまま runtime 変更)

**最有力候補**。コードベースをほぼそのまま移行できて、起動時間 / 起動メモリ / fetch スループットで明確に勝つ。pnpm 互換、Vitest 互換 (Bun test もある)、tsc 互換。**Misskey エコシステムは Node 中心だがランタイムだけ差し替えるのは比較的低リスク**。

懸念: pdf-parse / pdfjs-dist の互換性検証が必要。`worker_threads` 相当は `Bun.Worker` で動く。`net.Agent` 相当の細かい制御は Bun 1.x で揃ってきたが、got 相当の API 互換は完全ではない（fetch ベースに書き直す必要あり）。

→ **rewrite するなら Bun + 観点 1 の TS 再設計を組み合わせるのが最も現実的**。

#### Deno

ランタイムの安全性 (`--allow-net=...`) で SSRF 防御層を追加できる。`linkedom` で cheerio を置換可能。**懸念**: Misskey 側が Node 前提の運用ガイドを持つため「Misskey 管理人が Deno を入れる学習コスト」が発生する。npm: 互換は使えるが pdfjs-dist が重い。

→ **観点 1 の TS 再設計でセキュリティ堅牢度を最大化したい場合に検討**。

#### Node.js (Bun 不採用なら現状維持)

無難、エコシステム最大、Misskey 親和性 100%。**rewrite せずに観点 1 の TS 再設計で十分価値が出る**。

#### Go

パフォーマンスと運用配布性 (single binary) が圧倒的。Misskey デプロイ環境で systemd で 1 バイナリ配るのが容易。`goquery` は cheerio に近い API でプラグイン移植は中難度。**懸念**:
- TypeScript の型定義からスキーマ自動生成しにくい（手書き再定義）
- Misskey エコシステムは JS/TS 中心なので「fork で Go 化」のメンテナビリティが下がる
- PDF パースは Go 側に強いライブラリが少なく `pdfcpu` も重い → どちらにせよ external process 隔離

→ **「summaly を独立サーバとして他言語に置く」「複数 Misskey インスタンスで共有する HTTP サービスとして配布」の文脈なら Go が良い**。

#### Rust

最高性能、メモリ安全、`reqwest` + `scraper` で実装可能。**懸念**: 学習コストと開発速度のトレードオフが summaly のようなスクレイピングプロダクト（**サイト固有の挙動変化に頻繁に追従する必要がある**）には合わない。プラグイン作者の参入障壁が高い。

→ **採用しない**。CPU バウンドなライブラリではないので Rust の旨味が薄い。

#### Python

scraping エコシステム（BeautifulSoup / parsel）が豊富で開発速度は早い。ASGI で `httpx` + `FastAPI` 構成にすれば一定の性能は出る。**懸念**: 静的型 (Pydantic) の充実は伸びてきたが TypeScript 比で型整合性は弱い。GIL 由来の並列性能で Node に劣る場面あり。Misskey エコシステムから遠い。

→ **採用しない**。型と Misskey 親和性で TS / Bun に劣る。

#### Elixir

BEAM の障害分離 (per-request process) で「PDF パースで暴走しても他リクエストが死なない」が最大の強み。`Floki` は cheerio に近い。**懸念**: PDF は外部呼び出し前提、エコシステムから遠く、Misskey 管理人の学習コストが極めて高い。

→ **採用しない**。長所はあるが summaly 単体では報われない。

### 4.3 プラグインシステムを「エコシステムが薄い言語」でどう代替するか

| 言語 | プラグイン代替案 |
|---|---|
| **Go** | `interface { Test(*url.URL) bool; Summarize(*url.URL, *Options) (*Summary, error) }` を定義。組み込みは `[]Plugin` を init() で登録。**動的 .so loading は CGo 制約があり非実用** → 「ビルド時に組み込み」モデルになる。**fork してプラグイン追加 = 再ビルド** のワークフロー。 |
| **Rust** | `trait SummalyPlugin: Send + Sync { fn test(&self, url: &Url) -> bool; async fn summarize(...) }` + `Vec<Box<dyn SummalyPlugin>>`。動的 loading は `libloading` で出来るがクロスプラットフォームで脆い。同様にビルド時組み込み前提。 |
| **Python** | `entry_points` (pyproject.toml) で動的 loading 可能。`importlib.metadata.entry_points("summaly.plugins")`。Python 的にはネイティブな仕組み。 |
| **Elixir** | `behaviour @behaviour SummalyPlugin` + Application 起動時に config から `:plugins` を読んで dispatch。BEAM の hot reload もある。 |

→ **Go / Rust への移行は「プラグインの動的追加」を諦める覚悟が必要**。summaly の場合は「組み込み 10 個 + 利用側のカスタムプラグイン」という二層構造なので、後者を **HTTP webhook** 化（外部サーバに dispatch）する設計に倒す案もある。ただし latency 増加。

### 4.4 パフォーマンスと運用コストのトレードオフ

| 軸 | Node/Bun TS | Deno | Go | Rust |
|---|---|---|---|---|
| 起動時間 | 100-300 ms | 100-300 ms | 5-50 ms | 5-50 ms |
| 並列リクエスト捌き | 高 (libuv) | 高 | 最高 (goroutine) | 最高 |
| メモリ常駐 | 50-100 MB | 50-80 MB | 20-50 MB | 10-30 MB |
| 開発スピード | 最高 | 高 | 中 | 低 |
| Misskey 親和性 | 最高 | 中 | 低 | 低 |
| PDF 隔離 | worker_threads | worker | goroutine + 別プロセス | tokio task + 別プロセス |
| デプロイ容易性 | npm 配布 / Docker | Deno bin / Docker | single binary 最強 | single binary 最強 |
| プラグイン追加性 | 最高 (動的 import) | 最高 | 低 (要ビルド) | 低 (要ビルド) |

### 4.5 ハング・暴走リスクの隔離しやすさ

「PDF パースが暴走して Fastify が止まる」リスクの観点:

- **Node/Bun**: `worker_threads` で `terminate()` 可能。`resourceLimits.maxOldGenerationSizeMb` でメモリ cap 可能。**実用十分**。
- **Go**: goroutine は `terminate` できない（cooperative 前提）。PDF パースは外部 process (`os/exec`) で `Cmd.Process.Kill()` が確実。
- **Rust**: tokio task 自体は cancel 可能だが PDF library が cooperative かは別問題。確実なのは別プロセス。
- **Elixir**: BEAM の per-process kill が最強。PDF だけ「監視つき GenServer」に分離して `Process.exit(pid, :kill)` で確実停止。

→ **PDF 隔離だけを最優先するなら Elixir or Go 別プロセス。それ以外の要件込みなら Bun + worker_threads が現実的**。

---

## 5. 統合レコメンド

### シナリオ A（推奨）: Node 維持 + 観点 1 の TS 再設計

**優先順位: 1**

- 既存テスト 1,871 行 + 既存 plugin 10 個を **段階的に新構造へ移植** していく
- 依存スリム化 (got → undici, encoding-japanese 削除, escape-regexp 自前化)
- ファイル構成を `core` / `http` / `server` 三層分離
- worker_threads で PDF 隔離
- in-flight dedup を rewrite で標準化（phase4.2 の DoD を統合）
- プラグイン別 config 機構（phase8.1 TOML の placeholder 解消）
- OpenTelemetry / pino / OpenAPI スキーマ自動化
- 期間: **3 〜 5 ヶ月**

リスク: 既存 fork ユーザー（カスタムプラグイン作者）への影響。`SummalyPlugin.name` 必須化と `PluginContext` 導入は破壊的。**メジャーバージョン 6.0** として明示。

### シナリオ B（次点）: Bun ランタイム + シナリオ A

**優先順位: 2**

- シナリオ A の TS コードを Bun で動かす
- got を fetch (Bun ネイティブ) に置換、`Bun.Worker` で PDF 隔離
- pdf-parse の互換性検証が必要
- パフォーマンス改善 (起動時間 -50%、並列スループット +20-30%)
- Misskey エコシステムからの距離が増えるので「Bun 推奨だが Node でも動く」のデュアル対応が望ましい
- 期間: **シナリオ A + 1 ヶ月**

### シナリオ C（特殊条件下）: Go single binary 化

**優先順位: 3**

- Misskey インスタンス管理者が「summaly を独立 HTTP サービスとして k8s / systemd で配るときに Node ランタイムを入れたくない」要件があるとき
- プラグインの動的追加性を諦め、組み込み 10 個 + 「カスタムプラグインは webhook で外部 dispatch」モデルに切り替える
- パフォーマンスと配布性が最高、ただし **fork メンテナンスコストとプラグイン作者参入障壁が劇的に上がる** ので Misskey コミュニティ全体での合意形成が必要
- 期間: **6 〜 9 ヶ月**

### 採用判断のフローチャート

```
Q1. 既存プラグイン互換性は重要か？
  Yes → シナリオ A or B
  No  → Q2

Q2. single binary 配布が要求されるか？
  Yes → シナリオ C
  No  → シナリオ A or B

Q3. パフォーマンスとデプロイ容易性で +20% 欲しいか？
  Yes → シナリオ B
  No  → シナリオ A
```

→ **多くの Misskey 管理人にとってはシナリオ A が現実的最適解**。

---

## 6. 参考資料 / 関連 issue / リンク集

### 内部ドキュメント

- [README.md](../../README.md) — ライブラリ概要と Misskey 管理人向け案内
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

- **Misskey 本体の URL プレビュー実装**:
  - `packages/frontend-shared/js/url-preview.ts`
  - `packages/frontend/src/components/MkUrlPreview.vue`
  - HTTP インターフェース凍結の根拠
- **Mastodon link-preview DDoS issue**: https://github.com/mastodon/mastodon/issues/23662 — エラーキャッシュ短期 TTL の根拠
- **OWASP SSRF Prevention Cheat Sheet** — private IP guard 設計の根拠
- **`undici` ドキュメント**: https://undici.nodejs.org — got からの移行候補
- **`smol-toml`**: https://github.com/squirrelchat/smol-toml — phase8.1 採用候補
- **OpenTelemetry Node SDK**: https://opentelemetry.io/docs/instrumentation/js/ — observability 強化の参考
- **`@sinclair/typebox`** / **zod**: HTTP インターフェースのスキーマ定義（OpenAPI 自動化）

### 関連 issue（rewrite 検討時の事前確認）

- misskey-dev/summaly#39 — 文字エンコーディング検出（Shift_JIS / ISO-2022-JP の経緯）
- 本フォークの phase ドキュメント全 12 件 — 過去 6 ヶ月の意思決定履歴

---

**結論**: 本ドキュメントは「シナリオ A（Node 維持 + TS 再設計）」を最優先推奨とする。観点 2 の他言語移行は「Misskey エコシステム全体での合意形成」が前提条件となるため、fork レベルでの判断としては観点 1 の改善で得られる便益（依存スリム化・PDF 隔離・プラグイン別 config・観測性）の方が ROI が高い。
