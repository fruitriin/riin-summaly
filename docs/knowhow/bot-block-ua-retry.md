# Bot block 対策（複合 UA + フォールバック UA リトライ）

> phase11.9 で導入。`SummalyBot` 文字列を WAF が検知して 黙殺するサイトを救援するための知見。

## 課題

`SummalyBot/<ver>` を名乗ると **TCP/TLS は通すが HTTP レスポンスを返さず黙って RST する** WAF が実在する（`socket hang up` シグニチャ）。`parseFailureLog` には残るが、UA 切り替えで救えるか否かを区別する仕組みが phase10.1 までは無かった。

## 実証データ（2026-05-05 計測）

| サイト | `SummalyBot/...` | `Mozilla/5.0` ブラウザ | `Twitterbot/1.0` | `facebookexternalhit/1.1` | `Mozilla/5.0 (compatible; SummalyBot/x.y.z)` |
|---|---|---|---|---|---|
| `playing-games.com` | ❌ socket hang up | ✅ 200 | ✅ 200 | ✅ 200 | ❌ socket hang up |
| `wacoca.com` | ❌ socket hang up | ⚠️ 404 (URL 自体無効) | ⚠️ 404 | ⚠️ 404 | ❌ socket hang up |
| `rawchili.com` | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up | ❌ socket hang up |

### わかったこと

1. `playing-games.com` / `wacoca.com` は **UA に `SummalyBot` という文字列が含まれているとピンポイントで弾く** WAF を入れている。`Twitterbot` / `Discordbot` / `facebookexternalhit` 等の有名どころの share-link bot UA は許可している
2. **Mozilla プレフィックスを付けただけ（複合 UA）では救えない**。`SummalyBot` 文字列の substring match で弾かれているため、自己同定する限りこのサイト群には届かない
3. `rawchili.com` はどの UA でも沈黙。**IP-based block**（特定 ASN / Linode 互いの IP レンジ等）と推察され、UA レイヤでは救えない（プロキシ経由が必要）
4. 救える比率: 上記 3 サイトのうち **2/3 (67%)** は UA 切り替えで救援可能

## 設計の決め手

### 1. デフォルト UA を複合化（Slackbot / LinkedInBot 流）

```
Mozilla/5.0 (compatible; SummalyBot/<ver>; +https://github.com/fruitriin/riin-summaly)
```

- 「Mozilla プレフィックス必須」タイプの WAF を底上げで通す（実証データには出ない種類だが世の中の件数として多いと推察）
- 自己同定（`SummalyBot/<ver>` + URL）は維持
- 副作用: 既存の bot 検知ロジックが `SummalyBot` 文字列を期待しているなら互換性は保たれる
- `+https://...` の自己説明 URL は cookie-less 識別情報として扱ってもらいやすい
- URL は **riin-summaly fork のリポジトリ** を指す（運用者が問い合わせ可能な場所）

### 2. フォールバック UA リトライ

`scpaping()` のリクエストが **「リトライ価値ありの bot block シグナル」** で失敗したら、**`SummalyBot` 文字列を含まない UA** で 1 回だけ再試行する。

#### リトライ対象シグナルの判定

phase11.2 の `categorizeError` を拡張して新カテゴリを追加:

- **`connection_dropped`**: TCP/TLS は通ったが HTTP レスポンスを返さず切断 (`socket hang up`, `EPIPE`, `ECONNRESET`, `Empty reply`)

`ECONNRESET` は phase11.2 までは `network_error` 配下だったが、意味的に `socket hang up` とほぼ同じなので `connection_dropped` 側に再分類。**判定優先順位は `connection_dropped` を `network_error` より前に置く**（`ECONNRESET` が両方にマッチするため）。

リトライするカテゴリ:
- `bot_blocked` (4xx — 401/403/429 が典型)
- `connection_dropped` (新規)

`network_error` (DNS 失敗等) はリトライ対象に含めない。何度叩いても無駄なので。

#### リトライ UA

デフォルトは **`facebookexternalhit/1.1`**。share link を発行している多くのサイトが OGP 取得用途として明示的に許可しているため。

倫理的に気になる場合の安全弁として **config で差し替え可能**。`Mozilla/5.0 (compatible; LinkPreviewBot/1.0)` 等の中立な UA に変更可。

#### 実装場所

`getResponse()` の **外側** に薄いラッパ `getResponseWithFallback(args, fallback)` を作る。`scpaping()` から呼ぶ。

- 1 度目: 通常 UA (`opts.userAgent ?? DEFAULT_BOT_UA`) で `getResponse()`
- 失敗 + カテゴリが `fallback.categories` に含まれれば、UA だけ差し替えて 2 度目
- 2 度目失敗時は **2 回目のエラー（最後に踏んだエラー）を throw**
- リトライ回数は常に最大 1 回。指数バックオフ無し

