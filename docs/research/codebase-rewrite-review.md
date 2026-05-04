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

**評価軸**: 「**実行速度** (リクエスト捌きの throughput / パース速度 / latency)」と「**できることの品質** (機能の正確性・カバレッジ・エッジケース対応)」のバランスで判定する。**コードベース / 依存サイズは判断材料から除外**。

| 現状 | 速度 | 品質 | 総評 / 推奨アクション |
|---|---|---|---|
| **got** 15.0.3 | △ | ◎ | **置換候補: `undici`**。got は HTTP クライアントとして最も機能が豊富 (retry / hooks / pagination / cookies / pre-redirect normalization)。一方 `undici` は Node 18+ の `fetch` 内部実装で、HTTP/1.1 keep-alive プールの効率と pipeline で **got より request/sec が 1.5〜2x 高い**（公式ベンチで 60-70K req/s vs got 35-40K req/s）。summaly は got の features (retry/hooks 等) を使っていないので、品質を落とさず速度を取れる。**推奨: undici Dispatcher + AbortController**（agent 制御も undici の方が細かい）。ただし「stream の AbortError 取り回し」「`got.HTTPError` 相当の例外シェイプ」「`agent` の `Agents` 型」など API 互換調整が rewrite 規模で必要。 |
| **cheerio** 1.2.0 | △ | ◎ | **置換候補: `linkedom`**（rewrite なら）。cheerio は jQuery 風の表現力（`$('meta[property="og:title"]').attr('content')` のような selector + traversal）が summaly の抽出ロジックに刺さる。一方 `linkedom` は実 DOM (Window/Document/HTMLElement) を再現し **selector queries が cheerio の 2-3x 速い**（特に大きい HTML で）。本フォークの `general.ts` / 各プラグインは jQuery 相当 API に依存しているため**移行コストは大きい**が、rewrite 規模なら全プラグイン書き直しを許容できる。**recommended: rewrite で linkedom**、漸進改修なら cheerio 維持。 |
| **iconv-lite** 0.7.2 | ○ | ◎ | **現状維持推奨**。iconv-lite は pure JS で **`iconv` (native binding) より 30% 程度遅いが、Buffer 出力の正確性とエンコーディングカバレッジで業界標準**。Node の `TextDecoder` は最速 (ICU 直叩き) だが、配布 Node によっては ISO-2022-JP / Shift_JIS が含まれない (ICU small ビルド) ため Misskey 配布環境を縛れない。「速度を最大化」したいなら `TextDecoder` を try、失敗時 iconv-lite フォールバックの 2 段階構成が選択肢。 |
| **jschardet** 3.1.4 | △ | △ | **置換候補: `chardetng-js` (wasm)**。jschardet は Mozilla 由来の古いポートで、Latin / EUC / Shift_JIS / UTF-8 の検出精度が現代ブラウザに劣る。**`chardetng-js`** は Firefox 同梱の Rust 実装の wasm port で、**実 Web ページに対する検出精度が圧倒的に高い**（Firefox 同等）。速度は wasm 起動コストでわずかに劣るが、検出精度の品質差が大きい。本フォークは confidence 0.99 縛りで実質ほぼ採用されない設定 (= jschardet の弱検出を信じない設計) のため、品質改善でこのワークアラウンドを外せる。**rewrite で chardetng-js 推奨**。 |
| **encoding-japanese** 2.2.0 | ✕ | ✕ | **削除推奨**。本ライブラリ最大の問題: ISO-2022-JP の decode 速度が **iconv-lite の 4〜5 倍遅い** ([phase2.2 計画ファイルの実測表](../plans/phase2.2-mei23-non-plugin.md))。本フォークは「ISO-2022-JP のために iconv-lite を補完する」目的で導入したが、**iconv-lite 0.7.x は ISO-2022-JP の decode を公式サポート済み** (changelog 確認済)。速度・品質の両軸で iconv-lite に統合すべき。**rewrite で削除確定**。 |
| **fastify** 5.8.5 | ◎ | ◎ | **現状維持推奨**。Fastify は **Express の 2-3x 速い**（公式ベンチ 65K req/s vs 25K）うえ、JSON Schema による自動 fast-json-stringify、route plugins の encapsulation、Cache-Control / ETag のフック容易性で summaly の用途と完全に噛み合う。代替 `Hono` は Web Standard fetch ベースで Bun/Deno 親和性が高いが Node 環境では fastify 同等以下。Express 5 / Koa は速度品質ともに劣る。**rewrite でも fastify**。Bun 移行 (シナリオ B) なら hono 検討。 |
| **lru-cache** 11.3.5 | ◎ | ◎ | **現状維持推奨**。`lru-cache` は **業界標準で TTL / maxSize / dispose / size calculation 全部入り**、かつ get/set が O(1) で速い。代替 `mnemonist/LRUCache` は速度同等で API も近いが TTL 機構が弱い。`quick-lru` は機能少なく summaly の use case (per-entry TTL) に不向き。**rewrite でも lru-cache**。 |
| **pdf-parse** 2.4.5 | ✕ | ◎ | **置換候補: 自前正規表現パーサ + フォールバック `pdfjs-dist` 直叩き**。pdf-parse は内部で `pdfjs-dist` 全体をロードし、メタデータ取得だけでも **document parse のフルパスを通る** (~50-200ms/ファイル)。一方 PDF メタデータ (`Title`) は **PDF Trailer Dictionary を直接読めば数ミリ秒で取れる**。速度は 10-50x 改善。品質面では PDF 仕様準拠の正規表現で 90% のメタデータ付き PDF をカバーでき、外れ値 (encoding 違い・compressed metadata) には pdfjs-dist フォールバック。**rewrite で自前 + worker_threads 隔離**。pdfjs-dist を fallback として残すなら品質ロスなし、worker 隔離で速度差を相殺できる。 |
| **ipaddr.js** 2.3.0 | ◎ | ◎ | **現状維持推奨**。`ipaddr.js` は **IPv4/IPv6 統合 + range 判定 (`unicast` / `private` / `loopback` 等) を pure JS で高速に行える** 業界標準。代替 `ip-address` は機能豊富だが速度同等以下。Node native `net.isIP` は range 判定不可で SSRF ガード用途に不足。**rewrite でも ipaddr.js**。 |
| **html-entities** 2.6.0 | ◎ | ◎ | **現状維持推奨**。`html-entities` v2 は **Trie ベースで decode 速度が `he` の 2-3x 速い**、HTML5 仕様完全対応。`he` は厳密性ではやや上回るが summaly の use case (meta tag content の decode) では差が出ない。**rewrite でも html-entities**。 |
| **escape-regexp** 0.0.1 | ○ | △ | **置換候補: `escape-string-regexp` または自前**。本ライブラリは中身 1 行 (`s.replace(/[\-\/\\^$*+?.()|[\]{}]/g, '\\$&')`) で速度品質とも問題なし。ただし **0.0.1 で 11 年メンテなし**、TypeScript 型定義は `@types/escape-regexp` 任せ、依存の信頼性に難。`escape-string-regexp` は同じ機能でメンテ活発、または **自前 1 行関数** で十分（パフォーマンス同等、品質保証は自分でできる）。**rewrite で自前化推奨**。 |
| **tsdown** 0.21.10 | ◎ | ◎ | **現状維持推奨**。tsdown は rolldown ベースで **build 時間が tsc の 5-10x 速い**、`.d.ts` 出力 / ESM 完全対応。代替 `tsup` (esbuild) や `unbuild` も同等だが tsdown が最新。**rewrite でも tsdown**。 |
| **vitest** 4.1.5 | ◎ | ◎ | **現状維持推奨**。Vitest は **jest 互換 API + esbuild ベースの fast watch mode**、HMR でテストイテレーションが速い。Bun test は速度では勝るが Bun 環境前提。Node test runner (`node:test`) は機能が薄い。**rewrite でも vitest**。 |
| **eslint** 9 + `@misskey-dev/eslint-plugin` | ○ | ◎ | **現状維持推奨**。lint は実行速度より品質ルールカバレッジが重要。flat config 採用済みで設定の見通しが良い。代替 `oxlint` (Rust) は 50-100x 速いが rule カバレッジで eslint に劣る。speed/quality で **eslint + 必要なら oxlint を CI の事前チェックに併用** が選択肢。 |
| **typescript** 6.0.3 | ◎ | ◎ | **現状維持推奨**。tsc は速度では Babel/swc に劣るが**型システムの品質はオリジナル**。代替なし。 |
| **@types/encoding-japanese** | — | — | encoding-japanese を削除すれば不要。 |

