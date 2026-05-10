/**
 * TOML ベースの設定ファイル loader。
 *
 * `parseTomlConfig(path)` で TOML を読み、`SummalyOptions` と `[server]` 設定にマッピングする。
 * 不正値は早期に `RangeError` / `TypeError` で fail するため、cryptic な runtime エラーを防げる。
 *
 * スキーマ詳細は `config.example.toml` 参照。
 */

import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { SummalyOptions } from '../src/index.js';
import { DEFAULT_FALLBACK_UA } from '../src/utils/got.js';

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
 * セクション内の未知キーを起動失敗で検出する。
 *
 * smol-toml は unknown key を silent ignore するため、旧キー (`[scraping.proxy].domains` 等) や
 * typo を黙って受け流してしまう。「動かないが気付けない」状態を防ぐため、各セクションで
 * allowed キーを明示する fail-fast 設計を採用。
 *
 * `[plugins.<name>]` のような placeholder セクションは unknown キーになるため例外的に skip する場合がある。
 */
function expectKnownKeys(obj: Record<string, Toml>, allowed: readonly string[], path: string): void {
	for (const k of Object.keys(obj)) {
		if (!allowed.includes(k)) {
			throw new RangeError(
				`config: unknown key '${path}.${k}'. valid keys: ${allowed.join(', ')}. `
				+ `(削除/移動された可能性があります — DEPRECATED.md を参照してください)`,
			);
		}
	}
}

// phase18.1: proxy / curl_cffi の `categories` / `domains` は撤廃。
// hedge race ですべての URL に対して全 strategy が並列発火する。
const DEFAULT_FALLBACK_CATEGORIES: NonNullable<SummalyOptions['fallbackRetryCategories']>
	= ['bot_blocked', 'connection_dropped'];

/**
 * `parseFailureLog = true` 時のデフォルトパス。
 *
 * 運用者が `parseFailureLog = true` だけ書けば集約が動くようにペア制御 + デフォルト適用。
 * cwd 相対の `./data/` (bootstrap.jsonl と同階層) で grep / jq しやすく一貫性確保。
 * `.gitignore` で `data/parse-failures*.jsonl` を除外するので git status を汚さない。
 */
const DEFAULT_PARSE_FAILURE_LOG_JSONL_PATH = './data/parse-failures.jsonl';
const DEFAULT_PARSE_FAILURE_LOG_BLOCKED_JSONL_PATH = './data/parse-failures-blocked.jsonl';

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

	// トップレベルの未知キーも fail-fast。`[plugins.<name>]` のような placeholder
	// (将来拡張用) も含むため `plugins` だけは例外的に許容する判断はしない (placeholder は plugins 配下のみ)。
	expectKnownKeys(parsed, TOP_LEVEL_KEYS, '');

	const server = parseServerSection(parsed.server);
	const summaly = parseSummalySection(parsed.summaly, parsed.plugins, parsed.diagnostics);
	parseScrapingSection(parsed.scraping, summaly);
	parseEmbedSection(parsed.embed, summaly);

	return { server, summaly };
}

const TOP_LEVEL_KEYS = ['server', 'summaly', 'scraping', 'plugins', 'diagnostics', 'embed'] as const;

/**
 * `[embed]` セクションを処理し、`SummalyOptions.embedBaseUrl` / `embedConfig` にマップする。
 *
 * - `enabled` が省略 / true で `publicUrl` が設定済なら embed 有効化、`embedBaseUrl` を投入
 * - `enabled = false` なら `embedConfig.enabled = false` で完全無効化 (= /embed が 404、player.url も生成しない)
 * - `publicUrl` 未設定なら embed は実質無効 (embedConfig は作るが embedBaseUrl は undefined のまま)
 * - `frameAncestors` 省略時は `["*"]` (デフォルト全許可、商用は config で制限推奨)
 * - `allowedPlugins` は持たない。`renderEmbed` 実装プラグインで `[plugins].allowed` に含まれるものを
 *   src/index.ts の Fastify auto-init 側で自動構成 (詳細は src/index.ts 参照)
 */
