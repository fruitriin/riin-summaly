/**
 * 起動時 healthcheck (phase16.4) の単体テスト。
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigHealthchecks } from '../bin/healthcheck.js';
import type { ParsedConfig } from '../bin/config-loader.js';

function emptyConfig(): ParsedConfig {
	return { server: {}, summaly: {} };
}

describe('runConfigHealthchecks — proxy', () => {
	test('placeholder URL `<your>.workers.dev` で起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.proxyFallback = {
			enabled: true,
			url: 'https://summaly-proxy.<your>.workers.dev',
			secret: 'real-secret',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/scraping\.proxy\.url が placeholder/);
	});

	test('placeholder secret `...` で起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.proxyFallback = {
			enabled: true,
			url: 'https://real-proxy.workers.dev',
			secret: '...',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/scraping\.proxy\.secret が placeholder/);
	});

	test('placeholder secret `<...>` 形式でも起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.proxyFallback = {
			enabled: true,
			url: 'https://real-proxy.workers.dev',
			secret: '<your-shared-secret>',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/scraping\.proxy\.secret が placeholder/);
	});

	test('実値設定なら通過', () => {
		const cfg = emptyConfig();
		cfg.summaly.proxyFallback = {
			enabled: true,
			url: 'https://real-proxy.workers.dev',
			secret: 'real-shared-secret',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});

	test('proxyFallback 未設定なら何もチェックしない', () => {
		const cfg = emptyConfig();
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});
});

describe('runConfigHealthchecks — curl_cffi', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'summaly-healthcheck-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('placeholder projectDir `/path/to/...` で起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.curlCffiFallback = {
			enabled: true,
			projectDir: '/path/to/summaly/tools/curl-cffi-fetcher',
			uvPath: 'uv',
			impersonate: 'chrome120',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/curl_cffi\.projectDir が placeholder/);
	});

	test('存在しない projectDir で起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.curlCffiFallback = {
			enabled: true,
			projectDir: '/nonexistent/dir/' + Date.now(),
			uvPath: 'uv',
			impersonate: 'chrome120',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/projectDir が存在しません/);
	});

	test('uvPath が PATH に無い + 実行不可で起動失敗', () => {
		const cfg = emptyConfig();
		const subDir = join(tmpDir, 'curl-cffi-fetcher');
		mkdirSync(subDir);
		cfg.summaly.curlCffiFallback = {
			enabled: true,
			projectDir: subDir,
			uvPath: '/nonexistent/uv-binary-' + Date.now(),
			impersonate: 'chrome120',
			timeoutMs: 30000,
		};
		expect(() => runConfigHealthchecks(cfg)).toThrow(/uv が実行できません|uv 実行で例外/);
	});

	test('curlCffiFallback 未設定なら何もチェックしない', () => {
		const cfg = emptyConfig();
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});

	test('enabled = false なら何もチェックしない (placeholder でも通過)', () => {
		const cfg = emptyConfig();
		cfg.summaly.curlCffiFallback = {
			enabled: false,
			projectDir: '/path/to/x',
			uvPath: '/nonexistent/uv',
			impersonate: 'chrome120',
			timeoutMs: 30000,
		} as never;
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});
});

describe('runConfigHealthchecks — embed', () => {
	test('placeholder publicUrl で起動失敗', () => {
		const cfg = emptyConfig();
		cfg.summaly.embedConfig = { enabled: true, allowedPlugins: ['syosetu'], frameAncestors: ['*'] };
		cfg.summaly.embedBaseUrl = 'https://summaly.<your-domain>.com';
		expect(() => runConfigHealthchecks(cfg)).toThrow(/embed\.publicUrl が placeholder/);
	});

	test('実 publicUrl 設定なら通過', () => {
		const cfg = emptyConfig();
		cfg.summaly.embedConfig = { enabled: true, allowedPlugins: ['syosetu'], frameAncestors: ['*'] };
		cfg.summaly.embedBaseUrl = 'https://summaly.example.com';
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});

	test('embed.enabled = true + publicUrl 未設定 は warning のみで起動は通る', () => {
		const cfg = emptyConfig();
		cfg.summaly.embedConfig = { enabled: true, allowedPlugins: ['syosetu'], frameAncestors: ['*'] };
		cfg.summaly.embedBaseUrl = undefined;
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});

	test('embed.enabled = false なら何もチェックしない', () => {
		const cfg = emptyConfig();
		cfg.summaly.embedConfig = { enabled: false, allowedPlugins: [], frameAncestors: [] };
		cfg.summaly.embedBaseUrl = 'https://summaly.<placeholder>.com';
		expect(() => runConfigHealthchecks(cfg)).not.toThrow();
	});
});
