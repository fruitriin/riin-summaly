/**
 * src/config-loader.ts の単体テスト（phase8.1）。
 * TOML 文字列を直接渡せる `parseTomlConfigString` で I/O 抜きに検証する。
 */

import { describe, expect, test } from 'vitest';
import { parseTomlConfigString } from '../bin/config-loader.js';

describe('parseTomlConfigString', () => {
	test('空文字列は server={} / summaly={} を返す', () => {
		const cfg = parseTomlConfigString('');
		expect(cfg.server).toEqual({});
		expect(cfg.summaly).toEqual({});
	});

	test('[server] host / port を抽出する', () => {
		const cfg = parseTomlConfigString(`
			[server]
			host = "0.0.0.0"
			port = 8080
		`);
		expect(cfg.server).toEqual({ host: '0.0.0.0', port: 8080 });
	});

	test('[summaly] のフラットなフィールドを SummalyOptions にマップする', () => {
		const cfg = parseTomlConfigString(`
			[summaly]
			userAgent = "MyBot/1.0"
			responseTimeout = 10000
			operationTimeout = 30000
			contentLengthLimit = 5242880
			contentLengthRequired = true
			useRange = true
		`);
		expect(cfg.summaly).toEqual({
			userAgent: 'MyBot/1.0',
			responseTimeout: 10000,
			operationTimeout: 30000,
			contentLengthLimit: 5242880,
			contentLengthRequired: true,
			useRange: true,
		});
	});

	test('[summaly.cache] / [summaly.pdf] / [plugins] を再マップする', () => {
		const cfg = parseTomlConfigString(`
			[summaly.cache]
			maxAge = 86400
			errorMaxAge = 60
			inMemory = true
			inMemoryMaxEntries = 500
			inFlightDedup = false

			[summaly.pdf]
			enabled = true

			[plugins]
			allowed = ["youtube", "spotify"]
		`);
		expect(cfg.summaly).toMatchObject({
			cacheMaxAge: 86400,
			cacheErrorMaxAge: 60,
			inMemoryCache: true,
			inMemoryCacheMaxEntries: 500,
			inFlightDedup: false,
			enablePdf: true,
			allowedPlugins: ['youtube', 'spotify'],
		});
	});

	test('[plugins.<name>] サブセクションは現状無視される（将来拡張用 placeholder）', () => {
		const cfg = parseTomlConfigString(`
			[plugins]
			allowed = ["amazon"]

			[plugins.komiflo]
			preferredVariant = "346_mobile"

			[plugins.iwara]
			descriptionMaxLength = 500
		`);
		expect(cfg.summaly.allowedPlugins).toEqual(['amazon']);
		// プラグイン別 options は SummalyOptions に乗らない
		expect((cfg.summaly as Record<string, unknown>).komiflo).toBeUndefined();
		expect((cfg.summaly as Record<string, unknown>).iwara).toBeUndefined();
	});

	test('TOML 構文エラーは ConfigError 系で throw する', () => {
		expect(() => parseTomlConfigString('[unclosed')).toThrow(/TOML parse error/);
	});

	test('型違いは TypeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[summaly]
			responseTimeout = "fast"
		`)).toThrow(/responseTimeout.*number/);

		expect(() => parseTomlConfigString(`
			[server]
			port = "3000"
		`)).toThrow(/server\.port.*number/);

		expect(() => parseTomlConfigString(`
			[plugins]
			allowed = [1, 2]
		`)).toThrow(/plugins\.allowed.*array of strings/);
	});

	test('負数 / 非有限の数値は RangeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[summaly.cache]
			maxAge = -1
		`)).toThrow(/cache\.maxAge.*non-negative/);

		expect(() => parseTomlConfigString(`
			[summaly]
			operationTimeout = inf
		`)).toThrow(/operationTimeout.*non-negative finite/);
	});

	test('server.host 空文字列は RangeError で弾かれる（SSRF リレー化対策）', () => {
		expect(() => parseTomlConfigString(`
			[server]
			host = ""
		`)).toThrow(/server\.host.*must not be empty/);

		expect(() => parseTomlConfigString(`
			[server]
			host = "   "
		`)).toThrow(/server\.host.*must not be empty/);
	});

	test('ポート範囲外は RangeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[server]
			port = 0
		`)).toThrow(/server\.port.*\[1, 65535\]/);

		expect(() => parseTomlConfigString(`
			[server]
			port = 70000
		`)).toThrow(/server\.port.*\[1, 65535\]/);

		expect(() => parseTomlConfigString(`
			[server]
			port = 3000.5
		`)).toThrow(/server\.port.*integer/);
	});

	test('未知のキーは無視する（将来追加されたキーで起動失敗しないため）', () => {
		const cfg = parseTomlConfigString(`
			[summaly]
			responseTimeout = 5000
			unknownKey = "ignored"

			[unknownSection]
			foo = "bar"
		`);
		expect(cfg.summaly.responseTimeout).toBe(5000);
		expect((cfg.summaly as Record<string, unknown>).unknownKey).toBeUndefined();
	});

	test('空配列の plugins.allowed は組み込み全 disable を意味する', () => {
		const cfg = parseTomlConfigString(`
			[plugins]
			allowed = []
		`);
		expect(cfg.summaly.allowedPlugins).toEqual([]);
	});
});