const EMBED_KEYS = ['enabled', 'publicUrl', 'frameAncestors'] as const;
function parseEmbedSection(rawEmbed: Toml, summaly: SummalyOptions): void {
	if (rawEmbed === undefined) return;
	if (!isObject(rawEmbed)) {
		throw new TypeError('config: `[embed]` must be a table');
	}
	expectKnownKeys(rawEmbed, EMBED_KEYS, 'embed');

	let enabled = true;
	if (rawEmbed.enabled !== undefined) {
		expectType(rawEmbed.enabled, 'boolean', 'embed.enabled');
		enabled = rawEmbed.enabled as boolean;
	}
	if (!enabled) {
		// 完全無効化: embedConfig.enabled = false で /embed が 404、player.url も組み立てられない
		summaly.embedConfig = { enabled: false, allowedPlugins: [], frameAncestors: [] };
		return;
	}

	let frameAncestors: string[] = ['*'];
	if (rawEmbed.frameAncestors !== undefined) {
		expectStringArray(rawEmbed.frameAncestors, 'embed.frameAncestors');
		const v = rawEmbed.frameAncestors;
		if (v.length === 0) {
			throw new RangeError('config: `embed.frameAncestors` must not be empty (use ["*"] explicitly for全許可)');
		}
		// **CSP ヘッダインジェクション防御 (security review M-1)**: 各要素は `https://hostname[:port]` /
		// `*` / `'self'` / `'none'` のいずれかであることを厳格検証。`;` `,` 空白などを含むと
		// CSP ディレクティブを上書きできてしまう (例: `https://x.com; script-src *` で script-src を緩める)。
		for (const origin of v) {
			if (origin === '*' || origin === "'self'" || origin === "'none'") continue;
			let parsed: URL;
			try {
				parsed = new URL(origin);
			} catch {
				throw new RangeError(`config: \`embed.frameAncestors\` contains invalid value "${origin}" (must be a URL, "*", "'self'", or "'none'")`);
			}
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				throw new RangeError(`config: \`embed.frameAncestors\` "${origin}" must use http(s): scheme`);
			}
			// pathname / query / hash がある = origin だけでない → ヘッダインジェクション疑いとして弾く
			if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
				throw new RangeError(`config: \`embed.frameAncestors\` "${origin}" must be origin only (no path / query / fragment)`);
			}
		}
		frameAncestors = v;
	}

	// **`*` 利用時に warning** (security review M-3): 商用運用で全 origin 許可は事故元になりやすいため stderr に注意喚起
	if (frameAncestors.includes('*')) {
		process.stderr.write(
			'[summaly][embed] frameAncestors = ["*"] が設定されています。' +
			'商用運用では Misskey インスタンスのオリジンに明示制限することを推奨します\n',
		);
	}

	// allowedPlugins は src/index.ts 側で `renderEmbed` 実装 × `[plugins].allowed` から auto-fill。
	// ここでは空配列を入れる (auto-fill されるまでのプレースホルダ)。
	summaly.embedConfig = { enabled: true, allowedPlugins: [], frameAncestors };

	// `[embed].publicUrl` が設定済なら `embedBaseUrl` を組み立てて投入
	if (rawEmbed.publicUrl !== undefined) {
		expectType(rawEmbed.publicUrl, 'string', 'embed.publicUrl');
		const v = (rawEmbed.publicUrl as string).trim();
		if (v === '') {
			throw new RangeError('config: `embed.publicUrl` must not be empty when specified');
		}
		// `https:` only — `/embed` は browser から直接アクセスされるため平文 HTTP は不可
		// (中間者が iframe HTML を改竄してフィッシング/XSS の踏み台にする)
		let parsed: URL;
		try {
			parsed = new URL(v);
		} catch {
			throw new RangeError(`config: \`embed.publicUrl\` must be a valid URL, got "${v}"`);
		}
		if (parsed.protocol !== 'https:') {
			throw new RangeError(`config: \`embed.publicUrl\` must use https: scheme, got "${parsed.protocol}"`);
		}
		// **`URL` パースで origin + pathname だけを取る** (security review L-3): 末尾スラッシュ削除 +
		// クエリ / フラグメントは除去 ( `https://x.com?debug=1/embed?url=...` のような不正 URL 生成を防ぐ)。
		summaly.embedBaseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
	}
}

