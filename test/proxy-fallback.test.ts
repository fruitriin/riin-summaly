/**
 * src/utils/proxy-fallback.ts の単体テスト (phase18.1 で cascade fallback 廃止後)。
 *
 * phase18.1 で `getResponseWithProxyFallback` (cascade) を廃止し、`viaProxyWorker` を直接呼ぶ形に変更。
 * cascade 時代の発火条件 (categories / domains allowlist / 1段目失敗をトリガにする等) は撤廃。
 *
 * Worker の動作は Node の `http.createServer` でモックする。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import {
	matchesDomain,
	generateHmacSignature,
	viaProxyWorker,
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
		const expected = createHmac('sha256', 'secret')
			.update(`https://example.com\n1000`)
			.digest('hex');
		expect(generateHmacSignature('secret', 'https://example.com', 1000)).toBe(expected);
	});

	test('異なる ts なら異なる sig', () => {
		const s1 = generateHmacSignature('secret', 'https://example.com', 1000);
		const s2 = generateHmacSignature('secret', 'https://example.com', 2000);
		expect(s1).not.toBe(s2);
	});
});

describe('resolveProxySecret', () => {
	const origEnv = process.env.SUMMALY_PROXY_SECRET;
	afterEach(() => {
		if (origEnv === undefined) delete process.env.SUMMALY_PROXY_SECRET;
		else process.env.SUMMALY_PROXY_SECRET = origEnv;
	});

	test('env が設定されていれば env を優先', () => {
		process.env.SUMMALY_PROXY_SECRET = 'env-secret';
		expect(resolveProxySecret('config-secret')).toBe('env-secret');
	});

	test('env 未設定なら config の secret', () => {
		delete process.env.SUMMALY_PROXY_SECRET;
		expect(resolveProxySecret('config-secret')).toBe('config-secret');
	});

	test('両方未設定なら空文字', () => {
		delete process.env.SUMMALY_PROXY_SECRET;
		expect(resolveProxySecret(undefined)).toBe('');
		expect(resolveProxySecret('')).toBe('');
	});
});

describe('viaProxyWorker (mock proxy worker)', () => {
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
			timeoutMs: 5000,
			...overrides,
		};
	}

	test('viaProxyWorker は HMAC 署名 + forward UA を Worker に送る', async () => {
		const args = makeArgs('https://example.com/');
		const cfg = makeProxyConfig();
		const r = await viaProxyWorker(args, cfg);
		expect(r.statusCode).toBe(200);
		expect(mockProxyHits).toBe(1);
		expect(lastReceivedSig).toBe(generateHmacSignature(cfg.secret, args.url, Number(lastReceivedTs)));
		expect(lastForwardUA).toBe('TestBot/1.0');
	});

	test('viaProxyWorker は x-summaly-final-url を Got.Response.url に反映', async () => {
		const args = makeArgs('https://example.com/');
		const r = await viaProxyWorker(args, makeProxyConfig());
		expect(r.url).toBe('https://example.com/final');
	});

	test('viaProxyWorker は 4xx/5xx を StatusError で throw', async () => {
		mockProxyHandler = (_req, res) => {
			res.writeHead(503, { 'content-type': 'text/html' });
			res.end('upstream error');
		};
		const args = makeArgs('https://example.com/');
		await expect(viaProxyWorker(args, makeProxyConfig())).rejects.toThrow(/503/);
	});

	test('viaProxyWorker は typeFilter で content-type を再検証', async () => {
		mockProxyHandler = (_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"foo":"bar"}');
		};
		const args = makeArgs('https://example.com/');
		await expect(viaProxyWorker(args, makeProxyConfig())).rejects.toThrow(/type filter/);
	});

	test('viaProxyWorker は externalSignal で abort 可能', async () => {
		mockProxyHandler = (_req, _res) => {
			// 永遠に応答しない (timer で signal abort されるまで)
		};
		const args = makeArgs('https://example.com/');
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		await expect(viaProxyWorker(args, makeProxyConfig({ timeoutMs: 30000 }), ac.signal)).rejects.toThrow();
	});
});
