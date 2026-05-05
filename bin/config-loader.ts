/**
 * TOML ベースの設定ファイル loader（phase8.1）。
 *
 * `parseTomlConfig(path)` で TOML を読み、`SummalyOptions` と `[server]` 設定にマッピングする。
 * 不正値は早期に `RangeError` / `TypeError` で fail するため、cryptic な runtime エラーを防げる。
 *
 * スキーマ詳細は `config.example.toml` 参照。
 */

import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { SummalyOptions } from '../src/index.js';

export interface ServerOptions {
	host?: string;
	port?: number;
}

export interface ParsedConfig {
	server: ServerOptions;
	summaly: SummalyOptions;
}

class ConfigError extends Error {
	override readonly name = 'ConfigError';
}

/** TOML 値の型を簡潔に表現するヘルパ */
type Toml = unknown;

function isObject(v: Toml): v is Record<string, Toml> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectType(value: Toml, expected: 'string' | 'number' | 'boolean', key: string): void {
	if (typeof value !== expected) {
		throw new TypeError(`config: \`${key}\` must be a ${expected}, got ${typeof value}`);
	}
}

function expectStringArray(value: Toml, key: string): asserts value is string[] {
	if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
		throw new TypeError(`config: \`${key}\` must be an array of strings`);
	}
}

function expectNonNegativeFiniteNumber(value: number, key: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`config: \`${key}\` must be a non-negative finite number, got ${value}`);
	}
}

function expectPort(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new RangeError(`config: \`server.port\` must be an integer in [1, 65535], got ${value}`);
	}
}

function expectPositiveInteger(value: number, key: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`config: \`${key}\` must be a positive integer, got ${value}`);
	}
}

/**
 * TOML 文字列をパースし、検証済みの `SummalyOptions` + `ServerOptions` を返す。
 * テストから直接呼べるよう、ファイル I/O は分離する（`parseTomlConfig` がラッパー）。
 */