/**
 * `[scraping.fallback]` セクションを処理し、`SummalyOptions` の
 * `fallbackUserAgent` / `fallbackRetryCategories` にマップする。
 *
 * - `enabled = false` のときは何もマップしない（リトライ無効）
 * - `enabled = true` (or undefined) で `userAgent` 指定があれば `fallbackUserAgent` に
 * - `categories` 指定があれば `fallbackRetryCategories` に
 */
const SCRAPING_KEYS = ['fallback', 'proxy', 'curl_cffi', 'strategy_cache'] as const;
function parseScrapingSection(rawScraping: Toml, out: SummalyOptions): void {
	if (rawScraping === undefined) return;
	if (!isObject(rawScraping)) {
		throw new TypeError('config: `[scraping]` must be a table');
	}
	expectKnownKeys(rawScraping, SCRAPING_KEYS, 'scraping');

	// phase18.1: bootstrap 自動導出 + 経路依存 fail-fast を撤廃。hedge race ですべての URL に対して
	// 全 strategy が並列発火するため、bootstrap entry が無くても起動失敗にしない (host allowlist 不要化)。
	// `bootstrapPath` が空文字列の早期 fail-fast は parseStrategyCacheSection 内で実施。

	parseScrapingFallbackSection(rawScraping.fallback, out);
	parseProxySection(rawScraping.proxy, out);
	parseCurlCffiSection(rawScraping['curl_cffi'], out);
	parseStrategyCacheSection(rawScraping['strategy_cache'], out);
}

const SCRAPING_FALLBACK_KEYS = ['enabled', 'userAgent', 'hedgedThresholdMs'] as const;
function parseScrapingFallbackSection(fallback: Toml, out: SummalyOptions): void {
	if (fallback === undefined) return;
	if (!isObject(fallback)) {
		throw new TypeError('config: `[scraping.fallback]` must be a table');
	}
	expectKnownKeys(fallback, SCRAPING_FALLBACK_KEYS, 'scraping.fallback');

	// phase18: `hedgedThresholdMs` (default 5000) — `enabled` とは独立して機能 (常時有効)
	if (fallback.hedgedThresholdMs !== undefined) {
		expectType(fallback.hedgedThresholdMs, 'number', 'scraping.fallback.hedgedThresholdMs');
		const ms = fallback.hedgedThresholdMs as number;
		if (!Number.isFinite(ms) || ms < 0) {
			throw new RangeError('config: `scraping.fallback.hedgedThresholdMs` must be a non-negative number');
		}
		out.hedgedThresholdMs = ms;
	}

	let enabled = true;
	if (fallback.enabled !== undefined) {
		expectType(fallback.enabled, 'boolean', 'scraping.fallback.enabled');
		enabled = fallback.enabled as boolean;
	}
	if (!enabled) return;
	// `userAgent` 省略時は `DEFAULT_FALLBACK_UA` (`facebookexternalhit/1.1`) を採用。
	// phase18 hedge race では fallback_ua も並列発火対象の経路として機能する。
	if (fallback.userAgent !== undefined) {
		expectType(fallback.userAgent, 'string', 'scraping.fallback.userAgent');
		const ua = (fallback.userAgent as string).trim();
		if (ua === '') {
			throw new RangeError('config: `scraping.fallback.userAgent` must not be empty when fallback is enabled');
		}
		out.fallbackUserAgent = ua;
	} else {
		out.fallbackUserAgent = DEFAULT_FALLBACK_UA;
	}
	// `categories` は TOML キーを持たずコード側 default 固定。
	// phase18: hedge race ではすべての retryable error で並列発火するため、`fallbackRetryCategories` の
	// 機能上の意味はなくなった (旧 cascade 用に temporal 維持、Step 7 で deprecation 通知予定)。
	out.fallbackRetryCategories = DEFAULT_FALLBACK_CATEGORIES;
}

