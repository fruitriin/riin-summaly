/**
 * bin/config-loader.ts の単体テスト (phase8.1, phase16.3 で大幅書き直し)。
 *
 * phase16.3 の breaking change:
 * - 旧 `[server].publicUrl` → `[embed].publicUrl` 移動
 * - `[embed].allowedPlugins` 削除 (Fastify auto-init 側で renderEmbed × `[plugins].allowed` から auto-fill)
 * - `[scraping.proxy].categories` / `domains` / `[scraping.curl_cffi].categories` / `domains` / `[scraping.fallback].categories` 削除
 *   (コード側 default 固定 + bootstrap.jsonl から domains 自動導出)
 * - 各セクションで `expectKnownKeys` 起動失敗化 (旧キー silent ignore 廃止)
 * - 経路依存 fail-fast (bootstrap × enabled 不整合で起動失敗)
 * - `parseFailureLog` の Path ペア + デフォルトパス
 * - `useRange` の internal default を true に
 */

import { describe, expect, test } from 'vitest';
import { parseTomlConfigString } from '../bin/config-loader.js';

describe('parseTomlConfigString — 基本パース', () => {
	test('空文字列は server={} / summaly={ useRange: true } を返す (phase16.3 useRange default 変更)', () => {
		const cfg = parseTomlConfigString('');
		expect(cfg.server).toEqual({});
		expect(cfg.summaly.useRange).toBe(true);
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
			userAgent = "TestBot/1.0"
			responseTimeout = 5000
			operationTimeout = 30000
			contentLengthLimit = 1048576
			contentLengthRequired = true
			useRange = false
		`);
		expect(cfg.summaly).toMatchObject({
			userAgent: 'TestBot/1.0',
			responseTimeout: 5000,
			operationTimeout: 30000,
			contentLengthLimit: 1048576,
			contentLengthRequired: true,
			useRange: false,
		});
	});

	test('[summaly.cache] / [summaly.pdf] / [plugins] を再マップする', () => {
		const cfg = parseTomlConfigString(`
			[summaly.cache]
			maxAge = 3600
			errorMaxAge = 60
			inMemory = true
			inMemoryMaxEntries = 500
			inFlightDedup = true

			[summaly.pdf]
			enabled = true

			[plugins]
			allowed = ["youtube", "spotify"]
		`);
		expect(cfg.summaly.cacheMaxAge).toBe(3600);
		expect(cfg.summaly.cacheErrorMaxAge).toBe(60);
		expect(cfg.summaly.inMemoryCache).toBe(true);
		expect(cfg.summaly.inMemoryCacheMaxEntries).toBe(500);
		expect(cfg.summaly.inFlightDedup).toBe(true);
		expect(cfg.summaly.enablePdf).toBe(true);
		expect(cfg.summaly.allowedPlugins).toEqual(['youtube', 'spotify']);
	});

	test('[plugins.<name>] サブセクションは現状無視される（将来拡張用 placeholder）', () => {
		const cfg = parseTomlConfigString(`
			[plugins]
			allowed = ["amazon"]

			[plugins.komiflo]
			preferredVariant = "346_mobile"
		`);
		expect(cfg.summaly.allowedPlugins).toEqual(['amazon']);
	});

	test('TOML 構文エラーは ConfigError 系で throw する', () => {
		expect(() => parseTomlConfigString('{ invalid')).toThrow(/TOML parse error/);
	});

	test('型違いは TypeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[server]
			port = "8080"
		`)).toThrow(TypeError);
	});

	test('負数 / 非有限の数値は RangeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[summaly]
			responseTimeout = -1
		`)).toThrow(/non-negative finite/);
	});

	test('server.host 空文字列は RangeError で弾かれる（SSRF リレー化対策）', () => {
		expect(() => parseTomlConfigString(`
			[server]
			host = ""
		`)).toThrow(/server\.host.*must not be empty/);
	});

	test('ポート範囲外は RangeError で throw する', () => {
		expect(() => parseTomlConfigString(`
			[server]
			port = 99999
		`)).toThrow(/server\.port.*\[1, 65535\]/);
	});

	test('空配列の plugins.allowed は組み込み全 disable を意味する', () => {
		const cfg = parseTomlConfigString(`
			[plugins]
			allowed = []
		`);
		expect(cfg.summaly.allowedPlugins).toEqual([]);
	});
});

describe('parseTomlConfigString — phase16.3 unknown key 起動失敗 (expectKnownKeys)', () => {
	test('トップレベルの未知キーで起動失敗', () => {
		expect(() => parseTomlConfigString(`
			unknown_top_level = true
		`)).toThrow(/unknown key '\.unknown_top_level'/);
	});

	test('[server] の未知キーで起動失敗 (phase16.3 で publicUrl も unknown)', () => {
		expect(() => parseTomlConfigString(`
			[server]
			publicUrl = "https://example.com"
		`)).toThrow(/unknown key 'server\.publicUrl'/);
	});

	test('[summaly] の未知キーで起動失敗', () => {
		expect(() => parseTomlConfigString(`
			[summaly]
			fakeKey = true
		`)).toThrow(/unknown key 'summaly\.fakeKey'/);
	});

	test('[scraping.proxy] の未知キーで起動失敗 (phase16.3 で categories / domains も unknown)', () => {
		expect(() => parseTomlConfigString(`
			[scraping.proxy]
			enabled = false
			categories = ["origin_error"]
		`)).toThrow(/unknown key 'scraping\.proxy\.categories'/);
	});

	test('[scraping.curl_cffi] の未知キーで起動失敗', () => {
		expect(() => parseTomlConfigString(`
			[scraping.curl_cffi]
			enabled = false
			domains = ["yodobashi.com"]
		`)).toThrow(/unknown key 'scraping\.curl_cffi\.domains'/);
	});

	test('[scraping.fallback] の未知キーで起動失敗 (phase16.3 で categories も unknown)', () => {
		expect(() => parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
			categories = ["bot_blocked"]
		`)).toThrow(/unknown key 'scraping\.fallback\.categories'/);
	});

	test('[embed] の未知キーで起動失敗 (phase16.3 で allowedPlugins も unknown)', () => {
		expect(() => parseTomlConfigString(`
			[embed]
			enabled = true
			allowedPlugins = ["syosetu"]
		`)).toThrow(/unknown key 'embed\.allowedPlugins'/);
	});

	test('[diagnostics] の未知キーで起動失敗 (phase16.3 で parseFailureLogEndpoint も unknown — 旧 phase11.5 silent ignore 撤廃)', () => {
		expect(() => parseTomlConfigString(`
			[diagnostics]
			parseFailureLogEndpoint = true
		`)).toThrow(/unknown key 'diagnostics\.parseFailureLogEndpoint'/);
	});
});

