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
import { summaly } from '@/index.js';
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

	test('cache hit が失敗すると recordFailure + cascade fallthrough', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			// 1 リクエスト目 (fast path) は 500 エラー、以降 (cascade) も 500 を返す
			// → 両方失敗で cascade も throw、recordFailure が呼ばれることを確認
			reply.code(500).send('boom');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		await expect(summaly(host, { followRedirects: false })).rejects.toThrow();

		// fast path が失敗 → recordFailure で consecutiveFailures が 1 増える
		const after = cache.lookup(host)?.entry;
		expect(after?.consecutiveFailures).toBe(1);
		// cascade も同じレスポンスで失敗するため 2 リクエストを試みる (fast path + cascade 1段目)
		expect(requestCount).toBeGreaterThanOrEqual(2);
	});

	test('cache hit + fast path 失敗 → cascade で成功するケース (一時障害想定)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/', (_, reply) => {
			requestCount++;
			if (requestCount === 1) {
				// 1 つ目の HTTP リクエスト (= fast path) のみ 500、2 つ目以降 (= cascade) は正常応答。
				// 「fast path で失敗 → recordFailure → 通常カスケードで取れる」ケースを再現する
				reply.code(500).send('boom');
				return;
			}
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>recovered</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('recovered');

		// Step 2b 後半 仕様: fast path 失敗そのものは recordFailure しない (transient とみなす)。
		// cascade default success → summaly() レイヤで recordSuccess(hitKey, strategy=default) →
		// 既存 strategy と同じため successCount++、consecutiveFailures は元から 0 で変わらず。
		const after = cache.lookup(host)?.entry;
		expect(after?.strategy).toBe('default');
		expect(after?.consecutiveFailures).toBe(0); // 元から 0、fast path 失敗を記録しない設計
		expect(after?.successCount).toBeGreaterThanOrEqual(2); // 初期 1 + cascade success 1
	});

	test('strategy=fallback_ua が登録されていても fallbackUserAgent 未指定なら fallthrough (S-1)', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fallthroughUa</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		// fallback_ua strategy を登録するが、SummalyOptions.fallbackUserAgent を渡さない
		// → fast path のゲート不通過 → recordSuccess も recordFailure も呼ばれない (中立)
		cache.recordSuccess('localhost', 'fallback_ua');
		setActiveCache(cache);

		const before = cache.lookup(host)?.entry;
		expect(before?.successCount).toBe(1);

		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('fallthroughUa');

		// strategy ゲート不通過なのでカウンタは変化しない (failure 扱いではない)
		const after = cache.lookup(host)?.entry;
		expect(after?.successCount).toBe(1);
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.strategy).toBe('fallback_ua');
	});

	test('strategy=proxy が登録されていても proxy config 無効なら fallthrough', async () => {
		app = fastify();
		app.get('/', (_, reply) => {
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>fallthrough</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache();
		// proxy strategy を登録するが、SummalyOptions.proxyFallback を渡さない
		// → fast path のゲート不通過 → recordSuccess も recordFailure も呼ばれない (= 中立)
		cache.recordSuccess('localhost', 'proxy');
		setActiveCache(cache);

		const before = cache.lookup(host)?.entry;
		expect(before?.successCount).toBe(1);

		const result = await summaly(host, { followRedirects: false });
		expect(result.title).toBe('fallthrough');

		// strategy ゲート不通過なのでカウンタは変化しない (失敗ではないので consecutiveFailures も増やさない)
		const after = cache.lookup(host)?.entry;
		expect(after?.successCount).toBe(1);
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.strategy).toBe('proxy');
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

	test('cache hit fail + cascade success → hitKey に新 strategy を上書き記録 (Step 2b)', async () => {
		app = fastify();
		let requestCount = 0;
		app.get('/article/42', (_, reply) => {
			requestCount++;
			if (requestCount === 1) {
				// fast path のみ失敗
				reply.code(500).send('boom');
				return;
			}
			reply.header('content-type', 'text/html');
			return reply.send('<html><head><title>recovered</title></head></html>');
		});
		await app.listen({ port });

		const cache = new DomainStrategyCache({ consecutiveFailureThreshold: 5 });
		cache.recordSuccess('localhost', 'default');
		setActiveCache(cache);

		const result = await summaly(`${host}/article/42`, { followRedirects: false });
		expect(result.title).toBe('recovered');

		// Step 2b 後半 仕様: fast path 失敗を recordFailure しない。cascade success で
		// hitKey に新 strategy を上書き → 既存 strategy と同じ ('default') なので count++ + cf=0 維持
		const hit = cache.lookup(`${host}/article/42`);
		expect(hit?.hitKey).toBe('localhost');
		expect(hit?.entry.strategy).toBe('default');
		expect(hit?.entry.consecutiveFailures).toBe(0); // 元から 0
		expect(hit?.entry.successCount).toBeGreaterThanOrEqual(2); // 初期登録 1 + cascade success 1
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