export function parseTomlConfigString(toml: string): ParsedConfig {
	let parsed: Toml;
	try {
		parsed = parseToml(toml);
	} catch (e) {
		throw new ConfigError(`config: TOML parse error: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isObject(parsed)) {
		throw new ConfigError('config: top-level must be a TOML table');
	}

	const server = parseServerSection(parsed.server);
	const summaly = parseSummalySection(parsed.summaly, parsed.plugins, parsed.diagnostics);

	return { server, summaly };
}

function parseServerSection(raw: Toml): ServerOptions {
	if (raw === undefined) return {};
	if (!isObject(raw)) {
		throw new TypeError('config: `[server]` must be a table');
	}
	const out: ServerOptions = {};
	if (raw.host !== undefined) {
		expectType(raw.host, 'string', 'server.host');
		const h = (raw.host as string).trim();
		// 空文字列は Fastify / Node の listen で `::` (IPv6 全インターフェース) になり、
		// SUMMALY_ALLOW_PRIVATE_IP=true と組み合わさると SSRF リレー化リスクがあるため弾く。
		if (h === '') {
			throw new RangeError('config: `server.host` must not be empty (use "127.0.0.1" or "0.0.0.0" explicitly)');
		}
		out.host = h;
	}
	if (raw.port !== undefined) {
		expectType(raw.port, 'number', 'server.port');
		expectPort(raw.port as number);
		out.port = raw.port as number;
	}
	return out;
}

function parseSummalySection(rawSummaly: Toml, rawPlugins: Toml, rawDiagnostics: Toml): SummalyOptions {
	const out: SummalyOptions = {};
	const summaly = rawSummaly === undefined ? {} : rawSummaly;
	if (!isObject(summaly)) {
		throw new TypeError('config: `[summaly]` must be a table');
	}

	if (summaly.userAgent !== undefined) {
		expectType(summaly.userAgent, 'string', 'summaly.userAgent');
		out.userAgent = summaly.userAgent as string;
	}
	if (summaly.contentLengthRequired !== undefined) {
		expectType(summaly.contentLengthRequired, 'boolean', 'summaly.contentLengthRequired');
		out.contentLengthRequired = summaly.contentLengthRequired as boolean;
	}
	if (summaly.useRange !== undefined) {
		expectType(summaly.useRange, 'boolean', 'summaly.useRange');
		out.useRange = summaly.useRange as boolean;
	}

	// [summaly] 直下の数値フィールドを一括処理（[summaly.cache] / [summaly.pdf] は後述で別処理）
	const numericChecks: { key: string; src: Toml; assignTo: keyof SummalyOptions }[] = [
		{ key: 'summaly.responseTimeout', src: summaly.responseTimeout, assignTo: 'responseTimeout' },
		{ key: 'summaly.operationTimeout', src: summaly.operationTimeout, assignTo: 'operationTimeout' },
		{ key: 'summaly.contentLengthLimit', src: summaly.contentLengthLimit, assignTo: 'contentLengthLimit' },
	];
	for (const { key, src, assignTo } of numericChecks) {
		if (src === undefined) continue;
		expectType(src, 'number', key);
		expectNonNegativeFiniteNumber(src as number, key);
		(out as Record<string, unknown>)[assignTo] = src;
	}

	// [summaly.cache]
	if (summaly.cache !== undefined) {
		if (!isObject(summaly.cache)) {
			throw new TypeError('config: `[summaly.cache]` must be a table');
		}
		const c = summaly.cache;
		if (c.maxAge !== undefined) {
			expectType(c.maxAge, 'number', 'summaly.cache.maxAge');
			expectNonNegativeFiniteNumber(c.maxAge as number, 'summaly.cache.maxAge');
			out.cacheMaxAge = c.maxAge as number;
		}
		if (c.errorMaxAge !== undefined) {
			expectType(c.errorMaxAge, 'number', 'summaly.cache.errorMaxAge');
			expectNonNegativeFiniteNumber(c.errorMaxAge as number, 'summaly.cache.errorMaxAge');
			out.cacheErrorMaxAge = c.errorMaxAge as number;
		}
		if (c.inMemory !== undefined) {
			expectType(c.inMemory, 'boolean', 'summaly.cache.inMemory');
			out.inMemoryCache = c.inMemory as boolean;
		}
		if (c.inMemoryMaxEntries !== undefined) {
			expectType(c.inMemoryMaxEntries, 'number', 'summaly.cache.inMemoryMaxEntries');
			expectNonNegativeFiniteNumber(c.inMemoryMaxEntries as number, 'summaly.cache.inMemoryMaxEntries');
			out.inMemoryCacheMaxEntries = c.inMemoryMaxEntries as number;
		}
		if (c.inFlightDedup !== undefined) {
			expectType(c.inFlightDedup, 'boolean', 'summaly.cache.inFlightDedup');
			out.inFlightDedup = c.inFlightDedup as boolean;
		}
	}

	// [summaly.pdf]
	if (summaly.pdf !== undefined) {
		if (!isObject(summaly.pdf)) {
			throw new TypeError('config: `[summaly.pdf]` must be a table');
		}
		if (summaly.pdf.enabled !== undefined) {
			expectType(summaly.pdf.enabled, 'boolean', 'summaly.pdf.enabled');
			out.enablePdf = summaly.pdf.enabled as boolean;
		}
	}

	// [plugins]
	if (rawPlugins !== undefined) {
		if (!isObject(rawPlugins)) {
			throw new TypeError('config: `[plugins]` must be a table');
		}
		if (rawPlugins.allowed !== undefined) {
			expectStringArray(rawPlugins.allowed, 'plugins.allowed');
			out.allowedPlugins = rawPlugins.allowed;
		}
		// `[plugins.<name>]` セクションは将来拡張用 placeholder として読み飛ばす（無視）。
		// 個別プラグインへの options 受け渡し機構は本フェーズではスコープ外。
	}

	// [diagnostics] (phase10.1)
	if (rawDiagnostics !== undefined) {
		if (!isObject(rawDiagnostics)) {
			throw new TypeError('config: `[diagnostics]` must be a table');
		}
		const d = rawDiagnostics;
		if (d.parseFailureLog !== undefined) {
			expectType(d.parseFailureLog, 'boolean', 'diagnostics.parseFailureLog');
			out.parseFailureLog = d.parseFailureLog as boolean;
		}
		if (d.parseFailureLogMaxGroups !== undefined) {
			expectType(d.parseFailureLogMaxGroups, 'number', 'diagnostics.parseFailureLogMaxGroups');
			expectPositiveInteger(d.parseFailureLogMaxGroups as number, 'diagnostics.parseFailureLogMaxGroups');
			out.parseFailureLogMaxGroups = d.parseFailureLogMaxGroups as number;
		}
		if (d.parseFailureLogSamplesPerGroup !== undefined) {
			expectType(d.parseFailureLogSamplesPerGroup, 'number', 'diagnostics.parseFailureLogSamplesPerGroup');
			expectPositiveInteger(d.parseFailureLogSamplesPerGroup as number, 'diagnostics.parseFailureLogSamplesPerGroup');
			out.parseFailureLogSamplesPerGroup = d.parseFailureLogSamplesPerGroup as number;
		}
		if (d.parseFailureLogEndpoint !== undefined) {
			expectType(d.parseFailureLogEndpoint, 'boolean', 'diagnostics.parseFailureLogEndpoint');
			out.parseFailureLogEndpoint = d.parseFailureLogEndpoint as boolean;
		}
		if (d.parseFailureLogJsonlPath !== undefined) {
			expectType(d.parseFailureLogJsonlPath, 'string', 'diagnostics.parseFailureLogJsonlPath');
			const path = (d.parseFailureLogJsonlPath as string).trim();
			if (path === '') {
				throw new RangeError('config: `diagnostics.parseFailureLogJsonlPath` must not be empty');
			}
			out.parseFailureLogJsonlPath = path;
		}
		if (d.parseFailureLogJsonlMaxBytes !== undefined) {
			expectType(d.parseFailureLogJsonlMaxBytes, 'number', 'diagnostics.parseFailureLogJsonlMaxBytes');
			expectNonNegativeFiniteNumber(d.parseFailureLogJsonlMaxBytes as number, 'diagnostics.parseFailureLogJsonlMaxBytes');
			out.parseFailureLogJsonlMaxBytes = d.parseFailureLogJsonlMaxBytes as number;
		}
	}

	return out;
}

/**
 * TOML ファイルを読み込み、検証済みの `SummalyOptions` + `ServerOptions` を返す。
 * 失敗時は `ConfigError` / `TypeError` / `RangeError` で fail-fast する。
 */
export function parseTomlConfig(path: string): ParsedConfig {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (e) {
		throw new ConfigError(`config: failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	return parseTomlConfigString(text);
}