describe('parseTomlConfigString — [scraping.fallback]', () => {
	test('userAgent をマップ + categories はコード側 default 固定 (phase16.3)', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
			userAgent = "Mozilla/5.0 (custom)"
		`);
		expect(cfg.summaly.fallbackUserAgent).toBe('Mozilla/5.0 (custom)');
		expect(cfg.summaly.fallbackRetryCategories).toEqual(['bot_blocked', 'connection_dropped']);
	});

	test('userAgent 省略時はデフォルト UA (facebookexternalhit) を採用', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
		`);
		expect(cfg.summaly.fallbackUserAgent).toContain('facebookexternalhit');
	});

	test('enabled = false でリトライ無効', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = false
		`);
		expect(cfg.summaly.fallbackUserAgent).toBeUndefined();
		expect(cfg.summaly.fallbackRetryCategories).toBeUndefined();
	});

	test('phase18: hedgedThresholdMs を SummalyOptions に伝搬', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
			hedgedThresholdMs = 3000
		`);
		expect(cfg.summaly.hedgedThresholdMs).toBe(3000);
	});

	test('phase18: hedgedThresholdMs 省略時は undefined (default 5000 はコード側で適用)', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
		`);
		expect(cfg.summaly.hedgedThresholdMs).toBeUndefined();
	});

	test('phase18: hedgedThresholdMs = 0 (即時並列発火、debug 用) も valid', () => {
		const cfg = parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
			hedgedThresholdMs = 0
		`);
		expect(cfg.summaly.hedgedThresholdMs).toBe(0);
	});

	test('phase18: hedgedThresholdMs が負数なら起動失敗', () => {
		expect(() => parseTomlConfigString(`
			[scraping.fallback]
			enabled = true
			hedgedThresholdMs = -1
		`)).toThrow(/non-negative/);
	});
});

