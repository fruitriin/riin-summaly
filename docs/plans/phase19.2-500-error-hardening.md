# phase19.2 — 本番 500 エラーの根絶 (oEmbed html 欠落 / URL parse 例外) + エラーレベル分類の精緻化

## 背景 — 本番 256 時間分 (約 10.6 日) の journal ログ分析結果

本番 Vultr の journald から書き出した 2026-07-18〜07-29 のログ (314,869 行、うち pino JSON 314,849 行) を集計した。
level 50 (error) は **308 件**で、内訳は以下の 3 群に分かれる:

| 群 | 件数 | 割合 | 原因 | 対処 |
|---|---:|---:|---|---|
| **Bug A**: `Cannot read properties of undefined (reading 'startsWith')` | 199 | 65% | `getOEmbedPlayer` が `body.html` の存在チェックなしに `.startsWith()` を呼ぶ | Step 1 |
| **Bug B**: `TypeError: Invalid URL` | 6 | 2% | `parseGeneral` L337 の `new URL(image, url.href)` が壊れた og:image で throw | Step 2 |
| **外部要因ノイズ**: TLS 証明書エラー 44 / curl_cffi HTTP/2 切断 42 / EPROTO 5 / リダイレクトループ 2 / その他 10 | 103 | 33% | `categorizeError` にパターンが無く `unknown` → `chooseLogLevel` が error 扱い | Step 3 |

> **ログ加工の再現手順** (journalctl 由来ファイルは systemd の再起動メッセージ等の非 JSON 行が混ざり `jq` が parse error になる):
> ```bash
> grep '^{' jounallog-err.log > clean.ndjson   # 非 JSON 行 (20 行) を除去してから jq に渡す
> jq -r 'select(.level == 50) | .err.message' clean.ndjson | sort | uniq -c | sort -rn
> ```

### Bug A の詳細 (最優先)

[src/general.ts](../../src/general.ts) L47:

```ts
if (!body.html.startsWith('<iframe ') || !body.html.endsWith('</iframe>')) {
```

L42 のバリデーションは `body.version` / `body.type` のみで **`body.html` が string である保証がない**。
`html` フィールドを持たない (または非 string の) oEmbed JSON を返すサイトで TypeError → 500。

発生ドメイン (256h 実測): `fixupx.com` 154 件 / `unityroom.com` 30 件 / `fxtwitter.com` 11 件 / `tales.note.com` 4 件。
fixupx / fxtwitter は Misskey ユーザーが X の代替プレビューとして貼る頻出ドメインであり、ユーザー影響が大きい。

### Bug B の詳細

`parseGeneral` 内で HTML の属性値をそのまま `new URL()` に渡す箇所が 3 つあり、いずれも壊れた値で throw する:

- L337: `new URL(image, url.href)` — og:image 等 (**実測 6 件の 500**。jumpsq.shueisha.co.jp / en.irna.ir 等)
- L72: `new URL(url)` — oEmbed iframe の `src` 属性 (`getOEmbedPlayer` 内、実測ゼロだが同クラス)
- L398: `new URL(favicon, url.href)` — favicon href (実測ゼロだが同クラス)

なお L24 は既に try/catch ガード済み (このパターンを踏襲する)。

### 外部要因ノイズの詳細

以下は**取得先サイト側の問題**であり summaly のバグではないが、`categorizeError` が `unknown` を返すため
`chooseLogLevel` の「想定外 = error」に落ちて error レベルで記録され、真のバグ (Bug A/B) の観測を阻害している:

| メッセージパターン | 件数 | あるべきカテゴリ |
|---|---:|---|
| `unable to verify the first certificate` / `certificate has expired` / `self-signed certificate` / `unable to get local issuer certificate` / `Hostname/IP does not match certificate's altnames` | 44 | `tls_error` (新設) |
| `curl_cffi (network): ... HTTP/2 stream ... INTERNAL_ERROR` | 42 | `connection_dropped` (yodobashi 型 TLS 層 bot 切断のシグネチャ、[docs/knowhow/curl-cffi-tls-impersonation.md](../knowhow/curl-cffi-tls-impersonation.md) 参照) |
| `write EPROTO ... SSL routines` / `Client network socket disconnected before secure TLS connection` | 7 | `tls_error` |
| `Redirected 10 times. Aborting.` | 2 | `redirect_loop` (新設) or `origin_error` に丸める |
| `fetch failed` / `incorrect header check` / message 空の `RequestError` | 6 | `network_error` |

---

## ゴール

1. Bug A / Bug B を修正し、**summaly 自身に起因する 500 をゼロにする** (oEmbed / メタ URL が壊れていても graceful degradation で `null` フォールバック)
2. 外部要因のエラーを categorize して warn に降格し、**error レベル = 真のバグ** という観測規約を回復する

## 非ゴール

- fixupx.com 等の専用プラグイン追加 (Bug A 修正で general パスの player 拡張が正しく諦められれば OGP ベースの card は出る。player が欲しければ別 phase)
- `tls_error` サイトの救援 (証明書が壊れているのはサイト側の問題。preview 不能が正しい)

---

## 実装ステップ

### Step 1: Bug A 修正 — `getOEmbedPlayer` の `body.html` 型ガード (S) — 完了

- [x] [src/general.ts](../../src/general.ts) の well-formed 判定に `typeof body.html !== 'string'` を追加
- [x] テスト: `test/oembed/invalid/` に `oembed-no-html.json` / `oembed-html-not-string.json` を追加
  (invalid/ ディレクトリは自動列挙で `player.url === null` を検証する構造のためフィクスチャ追加のみで回帰テストになる)
