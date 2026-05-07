/**
 * src/utils/proxy-fallback.ts の単体テスト + 統合テスト (phase12.1)。
 *
 * Worker の動作は Node の `http.createServer` でモックする。Miniflare は重く、
 * fetch 透過 + HMAC 検証の挙動だけ確認できれば十分。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import {
	matchesDomain,
	generateHmacSignature,
	getResponseWithProxyFallback,
	resolveProxySecret,
	type ProxyFallbackConfig,
} from '@/utils/proxy-fallback.js';
import type { GotOptions } from '@/utils/got.js';

describe('matchesDomain', () => {
	test('完全一致は通る', () => {
		expect(matchesDomain('amazon.co.jp', ['amazon.co.jp'])).toBe(true);
	});

	test('サブドメインは通る (suffix-match)', () => {
		expect(matchesDomain('www.amazon.co.jp', ['amazon.co.jp'])).toBe(true);
		expect(matchesDomain('a.b.amazon.co.jp', ['amazon.co.jp'])).toBe(true);
	});

	test('境界違いの suffix は通らない (sibling)', () => {
		expect(matchesDomain('evil-amazon.co.jp', ['amazon.co.jp'])).toBe(false);
		expect(matchesDomain('amazonbad.co.jp', ['amazon.co.jp'])).toBe(false);
	});

	test('別ドメインは通らない', () => {
		expect(matchesDomain('example.com', ['amazon.co.jp'])).toBe(false);
	});

	test('複数 allowlist の OR', () => {
		expect(matchesDomain('amazon.com', ['amazon.co.jp', 'amazon.com'])).toBe(true);
		expect(matchesDomain('www.amazon.com', ['amazon.co.jp', 'amazon.com'])).toBe(true);
	});

	test('大小文字を無視する', () => {
		expect(matchesDomain('AMAZON.CO.JP', ['amazon.co.jp'])).toBe(true);
		expect(matchesDomain('amazon.co.jp', ['AMAZON.CO.JP'])).toBe(true);
	});
});

describe('generateHmacSignature', () => {
	test('決定的: 同じ input なら同じ出力', () => {
		const s1 = generateHmacSignature('secret', 'https://example.com', 1000);
		const s2 = generateHmacSignature('secret', 'https://example.com', 1000);
		expect(s1).toBe(s2);
	});

	test('Worker 側 (Web Crypto API) と相互運用できる format: `${url}\\n${ts}`', () => {
		// Worker 側の実装と同じ message format を使っていることの確認
		const expected = createHmac('sha256', 'secret')
			.update('https://example.com\n1000')
			.digest('hex');
		expect(generateHmacSignature('secret', 'https://example.com', 1000)).toBe(expected);
	});

	test('長さは SHA-256 hex なので 64 文字', () => {
		expect(generateHmacSignature('s', 'https://x', 1)).toHaveLength(64);
	});
});

describe('resolveProxySecret', () => {
	const originalEnv = process.env.SUMMALY_PROXY_SECRET;
	beforeEach(() => { delete process.env.SUMMALY_PROXY_SECRET; });
	afterEach(() => {
		if (originalEnv != null) process.env.SUMMALY_PROXY_SECRET = originalEnv;
		else delete process.env.SUMMALY_PROXY_SECRET;
	});

	test('env が設定されていれば env を最優先', () => {
		process.env.SUMMALY_PROXY_SECRET = 'env-secret';
		expect(resolveProxySecret('config-secret')).toBe('env-secret');
	});

	test('env が無ければ config の secret に fallback', () => {
		expect(resolveProxySecret('config-secret')).toBe('config-secret');
	});

	test('どちらも無ければ空文字列', () => {
		expect(resolveProxySecret(undefined)).toBe('');
		expect(resolveProxySecret('')).toBe('');
	});
});

describe('getResponseWithProxyFallback (mock proxy worker)', () => {
	let mockProxy: Server;
	let mockProxyUrl: string;
	let mockProxyHits = 0;
	let lastReceivedSig: string | null = null;
	let lastReceivedTs: string | null = null;
	let lastForwardUA: string | null = null;
	let mockProxyHandler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

	beforeEach(async () => {
		mockProxyHits = 0;
		lastReceivedSig = null;
		lastReceivedTs = null;
		lastForwardUA = null;
		mockProxyHandler = (req, res) => {
			mockProxyHits++;
			lastReceivedSig = (req.headers['x-summaly-sig'] as string) ?? null;
			lastReceivedTs = (req.headers['x-summaly-ts'] as string) ?? null;
			lastForwardUA = (req.headers['x-summaly-forward-ua'] as string) ?? null;
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'x-summaly-final-url': 'https://example.com/final',
			});
			res.end('<html><head><title>via proxy</title></head><body>x</body></html>');
		};
		mockProxy = createServer((req, res) => mockProxyHandler(req, res));
		await new Promise<void>(resolve => mockProxy.listen(0, '127.0.0.1', resolve));
		const addr = mockProxy.address() as AddressInfo;
		mockProxyUrl = `http://127.0.0.1:${addr.port}`;
		// テストは localhost にアクセスするためプライベート IP ガードを許可
		process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';
	});
	afterEach(async () => {
		await new Promise<void>(resolve => mockProxy.close(() => resolve()));
		process.env.SUMMALY_ALLOW_PRIVATE_IP = 'false';
	});

	function makeArgs(url: string): GotOptions {
		return {
			url,
			method: 'GET',
			headers: { 'user-agent': 'TestBot/1.0', 'accept': 'text/html' },
			typeFilter: /^text\/html/,
		};
	}

	function makeProxyConfig(overrides: Partial<ProxyFallbackConfig> = {}): ProxyFallbackConfig {
		return {
			enabled: true,
			url: mockProxyUrl,
			secret: 'test-secret-12345',
			categories: ['origin_error'],
			domains: ['example.com'],
			timeoutMs: 5000,
			...overrides,
		};
	}

	test('proxyConfig.enabled = false なら proxy 経由しない (元のエラーが throw される)', async () => {
		// localhost の存在しないポートに向けて 1 回目を確実に失敗させる
		const args = makeArgs('http://127.0.0.1:1/notfound');
		const cfg = makeProxyConfig({ enabled: false });
		await expect(getResponseWithProxyFallback(args, undefined, cfg)).rejects.toThrow();
		expect(mockProxyHits).toBe(0);
	});

	test('proxyConfig 未指定なら通常の getResponseWithFallback 等価', async () => {
		const args = makeArgs('http://127.0.0.1:1/notfound');
		await expect(getResponseWithProxyFallback(args, undefined, undefined)).rejects.toThrow();
		expect(mockProxyHits).toBe(0);
	});

	test('1 回目失敗 + category 一致 + domain 一致 → proxy 経由でリトライ成功', async () => {
		// upstream が 503 を返す mock
		const upstream = createServer((_req, res) => {
			res.writeHead(503, { 'content-type': 'text/html' });
			res.end('<html><body>down</body></html>');
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			// allowlist には example.com を入れるが、実 URL は 127.0.0.1。
			// host header で偽装する戦略は got 制限で難しいため、allowlist を 127.0.0.1 にして実 URL も合わせる
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['127.0.0.1'],
				categories: ['origin_error'],
			});
			const res = await getResponseWithProxyFallback(args, undefined, cfg);
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('via proxy');
			expect(mockProxyHits).toBe(1);
			// HMAC 署名が正しく生成されている
			expect(lastReceivedSig).toMatch(/^[0-9a-f]{64}$/);
			expect(lastReceivedTs).toMatch(/^\d+$/);
			// forward UA が伝播している
			expect(lastForwardUA).toBe('TestBot/1.0');
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('1 回目 404 (not_found) は proxy 対象外 (origin_error カテゴリでないため)', async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end('not found');
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['127.0.0.1'],
				categories: ['origin_error'],
			});
			await expect(getResponseWithProxyFallback(args, undefined, cfg)).rejects.toThrow(/404/);
			expect(mockProxyHits).toBe(0);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('domain 不一致なら proxy 対象外 (元のエラーが throw)', async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['amazon.co.jp'], // 127.0.0.1 とは一致しない
				categories: ['origin_error'],
			});
			await expect(getResponseWithProxyFallback(args, undefined, cfg)).rejects.toThrow(/503/);
			expect(mockProxyHits).toBe(0);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('secret 空文字列なら proxy 対象外', async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['127.0.0.1'],
				secret: '',
			});
			await expect(getResponseWithProxyFallback(args, undefined, cfg)).rejects.toThrow();
			expect(mockProxyHits).toBe(0);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('proxy が 4xx を返したら StatusError に変換される (C-2 throwHttpErrors: false)', async () => {
		mockProxyHandler = (_req, res) => {
			mockProxyHits++;
			res.writeHead(403, { 'content-type': 'text/plain' });
			res.end('forbidden');
		};
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({ domains: ['127.0.0.1'], categories: ['origin_error'] });
			let caughtName: string | undefined;
			let caughtStatus: number | undefined;
			try {
				await getResponseWithProxyFallback(args, undefined, cfg);
			} catch (e: unknown) {
				caughtName = e instanceof Error ? e.name : undefined;
				caughtStatus = (e as { statusCode?: number }).statusCode;
			}
			expect(caughtName).toBe('StatusError');
			expect(caughtStatus).toBe(403);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('proxy が typeFilter 不一致な content-type を返したら Rejected by type filter で拒否 (W-1)', async () => {
		mockProxyHandler = (_req, res) => {
			mockProxyHits++;
			// 200 だが application/octet-stream で text/html フィルタを通らない
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			res.end('binary garbage');
		};
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({ domains: ['127.0.0.1'], categories: ['origin_error'] });
			await expect(getResponseWithProxyFallback(args, undefined, cfg))
				.rejects.toThrow(/Rejected by type filter.*via proxy/);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('x-summaly-final-url が javascript: のとき URL 検証で無視され元 URL が使われる (W-2)', async () => {
		mockProxyHandler = (_req, res) => {
			mockProxyHits++;
			res.writeHead(200, {
				'content-type': 'text/html',
				'x-summaly-final-url': 'javascript:alert(1)',
			});
			res.end('<html><body>x</body></html>');
		};
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({ domains: ['127.0.0.1'], categories: ['origin_error'] });
			const res = await getResponseWithProxyFallback(args, undefined, cfg);
			// javascript: は弾かれて元 URL が使われる
			expect(res.url).toBe(`http://127.0.0.1:${upstreamPort}/`);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('proxy 自体が 403 (HMAC 失敗等) → 2 回目のエラーが throw される', async () => {
		mockProxyHandler = (_req, res) => {
			mockProxyHits++;
			res.writeHead(403, { 'content-type': 'text/plain' });
			res.end('forbidden');
		};
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['127.0.0.1'],
				categories: ['origin_error'],
			});
			await expect(getResponseWithProxyFallback(args, undefined, cfg)).rejects.toThrow(/403/);
			expect(mockProxyHits).toBe(1);
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('proxy 経由のレスポンスは x-summaly-final-url で resolved URL を持つ', async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(503);
			res.end();
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as AddressInfo).port;
		try {
			const args = makeArgs(`http://127.0.0.1:${upstreamPort}/`);
			const cfg = makeProxyConfig({
				domains: ['127.0.0.1'],
				categories: ['origin_error'],
			});
			const res = await getResponseWithProxyFallback(args, undefined, cfg);
			// mock proxy が x-summaly-final-url を返している
			expect(res.url).toBe('https://example.com/final');
		} finally {
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});
});

// **`forceProxyFallback` は phase14 Step 4 で廃止された** (経路学習キャッシュ + bootstrap に統合)。
// 該当テスト群は削除済み。sqex 等の HTTP 200 + 正規 404 IP block サイトは
// `data/domain-strategy-bootstrap.jsonl` の bootstrap エントリ (`store.jp.square-enix.com → proxy`) で
// cache fast path から直接 proxy が呼ばれる経路に移行している。
