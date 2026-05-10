/**
 * src/utils/curl-cffi-fetch.ts の単体テスト + 統合テスト (phase12.5)。
 *
 * spawn 経由の挙動は **Node.js で書かれた fake CLI スクリプト** を tmp ディレクトリに置いて
 * `uvPath` に指定することで mock する。`uv run fetch <url>` と同じ argv 形で呼ばれるため、
 * 実際の `uv` が無くても spawn 〜 stdout JSON パース 〜 Got.Response 整形のフローを exercise できる。
 *
 * gating ロジック (enabled / categories / domains / protocol) の検証は、
 * 1 段目の `getResponseWithProxyFallback` を実 HTTP に依存させないため、
 * `.invalid` ドメインで「DNS 失敗 → 原エラー伝播」だけ確認する。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	viaCurlCffi,
	pickOverrideHeaders,
	type CurlCffiFallbackConfig,
} from '@/utils/curl-cffi-fetch.js';
import { StatusError } from '@/utils/status-error.js';
import type { GotOptions } from '@/utils/got.js';

let tmpDir: string;
let mockScript: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(tmpdir(), 'curl-cffi-test-'));
	mockScript = path.join(tmpDir, 'mock-cli.mjs');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeMockCli(script: string) {
	writeFileSync(mockScript, script);
	chmodSync(mockScript, 0o755);
}

function makeConfig(overrides: Partial<CurlCffiFallbackConfig> = {}): CurlCffiFallbackConfig {
	return {
		enabled: true,
		uvPath: mockScript,
		projectDir: tmpDir,
		impersonate: 'chrome120',
		timeoutMs: 5000,
		...overrides,
	};
}

function makeArgs(overrides: Partial<GotOptions> = {}): GotOptions {
	return {
		url: 'https://example.com/page',
		method: 'GET',
		headers: { 'user-agent': 'SummalyBot' },
		typeFilter: /^(text\/html|application\/xhtml\+xml)/,
		...overrides,
	};
}

describe('viaCurlCffi (spawn 経由 CLI 呼び出しの直接テスト)', () => {
	test('成功: fake CLI が status 200 + HTML を返す → Got.Response<string> 形式に整形される', async () => {
		writeMockCli(`#!/usr/bin/env node
const url = process.argv[3] ?? '';
console.log(JSON.stringify({
	status: 200,
	final_url: url,
	content_type: 'text/html;charset=UTF-8',
	headers: { 'content-type': 'text/html;charset=UTF-8', 'x-test-header': 'curl-cffi-mock' },
	body: '<html><title>Mock OK</title></html>',
}));
`);
		const res = await viaCurlCffi(makeArgs({ url: 'https://example.com/test-success' }), makeConfig());
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('<title>Mock OK</title>');
		expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
		expect(res.headers['x-test-header']).toBe('curl-cffi-mock');
		expect(res.url).toBe('https://example.com/test-success');
		// ip は curl_cffi 経由のため undefined
		expect(res.ip).toBeUndefined();
	});

	test('CLI が argv に impersonate / timeout / max-bytes を受け取る (spawn 引数の検証)', async () => {
		// 全 argv を再エコーする mock
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: 'https://example.com/x',
	content_type: 'text/html',
	headers: { 'content-type': 'text/html', 'x-argv': process.argv.slice(2).join('|') },
	body: '<html></html>',
}));
`);
		const cfg = makeConfig({ impersonate: 'firefox120', timeoutMs: 8000 });
		const args = makeArgs({ url: 'https://example.com/x', responseTimeout: 15000, contentLengthLimit: 2 * 1024 * 1024 });
		const res = await viaCurlCffi(args, cfg);
		const argv = res.headers['x-argv'] as string;
		// argv 順: 'run', 'fetch', URL, '--impersonate', 'firefox120', '--timeout', '15', '--max-bytes', '2097152', '--header', 'user-agent:SummalyBot'
		// 末尾の --header は makeArgs() のデフォルト `headers: { 'user-agent': 'SummalyBot' }` が
		// `pickOverrideHeaders` の allowlist (`user-agent`) を通って CLI に渡されることを示す。
		expect(argv).toBe('run|fetch|https://example.com/x|--impersonate|firefox120|--timeout|15|--max-bytes|2097152|--header|user-agent:SummalyBot');
	});

	test('CLI が status >= 400 を返したら StatusError', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 503,
	final_url: process.argv[3] ?? '',
	content_type: 'text/html',
	headers: {},
	body: 'Service Unavailable',
}));
`);
		await expect(viaCurlCffi(makeArgs(), makeConfig())).rejects.toBeInstanceOf(StatusError);
	});

	test('CLI がエラー JSON (timeout category) を返したら Error', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({ error: 'Connection timed out', category: 'timeout' }));
`);
		await expect(viaCurlCffi(makeArgs(), makeConfig())).rejects.toThrow(/curl_cffi.*timeout.*Connection timed out/);
	});

	test('content_type が typeFilter に合わない場合は reject', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: process.argv[3] ?? '',
	content_type: 'application/octet-stream',
	headers: { 'content-type': 'application/octet-stream' },
	body: 'binary garbage',
}));
`);
		await expect(viaCurlCffi(makeArgs(), makeConfig())).rejects.toThrow(/Rejected by type filter.*via curl_cffi/);
	});

	test('CLI が malformed JSON を吐いたら Error', async () => {
		writeMockCli(`#!/usr/bin/env node
process.stdout.write('not a json');
`);
		await expect(viaCurlCffi(makeArgs(), makeConfig())).rejects.toThrow(/curl_cffi: malformed JSON/);
	});

	test('uv バイナリが存在しないと spawn が ENOENT で失敗 → 詳細メッセージ付きで throw', async () => {
		const cfg = makeConfig({ uvPath: '/nonexistent/uv-binary-not-here' });
		await expect(viaCurlCffi(makeArgs(), cfg)).rejects.toThrow(/curl_cffi spawn failed.*uv が未インストール/);
	});

	test('final_url が CLI から返されたら url に反映される', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: 'https://www.example.com/redirected',
	content_type: 'text/html',
	headers: { 'content-type': 'text/html' },
	body: '<html></html>',
}));
`);
		const res = await viaCurlCffi(makeArgs({ url: 'https://example.com/start' }), makeConfig());
		expect(res.url).toBe('https://www.example.com/redirected');
	});

	test('final_url が不正な URL なら無視して args.url を維持', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: 'not-a-url',
	content_type: 'text/html',
	headers: { 'content-type': 'text/html' },
	body: '<html></html>',
}));
`);
		const res = await viaCurlCffi(makeArgs({ url: 'https://example.com/start' }), makeConfig());
		expect(res.url).toBe('https://example.com/start');
	});

	test('複数 --header が argv に追加される (Accept + Accept-Language の同時指定)', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: 'https://example.com/api',
	content_type: 'application/json',
	headers: { 'content-type': 'application/json', 'x-argv': process.argv.slice(2).join('|') },
	body: '{}',
}));
`);
		const args = makeArgs({
			url: 'https://example.com/api',
			headers: {
				accept: 'application/json',
				'accept-language': 'ja',
				'user-agent': 'SummalyBot',
			},
			typeFilter: /^application\/(?:json|.*\+json)/,
		});
		const res = await viaCurlCffi(args, makeConfig());
		const argv = res.headers['x-argv'] as string;
		expect(argv).toContain('--header|accept:application/json');
		expect(argv).toContain('--header|accept-language:ja');
		expect(argv).toContain('--header|user-agent:SummalyBot');
	});

	test('allowlist 外のヘッダ (Range / Content-Type 等) は CLI に渡らない', async () => {
		writeMockCli(`#!/usr/bin/env node
console.log(JSON.stringify({
	status: 200,
	final_url: 'https://example.com/api',
	content_type: 'application/json',
	headers: { 'content-type': 'application/json', 'x-argv': process.argv.slice(2).join('|') },
	body: '{}',
}));
`);
		const args = makeArgs({
			url: 'https://example.com/api',
			headers: {
				accept: 'application/json',
				range: 'bytes=0-1024',
				'content-type': 'text/plain',
				'x-custom': 'foo',
			},
			typeFilter: /^application\/(?:json|.*\+json)/,
		});
		const res = await viaCurlCffi(args, makeConfig());
		const argv = res.headers['x-argv'] as string;
		expect(argv).toContain('--header|accept:application/json');
		expect(argv).not.toContain('range:');
		expect(argv).not.toContain('content-type:');
		expect(argv).not.toContain('x-custom:');
	});
});

describe('pickOverrideHeaders (allowlist フィルタ)', () => {
	test('allowlist (accept / accept-language / referer / user-agent) は通す', () => {
		const result = pickOverrideHeaders({
			accept: 'application/json',
			'accept-language': 'ja',
			referer: 'https://example.com/',
			'user-agent': 'SummalyBot',
		});
		expect(result).toEqual({
			accept: 'application/json',
			'accept-language': 'ja',
			referer: 'https://example.com/',
			'user-agent': 'SummalyBot',
		});
	});

	test('allowlist 外 (Range / Content-Type / X-Custom 等) は除外', () => {
		const result = pickOverrideHeaders({
			accept: 'application/json',
			range: 'bytes=0-1024',
			'content-type': 'text/plain',
			'x-custom': 'foo',
		});
		expect(result).toEqual({ accept: 'application/json' });
	});

	test('大文字小文字を区別せず allowlist 判定', () => {
		const result = pickOverrideHeaders({
			Accept: 'application/json',
			'User-Agent': 'SummalyBot',
		});
		expect(result).toEqual({
			Accept: 'application/json',
			'User-Agent': 'SummalyBot',
		});
	});

	test('value が undefined / 空文字なら除外 (CLI 側の事故防止)', () => {
		const result = pickOverrideHeaders({
			accept: 'application/json',
			'accept-language': undefined,
			'user-agent': '',
		});
		expect(result).toEqual({ accept: 'application/json' });
	});

	test('header 名に `:` が含まれている不正値は除外 (CLI parse 衝突防止)', () => {
		const result = pickOverrideHeaders({
			'accept:weird': 'value',
			accept: 'application/json',
		});
		expect(result).toEqual({ accept: 'application/json' });
	});
});

// phase18.1: `getResponseWithCurlCffiFallback` (cascade) は廃止。
// gating ロジック (enabled / categories / domains / protocol) は phase18 hedge race の `fetchByStrategy`
// で `enabled` + `https:` のみに簡素化された。`fetchByStrategy` 自体のテストは hedged-fetch.test.ts に集約。
// `viaCurlCffi` 直接呼びの挙動 (HTTP-level の挙動) は本ファイルの「viaCurlCffi (spawn 経由 ...)」 describe で確認済み。
