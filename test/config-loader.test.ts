/**
 * src/config-loader.ts の単体テスト（phase8.1）。
 * TOML 文字列を直接渡せる `parseTomlConfigString` で I/O 抜きに検証する。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
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

	describe('[scraping.proxy] (phase12.1)', () => {
		const originalEnv = process.env.SUMMALY_PROXY_SECRET;
		beforeEach(() => { delete process.env.SUMMALY_PROXY_SECRET; });
		afterEach(() => {
			if (originalEnv != null) process.env.SUMMALY_PROXY_SECRET = originalEnv;
			else delete process.env.SUMMALY_PROXY_SECRET;
		});

		test('enabled = false (default) はマップしない', () => {
			const cfg = parseTomlConfigString(`
				[summaly]
				responseTimeout = 5000
			`);
			expect(cfg.summaly.proxyFallback).toBeUndefined();
		});

		test('enabled = true + secret + 必須項目を指定すると ProxyFallbackConfig を組み立てる', () => {
			const cfg = parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://summaly-proxy.example.workers.dev"
				secret = "test-secret"
				categories = ["origin_error", "bot_blocked"]
				domains = ["amazon.co.jp", "amazon.com"]
				timeoutMs = 25000
			`);
			expect(cfg.summaly.proxyFallback).toEqual({
				enabled: true,
				url: 'https://summaly-proxy.example.workers.dev',
				secret: 'test-secret',
				categories: ['origin_error', 'bot_blocked'],
				domains: ['amazon.co.jp', 'amazon.com'],
				timeoutMs: 25000,
			});
		});

		test('env SUMMALY_PROXY_SECRET が config.secret より優先', () => {
			process.env.SUMMALY_PROXY_SECRET = 'env-secret';
			const cfg = parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "config-secret"
				domains = ["amazon.co.jp"]
			`);
			expect(cfg.summaly.proxyFallback?.secret).toBe('env-secret');
		});

		test('secret 未設定 (env も config も) なら警告で disable', () => {
			// stderr.write をモック化して captured
			const stderrWrites: string[] = [];
			const origWrite = process.stderr.write.bind(process.stderr);
			(process.stderr as { write: typeof process.stderr.write }).write = (chunk: string | Uint8Array): boolean => {
				stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
				return true;
			};
			try {
				const cfg = parseTomlConfigString(`
					[scraping.proxy]
					enabled = true
					url = "https://x.workers.dev"
					domains = ["amazon.co.jp"]
				`);
				expect(cfg.summaly.proxyFallback).toBeUndefined();
				expect(stderrWrites.some(s => s.includes('secret が未設定'))).toBe(true);
			} finally {
				(process.stderr as { write: typeof process.stderr.write }).write = origWrite;
			}
		});

		test('url 未設定なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				secret = "x"
				domains = ["amazon.co.jp"]
			`)).toThrow(/scraping\.proxy\.url.*required/);
		});

		test('url が http(s) で始まらないと RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "ftp://example.com"
				secret = "x"
				domains = ["amazon.co.jp"]
			`)).toThrow(/scraping\.proxy\.url.*valid http/);
		});

		test('domains 未設定なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "x"
			`)).toThrow(/scraping\.proxy\.domains.*required/);
		});

		test('domains 空配列なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "x"
				domains = []
			`)).toThrow(/scraping\.proxy\.domains.*must not be empty/);
		});

		test('categories に typo は RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "x"
				domains = ["amazon.co.jp"]
				categories = ["origin_error", "typo_cat"]
			`)).toThrow(/scraping\.proxy\.categories.*unknown category.*typo_cat/);
		});

		test('categories のデフォルトは ["origin_error", "bot_blocked"] (phase12.1 followup)', () => {
			// Amazon は IP block で 5xx もしくは 200 + content-type 欠落 (= bot_blocked カテゴリ)
			// の両方で弾くため、デフォルトで両方を proxy 発火対象にする
			const cfg = parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "x"
				domains = ["amazon.co.jp"]
			`);
			expect(cfg.summaly.proxyFallback?.categories).toEqual(['origin_error', 'bot_blocked']);
		});

		test('timeoutMs のデフォルトは 30000', () => {
			const cfg = parseTomlConfigString(`
				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "x"
				domains = ["amazon.co.jp"]
			`);
			expect(cfg.summaly.proxyFallback?.timeoutMs).toBe(30000);
		});
	});

	describe('[scraping.strategy_cache] (phase14 Step 1)', () => {
		test('セクション省略時は domainStrategyCache が undefined', () => {
			const cfg = parseTomlConfigString(`
				[summaly]
				responseTimeout = 5000
			`);
			expect(cfg.summaly.domainStrategyCache).toBeUndefined();
		});

		test('enabled = true (デフォルト) + 全パラメータ指定で全フィールドをマップ', () => {
			const cfg = parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = true
				bootstrapPath = "data/bootstrap.jsonl"
				runtimePath = "/var/cache/summaly/runtime.jsonl"
				maxEntries = 2000
				consecutiveFailureThreshold = 5
				compactionThreshold = 500
			`);
			expect(cfg.summaly.domainStrategyCache).toEqual({
				enabled: true,
				bootstrapPath: 'data/bootstrap.jsonl',
				runtimePath: '/var/cache/summaly/runtime.jsonl',
				maxEntries: 2000,
				consecutiveFailureThreshold: 5,
				compactionThreshold: 500,
			});
		});

		test('enabled = false なら何もマップしない', () => {
			const cfg = parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = false
				bootstrapPath = "data/bootstrap.jsonl"
			`);
			expect(cfg.summaly.domainStrategyCache).toBeUndefined();
		});

		test('enabled 省略時はデフォルト ON で空 opts (= 全 default 採用)', () => {
			const cfg = parseTomlConfigString(`
				[scraping.strategy_cache]
			`);
			expect(cfg.summaly.domainStrategyCache).toEqual({ enabled: true });
		});

		test('bootstrapPath 空文字列は RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				bootstrapPath = ""
			`)).toThrow(/scraping\.strategy_cache\.bootstrapPath.*must not be empty/);
		});

		test('runtimePath 空文字列は RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				runtimePath = ""
			`)).toThrow(/scraping\.strategy_cache\.runtimePath.*must not be empty/);
		});

		test('maxEntries が 0 / 負数 / 小数なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				maxEntries = 0
			`)).toThrow(/scraping\.strategy_cache\.maxEntries.*positive integer/);
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				maxEntries = -1
			`)).toThrow(/scraping\.strategy_cache\.maxEntries.*positive integer/);
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				maxEntries = 1.5
			`)).toThrow(/scraping\.strategy_cache\.maxEntries.*positive integer/);
		});

		test('consecutiveFailureThreshold が 0 なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				consecutiveFailureThreshold = 0
			`)).toThrow(/scraping\.strategy_cache\.consecutiveFailureThreshold.*positive integer/);
		});

		test('compactionThreshold が 0 なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				compactionThreshold = 0
			`)).toThrow(/scraping\.strategy_cache\.compactionThreshold.*positive integer/);
		});

		test('enabled の型違いは TypeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = "yes"
			`)).toThrow(/scraping\.strategy_cache\.enabled.*boolean/);
		});

		test('セクションがテーブルでないと TypeError', () => {
			expect(() => parseTomlConfigString(`
				[scraping]
				strategy_cache = "not a table"
			`)).toThrow(/scraping\.strategy_cache.*must be a table/);
		});
	});

	describe('[server].publicUrl + [embed] (phase13.1 Step 2)', () => {
		test('publicUrl + [embed] enabled で embedBaseUrl + embedConfig が両方設定される', () => {
			const cfg = parseTomlConfigString(`
				[server]
				publicUrl = "https://summaly.example.com"

				[embed]
				enabled = true
				allowedPlugins = ["syosetu"]
				frameAncestors = ["https://misskey.example.com"]
			`);
			expect(cfg.server.publicUrl).toBe('https://summaly.example.com');
			expect(cfg.summaly.embedBaseUrl).toBe('https://summaly.example.com');
			expect(cfg.summaly.embedConfig).toEqual({
				enabled: true,
				allowedPlugins: ['syosetu'],
				frameAncestors: ['https://misskey.example.com'],
			});
		});

		test('publicUrl の末尾スラッシュは embedBaseUrl で削られる', () => {
			const cfg = parseTomlConfigString(`
				[server]
				publicUrl = "https://summaly.example.com/"

				[embed]
				allowedPlugins = ["syosetu"]
			`);
			expect(cfg.summaly.embedBaseUrl).toBe('https://summaly.example.com');
		});

		test('publicUrl 未設定でも [embed] は設定可能 (embedBaseUrl は undefined)', () => {
			// 開発環境で publicUrl 設定なしでも embed config だけ書いてエラー耐性を確認できる用途
			const cfg = parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
			`);
			expect(cfg.summaly.embedBaseUrl).toBeUndefined();
			expect(cfg.summaly.embedConfig?.enabled).toBe(true);
		});

		test('[embed] enabled = false で embedConfig.enabled = false (完全無効化)', () => {
			const cfg = parseTomlConfigString(`
				[server]
				publicUrl = "https://summaly.example.com"

				[embed]
				enabled = false
			`);
			expect(cfg.summaly.embedConfig).toEqual({
				enabled: false,
				allowedPlugins: [],
				frameAncestors: [],
			});
			// embedBaseUrl も生成しない (player.url 組み立てを防ぐ)
			expect(cfg.summaly.embedBaseUrl).toBeUndefined();
		});

		test('[embed] 未指定なら embedConfig も embedBaseUrl も undefined', () => {
			const cfg = parseTomlConfigString(`
				[server]
				publicUrl = "https://summaly.example.com"
			`);
			expect(cfg.summaly.embedConfig).toBeUndefined();
			expect(cfg.summaly.embedBaseUrl).toBeUndefined();
		});

		test('frameAncestors 省略時はデフォルト ["*"]', () => {
			const cfg = parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
			`);
			expect(cfg.summaly.embedConfig?.frameAncestors).toEqual(['*']);
		});

		test('publicUrl が http: なら RangeError (https only)', () => {
			expect(() => parseTomlConfigString(`
				[server]
				publicUrl = "http://summaly.example.com"
			`)).toThrow(/server\.publicUrl.*https/);
		});

		test('publicUrl が不正 URL なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[server]
				publicUrl = "not a url"
			`)).toThrow(/server\.publicUrl.*valid URL/);
		});

		test('publicUrl 空文字列なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[server]
				publicUrl = ""
			`)).toThrow(/server\.publicUrl.*must not be empty/);
		});

		test('[embed] enabled = true で allowedPlugins 未指定なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				enabled = true
			`)).toThrow(/embed\.allowedPlugins.*required/);
		});

		test('[embed] allowedPlugins 空配列なら RangeError (fail-close)', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				allowedPlugins = []
			`)).toThrow(/embed\.allowedPlugins.*must not be empty/);
		});

		test('[embed] frameAncestors 空配列なら RangeError', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
				frameAncestors = []
			`)).toThrow(/embed\.frameAncestors.*must not be empty/);
		});

		test('[embed] frameAncestors に CSP インジェクション (`;`) があると RangeError (M-1)', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
				frameAncestors = ["https://misskey.example.com; script-src *"]
			`)).toThrow(/embed\.frameAncestors.*invalid value/);
		});

		test('[embed] frameAncestors に path / query / fragment があると RangeError', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
				frameAncestors = ["https://misskey.example.com/path"]
			`)).toThrow(/embed\.frameAncestors.*origin only/);
		});

		test('[embed] frameAncestors に "*" / "https://x.com" / "\'self\'" / "\'none\'" は許容される', () => {
			const cfg = parseTomlConfigString(`
				[embed]
				allowedPlugins = ["syosetu"]
				frameAncestors = ["*", "https://misskey.example.com", "'self'", "'none'"]
			`);
			expect(cfg.summaly.embedConfig?.frameAncestors).toEqual(
				["*", "https://misskey.example.com", "'self'", "'none'"],
			);
		});

		test('publicUrl にクエリ / フラグメントがあっても embedBaseUrl は origin + path のみ (L-3)', () => {
			const cfg = parseTomlConfigString(`
				[server]
				publicUrl = "https://summaly.example.com?debug=1#hash"

				[embed]
				allowedPlugins = ["syosetu"]
			`);
			expect(cfg.summaly.embedBaseUrl).toBe('https://summaly.example.com');
		});

		test('[embed] enabled の型違いは TypeError', () => {
			expect(() => parseTomlConfigString(`
				[embed]
				enabled = "yes"
			`)).toThrow(/embed\.enabled.*boolean/);
		});

		test('[embed] がテーブルでないと TypeError', () => {
			expect(() => parseTomlConfigString(`
				embed = "not a table"
			`)).toThrow(/\[embed\].*must be a table/);
		});
	});
});