describe('parseTomlConfigString — [scraping.proxy] (phase12.1, phase16.3 で domains 自動導出)', () => {
	test('enabled = true + url + secret + 同梱 bootstrap → proxyFallback マップ + domains 自動導出', () => {
		// 同梱 bootstrap (`data/domain-strategy-bootstrap.jsonl`) には proxy / curl_cffi 両方の entry が
		// 入っているので、proxy だけ単独テストするには curl_cffi も enabled = true にする必要がある。
		const cfg = parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = true

			[scraping.proxy]
			enabled = true
			url = "https://summaly-proxy.test.workers.dev"
			secret = "test-secret"

			[scraping.curl_cffi]
			enabled = true
			projectDir = "/path/to/curl-cffi-fetcher"
		`);
		expect(cfg.summaly.proxyFallback).toBeDefined();
		expect(cfg.summaly.proxyFallback?.url).toBe('https://summaly-proxy.test.workers.dev');
		expect(cfg.summaly.proxyFallback?.secret).toBe('test-secret');
		// phase18.1: categories / domains 撤廃 (hedge race ですべての URL に対して並列発火)
	});

	test('enabled = false で proxyFallback は undefined', () => {
		const cfg = parseTomlConfigString(`
			[scraping.proxy]
			enabled = false
		`);
		expect(cfg.summaly.proxyFallback).toBeUndefined();
	});

	test('enabled = true で url 未指定なら起動失敗', () => {
		expect(() => parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = false

			[scraping.proxy]
			enabled = true
			secret = "x"
		`)).toThrow(/scraping\.proxy\.url.*required/);
	});

	test('enabled = true で secret 未設定なら起動失敗 (phase16.3 で warning + 無効化を fail-fast に変更)', () => {
		const prev = process.env.SUMMALY_PROXY_SECRET;
		delete process.env.SUMMALY_PROXY_SECRET;
		try {
			expect(() => parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = false

				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
			`)).toThrow(/secret.*未設定/);
		} finally {
			if (prev !== undefined) process.env.SUMMALY_PROXY_SECRET = prev;
		}
	});

	test('env SUMMALY_PROXY_SECRET が config の secret より優先される', () => {
		const prev = process.env.SUMMALY_PROXY_SECRET;
		process.env.SUMMALY_PROXY_SECRET = 'env-secret';
		try {
			// strategy_cache 無効で bootstrap 読まないが、proxy enabled=true で domains 空エラーが出るので
			// bootstrap 不在のテスト用 path を渡して空でも成立させる
			const cfg = parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = true
				bootstrapPath = "/tmp/nonexistent-bootstrap-${Date.now()}.jsonl"

				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "config-secret"
			`);
			// bootstrap 不在なので domains が空 → そもそも proxyFallback は domain check で起動失敗するはず
			// 修正: 非存在 bootstrap だと domains 空で起動失敗。secret 優先テストとしては bootstrap 不在では確認不能
			// 同梱 bootstrap を使い curl_cffi も同時 enable する形で書き直す
			void cfg;
		} catch {
			// 上記は domains 空で起動失敗するためここに来る (= proxy.secret テストとしては別の経路)
		}
		// 同梱 bootstrap + curl_cffi 同時有効化で本来の secret 優先確認
		try {
			const cfg = parseTomlConfigString(`
				[scraping.strategy_cache]
				enabled = true

				[scraping.proxy]
				enabled = true
				url = "https://x.workers.dev"
				secret = "config-secret"

				[scraping.curl_cffi]
				enabled = true
				projectDir = "/path"
			`);
			expect(cfg.summaly.proxyFallback?.secret).toBe('env-secret');
		} finally {
			if (prev === undefined) delete process.env.SUMMALY_PROXY_SECRET;
			else process.env.SUMMALY_PROXY_SECRET = prev;
		}
	});

	// phase18.1: bootstrap 自動導出 + domains 起動失敗ロジックを撤廃したので
	// 「bootstrap に proxy 経路のエントリが無いと起動失敗」テストは削除。
	test('phase18.1: strategy_cache 無効 + proxy enabled でも bootstrap entry 不要で起動成功', () => {
		const cfg = parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = false

			[scraping.proxy]
			enabled = true
			url = "https://x.workers.dev"
			secret = "s"
		`);
		expect(cfg.summaly.proxyFallback?.enabled).toBe(true);
	});
});

describe('parseTomlConfigString — [scraping.curl_cffi] (phase12.5, phase16.3 で domains 自動導出)', () => {
	test('enabled = true + projectDir + 同梱 bootstrap → curlCffiFallback マップ + domains 自動導出', () => {
		// 同梱 bootstrap には proxy entry もあるので、proxy も enabled = true にする必要がある。
		const cfg = parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = true

			[scraping.proxy]
			enabled = true
			url = "https://x.workers.dev"
			secret = "s"

			[scraping.curl_cffi]
			enabled = true
			projectDir = "/path/to/curl-cffi-fetcher"
		`);
		expect(cfg.summaly.curlCffiFallback).toBeDefined();
		expect(cfg.summaly.curlCffiFallback?.projectDir).toBe('/path/to/curl-cffi-fetcher');
		expect(cfg.summaly.curlCffiFallback?.uvPath).toBe('uv');
		expect(cfg.summaly.curlCffiFallback?.impersonate).toBe('chrome120');
		// phase18.1: categories / domains 撤廃 (hedge race ですべての URL に対して並列発火)
	});

	test('enabled = true で projectDir 未指定なら起動失敗', () => {
		expect(() => parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = false

			[scraping.curl_cffi]
			enabled = true
		`)).toThrow(/scraping\.curl_cffi\.projectDir.*required/);
	});
});

// phase18.1: 経路依存 fail-fast (bootstrap × enabled 不整合で起動失敗) は撤廃。
// hedge race ですべての URL に対して全 strategy 並列発火するため、bootstrap entry なしでも
// 起動失敗にしない (host allowlist 不要化)。該当 describe は削除。

describe('parseTomlConfigString — [scraping.strategy_cache]', () => {
	test('enabled = false で domainStrategyCache 未設定 (経路依存チェックも走らない)', () => {
		const cfg = parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = false
		`);
		expect(cfg.summaly.domainStrategyCache).toBeUndefined();
	});

	test('runtimePath / maxEntries マップ (enabled = true + テスト用 bootstrap 不在 path で経路依存チェック skip)', () => {
		const cfg = parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = true
			bootstrapPath = "/tmp/nonexistent-bootstrap-${Date.now()}.jsonl"
			runtimePath = "/tmp/test-runtime.jsonl"
			maxEntries = 100
			consecutiveFailureThreshold = 5
			compactionThreshold = 200
		`);
		expect(cfg.summaly.domainStrategyCache?.enabled).toBe(true);
		expect(cfg.summaly.domainStrategyCache?.runtimePath).toBe('/tmp/test-runtime.jsonl');
		expect(cfg.summaly.domainStrategyCache?.maxEntries).toBe(100);
		expect(cfg.summaly.domainStrategyCache?.consecutiveFailureThreshold).toBe(5);
		expect(cfg.summaly.domainStrategyCache?.compactionThreshold).toBe(200);
	});

	test('bootstrapPath 空文字は RangeError', () => {
		expect(() => parseTomlConfigString(`
			[scraping.strategy_cache]
			enabled = true
			bootstrapPath = ""
		`)).toThrow(/bootstrapPath.*must not be empty/);
	});
});

describe('parseTomlConfigString — [embed] (phase13.1, phase16.3 改修)', () => {
	test('enabled = true + publicUrl で embedConfig + embedBaseUrl がマップされる (phase16.3 で publicUrl が embed 配下に移動)', () => {
		const cfg = parseTomlConfigString(`
			[embed]
			enabled = true
			publicUrl = "https://summaly.example.com"
		`);
		expect(cfg.summaly.embedConfig?.enabled).toBe(true);
		expect(cfg.summaly.embedConfig?.frameAncestors).toEqual(['*']);
		// allowedPlugins は src/index.ts の auto-init で auto-fill されるため、ここでは空配列
		expect(cfg.summaly.embedConfig?.allowedPlugins).toEqual([]);
		expect(cfg.summaly.embedBaseUrl).toBe('https://summaly.example.com');
	});

	test('enabled = false で embedConfig.enabled = false (完全無効化)', () => {
		const cfg = parseTomlConfigString(`
			[embed]
			enabled = false
		`);
		expect(cfg.summaly.embedConfig?.enabled).toBe(false);
		expect(cfg.summaly.embedBaseUrl).toBeUndefined();
	});

	test('publicUrl 未設定でも embedConfig.enabled は true、embedBaseUrl だけ undefined', () => {
		const cfg = parseTomlConfigString(`
			[embed]
			enabled = true
		`);
		expect(cfg.summaly.embedConfig?.enabled).toBe(true);
		expect(cfg.summaly.embedBaseUrl).toBeUndefined();
	});

	test('publicUrl が http (非 https) なら起動失敗 (XSS 踏み台防止)', () => {
		expect(() => parseTomlConfigString(`
			[embed]
			enabled = true
			publicUrl = "http://example.com"
		`)).toThrow(/embed\.publicUrl.*https:/);
	});

	test('frameAncestors の origin only 検証 (CSP インジェクション防御)', () => {
		expect(() => parseTomlConfigString(`
			[embed]
			enabled = true
			frameAncestors = ["https://example.com; script-src *"]
		`)).toThrow(/embed\.frameAncestors.*must be a URL/);
	});
});

describe('parseTomlConfigString — phase16.3 parseFailureLog ペア + デフォルト', () => {
	test('parseFailureLog = true + Path 未指定なら両方デフォルトパスが適用される', () => {
		const cfg = parseTomlConfigString(`
			[diagnostics]
			parseFailureLog = true
		`);
		expect(cfg.summaly.parseFailureLog).toBe(true);
		expect(cfg.summaly.parseFailureLogJsonlPath).toBe('./data/parse-failures.jsonl');
		expect(cfg.summaly.parseFailureLogBlockedJsonlPath).toBe('./data/parse-failures-blocked.jsonl');
	});

	test('parseFailureLog = true + Path 両方明示なら明示値が使われる', () => {
		const cfg = parseTomlConfigString(`
			[diagnostics]
			parseFailureLog = true
			parseFailureLogJsonlPath = "/var/log/summaly/pf.jsonl"
			parseFailureLogBlockedJsonlPath = "/var/log/summaly/pfb.jsonl"
		`);
		expect(cfg.summaly.parseFailureLogJsonlPath).toBe('/var/log/summaly/pf.jsonl');
		expect(cfg.summaly.parseFailureLogBlockedJsonlPath).toBe('/var/log/summaly/pfb.jsonl');
	});

	test('parseFailureLog = true で片方だけ Path 指定すると起動失敗 (ペア違反)', () => {
		expect(() => parseTomlConfigString(`
			[diagnostics]
			parseFailureLog = true
			parseFailureLogJsonlPath = "/var/log/summaly/pf.jsonl"
		`)).toThrow(/ペアで指定するか.*両方とも未指定/);
	});

	test('parseFailureLog = false なら Path はデフォルト適用されない', () => {
		const cfg = parseTomlConfigString(`
			[diagnostics]
			parseFailureLog = false
		`);
		expect(cfg.summaly.parseFailureLog).toBe(false);
		expect(cfg.summaly.parseFailureLogJsonlPath).toBeUndefined();
		expect(cfg.summaly.parseFailureLogBlockedJsonlPath).toBeUndefined();
	});
});

describe('parseTomlConfigString — example ファイルの起動互換性', () => {
	test('config.example.toml (root) が parse error なくロードできる', async () => {
		const fs = await import('node:fs');
		const text = fs.readFileSync('config.example.toml', 'utf8');
		expect(() => parseTomlConfigString(text)).not.toThrow();
	});

	test('docs/deploy-examples/summaly-config.example.toml が parse error なくロードできる', async () => {
		const fs = await import('node:fs');
		const text = fs.readFileSync('docs/deploy-examples/summaly-config.example.toml', 'utf8');
		expect(() => parseTomlConfigString(text)).not.toThrow();
	});
});