- [x] 回帰確認: 既存の oEmbed テスト含む 729 件全パス

### Step 2: Bug B 修正 — `parseGeneral` 内 URL 解決の安全化 (S) — 完了

- [x] safe URL ヘルパ `tryResolveUrl(href, base)` を追加 (既存 try/catch パターンの関数化)
- [x] image (og:image 等) / favicon (getIcon) の 2 箇所を置き換え。parse 失敗時は該当フィールド null で処理続行
  - **方針からの変更**: oEmbed iframe src (旧 L72) は実装時に確認したところ**既に try/catch ガード済み**だったため対象外 (Plan の記載が過剰だった)。置き換えは実質 2 箇所
- [x] テスト: `og:image` / favicon href に `https://` (不正 URL) を持つ HTML で 500 にならず null になることを検証 (2 件追加)

### Step 3: `categorizeError` の外部要因パターン追加 (S〜M) — 完了

- [x] `SummalyErrorCategory` に `tls_error` を追加 (`redirect_loop` は件数 2 のため `origin_error` に丸めた)
- [x] [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) `categorizeError` にパターン追加 (メッセージ高シグナル先の既存原則維持)
  - **方針からの変更 (重要)**: Plan は EPROTO / SSL routines / secure TLS connection を `tls_error` に含める案だったが、
    これらは**サイト側が当方の TLS handshake を拒否する bot block シグネチャ** (yodobashi 型、curl_cffi の TLS
    フィンガープリント偽装で救援可能) なので `connection_dropped` に振り分けた。`tls_error` は**証明書検証失敗**
    (Node のメッセージはすべて "certificate" を含む) 専用 = どの経路でも救えない決定的失敗。この区別を誤ると
    TLS 層 bot block サイトの hedge 救援経路を殺すところだった
  - `/certificate/i` → `tls_error` (EPROTO より先に判定。`certificate verify failed` は両方にマッチするが証明書問題側に寄せる)
  - `/EPROTO|SSL routines|secure TLS connection|HTTP\/2 stream \d+ was not closed cleanly/i` → `connection_dropped`
  - `/Redirected \d+ times/i` → `origin_error`、`/fetch failed|incorrect header check/i` → `network_error`
  - message 空の `RequestError` → `network_error` (message ありの未知 RequestError は新パターン発見のため unknown 維持)
- [x] `LOG_LEVEL_BY_CATEGORY` に `tls_error: 'warn'` 追加 (`Record` 型なので網羅漏れは typecheck が検出)
- [x] `FILTERED_CATEGORIES` に `tls_error` 追加 (プラグインで救えない類型)
- [x] ~~**`bin/config-loader.ts` の `VALID_ERROR_CATEGORIES` との手動同期を忘れない**~~ **(方針からの変更)**: `VALID_ERROR_CATEGORIES` は phase16.3/18.1 の `categories` TOML キー撤廃と同時に消滅済みで、現行コードベースに存在しないため本項目は対象外 (実装時 grep + レビュー agent の裏取りで確認)
- [x] `HEDGED_FINAL_CATEGORIES` への対応 — **方針からの変更**: Plan は「含めないことを確認」だったが、証明書検証は
  got / CF Workers / curl_cffi のどの経路でも行われ hedge fire が全経路無駄弾になるため、`tls_error` を**追加**して
  hedge fire skip 対象にした (レビュー agent も正しい設計判断と追認)。`DEFAULT_FALLBACK_RETRY_CATEGORIES` は変更なし
  (phase18 以降 dead field のため挙動影響なし、誤解防止コメントを付記)
- [x] テスト: 本番実測メッセージでパターン → カテゴリ (8 テスト) + カテゴリ → ログレベル (2 テスト) を追加
- [x] レビュー S-3 (isFinalError への tls_error 直接テスト) は**スキップ判断**: `isFinalError` は非 export で、既存カテゴリも
  「カテゴリ単体テスト + hedge 機構テストは別レイヤ」の慣行に沿っており、テストのためだけの export 追加は見送り

### Step 4: ドキュメント突き合わせ + 品質ゲート (S) — 完了

- [x] docs/Library.md のカテゴリ一覧に `tls_error` 追記 + `connection_dropped` の典型例を拡充
- [x] CHANGELOG (unreleased): fix (general) + enhance (error category) の 2 項目を記載
- [x] `config.example.toml` / `docs/deploy-examples/summaly-config.example.toml`: カテゴリ列挙なしを確認、変更不要。
  docs/SETUP.md L193-235 の旧 cascade 記述は既存負債 phase16.5 の範囲のため本 phase では触れない
- [x] `pnpm build` / `pnpm eslint` / `pnpm typecheck` / `pnpm test` (729 件) + `bash .claude/tests/run-all.sh` 全パス
- [x] `addf-code-review-agent` レビュー: Critical 0 / Warning 2 (進捗ドキュメント同期・Plan 追記 → 対応済) /
  Suggestion 3 (S-1 knowhow 記録で対応、S-2 dead field コメント追加済、S-3 スキップ判断を Step 3 に記録)

---

## 検証 (本番デプロイ後、運用者範囲)

- デプロイ後に `journalctl` で level 50 を監視し、`fixupx.com` URL で error が出ないこと・card preview が返ることを確認:
  ```bash
  curl 'http://localhost:PORT/?url=https://fixupx.com/i/status/2082088965578899860'
  ```
- 1 週間後に再度 level 50 を集計し、残存 error が真のバグのみになっていることを確認

## サイズ見積もり

S〜M (AI 実装で 1 セッション内。Step 1+2 は数行の修正 + テスト、Step 3 がカテゴリ同期箇所の確認で最も手間)
