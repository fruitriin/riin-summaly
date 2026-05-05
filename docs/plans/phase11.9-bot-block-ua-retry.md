# Phase 11.9 — bot block 対策（複合 UA + フォールバック UA リトライ）

> 状態: **完了 (2026-05-05)**
> 種別: 機能改善 / 救援率向上
> サイズ: **M**
> 依存: phase11.2（`categorizeError` を拡張・再利用）、phase8.1（TOML 設定）、phase4.1（LRU キャッシュ）、phase4.2（in-flight dedup）
> 関連: phase11.6（迂回候補ログ — 統合せず役割分離）、phase10.1（`parseFailureLog` を計測基盤として活用）
> 並列可: phase11.4 / 11.5 / 11.6 / 11.7 と独立

## 目的・背景

`SummalyBot/<ver>` を名乗ると **TCP/TLS は通すが HTTP レスポンスを返さず黙って RST する** 種類の bot block を踏むサイトがそれなりにあり、Misskey 上で OGP プレビューが取れない事例が継続発生している。`socket hang up` シグニチャで `parseFailureLog` には残るが、エラーカテゴリも `unknown` 落ち（[src/utils/parse-failure-log.ts:152](../../src/utils/parse-failure-log.ts#L152) の `network_error` パターンが `socket hang up` をカバーしていない）で、運用観測上もぼんやりしている。

### 実証データ（2026-05-05 計測）

`parse-failure-log.jsonl` で頻発していた 3 サイトに対して UA を変えて挙動測定した結果:

| サイト | `SummalyBot/...` | `Mozilla/5.0 (Macintosh ...) Chrome/...` | `Twitterbot/1.0` | `facebookexternalhit/1.1` | `Discordbot/2.0` | UA に `SummalyBot` を含む複合 UA |
|---|---|---|---|---|---|---|
| `playing-games.com` | ❌ socket hang up | ✅ 200 (150 KB) | ✅ 200 | ✅ 200 | ✅ 200 | ❌ socket hang up |
| `wacoca.com` | ❌ socket hang up | ⚠️ 404 (URL 自体無効) | ⚠️ 404 | ⚠️ 404 | ⚠️ 404 | ❌ socket hang up |
| `rawchili.com` | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up |

**わかったこと**:

1. `playing-games.com` / `wacoca.com` は **UA に `SummalyBot` という文字列が含まれているとピンポイントで弾く** WAF を入れている。`Twitterbot` / `Discordbot` / `facebookexternalhit` 等の有名どころの share-link bot UA は許可している。
2. **Mozilla プレフィックスを付けただけ（複合 UA）では救えない**。`SummalyBot` 文字列の substring match で弾かれているため、自己同定する限りこのサイト群には届かない。
3. `rawchili.com` はどの UA でも沈黙。これは IP-based block（特定 ASN / Linode 互いの IP レンジ等）と推察され、UA レイヤでは救えない。
4. `playing-games.com` のように **「ピュア Mozilla なら通すが Mozilla プレフィックス + SummalyBot を含むと弾く」** タイプも実在することは追加で実証済み。

### 救える比率の推定

- 上記 3 サイトのうち **2/3 (67%)** は UA を完全に切り替える（`SummalyBot` 文字列を含まない）リトライで救える
- 残り 1/3 (`rawchili.com` 系の IP block) は本フェーズの射程外

3 件は氷山の一角で、`parse-failure-log.jsonl` の他の `socket hang up` / `403` / `429` 系も同型のはず。

### share link を出すサイトの設計意図と OGP scraper の役割は一致している

「share link を発行している」ということは「他のサービスでプレビューされることを許諾している」と解釈できる。`facebookexternalhit` を許可しているサイトは「OGP を読まれること」を想定している。summaly がそのまま fallback として `facebookexternalhit` を名乗るのは「fb 偽装」とも見えるが、**OGP を読み出すという目的自体は完全に合致**しており、サイト側の運用方針にも沿っている。

ただし倫理的に気になる場合の安全弁として、フォールバック UA は **config で差し替え可能** にする。

## 設計方針

### 1. デフォルト UA を複合化（Slackbot / LinkedInBot 流）

```
Mozilla/5.0 (compatible; SummalyBot/<ver>; +https://github.com/misskey-dev/summaly)
```

- 上記実証では **このサイト群に対しては効かない**（`SummalyBot` 文字列で弾かれるため）
- 効くのは **「Mozilla プレフィックス必須」** タイプの WAF。世の中こちらの方が件数として多いと思われるので、底上げの意味で導入
- 自己同定（`SummalyBot/<ver>` + URL）は維持できる
- 副作用として既存の bot 検知ロジック（運営者が summaly を許可リスト入りさせている等）が `SummalyBot` 文字列を期待しているなら互換性は保たれる
- `+https://...` の自己説明 URL は cookie-less 識別情報として扱ってもらいやすい

### 2. フォールバック UA リトライ（本命）

`scpaping()` のリクエストが **「リトライ価値ありの bot block シグナル」** で失敗したとき、**`SummalyBot` 文字列を含まない UA** で 1 回だけ再試行する。

#### 2.1 リトライ対象シグナルの判定

phase11.2 の `categorizeError` を拡張して以下の新カテゴリを追加:

- **`connection_dropped`**: TCP/TLS は通ったが HTTP レスポンスを返さず切断 (`socket hang up`, `EPIPE`, `ECONNRESET`<sup>※</sup>, `Empty reply`)

※ `ECONNRESET` は現状 `network_error` 配下になっているが、socket hang up と意味的にほぼ同じなので `connection_dropped` 側に寄せる（後方互換のため `network_error` でも判定経路を残す案も検討）

リトライするカテゴリ:
- `bot_blocked` (4xx — 401/403/429 が典型)
- `connection_dropped` (新規)
- `origin_error` のうち **503** だけ（一般的な 5xx は再試行価値が低い）

#### 2.2 リトライ UA

```toml
# デフォルト（運用者が嫌なら config で差し替え）
"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
```

候補（運用判断で選択可）:
- `facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)` （最も広く許可されている）
- `Twitterbot/1.0`
- `Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)`
- `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ...` （ブラウザ偽装、最強だが倫理的に微妙）

#### 2.3 リトライ実装場所

`getResponse()`（[src/utils/got.ts](../../src/utils/got.ts)）の **外側** に薄いラッパ `getResponseWithFallback()` を作る。`scpaping()` および `summaly()` 関数の HEAD/GET 経由の主要呼び出し箇所からこのラッパを通す。

- 1 度目: 通常 UA (`opts.userAgent ?? DEFAULT_BOT_UA`) で `getResponse()`
- 失敗時、`categorizeError` 結果がリトライ対象カテゴリに含まれれば、UA を `fallbackUserAgent` に差し替えて 1 度だけ再呼び出し
- どちらも失敗したら **2 回目のエラー**（最後に踏んだエラー）を throw する。これによりフォールバックでも失敗したという情報が末端まで伝わる
- 成功時はそのまま `Got.Response<string>` を返す

リトライ回数は **常に最大 1 回** (= 合計 2 回試行)。指数バックオフは入れない（同 URL に短時間で 2 回叩くだけなので意味薄）。

### 3. 設定スキーマ（TOML）

`config.example.toml` に追加:

```toml
[scraping.fallback]
# bot block されたとき別 UA で 1 回リトライするか
enabled = true

# リトライ時に使う UA
user_agent = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"

# どのカテゴリでリトライを発火するか
categories = ["bot_blocked", "connection_dropped"]
```

[bin/config-loader.ts](../../bin/config-loader.ts) のスキーマ拡張で `scraping.fallback` セクションをパース。`enabled = false` でリトライ無効化。

### 4. `summaly()` 関数経路の API 拡張

ライブラリ利用者（Fastify を経由しない）にもリトライを提供するため、`SummalyOptions` に追加:

```ts
export type SummalyOptions = {
    // ... 既存 ...

    /**
     * Bot block 検出時のフォールバック UA。指定すると、リトライ対象カテゴリのエラーが発生したとき
     * この UA で 1 回だけ再試行する。`undefined` または空文字列ならリトライ無効。
     */
    fallbackUserAgent?: string;

    /**
     * `fallbackUserAgent` が発火するエラーカテゴリ。デフォルトは `["bot_blocked", "connection_dropped"]`。
     */
    fallbackRetryCategories?: SummalyErrorCategory[];
};
```

デフォルト挙動の互換性:
- `fallbackUserAgent` 未指定なら **既存挙動（リトライなし）**
- Fastify モードでは `config.toml` の `[scraping.fallback]` から `summaly()` 呼び出しに自動注入する

これによりライブラリ呼び出しは **明示的にオプトイン**、Fastify 運用は **設定でオプトアウト可能だがデフォルト ON**、という分離になる。

### 5. リトライ結果の観測（parse-failure-log と pino ログ）

#### parse-failure-log

リトライ前のエラーは記録しない（`isFilteredFailure` でフィルタされる範囲）。**最終結果だけ記録する**:
- 1 回目で成功 → 何も記録しない
- 1 回目失敗 + 2 回目で成功 → 「フォールバック救援成功」を別ログに記録（phase11.6 の射程と被るのでここでは最低限 `req.log.info` だけ出して、構造化記録は phase11.6 で）
- 両方失敗 → 既存の `parseFailureLog.record()` 経路（最後のエラーで記録）

#### pino ログ（Fastify モード）

phase11.8 で導入した `req.log` 経由のエラーログに **リトライ情報** を追加:

```ts
req.log[level]({
    err,
    url: sanitizeUrlForLog(url),
    lang,
    statusCode,
    fallbackAttempted: true,    // ← 追加
    fallbackSucceeded: false,    // ← 追加
}, 'summaly error');
```

成功時は `req.log.info({ url, fallbackSucceeded: true }, 'summaly fallback rescued')` を 1 行出して、運用上の救援統計に使えるようにする。

### 6. 副作用 / リスクの整理

- **総リクエスト数 (worst case)**: bot block されたサイトでは 1 リクエストが 2 リクエストになる。LRU キャッシュ HIT で 2 度目以降は 0 リクエストなので実質増えない。in-flight dedup によりバースト時も先頭の 1 ユーザーだけが 2 リクエスト払う形
- **fb 偽装の倫理**: config で差し替え可能。`compatible; SummalyBot/<ver>` を含めることもできる（ただしそれだと再び弾かれる可能性）。サーバ運営者が選択する形にして責任を分離
- **ループリスク**: リトライは固定 1 回上限。`fallbackUserAgent` で叩いた結果も同じカテゴリで失敗した場合に「2 回目のリトライ」は **しない**。実装で明示的にガード（`retryWithFallback({ maxAttempts: 2 })` のようなフラグ）
- **LRU キャッシュキー**: 現状 `(url, lang)` のみ。リトライ結果と通常結果でキャッシュキーが衝突しないか確認 → リトライ結果も最終結果なので同一キーに入れて問題なし。むしろ「リトライで救えた結果」も `defaultMaxAge` 期間キャッシュされて再現要求は 0 リクエストで返せる
- **`agent` がカスタムのときの扱い**: `setAgent()` でカスタム agent が設定されているとプライベート IP ガードは無効化される。リトライ機構はこの状態でも動作するが、**「カスタム agent 経由のリクエストはサーバ側でも正規 IP に見える」想定** なので、bot block の踏み方が変わる可能性がある。本フェーズでは「カスタム agent でも同じロジックを通す」とし、特殊な分岐は入れない

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `categorizeError` 拡張**
  - [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) の `SummalyErrorCategory` に `connection_dropped` を追加
  - 判定ロジックに `socket hang up|EPIPE|Empty reply` パターンを追加（優先順位は `network_error` より前 — `ECONNRESET` は意味的に近いので `connection_dropped` に再振り分け）
  - `LOG_LEVEL_BY_CATEGORY` ([src/utils/log-level.ts](../../src/utils/log-level.ts)) に `connection_dropped: 'warn'` を追加
  - `FILTERED_CATEGORIES` に `connection_dropped` を追加（プラグイン候補ではないので `parseFailureLog` のノイズから除外）
- [x] **Step 2 — `categorizeError` ユニットテスト追加**
  - [test/parse-failure-log.test.ts](../../test/parse-failure-log.test.ts) に `connection_dropped` ケースを追加（`socket hang up`, `EPIPE`, `ECONNRESET`, `Empty reply from server`）
  - [test/log-level.test.ts](../../test/log-level.test.ts) に `Error('socket hang up')` → `'warn'` のケースを追加
- [x] **Step 3 — デフォルト UA を複合化**
  - [src/utils/got.ts:69](../../src/utils/got.ts#L69) の `DEFAULT_BOT_UA` を `Mozilla/5.0 (compatible; SummalyBot/${_VERSION_}; +https://github.com/misskey-dev/summaly)` に変更
  - 既存テストが `SummalyBot/${version}` 完全一致で assert しているなら、複合 UA に含まれることを assert するように調整（`expect(ua).toContain('SummalyBot/')`）
- [x] **Step 4 — `getResponseWithFallback` ラッパ実装**
  - [src/utils/got.ts](../../src/utils/got.ts) に `getResponseWithFallback(args, fallback)` を追加
    - `fallback`: `{ userAgent: string, categories: SummalyErrorCategory[] } | undefined`
    - `undefined` なら通常の `getResponse(args)` 1 回呼び出しと等価
    - 1 回目失敗 → `categorizeError` でカテゴリ判定 → `fallback.categories` に含まれていれば UA だけ差し替えて 2 回目
    - 2 回目失敗時は **2 回目のエラー**（最後のエラー）を throw
  - `scpaping()` の内部呼び出しを `getResponseWithFallback` に切り替え
- [x] **Step 5 — `SummalyOptions` API 拡張**
  - [src/index.ts](../../src/index.ts) の `SummalyOptions` に `fallbackUserAgent?: string` と `fallbackRetryCategories?: SummalyErrorCategory[]` を追加
  - `summaly()` 関数本体で `opts.fallbackUserAgent` を受け取り、`scpaping()` / `general()` 経由の `GeneralScrapingOptions` に伝播
  - `general()`（[src/general.ts](../../src/general.ts)）の `GeneralScrapingOptions` にも `fallbackUserAgent` / `fallbackRetryCategories` を追加
  - 初期 HEAD（リダイレクト解決）にもフォールバックを適用するか判断 → **適用する**（HEAD で落ちるサイトもあるため）
- [x] **Step 6 — Fastify モード config 統合**
  - [bin/config-loader.ts](../../bin/config-loader.ts) のスキーマに `[scraping.fallback]` セクションを追加（`enabled` / `user_agent` / `categories`）
  - [src/index.ts](../../src/index.ts) の Fastify プラグインで config から読み取って `summaly()` 呼び出しに自動注入
  - `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` の **両方** を更新（CLAUDE.md の「ドキュメントと実装の突き合わせ」ステップ 4.5 に従う）
- [x] **Step 7 — リトライの ユニット / 統合テスト**
  - [test/got.test.ts](../../test/got.test.ts) （無ければ新設）に `getResponseWithFallback` のユニットテスト
    - 1 回目で成功 → 1 回しか呼ばれない
    - 1 回目 `socket hang up` → 2 回目で UA が `fallback.userAgent` に差し替わって呼ばれる
    - 1 回目 `404` → カテゴリ `not_found` でリトライ対象外、`fallback.categories` に含まれないので 2 回目呼ばれない
    - 1 回目 / 2 回目両方失敗 → 2 回目のエラーが throw される
    - `fallback === undefined` → 通常 `getResponse` 等価
  - [test/index.test.ts](../../test/index.test.ts) に Fastify モードでのフォールバック動作テスト
    - mock origin で 1 回目 `socket hang up` → 2 回目成功、最終的に 200 が返ること
    - mock origin で 1 回目 `403` → 2 回目で別 UA が来ること（mock 側で UA を assert）
    - LRU キャッシュ動作: 1 回目フォールバック成功 → 2 度目のリクエストはキャッシュ HIT で 0 リクエスト
- [x] **Step 8 — pino ログ拡張（**方針からの変更**: `fallbackAttempted` / `fallbackSucceeded` 追加は別 phase に廆す）**
  - 当初の方針: `req.log` 呼び出しに 2 フィールド追加 + 救援成功時に `'summaly fallback rescued'` を出す
  - **変更**: 実装規模対観測コストが見合わないため deferral。`getResponseWithFallback` から Fastify ハンドラまで context を通す plumbing が `got.ts → general.ts → index.ts → req.log` の全レイヤ変更になる。代わりに既存の `error.category` フィルタ (`jq -c 'select(.err.category == "bot_blocked" or .err.category == "connection_dropped")'`) で観測可能と判断
  - phase11.6 (迂回候補ログ) で同種の観測ニーズに合流させる前提（fallback 救援統計 → 別 JSONL 書き出し）
- [x] **Step 9 — ドキュメント更新**
  - [docs/Library.md](../../docs/Library.md) に `fallbackUserAgent` / `fallbackRetryCategories` オプションを追記
  - [docs/SETUP.md](../../docs/SETUP.md) に `[scraping.fallback]` の運用説明を追加（fb 偽装の倫理面の選択も書く）
  - [docs/deploy-examples/README.md](../../docs/deploy-examples/README.md) を見直し、フォールバック設定例を追記
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased に
    - `enhance: デフォルト UA を Mozilla プレフィックス付きの複合 UA に変更（自己同定は維持）`
    - `feat: bot block 検出時に別 UA で 1 回リトライするフォールバック機構を追加（config.toml の [scraping.fallback] でオプトイン制御）`
- [x] **Step 10 — knowhow 記録**
  - `docs/knowhow/bot-block-ua-retry.md` を新設
    - 「`SummalyBot` 文字列の substring match でピンポイント弾く WAF が実在し、複合 UA では救えない」
    - 「`socket hang up` / `Empty reply from server` は got/Node.js が TCP/TLS 確立後に HTTP レスポンス前で切断されたときの典型シグニチャ」
    - 「リトライ UA に `facebookexternalhit/1.1` を採用するときの倫理判断と、config で差し替え可能にする設計」
    - 「IP block (rawchili 系) は UA 切り替えでは救えず、別レイヤ（プロキシ等）の射程」
- [x] **Step 11 — 品質ゲート**
  - `pnpm build && pnpm eslint && pnpm typecheck && pnpm test`
  - `bash .claude/tests/run-all.sh`
  - `addf-code-review-agent` でレビュー
  - `addf-contribution-agent` で ADD フレームワーク寄与候補を確認（`.claude/` `docs/knowhow/ADDF/` `templates/` を触らないなら通常スキップ判定）

## 完了条件 (Definition of Done)

- `categorizeError` が `socket hang up` / `EPIPE` / `Empty reply` を `connection_dropped` カテゴリに振り分ける
- デフォルト UA が `Mozilla/5.0 (compatible; SummalyBot/<ver>; +https://github.com/misskey-dev/summaly)` 形式に変わっている
- `summaly()` 関数経路で `fallbackUserAgent` を渡すと、bot block カテゴリのエラー時に別 UA で 1 回リトライされる
- Fastify モードでは `config.toml` の `[scraping.fallback]` でデフォルト ON にした状態で起動できる
- LRU キャッシュ HIT 時はフォールバックも含めて再リクエストしない
- pino ログに `fallbackAttempted` / `fallbackSucceeded` フィールドが追加される
- `docs/Library.md` / `docs/SETUP.md` / `config.example.toml` / `docs/deploy-examples/summaly-config.example.toml` がすべて更新されている
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る
- 実証データ取得サイト（`playing-games.com`、`wacoca.com`）に対して、フォールバック有効時に OGP が取得できる（手動検証）

## リスク・注意点

1. **fb 偽装の倫理**: フォールバック UA に `facebookexternalhit/1.1` を採用すること自体への抵抗感が運用者にあり得る。`config.toml` で差し替え可能にする設計でこの懸念を吸収する。デフォルトを `facebookexternalhit` にするか中立な `Mozilla/5.0 (compatible; LinkPreviewBot/1.0)` 等にするかは Plan 受け入れ時に判断
2. **既存テストの UA 完全一致 assert**: `DEFAULT_BOT_UA` を変えると `SummalyBot/${version}` で完全一致の assert が壊れる可能性。事前に grep して `toContain('SummalyBot/')` 形に書き直す
3. **総リクエスト 2 倍問題**: bot block 多発するサイトでは worst case 2 倍。LRU キャッシュと in-flight dedup で実運用ではほぼ問題にならないが、低頻度多種 URL の運用（プレビュー先がほぼ全て一発限り）の場合は負荷が読みにくい。`config.toml` の `enabled = false` で無効化する逃げ道は確保済み
4. **`socket hang up` を `network_error` に寄せる選択肢**: 新カテゴリ `connection_dropped` を作らず既存 `network_error` の正規表現に追加するだけの簡略案もあり得る。意味の精度は落ちるが実装は最小。ただし「リトライ対象カテゴリ」を選ぶときに `network_error` を全部入れると DNS 失敗でも 2 回叩くことになる（DNS 失敗は 2 回叩いても無駄）ので、`connection_dropped` を分離する方が筋がいい
5. **`ECONNRESET` の再分類**: 現状 `network_error` 配下の `ECONNRESET` を `connection_dropped` 側に動かすのは後方互換の点で軽微なリスク（既存運用者が `network_error` で監視している場合の見落とし）。CHANGELOG にカテゴリ移動を明記
6. **HEAD リクエスト経由のリトライ**: `summaly()` 初期 HEAD（[src/index.ts](../../src/index.ts) の `resolveRedirect()` 相当）でも同じ bot block に当たる可能性がある。フォールバックを HEAD にも適用するかは設計判断 → **適用する**（HEAD で 403 / socket hang up を返すサイト、特に `bsky.app` のように HEAD 自体を 404 にするサイト、が実在するため）
7. **テストの mock origin**: `socket hang up` を mock するには Node の `net.Server` で TCP は accept してから `socket.destroy()` する必要があり、Fastify では再現しにくい。`http.createServer((req, res) => { req.socket.destroy(); })` の薄い mock サーバを別途立てるか、`got` レベルで `nock` 等で `replyWithError('socket hang up')` する。後者の方がテスト軽量
8. **`opts.userAgent` 明示時の挙動**: ライブラリ利用者が `userAgent` を明示指定した場合、フォールバック UA はそれを尊重するか上書きするか。**指定された UA が 1 回目で使われ、リトライ時に `fallbackUserAgent` に切り替わる** が筋。「明示指定したのに勝手に変わるのは嫌」という意見もあり得るので、`fallbackUserAgent === undefined` でリトライ無効、を library の default 挙動として担保
9. **rawchili 系の IP block は救えない**: 本フェーズの射程外。次のステップとしては「専用プロキシ経由でリトライ」が考えられるが、運用コスト・倫理・SSRF 面で重く、別 phase で要検討（候補外で TODO に置かない）