/**
 * `[scraping.proxy]` セクションを処理し、`SummalyOptions.proxyFallback` にマップする。
 *
 * シークレットの解決順:
 * 1. `process.env.SUMMALY_PROXY_SECRET`
 * 2. `config.toml` の `[scraping.proxy].secret`
 * 3. どちらも無ければ起動失敗
 *
 * **設計**:
 * - `categories` は TOML キーを持たずコード側 default 固定 (`DEFAULT_PROXY_CATEGORIES`)
 * - `domains` は TOML キーを持たず bootstrap.jsonl から strategy=proxy の host を自動導出
 * - 経路依存 fail-fast: bootstrap に proxy entry があるけど `enabled = false` なら起動失敗
 *
 * @param bootstrapHostsByStrategy bootstrap.jsonl から導出した strategy 別 host set
 */
const SCRAPING_PROXY_KEYS = ['enabled', 'url', 'secret', 'timeoutMs'] as const;
function parseProxySection(
	rawProxy: Toml,
	out: SummalyOptions,
): void {
	if (rawProxy === undefined) return;
	if (!isObject(rawProxy)) {
		throw new TypeError('config: `[scraping.proxy]` must be a table');
	}
	expectKnownKeys(rawProxy, SCRAPING_PROXY_KEYS, 'scraping.proxy');

	let enabled = false;
	if (rawProxy.enabled !== undefined) {
		expectType(rawProxy.enabled, 'boolean', 'scraping.proxy.enabled');
		enabled = rawProxy.enabled as boolean;
	}
	if (!enabled) return;

	if (rawProxy.url === undefined) {
		throw new RangeError('config: `scraping.proxy.url` is required when scraping.proxy.enabled = true');
	}
	expectType(rawProxy.url, 'string', 'scraping.proxy.url');
	const url = (rawProxy.url as string).trim();
	if (url === '' || !/^https?:\/\//.test(url)) {
		throw new RangeError('config: `scraping.proxy.url` must be a valid http(s) URL');
	}
	let configSecret: string | undefined;
	if (rawProxy.secret !== undefined) {
		expectType(rawProxy.secret, 'string', 'scraping.proxy.secret');
		configSecret = rawProxy.secret as string;
	}
	const envSecret = process.env.SUMMALY_PROXY_SECRET;
	const secret = (envSecret != null && envSecret !== '') ? envSecret : (configSecret ?? '');
	if (secret === '') {
		throw new RangeError(
			'config: scraping.proxy.enabled = true ですが secret が未設定です。'
			+ ' 環境変数 SUMMALY_PROXY_SECRET または `[scraping.proxy].secret` のいずれかを設定してください',
		);
	}

	let timeoutMs = 30000;
	if (rawProxy.timeoutMs !== undefined) {
		expectType(rawProxy.timeoutMs, 'number', 'scraping.proxy.timeoutMs');
		expectPositiveInteger(rawProxy.timeoutMs as number, 'scraping.proxy.timeoutMs');
		timeoutMs = rawProxy.timeoutMs as number;
	}
	out.proxyFallback = {
		enabled: true,
		url,
		secret,
		timeoutMs,
	};
}

/**
 * `[scraping.curl_cffi]` セクションを処理し、`SummalyOptions.curlCffiFallback` にマップする。
 *
 * - `enabled === false` のときは何もマップしない（curl_cffi 無効）
 * - `enabled === true` で `projectDir` 必須（`tools/curl-cffi-fetcher/` の絶対 or 相対パス）
 * - `uvPath` / `impersonate` / `timeoutMs` は省略可能（妥当なデフォルトを採用）
 *
 * **設計**:
 * - `categories` は TOML キーを持たずコード側 default 固定
 * - `domains` は TOML キーを持たず bootstrap.jsonl から strategy=curl_cffi の host を自動導出
 * - 経路依存 fail-fast: bootstrap に curl_cffi entry あり + enabled = false → 起動失敗
 */