#### 推奨入れ替え方針 (速度 + 品質バランス重視)

優先順:

1. **encoding-japanese → 削除 (iconv-lite 一本化)**: 速度 4-5x 改善 + 品質変化なし。最も ROI 高い。
2. **pdf-parse → 自前 PDF Trailer parser + pdfjs-dist フォールバック**: 速度 10-50x 改善、品質はフォールバックで担保。
3. **jschardet → chardetng-js (wasm)**: 検出精度が大きく向上 (Firefox 同等)。confidence 0.99 縛りを外せて品質向上。
4. **got → undici Dispatcher**: throughput 1.5-2x 改善、機能ロスなし (summaly は got の advanced features を使っていない)。
5. **cheerio → linkedom**: selector 速度 2-3x 改善。ただしプラグイン全書き直しが必要なので **rewrite 規模でのみ採用**。
6. **escape-regexp → 自前 / escape-string-regexp**: 速度品質変化なし、依存の信頼性向上のみ。

その他 (fastify / lru-cache / ipaddr.js / html-entities / iconv-lite / tsdown / vitest / eslint / typescript) は **速度・品質の両軸で現状が最適解**、rewrite でも維持。

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

### 3.6 rewrite 規模なら検討する「メタツールチェーン一括差し替え」

3.4 では「個別ツール (bundler / test / lint / typecheck) の現状維持で十分」と結論づけたが、**rewrite 規模で一気に作り直すなら、ツールチェーン全体を統合パッケージに置き換える** 選択肢が現実味を帯びる。代表例 2 つ:

