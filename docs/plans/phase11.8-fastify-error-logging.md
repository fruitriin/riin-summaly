# Phase 11.8 — Fastify モードのエラー観測性回復（500 をログに出す）

> 状態: **完了 (2026-05-05)**
> 種別: 観測性 / 運用改善（バグに近い）
> サイズ: **S**
> 依存: なし
> 関連: phase10.1（`parseFailureLog`、本フェーズで補完）、phase11.2（`categorizeError` を log level 派生で再利用）、phase1.1（`Cache-Control`）
> 並列可: phase11.1 / 11.2 / 11.4 / 11.5 / 11.6 / 11.7 すべてと独立

## 実装結果メモ

- **`chooseLogLevel(e)` を `categorizeError` ベースで実装**: Plan は 2 引数 (`e`, `statusCode`) だったが、`statusCode` の取り出しを関数内に閉じ込めて 1 引数にした。`LOG_LEVEL_BY_CATEGORY: Record<SummalyErrorCategory, LogLevel>` テーブル 1 箇所でカテゴリと level の整合を保つ
- **err を手動シリアライズ** (Stage 2 review W-1 対応): pino のデフォルト `errSerializer` は got の `RequestError.options.url` 等の内部プロパティを列挙して出力するため、スクレイピング先 URL のクエリが漏れる経路があった。`{ name, message, stack, statusCode? }` のみ明示的に渡す形に変更し、漏洩経路を遮断
- **`parse_error` テストを null 返しプラグイン経由に整理** (W-3 対応): 空 HTML フォールバックでは general() が title=hostname で summary を返してしまう (parse_error にならない)。カスタムプラグインで `summarize: async () => null` を強制する経路に変更し、`failed summarize` を確実に踏むようにした
- **knowhow の `errorMaxAge` 値を 30 秒 → 1 時間 (`cacheErrorMaxAge` のデフォルト)** に修正 (W-2)
- **mock pino logger の Fastify 6 型対応**: `loggerInstance` が `FastifyChildLoggerFactory<RawServer, ...>` という非常に厳しい型を要求するため、`as any` を経由した `as unknown as FastifyInstance` の二重キャストでテスト注入

## 目的・背景

Fastify モードで `summaly()` が throw すると、現状 **500 をクライアントに返すだけでサーバ側のログには一切何も出ない**。`bin/summaly-server.ts` は `Fastify({ logger: true })` で pino を有効化しているのに、エラー経路で `req.log.error(...)` を呼んでいないため、journalctl / pm2 logs / docker logs のどこを見ても 500 の原因が分からない。

### 現状の経路（[src/index.ts:511-522](../../src/index.ts#L511-L522)）

```ts
const fetchEntry = async (): Promise<CacheEntry> => {
    try {
        const summary = await summaly(url, { ... });
        return { kind: 'success', value: summary };
    } catch (e) {
        return { kind: 'error', error: serializableError(e) };  // ← 黙って詰めてクライアントに返すだけ
    }
};
```