const SCRAPING_CURL_CFFI_KEYS = ['enabled', 'projectDir', 'uvPath', 'impersonate', 'timeoutMs'] as const;
function parseCurlCffiSection(
	rawCurlCffi: Toml,
	out: SummalyOptions,
): void {
	if (rawCurlCffi === undefined) return;
	if (!isObject(rawCurlCffi)) {
		throw new TypeError('config: `[scraping.curl_cffi]` must be a table');
	}
	expectKnownKeys(rawCurlCffi, SCRAPING_CURL_CFFI_KEYS, 'scraping.curl_cffi');

	let enabled = false;
	if (rawCurlCffi.enabled !== undefined) {
		expectType(rawCurlCffi.enabled, 'boolean', 'scraping.curl_cffi.enabled');
		enabled = rawCurlCffi.enabled as boolean;
	}
	if (!enabled) return;

	if (rawCurlCffi.projectDir === undefined) {
		throw new RangeError('config: `scraping.curl_cffi.projectDir` is required when scraping.curl_cffi.enabled = true');
	}
	expectType(rawCurlCffi.projectDir, 'string', 'scraping.curl_cffi.projectDir');
	const projectDir = (rawCurlCffi.projectDir as string).trim();
	if (projectDir === '') {
		throw new RangeError('config: `scraping.curl_cffi.projectDir` must not be empty');
	}

	let uvPath = 'uv';
	if (rawCurlCffi.uvPath !== undefined) {
		expectType(rawCurlCffi.uvPath, 'string', 'scraping.curl_cffi.uvPath');
		const v = (rawCurlCffi.uvPath as string).trim();
		if (v === '') {
			throw new RangeError('config: `scraping.curl_cffi.uvPath` must not be empty when specified');
		}
		uvPath = v;
	}

	let impersonate = 'chrome120';
	if (rawCurlCffi.impersonate !== undefined) {
		expectType(rawCurlCffi.impersonate, 'string', 'scraping.curl_cffi.impersonate');
		const v = (rawCurlCffi.impersonate as string).trim();
		if (v === '') {
			throw new RangeError('config: `scraping.curl_cffi.impersonate` must not be empty when specified');
		}
		impersonate = v;
	}

	let timeoutMs = 30000;
	if (rawCurlCffi.timeoutMs !== undefined) {
		expectType(rawCurlCffi.timeoutMs, 'number', 'scraping.curl_cffi.timeoutMs');
		expectPositiveInteger(rawCurlCffi.timeoutMs as number, 'scraping.curl_cffi.timeoutMs');
		timeoutMs = rawCurlCffi.timeoutMs as number;
	}

	out.curlCffiFallback = {
		enabled: true,
		uvPath,
		projectDir,
		impersonate,
		timeoutMs,
	};
}

/**
 * `[scraping.strategy_cache]` セクションを処理し、`SummalyOptions.domainStrategyCache` にマップする。
 *
 * - `enabled === false` のときは何もマップしない (従来カスケードのみ)
 * - `enabled === true` (or undefined when section present) でデフォルト値を採用する
 * - `bootstrapPath` / `runtimePath` は省略可。空文字列は明示エラー
 * - `maxEntries` / `consecutiveFailureThreshold` / `compactionThreshold` は正整数
 */
