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

	describe('[diagnostics] (phase10.1)', () => {
		test('parseFailureLog 系の bool / number を正しくマップ', () => {
			const cfg = parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = true
				parseFailureLogMaxGroups = 500
				parseFailureLogSamplesPerGroup = 3
			`);
			expect(cfg.summaly.parseFailureLog).toBe(true);
			expect(cfg.summaly.parseFailureLogMaxGroups).toBe(500);
			expect(cfg.summaly.parseFailureLogSamplesPerGroup).toBe(3);
		});

		test('未指定時はキーが付かない', () => {
			const cfg = parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = false
			`);
			expect(cfg.summaly.parseFailureLog).toBe(false);
			expect(cfg.summaly.parseFailureLogMaxGroups).toBeUndefined();
			expect(cfg.summaly.parseFailureLogSamplesPerGroup).toBeUndefined();
		});

		test('phase11.5 で削除された parseFailureLogEndpoint が TOML に残っていても無視される (smol-toml は unknown key を silent ignore)', () => {
			const cfg = parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = true
				parseFailureLogEndpoint = true
			`);
			expect(cfg.summaly.parseFailureLog).toBe(true);
			expect((cfg.summaly as Record<string, unknown>).parseFailureLogEndpoint).toBeUndefined();
		});

		test('正の整数以外（0 / 負数 / 小数）は RangeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogMaxGroups = 0
			`)).toThrow(/parseFailureLogMaxGroups.*positive integer/);
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogSamplesPerGroup = 1.5
			`)).toThrow(/parseFailureLogSamplesPerGroup.*positive integer/);
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogMaxGroups = -10
			`)).toThrow(/parseFailureLogMaxGroups.*positive integer/);
		});

		test('型違いは TypeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = "yes"
			`)).toThrow(/parseFailureLog.*boolean/);
		});

		test('[diagnostics] 自体が無いと undefined のまま（既存挙動）', () => {
			const cfg = parseTomlConfigString(`
				[summaly]
				responseTimeout = 5000
			`);
			expect(cfg.summaly.parseFailureLog).toBeUndefined();
		});

		test('parseFailureLogJsonlPath / parseFailureLogJsonlMaxBytes をマップ', () => {
			const cfg = parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = true
				parseFailureLogJsonlPath = "/var/log/summaly/pf.jsonl"
				parseFailureLogJsonlMaxBytes = 5242880
			`);
			expect(cfg.summaly.parseFailureLogJsonlPath).toBe('/var/log/summaly/pf.jsonl');
			expect(cfg.summaly.parseFailureLogJsonlMaxBytes).toBe(5242880);
		});

		test('parseFailureLogJsonlPath が空文字列だと RangeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogJsonlPath = ""
			`)).toThrow(/parseFailureLogJsonlPath.*must not be empty/);
		});

		test('parseFailureLogJsonlMaxBytes が負数だと RangeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogJsonlMaxBytes = -1
			`)).toThrow(/parseFailureLogJsonlMaxBytes.*non-negative/);
		});

		test('parseFailureLogBlockedJsonlPath / Bytes をマップ (phase11.6)', () => {
			const cfg = parseTomlConfigString(`
				[diagnostics]
				parseFailureLog = true
				parseFailureLogBlockedJsonlPath = "/var/log/summaly/blocked.jsonl"
				parseFailureLogBlockedJsonlMaxBytes = 5242880
			`);
			expect(cfg.summaly.parseFailureLogBlockedJsonlPath).toBe('/var/log/summaly/blocked.jsonl');
			expect(cfg.summaly.parseFailureLogBlockedJsonlMaxBytes).toBe(5242880);
		});

		test('parseFailureLogBlockedJsonlPath が空文字列だと RangeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogBlockedJsonlPath = ""
			`)).toThrow(/parseFailureLogBlockedJsonlPath.*must not be empty/);
		});

		test('parseFailureLogBlockedJsonlMaxBytes が負数だと RangeError', () => {
			expect(() => parseTomlConfigString(`
				[diagnostics]
				parseFailureLogBlockedJsonlMaxBytes = -1
			`)).toThrow(/parseFailureLogBlockedJsonlMaxBytes.*non-negative/);
		});
	});

	describe('[scraping.fallback] (phase11.9)', () => {
		test('userAgent / categories をマップ', () => {
			const cfg = parseTomlConfigString(`
				[scraping.fallback]
				enabled = true
				userAgent = "facebookexternalhit/1.1"
				categories = ["bot_blocked", "connection_dropped"]
			`);
			expect(cfg.summaly.fallbackUserAgent).toBe('facebookexternalhit/1.1');
			expect(cfg.summaly.fallbackRetryCategories).toEqual(['bot_blocked', 'connection_dropped']);
		});

		test('enabled = false のときは何もマップしない', () => {
			const cfg = parseTomlConfigString(`
				[scraping.fallback]
				enabled = false
				userAgent = "facebookexternalhit/1.1"
				categories = ["bot_blocked"]
			`);
			expect(cfg.summaly.fallbackUserAgent).toBeUndefined();
			expect(cfg.summaly.fallbackRetryCategories).toBeUndefined();
		});

		test('セクション省略時は undefined のまま', () => {
			const cfg = parseTomlConfigString(`
				[summaly]
				responseTimeout = 5000
			`);
			expect(cfg.summaly.fallbackUserAgent).toBeUndefined();
			expect(cfg.summaly.fallbackRetryCategories).toBeUndefined();
		});

		test('userAgent 省略時は DEFAULT_FALLBACK_UA (facebookexternalhit) で埋める (phase11.9 W-2)', () => {
			const cfg = parseTomlConfigString(`
				[scraping.fallback]
				enabled = true
			`);
			expect(cfg.summaly.fallbackUserAgent).toContain('facebookexternalhit');
		});

		test('userAgent 空文字列は RangeError (有効化時)', () => {
			expect(() => parseTomlConfigString(`
				[scraping.fallback]
				enabled = true
				userAgent = ""
			`)).toThrow(/scraping\.fallback\.userAgent.*must not be empty/);
		});

		test('categories の型違いは TypeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.fallback]
				categories = [1, 2]
			`)).toThrow(/scraping\.fallback\.categories.*array of strings/);
		});

		test('enabled の型違いは TypeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.fallback]
				enabled = "yes"
			`)).toThrow(/scraping\.fallback\.enabled.*boolean/);
		});

		test('categories に未知のカテゴリは RangeError (S-3 typo 検出)', () => {
			expect(() => parseTomlConfigString(`
				[scraping.fallback]
				categories = ["bot_blocked", "typo_category"]
			`)).toThrow(/scraping\.fallback\.categories.*unknown category.*typo_category/);
		});
	});
});
