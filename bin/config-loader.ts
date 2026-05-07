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
import { DEFAULT_FALLBACK_UA } from '../src/utils/got.js';

/**
 * `SummalyErrorCategory` の現存値一覧（typo を防ぐための検証用）。
 * `src/utils/parse-failure-log.ts` の `SummalyErrorCategory` ユニオンに合わせる。
 * 新カテゴリ追加時はこちらも追記する必要がある（現状は手動同期）。
 */
const VALID_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
	'timeout',
	'bot_blocked',
	'not_found',
	'origin_error',
	'unsupported_type',
	'content_too_large',
	'ssrf_blocked',
	'network_error',
	'connection_dropped',
	'parse_error',
	'unknown',
]);

export interface ServerOptions {
	host?: string;
	port?: number;
	/**
	 * **自身が外部に公開されている URL** (phase13.1)。例: `https://summaly.example.com`。
	 * `[embed]` を有効化したプラグインの player.url を組み立てるのに使う。
	 * 未設定なら embed 機能は実質無効 (`embedBaseUrl` が undefined のまま)。
	 */
	publicUrl?: string;
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
	parseScrapingSection(parsed.scraping, summaly);
	parseEmbedSection(parsed.embed, server, summaly);

	return { server, summaly };
}

/**
 * `[embed]` セクションを処理し、`SummalyOptions.embedBaseUrl` / `embedConfig` にマップする (phase13.1)。
 *
 * - `enabled` が省略 / true で `[server].publicUrl` が設定済なら embed 有効化、`embedBaseUrl` を投入
 * - `enabled = false` なら `embedConfig.enabled = false` で完全無効化 (= /embed が 404、player.url も生成しない)
 * - `[server].publicUrl` 未設定なら embed は実質無効 (embedConfig は作るが embedBaseUrl は undefined のまま)
 * - `allowedPlugins` 必須 (空配列禁止、fail-close で全プラグイン無効を防ぐ)
 * - `frameAncestors` 省略時は `["*"]` (デフォルト全許可、商用は config で制限推奨)
 */
