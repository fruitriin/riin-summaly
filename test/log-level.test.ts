/**
 * src/utils/log-level.ts の単体テスト (phase11.8)。
 */

import { describe, expect, test } from 'vitest';
import { StatusError } from '@/utils/status-error.js';
import { chooseLogLevel } from '@/utils/log-level.js';

describe('chooseLogLevel', () => {
	test('StatusError 404 → info', () => {
		expect(chooseLogLevel(new StatusError('Not Found', 404, 'Not Found'))).toBe('info');
	});

	test('StatusError 403 → info (bot_blocked)', () => {
		expect(chooseLogLevel(new StatusError('Forbidden', 403, 'Forbidden'))).toBe('info');
	});

	test('StatusError 429 → info (bot_blocked: rate limit)', () => {
		expect(chooseLogLevel(new StatusError('Too Many Requests', 429, 'Too Many Requests'))).toBe('info');
	});

	test('StatusError 500 → warn (origin_error)', () => {
		expect(chooseLogLevel(new StatusError('Internal Server Error', 500, 'Internal Server Error'))).toBe('warn');
	});

	test('StatusError 503 → warn (origin_error)', () => {
		expect(chooseLogLevel(new StatusError('Service Unavailable', 503, 'Service Unavailable'))).toBe('warn');
	});

	test('Error("Rejected by type filter ...") → warn (unsupported_type)', () => {
		expect(chooseLogLevel(new Error('Rejected by type filter application/pdf'))).toBe('warn');
	});

	test('Error("Private IP rejected ...") → warn (ssrf_blocked)', () => {
		expect(chooseLogLevel(new Error('Private IP rejected 192.168.1.1'))).toBe('warn');
	});

	test('Error("maxSize exceeded ...") → warn (content_too_large)', () => {
		expect(chooseLogLevel(new Error('maxSize exceeded (15728640 > 10485760) on response'))).toBe('warn');
	});

	test('Error("getaddrinfo ENOTFOUND ...") → warn (network_error)', () => {
		expect(chooseLogLevel(new Error('getaddrinfo ENOTFOUND example.invalid'))).toBe('warn');
	});

	test('Error("socket hang up") → warn (connection_dropped, phase11.9)', () => {
		expect(chooseLogLevel(new Error('socket hang up'))).toBe('warn');
	});

	test('Error("failed summarize") → error (parse_error)', () => {
		expect(chooseLogLevel(new Error('failed summarize'))).toBe('error');
	});

	test('TypeError("foo") → error (unknown 想定外)', () => {
		expect(chooseLogLevel(new TypeError('foo'))).toBe('error');
	});

	test('Error()（プレーン）→ error (unknown)', () => {
		expect(chooseLogLevel(new Error('cheerio internal error'))).toBe('error');
	});

	test('TimeoutError 名前付きエラー → warn (timeout)', () => {
		const e = new Error('Timeout awaiting request') as Error & { name: string };
		e.name = 'TimeoutError';
		expect(chooseLogLevel(e)).toBe('warn');
	});

	test('非 Error 値 (string / number) も unknown 扱いで error', () => {
		expect(chooseLogLevel('something went wrong')).toBe('error');
		expect(chooseLogLevel(42)).toBe('error');
		expect(chooseLogLevel(undefined)).toBe('error');
	});
});