const SCRAPING_STRATEGY_CACHE_KEYS = [
	'enabled', 'bootstrapPath', 'runtimePath', 'maxEntries', 'consecutiveFailureThreshold', 'compactionThreshold',
] as const;
function parseStrategyCacheSection(rawStrategyCache: Toml, out: SummalyOptions): void {
	if (rawStrategyCache === undefined) return;
	if (!isObject(rawStrategyCache)) {
		throw new TypeError('config: `[scraping.strategy_cache]` must be a table');
	}
	expectKnownKeys(rawStrategyCache, SCRAPING_STRATEGY_CACHE_KEYS, 'scraping.strategy_cache');

	let enabled = true;
	if (rawStrategyCache.enabled !== undefined) {
		expectType(rawStrategyCache.enabled, 'boolean', 'scraping.strategy_cache.enabled');
		enabled = rawStrategyCache.enabled as boolean;
	}
	if (!enabled) return;

	const opts: NonNullable<SummalyOptions['domainStrategyCache']> = { enabled: true };

	if (rawStrategyCache.bootstrapPath !== undefined) {
		expectType(rawStrategyCache.bootstrapPath, 'string', 'scraping.strategy_cache.bootstrapPath');
		const v = (rawStrategyCache.bootstrapPath as string).trim();
		if (v === '') {
			throw new RangeError('config: `scraping.strategy_cache.bootstrapPath` must not be empty when specified');
		}
		opts.bootstrapPath = v;
	}
	if (rawStrategyCache.runtimePath !== undefined) {
		expectType(rawStrategyCache.runtimePath, 'string', 'scraping.strategy_cache.runtimePath');
		const v = (rawStrategyCache.runtimePath as string).trim();
		if (v === '') {
			throw new RangeError('config: `scraping.strategy_cache.runtimePath` must not be empty when specified');
		}
		opts.runtimePath = v;
	}
	if (rawStrategyCache.maxEntries !== undefined) {
		expectType(rawStrategyCache.maxEntries, 'number', 'scraping.strategy_cache.maxEntries');
		expectPositiveInteger(rawStrategyCache.maxEntries as number, 'scraping.strategy_cache.maxEntries');
		opts.maxEntries = rawStrategyCache.maxEntries as number;
	}
	if (rawStrategyCache.consecutiveFailureThreshold !== undefined) {
		expectType(rawStrategyCache.consecutiveFailureThreshold, 'number', 'scraping.strategy_cache.consecutiveFailureThreshold');
		expectPositiveInteger(rawStrategyCache.consecutiveFailureThreshold as number, 'scraping.strategy_cache.consecutiveFailureThreshold');
		opts.consecutiveFailureThreshold = rawStrategyCache.consecutiveFailureThreshold as number;
	}
	if (rawStrategyCache.compactionThreshold !== undefined) {
		expectType(rawStrategyCache.compactionThreshold, 'number', 'scraping.strategy_cache.compactionThreshold');
		expectPositiveInteger(rawStrategyCache.compactionThreshold as number, 'scraping.strategy_cache.compactionThreshold');
		opts.compactionThreshold = rawStrategyCache.compactionThreshold as number;
	}

	out.domainStrategyCache = opts;
}