function parseEmbedSection(rawEmbed: Toml, server: ServerOptions, summaly: SummalyOptions): void {
	if (rawEmbed === undefined) return;
	if (!isObject(rawEmbed)) {
		throw new TypeError('config: `[embed]` must be a table');
	}
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

	// allowedPlugins は必須 (空配列禁止 — fail-close 維持)
	if (rawEmbed.allowedPlugins === undefined) {
		throw new RangeError('config: `embed.allowedPlugins` is required when embed.enabled = true');
	}
	expectStringArray(rawEmbed.allowedPlugins, 'embed.allowedPlugins');
	const allowedPlugins = rawEmbed.allowedPlugins;
	if (allowedPlugins.length === 0) {
		throw new RangeError('config: `embed.allowedPlugins` must not be empty (fail-close)');
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

	summaly.embedConfig = { enabled: true, allowedPlugins, frameAncestors };

	// `[server].publicUrl` が設定済なら `embedBaseUrl` を組み立てて投入
	// (publicUrl 未設定でも embed エンドポイント自体は受け付けるが、プラグインが player.url を組み立てない)
	if (server.publicUrl != null && server.publicUrl !== '') {
		// **`URL` パースで origin + pathname だけを取る** (security review L-3): 末尾スラッシュ削除 +
		// クエリ / フラグメントは除去 ( `https://x.com?debug=1/embed?url=...` のような不正 URL 生成を防ぐ)。
		// publicUrl は parseServerSection で URL 検証済みのため new URL は throw しない
		const parsed = new URL(server.publicUrl);
		summaly.embedBaseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
	}
}

/**
 * `[scraping.fallback]` セクションを処理し、`SummalyOptions` の
 * `fallbackUserAgent` / `fallbackRetryCategories` にマップする (phase11.9)。
 *
 * - `enabled = false` のときは何もマップしない（リトライ無効）
 * - `enabled = true` (or undefined) で `userAgent` 指定があれば `fallbackUserAgent` に
 * - `categories` 指定があれば `fallbackRetryCategories` に
 */
function parseScrapingSection(rawScraping: Toml, out: SummalyOptions): void {
	if (rawScraping === undefined) return;
	if (!isObject(rawScraping)) {
		throw new TypeError('config: `[scraping]` must be a table');
	}
	parseScrapingFallbackSection(rawScraping.fallback, out);
	parseProxySection(rawScraping.proxy, out);
	parseCurlCffiSection(rawScraping['curl_cffi'], out);
	parseStrategyCacheSection(rawScraping['strategy_cache'], out);
}

function parseScrapingFallbackSection(fallback: Toml, out: SummalyOptions): void {
	if (fallback === undefined) return;
	if (!isObject(fallback)) {
		throw new TypeError('config: `[scraping.fallback]` must be a table');
	}
	let enabled = true;
	if (fallback.enabled !== undefined) {
		expectType(fallback.enabled, 'boolean', 'scraping.fallback.enabled');
		enabled = fallback.enabled as boolean;
	}
	if (!enabled) return;
	// `userAgent` 省略時は `DEFAULT_FALLBACK_UA` (`facebookexternalhit/1.1`) を採用。
	// 「`enabled = true` を書いたのにリトライしない」サイレントバグを防ぐため (phase11.9 W-2)。
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
	if (fallback.categories !== undefined) {
		expectStringArray(fallback.categories, 'scraping.fallback.categories');
		// 各値が `SummalyErrorCategory` の既存メンバーかをチェック（typo 検出）
		for (const c of fallback.categories) {
			if (!VALID_ERROR_CATEGORIES.has(c)) {
				throw new RangeError(`config: \`scraping.fallback.categories\` contains unknown category "${c}"`);
			}
		}
		out.fallbackRetryCategories = fallback.categories as SummalyOptions['fallbackRetryCategories'];
	}
}

/**
 * `[scraping.proxy]` セクションを処理し、`SummalyOptions.proxyFallback` にマップする (phase12.1)。
 *
 * シークレットの解決順:
 * 1. `process.env.SUMMALY_PROXY_SECRET`
 * 2. `config.toml` の `[scraping.proxy].secret`
 * 3. どちらも無ければ `enabled = false` 扱いで warning を stderr に出して return（起動失敗にはしない）
 */
function parseProxySection(rawProxy: Toml, out: SummalyOptions): void {
	if (rawProxy === undefined) return;
	if (!isObject(rawProxy)) {
		throw new TypeError('config: `[scraping.proxy]` must be a table');
	}
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
		// シークレット未設定なら起動失敗にせず warning + 無効化（運用者が config.toml を晒し投稿しても安全）
		process.stderr.write(
			'[summaly][scraping.proxy] enabled = true だが secret が未設定 (env SUMMALY_PROXY_SECRET も無い)。' +
			'proxy フォールバックは無効化されました\n',
		);
		return;
	}
	let categories: string[] = ['origin_error', 'bot_blocked'];
	if (rawProxy.categories !== undefined) {
		expectStringArray(rawProxy.categories, 'scraping.proxy.categories');
		for (const c of rawProxy.categories) {
			if (!VALID_ERROR_CATEGORIES.has(c)) {
				throw new RangeError(`config: \`scraping.proxy.categories\` contains unknown category "${c}"`);
			}
		}
		categories = rawProxy.categories;
	}
	if (rawProxy.domains === undefined) {
		throw new RangeError('config: `scraping.proxy.domains` is required when scraping.proxy.enabled = true');
	}
	expectStringArray(rawProxy.domains, 'scraping.proxy.domains');
	const domains = rawProxy.domains;
	if (domains.length === 0) {
		throw new RangeError('config: `scraping.proxy.domains` must not be empty (proxy は明示的な allowlist が必須)');
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
		// VALID_ERROR_CATEGORIES でメンバー検証済みなので SummalyErrorCategory[] に narrow できる
		categories: categories as NonNullable<SummalyOptions['fallbackRetryCategories']>,
		domains,
		timeoutMs,
	};
}