```ts
export async function getResponseWithFallback(
	args: GotOptions,
	fallback?: FallbackUaConfig,
): Promise<Got.Response<string>> {
	if (fallback == null) return await getResponse(args);
	try {
		return await getResponse(args);
	} catch (firstErr) {
		const category = categorizeError(/* ... */);
		if (!fallback.categories.includes(category)) throw firstErr;
		const retryArgs = { ...args, headers: { ...args.headers, 'user-agent': fallback.userAgent } };
		return await getResponse(retryArgs);
	}
}
```

### 3. 設定スキーマ（TOML）

```toml
[scraping.fallback]
enabled = true
userAgent = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
categories = ["bot_blocked", "connection_dropped"]
```

`[scraping.fallback]` を新セクションにしたのは、scrape 挙動を制御する設定として `[summaly]` `[summaly.cache]` `[summaly.pdf]` と同じトップレベルにあるべきだから。将来「`[scraping.retry]` (一般リトライ)」のような兄弟セクションを足しやすい構造。

### 4. ライブラリ利用者向け API

`SummalyOptions` に `fallbackUserAgent` / `fallbackRetryCategories` を追加。デフォルト挙動の互換性:

- `fallbackUserAgent` 未指定（または空文字列） → **既存挙動（リトライなし）**
- Fastify モードでは `config.toml` から `summaly()` 呼び出しに自動注入

これによりライブラリ呼び出しは **明示的にオプトイン**、Fastify 運用は **設定でオプトアウト可能だがデフォルト ON**、という分離になる。

## 落とし穴

### `ECONNRESET` の再分類は後方互換の点で軽微なリスク

phase11.2 までは `ECONNRESET` は `network_error` 配下だった。これを `connection_dropped` 側に動かしたため、既存運用者が `network_error` で監視している場合の見落としに注意。CHANGELOG にカテゴリ移動を明記。

### HEAD リクエスト経由の bot block

`summaly()` 初期 HEAD（`resolveRedirect()`）でも同じ bot block に当たる可能性がある。本フェーズでは **scpaping のみフォールバック適用**、HEAD は既存挙動のまま。HEAD 自体を 404 にするサイト（`bsky.app` 等）は `bluesky` プラグインで個別対処済み。

### `opts.userAgent` 明示時の挙動

ライブラリ利用者が `userAgent` を明示指定した場合、フォールバック UA はそれを尊重するか上書きするか。**指定された UA が 1 回目で使われ、リトライ時に `fallbackUserAgent` に切り替わる** 設計。「明示指定したのに勝手に変わるのは嫌」という意見もあり得るので、`fallbackUserAgent === undefined` でリトライ無効、を library default 挙動として担保。

### IP block は救えない

`rawchili.com` 系のように UA を変えても全く応答しないサイトは UA レイヤでは救えない。**専用プロキシ経由でリトライ** が次のステップだが、運用コスト・倫理・SSRF 面で重く、本フェーズの射程外。

### 総リクエスト 2 倍問題

bot block 多発するサイトでは worst case 2 倍。LRU キャッシュと in-flight dedup で実運用ではほぼ問題にならないが、低頻度多種 URL の運用（プレビュー先がほぼ全て一発限り）の場合は負荷が読みにくい。`config.toml` の `enabled = false` で無効化する逃げ道を確保。

## テストの mock 戦略

`fastify` モックサーバ + `followRedirects: false` で観測する。`followRedirects: true`（デフォルト）だと `summaly()` が HEAD/GET probe を最初に行うため、attempts カウントが 2-3 増えて assertion が複雑になる。**`followRedirects: false` を明示してリトライ機構の挙動だけを切り出す** のが綺麗。

## 関連

- [plugin-infrastructure-patterns.md](plugin-infrastructure-patterns.md) — Cloudflare 配下サイトの公式 JSON API 直叩きパターン（npmjs プラグインで採用、こちらは UA 切り替えと別レイヤの救援策）
- [observability-parse-failure-log.md](observability-parse-failure-log.md) — パース失敗ログ集約パターン（救援できなかった残り 1/3 を発見する基盤）
- [docs/plans/phase11.9-bot-block-ua-retry.md](../plans/phase11.9-bot-block-ua-retry.md)
- [src/utils/got.ts](../../src/utils/got.ts) `getResponseWithFallback` / `DEFAULT_BOT_UA` / `DEFAULT_FALLBACK_UA`
- [src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) `connection_dropped` カテゴリ
