/**
 * 経路学習キャッシュの `scpaping()` 統合テスト (phase14 Step 2a)。
 *
 * - cache hit fast path: cache に登録された strategy で direct invoke される
 * - cache miss: 通常 4 段カスケード (既存挙動)
 * - hit 失敗時の `recordFailure` + cascade fallthrough
 * - strategy ゲート不通過 (config 未設定等) は cache 値を無視して fallthrough
 *
 * 注: phase14 Step 2a 範囲のため cascade tracking + recordSuccess on miss は対象外 (Step 2b)。
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import Summaly, { summaly } from '@/index.js';
import {
	DomainStrategyCache,
	getActiveCache,
	setActiveCache,
} from '@/utils/domain-strategy-cache.js';

const port = 3061; // phase4.1 / phase11.x の `3060` と被らないよう別ポート
const host = `http://localhost:${port}`;

let app: FastifyInstance | null = null;

beforeEach(() => {
	process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';
});

afterEach(async () => {
	process.env.SUMMALY_ALLOW_PRIVATE_IP = 'false';
	setActiveCache(undefined);
	if (app != null) {
		await app.close();
		app = null;
	}
});

describe('DomainStrategyCache scpaping 統合 (phase14 Step 2a)', () => {
	test('cache 未設定なら従来の cascade のみ (回帰テスト)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>noCache</title></head></html>');
		});
		await app.listen({ port });

		expect(getActiveCache()).toBeUndefined();
		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('noCache');
		expect(requestCount).toBe(1); // 1 段目で成功 → 1 リクエストのみ
	});

	test('cache hit (strategy=default) でも結果は同じ (fast path 経由)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fastPath</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		// 'localhost' を `default` strategy で登録 (= 1段目を直接呼ぶ)
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		const initialSuccessCount = cache.lookup(host)?.entry.successCount;
		expect(initialSuccessCount).toBe(1);

		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('fastPath');
		expect(requestCount).toBe(1);

		// fast path 成功で recordSuccess が呼ばれて successCount が増えている
		const after = cache.lookup(host)?.entry;
		expect(after?.successCount).toBe(2);
		expect(after?.consecutiveFailures).toBe(0);
	});

	test('cache hit が失敗すると recordFailure (phase18: challenger 不在で 1 attempt)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			reply.code(500).send('boom');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();

		// phase18: champion=default 500 → not final (origin_error は retryable) → hedge fire →
		// challengers 全 gate_failed (config 不在) → champion error throw → recordFailure
		const after = cache.lookup(host)?.entry;
		expect(after?.consecutiveFailures).toBe(1);
		// challenger が config 上使えないため champion 1 attempt のみ
		expect(requestCount).toBe(1);
	});

	test('strategy=fallback_ua が登録されていて fallbackUserAgent 未指定 → 別 challenger で勝ち、新 strategy 上書き (phase18)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fallthroughUa</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		// fallback_ua strategy を登録するが、SummalyOptions.fallbackUserAgent を渡さない
		// → champion gate_failed → hedge fire → default challenger で 200 → strategy 上書き
		cache.recordSuccess('localhost', 'fallback_ua');
		setActiveCache(cache);

		const before = cache.lookup(host)?.entry;
		expect(before?.successCount).toBe(1);

		const result = await summaly(host, { followRedirects: false, hedgedThresholdMs: 0 });
		expect(result.title).toBe('fallthroughUa');

		// phase18: gate_failed champion → hedge fire → default 経路勝ち → strategy = 'default' 上書き
		const after = cache.lookup(host)?.entry;
		expect(after?.strategy).toBe('default');
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.successCount).toBe(1); // 別 strategy へ切り替えなので新規カウント
	});

	test('strategy=proxy が登録されていて proxy config 無効 → 別 challenger で勝ち、新 strategy 上書き (phase18)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fallthrough</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		// proxy strategy を登録するが、SummalyOptions.proxyFallback を渡さない
		// → champion gate_failed → hedge fire → default 経路勝ち → strategy 上書き
		cache.recordSuccess('localhost', 'proxy');
		setActiveCache(cache);

		const before = cache.lookup(host)?.entry;
		expect(before?.successCount).toBe(1);

		const result = await summaly(host, { followRedirects: false, hedgedThresholdMs: 0 });
		expect(result.title).toBe('fallthrough');

		// phase18: gate_failed champion → hedge fire → default 経路勝ち → strategy = 'default' 上書き
		const after = cache.lookup(host)?.entry;
		expect(after?.strategy).toBe('default');
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.successCount).toBe(1);
	});

	test('cache miss + cascade default 成功 → 1-seg pathKey に default を記録 (Step 2b)', async () => {
		app = fastify();
		app.get('/foo/bar', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>cascadeRecord</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		setActiveCache(cache);

		// cache 空状態
		expect(cache.size).toBe(0);

		const result = await summaly(`${host}/foo/bar`, { followRedirects: false });
		expect(result.title).toBe('cascadeRecord');

		// cache miss → cascade success → 1-seg ('localhost/foo') に default を記録
		expect(cache.size).toBe(1);
		const hit = cache.lookup(`${host}/foo/bar`);
		expect(hit?.hitKey).toBe('localhost/foo');
		expect(hit?.entry.strategy).toBe('default');
		expect(hit?.entry.successCount).toBe(1);
	});

	test('cache miss + cascade default 成功 (host のみ URL) → host pathKey に default を記録', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>hostOnly</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		setActiveCache(cache);

		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('hostOnly');

		// path 無しのときは host のみ pathKey
		const hit = cache.lookup(host);
		expect(hit?.hitKey).toBe('localhost');
		expect(hit?.entry.strategy).toBe('default');
	});

	test('cache hit が成功 → 既存 strategy で recordSuccess (phase18 hedged race champion 単独勝ち)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/article/42', (_, reply) => {
			requestCount++;
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fastChampion</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		const result = await summaly(`${host}/article/42`, { followRedirects: false });
		expect(result.title).toBe('fastChampion');

		// phase18: champion = default が threshold 内に勝ち → hedge fire しない →
		// 1 attempt のみ + recordSuccess で successCount++、consecutiveFailures = 0 維持
		const hit = cache.lookup(`${host}/article/42`);
		expect(hit?.hitKey).toBe('localhost');
		expect(hit?.entry.strategy).toBe('default');
		expect(hit?.entry.consecutiveFailures).toBe(0);
		expect(hit?.entry.successCount).toBeGreaterThanOrEqual(2);
		expect(requestCount).toBe(1);
	});

	test('cache miss + cascade fail → 何も記録しない (recordFailure は cache miss 経路では呼ばれない)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.code(500).send('boom');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		setActiveCache(cache);

		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();

		// Step 2b 後半 仕様: cache miss + cascade fail → summaly() catch で recordFailure 呼ぶが、
		// recordKey は 1-seg ('localhost' = pathKeysOf の host のみ) で、対応する entry が
		// map に無いため recordFailure は no-op (DomainStrategyCache.recordFailure は existing == null で early return)。
		// 結果として cache は空のまま (= 「cache miss + cascade fail で entry を新規作成しない」設計)
		expect(cache.size).toBe(0);
	});

	test('Summary thin (HTTP 200 だが本文スカスカ) → recordFailure (Step 2b 後半)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			// title が hostname (= 'localhost') と同じになる構造で thin 判定発動
			return reply.send('<html><head><title>localhost</title></head></html>');
		});
		// favicon が無い (= thumbnail も null になる) ことで thin 判定が安定する
		app.get('/favicon.ico', (_, reply) => reply.status(404).send());
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		// 初期 entry: localhost → default (count=1, cf=0)
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		// HTTP は 200 で取れるが Summary は thin
		await summaly(host, { followRedirects: false });

		// recordFailure が呼ばれて consecutiveFailures が増える (HTTP 層では成功してたが Summary 層で thin)
		const after = cache.lookup(host)?.entry;
		expect(after?.consecutiveFailures).toBe(1);
		expect(after?.strategy).toBe('default'); // strategy は変わらない (failure record は strategy を触らない)
	});

	test('Summary thin が連続して閾値に達するとエントリ破棄 (連続 thin で invalidate)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>localhost</title></head></html>');
		});
		app.get('/favicon.ico', (_, reply) => reply.status(404).send());
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 3 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		// 3 回連続で Summary thin → recordFailure × 3 → 閾値到達でエントリ破棄
		await summaly(host, { followRedirects: false });
		expect(cache.lookup(host)?.entry.consecutiveFailures).toBe(1);
		await summaly(host, { followRedirects: false });
		expect(cache.lookup(host)?.entry.consecutiveFailures).toBe(2);
		await summaly(host, { followRedirects: false });
		expect(cache.size).toBe(0); // 破棄
	});

	test('throw at summaly() (HTTP 完全失敗) → recordFailure', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.code(500).send('boom');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();

		// HTTP throw → summaly() catch で recordFailure
		const after = cache.lookup(host)?.entry;
		expect(after?.consecutiveFailures).toBe(1);
	});

	test('cache miss + default UA bot block → fallback UA で成功 → fallback_ua を学習し、2 回目は fast path 直行', async () => {
		// シナリオ A の E2E 確認 (オーナー基準: 「他の優先経路にフォールバック → 2 回目以降 OK」)。
		// cascade のどの段で成功してもその strategy が tracker 経由で学習され、次回 fast path で
		// 直接呼ばれることを確認する。phase14 Step 2b 後半 で導入した tracker 機構の回帰防止が目的。
		app = fastify();
		let defaultUaRequests = 0;
		let fallbackUaRequests = 0;
		app.get('/', (req, reply) => {
			const ua = req.headers['user-agent'];
			if (typeof ua === 'string' && ua.includes('Twitterbot/1.0')) {
				fallbackUaRequests++;
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>fallbackOk</title></head></html>');
			}
			defaultUaRequests++;
			return reply.code(403).send('blocked');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		setActiveCache(cache);

		// 1 回目: cache miss → cascade default 失敗 (403 = bot_blocked) → fallback UA 成功
		const result1 = await summaly(host, {
			followRedirects: false,
			fallbackUserAgent: 'Twitterbot/1.0',
		});
		expect(result1.title).toBe('fallbackOk');
		expect(defaultUaRequests).toBe(1);
		expect(fallbackUaRequests).toBe(1);

		// entry が `fallback_ua` strategy で学習されている (tracker.value 経由で recordSuccess が呼ばれた証拠)
		const learned = cache.lookup(host);
		expect(learned?.hitKey).toBe('localhost');
		expect(learned?.entry.strategy).toBe('fallback_ua');
		expect(learned?.entry.successCount).toBe(1);
		expect(learned?.entry.consecutiveFailures).toBe(0);

		// 2 回目: cache hit → fast path fallback_ua 直行 (default UA は試行されない)
		const result2 = await summaly(host, {
			followRedirects: false,
			fallbackUserAgent: 'Twitterbot/1.0',
		});
		expect(result2.title).toBe('fallbackOk');
		expect(defaultUaRequests).toBe(1); // 増えない = fast path で default をスキップしている
		expect(fallbackUaRequests).toBe(2); // 増える = fast path で fallback UA を直接呼んでいる

		// fast path 成功で successCount++ (= 学習が累積している)
		const after = cache.lookup(host);
		expect(after?.entry.strategy).toBe('fallback_ua');
		expect(after?.entry.successCount).toBe(2);
	});

	test('閾値到達でエントリが破棄され、次回は cascade のみ', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			// 全てのリクエストを 500 で返す (fast path も cascade も失敗)
			reply.code(500).send('boom');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 2 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		// 1 回目: fast path 失敗 → recordFailure (consecutiveFailures=1) → cascade 失敗 → throw
		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();
		expect(cache.size).toBe(1);

		// 2 回目: fast path 失敗 → recordFailure (consecutiveFailures=2 >= threshold) → エントリ破棄 → cascade 失敗 → throw
		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();
		expect(cache.size).toBe(0);

		// 3 回目: cache 空 → cascade のみ (fast path が呼ばれない) → cascade 失敗 → throw
		const before = requestCount;
		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();
		// 3 回目はキャッシュなしなので cascade 1 段のみ実行される (= +1 リクエスト)
		// 1〜2 回目はそれぞれ fast path + cascade 1 段で +2 リクエストずつ
		expect(requestCount - before).toBe(1);
	});
});

describe('Fastify モードでの cache 自動インスタンス化 (phase14 Step 2b-4)', () => {
	test('domainStrategyCache.enabled = true で cache が自動生成される', async () => {
		// W-2 review feedback: 全テストで明示的に setActiveCache(undefined) してから始める (対称性)。
		// 外側 afterEach でも reset されているが、テスト読者が前提を直感的に把握できるよう冒頭に置く
		setActiveCache(undefined);
		const fastifyApp = fastify();
		const opts = { domainStrategyCache: { enabled: true } };
		await new Promise<void>((resolve, reject) => {
			Summaly(fastifyApp, opts, (err) => err != null ? reject(err) : resolve());
		});
		try {
			expect(getActiveCache()).toBeDefined();
		} finally {
			await fastifyApp.close();
		}
	});

	test('domainStrategyCache 未指定なら cache 生成されない (既存挙動維持)', async () => {
		setActiveCache(undefined);
		const fastifyApp = fastify();
		await new Promise<void>((resolve, reject) => {
			Summaly(fastifyApp, {}, (err) => err != null ? reject(err) : resolve());
		});
		try {
			expect(getActiveCache()).toBeUndefined();
		} finally {
			await fastifyApp.close();
		}
	});

	test('domainStrategyCache.enabled = false なら cache 生成されない', async () => {
		setActiveCache(undefined);
		const fastifyApp = fastify();
		const opts = { domainStrategyCache: { enabled: false } };
		await new Promise<void>((resolve, reject) => {
			Summaly(fastifyApp, opts, (err) => err != null ? reject(err) : resolve());
		});
		try {
			expect(getActiveCache()).toBeUndefined();
		} finally {
			await fastifyApp.close();
		}
	});

	test('bootstrapPath 未指定 + enabled=true → 同梱 bootstrap が自動ロードされる (Step 3)', async () => {
		setActiveCache(undefined);
		const fastifyApp = fastify();
		const opts = { domainStrategyCache: { enabled: true } };
		await new Promise<void>((resolve, reject) => {
			Summaly(fastifyApp, opts, (err) => err != null ? reject(err) : resolve());
		});
		try {
			const cache = getActiveCache();
			expect(cache).toBeDefined();
			// bootstrap で yodobashi.com → curl_cffi が登録されている
			const yodobashi = cache?.lookup('https://yodobashi.com/test')?.entry;
			expect(yodobashi?.strategy).toBe('curl_cffi');
			// sqex → proxy
			const sqex = cache?.lookup('https://store.jp.square-enix.com/item')?.entry;
			expect(sqex?.strategy).toBe('proxy');
		} finally {
			await fastifyApp.close();
		}
	});

	test('domainStrategyCache の各オプションが DomainStrategyCache に渡される (path 系含む)', async () => {
		// W-3 review feedback: `bootstrapPath` / `runtimePath` も含めて全フィールドの伝搬を網羅する
		setActiveCache(undefined);
		const fastifyApp = fastify();
		const opts = {
			domainStrategyCache: {
				enabled: true,
				maxEntries: 1234,
				bootstrapPath: '/tmp/bootstrap-test.jsonl', // ファイル不在でもコンストラクタは error にしない (ENOENT 受容)
				runtimePath: '/tmp/runtime-test.jsonl',
				consecutiveFailureThreshold: 7,
				compactionThreshold: 500,
			},
		};
		await new Promise<void>((resolve, reject) => {
			Summaly(fastifyApp, opts, (err) => err != null ? reject(err) : resolve());
		});
		try {
			const cache = getActiveCache();
			expect(cache).toBeDefined();
			expect(cache?.maxEntries).toBe(1234);
			expect(cache?.bootstrapPath).toBe('/tmp/bootstrap-test.jsonl');
			expect(cache?.runtimePath).toBe('/tmp/runtime-test.jsonl');
			expect(cache?.consecutiveFailureThreshold).toBe(7);
			expect(cache?.compactionThreshold).toBe(500);
		} finally {
			await fastifyApp.close();
		}
	});
});