[src/index.ts:462-469](../../src/index.ts#L462-L469) の `respondWithEntry` も `reply.status(500).send(...)` するだけで `req.log` に触らない。`parseFailureLog` を有効にしていれば JSONL には残るが、`isFilteredFailure` が **4xx/5xx・timeout・type filter reject・SSRF・ENOTFOUND を除外する**（[src/utils/parse-failure-log.ts:107-130](../../src/utils/parse-failure-log.ts#L107-L130)）ため、**本番で実際に頻発するエラーほど記録から外れる**。

### 実例（2026-05-05 確認）

`https://summaly.riinswork.space/?url=https://amzn.asia/d/0fqGlUHz` が 500 を返すが journalctl に何も出ない、という運用者の報告。同じコードでローカル直叩きすると正常に取れるため、本番ネットワーク経路（Cloudflare egress IP からの Amazon アクセス）特有の問題と推察されるが、**ログが無いので原因特定できない**。

これは観測性ゼロの状態。バグ・運用障害・upstream のサイト構造変化、すべての切り分けが不可能になっている。

## 設計方針

### 1. ログを出す場所

**MISS 経路の `fetchEntry` catch ブロック1か所だけで良い**。LRU HIT・dedup HIT で過去のエラーを返すときは「同じエラーを再ログしない」方が運用上ノイズが少ない（既に MISS 時に記録済み）。

```ts
const fetchEntry = async (): Promise<CacheEntry> => {
    try {
        const summary = await summaly(url, { ... });
        return { kind: 'success', value: summary };
    } catch (e) {
        // pino の慣例: { err, ... } で渡すと name / message / stack / statusCode を構造化出力
        const statusCode = e instanceof StatusError ? e.statusCode : undefined;
        const logLevel = chooseLogLevel(e, statusCode);
        req.log[logLevel]({ err: e, url: sanitizeUrlForLog(url), lang, statusCode }, 'summaly error');
        return { kind: 'error', error: serializableError(e) };
    }
};
```

### 2. ログレベルの分け方

journalctl/pm2 の運用フィルタで「重大なエラーだけ追う」を可能にするため、レベルを 3 段に分ける:

| 条件 | level | 例 |
|---|---|---|
| `StatusError` 4xx | `info` | upstream の 404 / 403（普通の bot block） |
| `StatusError` 5xx・`TimeoutError`・`AbortError`・型/SSRF reject | `warn` | upstream 障害・遅延・SSRF ガード発動 |
| その他すべて（`failed summarize`、想定外の TypeError 等） | `error` | プラグインのバグ・パーサ落ち |

これで `journalctl --priority=warning` で「気にすべき分」だけ拾える。

### 3. URL のサニタイズ

ログに `url` をそのまま出すと **クエリ文字列に含まれるトークン・セッション ID 等の PII** が漏れる。既存の `sanitizeUrlForLog`（[src/utils/parse-failure-log.ts:63-73](../../src/utils/parse-failure-log.ts#L63-L73)）が `${origin}${pathname}` だけに切り詰めるので **これを再利用** する。クエリ無し URL を出力することで運用上の切り分けに必要な情報（どのサイトの何のパスで落ちたか）は残る。

### 4. `parseFailureLog` との関係

- `parseFailureLog` は **プラグイン候補発見器**（純度を上げるため filter する）
- `req.log.error` は **運用観測ログ**（全エラーを出す）

役割が違うので両立する。本フェーズで `parseFailureLog` の `isFilteredFailure` は触らない（phase11.6 で blocked-failure-log を別系列に切る話があるので、そちらと干渉させない）。

### 5. ログのスパム対策

高頻度に同じエラーが出る本番（例: bot block 連発）でログが膨れる懸念。ただし:
- `info` レベルに落とした 4xx 系は priority フィルタで簡単に切れる
- LRU キャッシュ HIT 時は再ログしないので、`errorMaxAge`（デフォルト 30 秒）の間は同じ URL のエラーは 1 回だけ
- in-flight dedup HIT 時も再ログしない（先頭リクエストの結果共有）

つまり同 URL の同 lang は `errorMaxAge` ごとに 1 行しか出ない。デフォルト運用ではスパムにならない。

### 6. `bin/summaly-server.ts` 側の最終フォールバック

念のため、Fastify アプリ全体に `setErrorHandler` を仕掛けて **summaly プラグイン以外で発生した想定外エラー**（404 ハンドラ・register 失敗等）も拾う。これは upstream Fastify が prefHandler 内で throw した場合のセーフティネット。

```ts
// bin/summaly-server.ts
app.setErrorHandler((err, req, reply) => {
    req.log.error({ err, url: req.url }, 'unhandled fastify error');
    reply.status(500).send({ error: { name: 'InternalServerError', message: 'unhandled error' } });
});
```

ただし summaly プラグイン内で `try/catch` してから `kind: 'error'` を return する経路は **errorHandler に飛ばない**（throw しないので）。結局 §1 の `req.log` 直接呼び出しが本筋。

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `fetchEntry` catch でログ出力**
  - [src/index.ts](../../src/index.ts) の `'/'` ハンドラ内 `fetchEntry` の catch ブロックに `req.log[level]({ err, url: sanitizeUrlForLog(url), lang, statusCode }, 'summaly error')` を追加
  - `sanitizeUrlForLog` は `@/utils/parse-failure-log.js` から import
  - `chooseLogLevel(e, statusCode)` を [src/utils/log-level.ts](../../src/utils/log-level.ts) として新設し、§2 の表に従って `'info' | 'warn' | 'error'` を返す
- [x] **Step 2 — `chooseLogLevel` ユニットテスト** (14 件)
  - [test/log-level.test.ts](../../test/log-level.test.ts) を新設
    - `StatusError(404)` → `info`
    - `StatusError(403)` → `info`
    - `StatusError(500)` → `warn`
    - `StatusError(503)` → `warn`
    - `Error('Rejected by type filter')` → `warn`
    - `Error('Private IP rejected')` → `warn`
    - `Error('failed summarize')` → `error`
    - `TypeError('foo')` → `error`
    - `Error()`（プレーン）→ `error`
- [x] **Step 3 — Fastify モードの統合テスト** (6 件: 500=warn / 403=info / 成功時ログなし / LRU HIT 再ログなし / URL sanitize / parse_error null プラグイン経由)
  - [test/index.test.ts](../../test/index.test.ts) に「500 が返るとき pino ログが呼ばれる」テストを追加
    - `Fastify({ logger: <mock pino>})` でカスタム logger を注入し、`StatusError(500)` を throw する mock origin を用意
    - リクエスト → `mockLogger.warn` が `{ err, url, statusCode: 500 }` 付きで 1 回呼ばれることを assert
    - 同じ URL に 2 回目のリクエスト → エラーがキャッシュ HIT されるなら `mockLogger.warn` は **追加で呼ばれない**（cache HIT は再ログしない設計）
  - 4xx ケース（`StatusError(403)`）で `info` が呼ばれること
  - `failed summarize` ケースで `error` が呼ばれること
- [x] **Step 4 — `bin/summaly-server.ts` に `setErrorHandler` を追加** (404 ハンドラ未マッチ等のセーフティネット)
  - register 失敗・404 ハンドラ等の最終フォールバック
  - 本ハンドラはあくまでセーフティネット（実用上はほぼ通らない）
- [x] **Step 5 — ドキュメント更新** (SETUP.md / CHANGELOG.md)
  - [docs/SETUP.md](../../docs/SETUP.md) の運用セクションに「ログレベル別の意味」を追記
    - `info`: upstream 4xx（普通のことなので無視可）
    - `warn`: upstream 5xx / timeout / SSRF block（気にする）
    - `error`: 想定外（必ず確認）
  - journalctl で気にすべきものだけ追う例: `journalctl -u summaly --priority=warning -f`
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased に `enhance: Fastify モードで summaly エラーを pino ログに出力するように` を追加
- [x] **Step 6 — knowhow 記録** (`docs/knowhow/fastify-plugin-error-logging.md`)
  - 「Fastify プラグイン内で `try/catch` して return した非 throw エラーは `setErrorHandler` には飛ばない。観測したいなら明示的に `req.log` を呼ぶ必要がある」を `docs/knowhow/fastify-plugin-error-logging.md` 等にまとめる
  - 「pino の `{ err }` プロパティに Error を渡すと name / message / stack / statusCode が構造化される」点もメモ
- [x] **Step 7 — 品質ゲート** (272 pass / lint / typecheck / build / ADDF tests / Stage 2 review W-1〜W-3 + S-1 + S-3 対応)
  - `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
  - `bash .claude/tests/run-all.sh`
  - `addf-code-review-agent` / `addf-contribution-agent`

## 完了条件 (Definition of Done)

- Fastify モードで summaly が throw したとき、`req.log` 経由で pino ログが必ず 1 行出る
- ログレベルがエラー種別で正しく分かれている（4xx=info / 5xx・timeout=warn / 想定外=error）
- LRU/dedup HIT 時は再ログしない（spam 抑制）
- URL は `sanitizeUrlForLog` でクエリ除去された形で出力される
- `bin/summaly-server.ts` に `setErrorHandler` セーフティネットがある
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- 本番 `summaly.riinswork.space` で再現中の Amazon 500 が、本フェーズ反映後に journalctl で原因特定できる状態になる

## リスク・注意点

1. **ログ量増加**: デフォルトの `errorMaxAge = 30s` のおかげで同 URL は 30 秒に 1 回しか出ないが、多種多様な URL が連続して落ちると `info` レベルが膨らむ。priority フィルタで分離すれば運用上の問題にはならないはず
2. **PII 漏洩リスク**: `sanitizeUrlForLog` でクエリは落とすが、pathname に PII（ユーザー名等）を含むサイトもある。本フェーズでは pathname まで残す（運用上の切り分けに必要なため）。気になる場合は別途 `logUrlMode: 'origin' | 'origin-path' | 'full'` のような設定オプションを足す余地あり（今回は最低限のサニタイズのみ）
3. **`err` シリアライズの pino デフォルト挙動**: pino は `{ err: <Error> }` を `err: { type, message, stack }` 形式に展開する。stack まで毎回出ると冗長。pino の `serializers.err` を絞った形に差し替えるのは upstream Fastify の logger オプションを触る必要があるので、本フェーズではデフォルトのまま（運用で困ったら別途 tuning）
4. **テストの mock pino**: vitest で pino logger をどこまで本物に近く mock するかは設計次第。最小限「`info` / `warn` / `error` メソッドが呼ばれた回数と引数」を見れば十分。`Fastify({ logger: { level: 'silent' } })` で本物の pino を回しつつ stream を捕まえる方が確実だが実装コスト高い。前者で着手し、不足なら後者に切り替え
5. **`info` レベル昇格の運用判断**: 「4xx は info」を維持するか「すべて warn 以上」にするかは運用者の好み。本 Plan ではデフォルト `info` 推奨だが、phase11.2（error category）が完了した後にもう一度ポリシー見直しの余地あり
6. **observability スタックとの連携**: 将来 OpenTelemetry / Loki 等を入れる場合は構造化フィールド（`url`、`statusCode`、`category`）を維持するのが効く。本フェーズの `{ err, url, lang, statusCode }` はその下地になる