const SERVER_KEYS = ['host', 'port'] as const;
function parseServerSection(raw: Toml): ServerOptions {
	if (raw === undefined) return {};
	if (!isObject(raw)) {
		throw new TypeError('config: `[server]` must be a table');
	}
	expectKnownKeys(raw, SERVER_KEYS, 'server');

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

const SUMMALY_KEYS = [
	'userAgent', 'contentLengthRequired', 'useRange', 'responseTimeout', 'operationTimeout', 'contentLengthLimit',
	'cache', 'pdf',
] as const;
const SUMMALY_CACHE_KEYS = [
	'maxAge', 'errorMaxAge', 'inMemory', 'inMemoryMaxEntries', 'inFlightDedup',
] as const;
const SUMMALY_PDF_KEYS = ['enabled'] as const;
const PLUGINS_KEYS = ['allowed'] as const;
const DIAGNOSTICS_KEYS = [
	'parseFailureLog',
	'parseFailureLogMaxGroups',
	'parseFailureLogSamplesPerGroup',
	'parseFailureLogJsonlPath',
	'parseFailureLogJsonlMaxBytes',
	'parseFailureLogBlockedJsonlPath',
	'parseFailureLogBlockedJsonlMaxBytes',
] as const;

function parseSummalySection(rawSummaly: Toml, rawPlugins: Toml, rawDiagnostics: Toml): SummalyOptions {
	const out: SummalyOptions = {};
	const summaly = rawSummaly === undefined ? {} : rawSummaly;
	if (!isObject(summaly)) {
		throw new TypeError('config: `[summaly]` must be a table');
	}
	expectKnownKeys(summaly, SUMMALY_KEYS, 'summaly');

	// useRange の internal default は true。明示 false で off。
	out.useRange = true;

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
		expectKnownKeys(summaly.cache, SUMMALY_CACHE_KEYS, 'summaly.cache');
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
		expectKnownKeys(summaly.pdf, SUMMALY_PDF_KEYS, 'summaly.pdf');
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
		// `[plugins.<name>]` セクションは将来拡張用 placeholder として許容するため、unknown key 検出は
		// `allowed` キー以外の **string キー (= ネスト table)** を無視する形で行う (allowed と placeholder のみ)。
		for (const k of Object.keys(rawPlugins)) {
			if (k === 'allowed') continue;
			// `[plugins.<name>]` placeholder セクションは Toml object として現れる
			if (isObject(rawPlugins[k])) continue;
			throw new RangeError(
				`config: unknown key 'plugins.${k}'. valid keys: allowed (or '[plugins.<plugin-name>]' nested tables for future placeholder)`,
			);
		}
		if (rawPlugins.allowed !== undefined) {
			expectStringArray(rawPlugins.allowed, 'plugins.allowed');
			out.allowedPlugins = rawPlugins.allowed;
		}
	}

	// [diagnostics]
	if (rawDiagnostics !== undefined) {
		if (!isObject(rawDiagnostics)) {
			throw new TypeError('config: `[diagnostics]` must be a table');
		}
		expectKnownKeys(rawDiagnostics, DIAGNOSTICS_KEYS, 'diagnostics');
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
		// `parseFailureLogEndpoint` は廃止済 (詳細は DEPRECATED.md 参照)。expectKnownKeys が起動失敗で検出する。
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
		// 迂回候補ログ
		if (d.parseFailureLogBlockedJsonlPath !== undefined) {
			expectType(d.parseFailureLogBlockedJsonlPath, 'string', 'diagnostics.parseFailureLogBlockedJsonlPath');
			const path = (d.parseFailureLogBlockedJsonlPath as string).trim();
			if (path === '') {
				throw new RangeError('config: `diagnostics.parseFailureLogBlockedJsonlPath` must not be empty');
			}
			out.parseFailureLogBlockedJsonlPath = path;
		}
		if (d.parseFailureLogBlockedJsonlMaxBytes !== undefined) {
			expectType(d.parseFailureLogBlockedJsonlMaxBytes, 'number', 'diagnostics.parseFailureLogBlockedJsonlMaxBytes');
			expectNonNegativeFiniteNumber(d.parseFailureLogBlockedJsonlMaxBytes as number, 'diagnostics.parseFailureLogBlockedJsonlMaxBytes');
			out.parseFailureLogBlockedJsonlMaxBytes = d.parseFailureLogBlockedJsonlMaxBytes as number;
		}

		// parseFailureLog = true のとき、Path のペア制御 + デフォルト適用。
		// 「片方だけ Path を指定」は事故元になりやすいので fail-fast。両方明示 or 両方未指定 (= デフォルト適用) のいずれか。
		if (out.parseFailureLog === true) {
			const hasPath = out.parseFailureLogJsonlPath !== undefined;
			const hasBlockedPath = out.parseFailureLogBlockedJsonlPath !== undefined;
			if (hasPath !== hasBlockedPath) {
				throw new RangeError(
					'config: diagnostics.parseFailureLogJsonlPath と diagnostics.parseFailureLogBlockedJsonlPath は'
					+ ' ペアで指定するか、両方とも未指定 (デフォルトパス適用) にしてください。'
					+ ` (現在: parseFailureLogJsonlPath = ${hasPath}, parseFailureLogBlockedJsonlPath = ${hasBlockedPath})`,
				);
			}
			if (!hasPath && !hasBlockedPath) {
				out.parseFailureLogJsonlPath = DEFAULT_PARSE_FAILURE_LOG_JSONL_PATH;
				out.parseFailureLogBlockedJsonlPath = DEFAULT_PARSE_FAILURE_LOG_BLOCKED_JSONL_PATH;
			}
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