#### 候補 1: Vite Plus (Node 維持シナリオの上位互換)

[Vite Plus](https://viteplus.dev/guide/) は Vite / Vitest / Oxlint / Oxfmt / Rolldown / **tsdown** / Vite Task を統合した「**統一ツールチェーン**」。本フォークは既に tsdown / Vitest を採用しているため**親和性が高い**。

| 領域 | 現状 | Vite Plus 採用後 |
|---|---|---|
| bundler | tsdown | tsdown (Vite Plus 経由) |
| test | vitest | vitest (Vite Plus 経由) |
| lint | ESLint 9 | **Oxlint** (Rust 製、ESLint の **50-100x 速い**、ただし rule カバレッジでまだ ESLint に劣る) |
| format | (なし) | **Oxfmt** (Rust 製、Prettier 相当を超高速) |
| dev server | (なし) | Vite (phase7.1 dev サーバ用に直接利用可能) |
| task runner | npm scripts | Vite Task (依存タスクのオーケストレーション) |

**速度・品質のバランス**:
- ✅ 既存 tsdown / Vitest を維持できる (ノウハウロスゼロ)
- ✅ Oxlint で lint が桁違いに速い (CI 時間圧縮)
- ✅ phase7.1 dev サーバが Vite ベースで自然に組める (HMR が効く)
- ⚠ Oxlint は ESLint の全 rule をカバーしていない → 既存 `@misskey-dev/eslint-plugin` のルールを fallback で eslint に残す or oxlint 対応の rule に書き換える必要
- ⚠ 新興ツールのため Misskey エコシステムでの採用例は少ない (= 学習コスト中)

→ **シナリオ A (Node 維持) のサブオプションとして強く検討に値する**。

#### 候補 2: Bun + Biome (シナリオ B のフルスタック版)

| 領域 | 現状 | Bun + Biome 採用後 |
|---|---|---|
| ランタイム | Node | **Bun** (起動 -50%、fetch throughput +20-30%) |
| bundler | tsdown | **`bun build`** (esbuild ベース、超高速) |
| test | vitest | **`bun test`** (jest 互換 API、超高速) |
| lint | ESLint 9 | **Biome** (Rust 製、ESLint + Prettier 相当を一括、**ESLint の 25x 速い**) |
| format | (なし) | **Biome** |
| package manager | pnpm | **`bun install`** (npm の 10-30x 速い) |
| dev server | (なし) | Bun の HTTP サーバ (Hono と組み合わせ) |

**速度・品質のバランス**:
- ✅ ツールチェーン全体が Rust / Zig / native binding ベースで CI 時間が劇的に短縮 (体感 5-10x)
- ✅ Misskey ecosystem が将来 Bun 化する可能性に先回り
- ✅ Biome は ESLint + Prettier の両機能を 1 つの設定で扱え、設定の見通しが良い
- ⚠ pdf-parse / pdfjs-dist の Bun 互換性は要検証 (worker 経由なら回避可能)
- ⚠ Misskey 配布環境への Bun ランタイム要件追加 (運用者の学習コスト)
- ⚠ Biome は ESLint の全 rule カバーではない (`@misskey-dev/eslint-plugin` の互換性検証必要)

→ **シナリオ B (Bun) を採用するなら Biome もセットで採用するのが自然**。半端に Bun + ESLint より、Bun + Biome の方が tooling 一貫性が高い。

#### 統合判断マトリクス

| シナリオ | bundler | test | lint/format | runtime | 向き先 |
|---|---|---|---|---|---|
| A (現状維持リファクタ) | tsdown | vitest | ESLint | Node | 漸進改修 |
| **A + Vite Plus** | tsdown (Vite Plus) | vitest (Vite Plus) | **Oxlint + Oxfmt** | Node | rewrite 規模、Node 維持 |
| **B (Bun + Biome)** | bun build | bun test | **Biome** | Bun | rewrite 規模、配布環境変更可 |

**推奨**: rewrite を実施するなら、**「A + Vite Plus」を第一候補**、「B (Bun + Biome)」を Misskey 管理人の Bun 受容性次第での選択肢として併記する。シナリオ 5 章の優先順位もこれに合わせて更新可能。

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
- 依存入れ替え (got → undici, encoding-japanese 削除, jschardet → chardetng-js, pdf-parse → 自前 + フォールバック, escape-regexp 自前化)
- **ツールチェーン: Vite Plus に統合**（tsdown + Vitest を維持しつつ Oxlint + Oxfmt + Vite dev server を入れる）
- ファイル構成を `core` / `http` / `server` 三層分離
- worker_threads で PDF 隔離
- in-flight dedup を rewrite で標準化（phase4.2 の DoD を統合）
- プラグイン別 config 機構（phase8.1 TOML の placeholder 解消）
- OpenTelemetry / pino / OpenAPI スキーマ自動化
- 期間: **3 〜 5 ヶ月**

リスク: 既存 fork ユーザー（カスタムプラグイン作者）への影響。`SummalyPlugin.name` 必須化と `PluginContext` 導入は破壊的。**メジャーバージョン 6.0** として明示。

### シナリオ B（次点）: Bun + Biome + シナリオ A の設計思想

**優先順位: 2**

- シナリオ A の TS / アーキテクチャ設計をそのままに、**ランタイム = Bun、ツールチェーン = Bun + Biome** に置換
- `bun build` / `bun test` / **Biome (lint + format)** / `bun install` で CI 時間を 5-10x 短縮
- got を Bun ネイティブ fetch に置換、`Bun.Worker` で PDF 隔離 (pdf-parse の Bun 互換性は要検証)
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
