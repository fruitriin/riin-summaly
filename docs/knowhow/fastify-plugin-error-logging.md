# Fastify プラグイン内のエラーログ出力パターン

> phase11.8 で導入。Fastify プラグインで `try/catch` した非 throw エラーは `setErrorHandler` に飛ばないため、観測したいなら明示的に `req.log` を呼ぶ必要がある、という落とし穴の整理。

## 背景: なぜ `setErrorHandler` だけでは足りないのか

Fastify には `app.setErrorHandler((err, req, reply) => { ... })` で全エラーをまとめてログ・整形するパターンがあるが、これは **ハンドラ内で throw されたエラーにのみ発動**する。

summaly Fastify プラグインのように、ハンドラ内で `try/catch` してから `reply.status(500).send({ error })` を **return している** ケースは throw が起きていないため `setErrorHandler` には飛ばない。

```ts
fastify.get('/', async (req, reply) => {
	try {
		const summary = await summaly(url, opts);
		return summary;
	} catch (e) {
		// ↓ throw せずに return しているので setErrorHandler には飛ばない
		reply.status(500);
		return { error: serializableError(e) };
	}
});
```

結果として、500 をクライアントに返すだけで **サーバ側のログには何も出ない無音状態**になる。journalctl / pm2 logs / docker logs を見ても 500 の原因がわからない。

## 対策: `req.log` を catch ブロックで明示的に呼ぶ

```ts
catch (e) {
	const level = chooseLogLevel(e);  // 'info' | 'warn' | 'error'
	const statusCode = e instanceof StatusError ? e.statusCode : undefined;
	req.log[level](
		{ err: e, url: sanitizeUrlForLog(url), lang, statusCode },
		'summaly error',
	);
	return { kind: 'error', error: serializableError(e) };
}
```

ポイント:
- `req.log` は Fastify のリクエスト単位の logger（pino インスタンス）。`reqId` 等が自動付与される
- 第 1 引数は構造化フィールド (`{ err, ...context }`)、第 2 引数はメッセージ
- **`err` を手動シリアライズする** (`{ name, message, stack, statusCode? }` のみ): pino のデフォルト `errSerializer` は got の `RequestError.options.url` のような内部プロパティも列挙して出力するため、**スクレイピング先 URL（クエリ含む）が err 経由で漏れる**経路がある。`name` / `message` / `stack` / `statusCode` だけを明示的に渡すことで漏洩経路を遮断できる

## ログレベルの分け方

`info` / `warn` / `error` の 3 段階で運用上のフィルタリングを可能にする:

| level | 用途 | journalctl filter |
|:--|:--|:--|
| `info` | 普通のエラー (404 / 403 / 429) | `--priority=warning` で除外 |
| `warn` | 気にすべき (5xx / timeout / SSRF block / 型 reject) | `--priority=warning -f` で監視 |
| `error` | 想定外 (パーサ落ち、catch-all) | 即対応 |

判定ロジックを `chooseLogLevel(e)` に集約すれば、エラーカテゴリ enum (`SummalyErrorCategory`) との整合性も担保できる。

## URL のサニタイズ

URL をそのままログに出すと **クエリ文字列に含まれるトークン・セッション ID 等の PII** が漏れる。`sanitizeUrlForLog(url)` で `${origin}${pathname}` だけに切り詰める。

```ts
sanitizeUrlForLog('https://example.com/path?token=secret')
// → 'https://example.com/path'
```

非 http(s) スキーム (`data:` / `javascript:` 等) は `${protocol}[sanitized]` に置換してガベージ文字列の混入を防ぐ。

## スパム抑制

高頻度のエラーで journalctl / Loki が膨れる懸念は、以下の 3 段で抑える:

1. **MISS 経路でしかログを出さない** — LRU キャッシュ HIT / dedup HIT は重複ログ無し
2. **`cacheErrorMaxAge` (デフォルト 1 時間) の LRU キャッシュ TTL の間は同 URL の再ログ無し**
3. **`info` レベルに落とした 4xx は priority filter で除外可能**

これでデフォルト運用ではスパムにならない。

## セーフティネット

プラグイン外（404 ハンドラ未登録 / register 失敗 / `setErrorHandler` の手前で throw が抜けた等）の想定外エラーを拾うため、`bin/summaly-server.ts` 等のアプリケーション初期化箇所に `setErrorHandler` を追加する:

```ts
const app = Fastify({ logger: true });
app.setErrorHandler((err, req, reply) => {
	req.log.error({ err, url: req.url }, 'unhandled fastify error');
	reply.status(500).send({ error: { name: 'InternalServerError', message: 'unhandled error' } });
});
```

これは「実用上はほぼ通らないが、通った時に観測できる」セーフティ。

## テストでの mock pino

vitest で pino logger をどこまで本物で回すかは設計次第。最小限であれば次のように `info` / `warn` / `error` 等のメソッドが呼ばれた回数と引数を記録する自前 mock で十分:

```ts
function buildMockLogger() {
	const calls: { level: string; data: Record<string, unknown>; msg: string }[] = [];
	const recorder = (level: string) => (data: Record<string, unknown>, msg: string) => {
		calls.push({ level, data, msg });
	};
	const inst: Record<string, unknown> = {
		level: 'info',
		fatal: recorder('fatal'),
		error: recorder('error'),
		warn: recorder('warn'),
		info: recorder('info'),
		debug: recorder('debug'),
		trace: recorder('trace'),
		silent: () => {},
	};
	inst.child = () => inst;
	return { logger: inst as never, calls };
}

const { logger, calls } = buildMockLogger();
const app = fastify({ loggerInstance: logger });
```

`Fastify` の `loggerInstance` オプションに渡せる pino 互換オブジェクトの型は厳しく、`as never` キャストが必要になることがある。

## 参考

- [phase11.8 Plan](../plans/phase11.8-fastify-error-logging.md)
- [src/utils/log-level.ts](../../src/utils/log-level.ts) — `chooseLogLevel` 実装
- [pino API](https://github.com/pinojs/pino/blob/main/docs/api.md#errorobject-args) — `err` シリアライザ