/**
 * `[scraping.curl_cffi]` セクションを処理し、`SummalyOptions.curlCffiFallback` にマップする (phase12.5)。
 *
 * - `enabled === false` のときは何もマップしない（curl_cffi 無効）
 * - `enabled === true` で `domains` (allowlist) が必須。空配列は明示的に許可しない（オープンプロキシ化防止）
 * - `projectDir` 必須（`tools/curl-cffi-fetcher/` の絶対 or 相対パス）
 * - `uvPath` / `impersonate` / `categories` / `timeoutMs` は省略可能（妥当なデフォルトを採用）
 */
function parseCurlCffiSection(rawCurlCffi: Toml, out: SummalyOptions): void {
	if (rawCurlCffi === undefined) return;
	if (!isObject(rawCurlCffi)) {
		throw new TypeError('config: `[scraping.curl_cffi]` must be a table');
	}
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

	let categories: string[] = ['timeout', 'connection_dropped', 'bot_blocked'];
	if (rawCurlCffi.categories !== undefined) {
		expectStringArray(rawCurlCffi.categories, 'scraping.curl_cffi.categories');
		for (const c of rawCurlCffi.categories) {
			if (!VALID_ERROR_CATEGORIES.has(c)) {
				throw new RangeError(`config: \`scraping.curl_cffi.categories\` contains unknown category "${c}"`);
			}
		}
		categories = rawCurlCffi.categories;
	}

	if (rawCurlCffi.domains === undefined) {
		throw new RangeError('config: `scraping.curl_cffi.domains` is required when scraping.curl_cffi.enabled = true');
	}
	expectStringArray(rawCurlCffi.domains, 'scraping.curl_cffi.domains');
	const domains = rawCurlCffi.domains;
	if (domains.length === 0) {
		throw new RangeError('config: `scraping.curl_cffi.domains` must not be empty (curl_cffi は明示的な allowlist が必須)');
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
		// VALID_ERROR_CATEGORIES でメンバー検証済みなので SummalyErrorCategory[] に narrow できる。
		// 型は `CurlCffiFallbackConfig['categories']` を直接参照（`fallbackRetryCategories` を流用しない）。
		categories: categories as NonNullable<SummalyOptions['curlCffiFallback']>['categories'],
		domains,
		timeoutMs,
	};
}

/**
 * `[scraping.strategy_cache]` セクションを処理し、`SummalyOptions.domainStrategyCache` にマップする (phase14 Step 1)。
 *
 * - `enabled === false` のときは何もマップしない (従来カスケードのみ)
 * - `enabled === true` (or undefined when section present) でデフォルト値を採用する
 * - `bootstrapPath` / `runtimePath` は省略可。空文字列は明示エラー
 * - `maxEntries` / `consecutiveFailureThreshold` / `compactionThreshold` は正整数
 */
function parseStrategyCacheSection(rawStrategyCache: Toml, out: SummalyOptions): void {
	if (rawStrategyCache === undefined) return;
	if (!isObject(rawStrategyCache)) {
		throw new TypeError('config: `[scraping.strategy_cache]` must be a table');
	}
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
	if (raw.publicUrl !== undefined) {
		expectType(raw.publicUrl, 'string', 'server.publicUrl');
		const v = (raw.publicUrl as string).trim();
		if (v === '') {
			throw new RangeError('config: `server.publicUrl` must not be empty when specified');
		}
		// `https:` only — `/embed` 機能は browser から直接アクセスされるため平文 HTTP は不可
		// (= 中間者が iframe HTML を改竄してフィッシングや XSS の踏み台にする)
		let parsed: URL;
		try {
			parsed = new URL(v);
		} catch {
			throw new RangeError(`config: \`server.publicUrl\` must be a valid URL, got "${v}"`);
		}
		if (parsed.protocol !== 'https:') {
			throw new RangeError(`config: \`server.publicUrl\` must use https: scheme, got "${parsed.protocol}"`);
		}
		out.publicUrl = v;
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
		// `parseFailureLogEndpoint` は phase11.5 で削除済み (プライバシーリスク撤去)。
		// 既存設定で残っている場合は smol-toml が unknown key を silently 無視する挙動に任せる。
		// 集約データの参照は `parseFailureLogJsonlPath` 経由 (JSONL ファイル + jq) に移行。
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
		// 迂回候補ログ (phase11.6)
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
