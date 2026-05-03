/**
 * summaly
 * https://github.com/misskey-dev/summaly
 */

import got, { type Agents as GotAgents } from 'got';
import { LRUCache } from 'lru-cache';
import type { FastifyInstance } from 'fastify';
import { SummalyResult as _SummalyResult } from '@/summary.js';
import { SummalyPlugin as _SummalyPlugin } from '@/iplugin.js';
import { general, type GeneralScrapingOptions } from '@/general.js';
import { DEFAULT_BOT_UA, DEFAULT_OPERATION_TIMEOUT, DEFAULT_RESPONSE_TIMEOUT, agent, setAgent } from '@/utils/got.js';
import { plugins as builtinPlugins } from '@/plugins/index.js';
import { KNOWN_SHORT_HOSTS } from '@/utils/short-urls.js';
import { sanitizeUrl } from '@/utils/sanitize-url.js';

export type SummalyResult = _SummalyResult;

export type SummalyPlugin = _SummalyPlugin;

export type SummalyOptions = {
	/**
	 * Accept-Language for the request
	 */
	lang?: string | null;

	/**
	 * Whether follow redirects
	 */
	followRedirects?: boolean;

	/**
	 * Custom Plugins
	 */
	plugins?: SummalyPlugin[];

	/**
	 * Custom HTTP agent
	 */
	agent?: GotAgents;

	/**
	 * User-Agent for the request
	 */
	userAgent?: string;

	/**
	 * Response timeout.
	 * Set timeouts for each phase, such as host name resolution and socket communication.
	 */
	responseTimeout?: number;

	/**
	 * Operation timeout.
	 * Set the timeout from the start to the end of the request.
	 */
	operationTimeout?: number;

	/**
	 * Maximum content length.
	 * If set to true, an error will occur if the content-length value returned from the other server is larger than this parameter (or if the received body size exceeds this parameter).
	 */
	contentLengthLimit?: number;

	/**
	 * Content length required.
	 * If set to true, it will be an error if the other server does not return content-length.
	 */
	contentLengthRequired?: boolean;

	/**
	 * Cache-Control max-age (seconds) for successful responses in Fastify mode.
	 * Defaults to 604800 (1 week). Set to 0 to emit `Cache-Control: no-store`.
	 * Must be a non-negative finite number; negative values throw at register time.
	 */
	cacheMaxAge?: number;

	/**
	 * Cache-Control max-age (seconds) for error responses in Fastify mode.
	 * Defaults to 3600 (1 hour). Set to 0 to emit `Cache-Control: no-store`.
	 * Must be a non-negative finite number; negative values throw at register time.
	 */
	cacheErrorMaxAge?: number;

	/**
	 * Range リクエストで先頭領域のみ取得する。サーバが Range 未対応なら通常 GET と同等。
	 * 帯域節約用途。
	 */
	useRange?: boolean;

	/**
	 * 利用許可するプラグインの name 一覧。
	 * - undefined → 全プラグイン有効（互換挙動）
	 * - string[] → 配列に含まれる name のプラグインのみ有効（オプトイン）
	 * - [] → 組み込み全 disable（汎用パスのみで動く運用）
	 * 配列のフィルタ対象は組み込みプラグインのみ。`plugins` で渡したカスタムプラグインは除外されない。
	 */
	allowedPlugins?: string[];

	/**
	 * Fastify モードで summaly サーバ自身が LRU ベースのインメモリキャッシュを持つかどうか。デフォルト false。
	 * true にすると、cacheMaxAge 内の同一 URL リクエストは origin に到達せず、サーバ内のキャッシュから返す。
	 * プロセス再起動でキャッシュは消える（永続キャッシュは別実装）。
	 */
	inMemoryCache?: boolean;

	/**
	 * インメモリキャッシュの最大エントリ数。デフォルト 1000。
	 * 1 エントリ数 KB として 1000 で数 MB 程度のメモリ消費を見込む。
	 */
	inMemoryCacheMaxEntries?: number;
};

const DEFAULT_CACHE_MAX_AGE = 604800;
const DEFAULT_CACHE_ERROR_MAX_AGE = 3600;
const DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES = 1000;

type CacheEntry =
	| { kind: 'success'; value: SummalyResult }
	| { kind: 'error'; error: unknown };

/**
 * Fastify モードのインメモリキャッシュキーを生成する。
 * URL のフラグメントを除き、`lang` を含めることで言語別の汚染を防ぐ。
 * 区切りに NULL byte (`\0`) を使うことで `lang` に空白などが入っても URL 部と衝突しない。
 * （クエリ順正規化等の過剰正規化はキャッシュヒット率と引き換えに「異なる結果を返すべき URL」を
 * 同一視するリスクがあるため第一版では行わない）
 */
function normalizeCacheKey(url: string, lang: string | undefined): string | null {
	let normalized: URL;
	try {
		normalized = new URL(url);
	} catch {
		return null;
	}
	normalized.hash = '';
	return `${normalized.href}\0${lang ?? ''}`;
}

/**
 * エラーをキャッシュ可能な形に変換する。
 * `Error` インスタンスは `JSON.stringify` で `{}` になりレスポンスから情報が消えるため、
 * `{ message, name }` の plain object に正規化して HIT/MISS でレスポンスの一貫性を保つ。
 * stack トレースは積み重ねでメモリ消費の遠因になるため捨てる。
 */
function serializableError(e: unknown): unknown {
	if (e instanceof Error) {
		return { message: e.message, name: e.name };
	}
	return e;
}

function cacheControlHeader(maxAge: number): string {
	if (!Number.isFinite(maxAge) || maxAge < 0) {
		throw new RangeError(`cacheMaxAge / cacheErrorMaxAge must be a non-negative finite number, got ${maxAge}`);
	}
	return maxAge === 0 ? 'no-store' : `public, max-age=${maxAge}`;
}

export const summalyDefaultOptions = {
	lang: null,
	followRedirects: true,
	plugins: [],
} as SummalyOptions;

/**
 * Summarize an web page
 */
export const summaly = async (url: string, options?: SummalyOptions): Promise<SummalyResult> => {
	if (options?.agent) setAgent(options.agent);

	const opts = { ...summalyDefaultOptions, ...options };

	// allowedPlugins: 組み込みプラグインのみフィルタする。
	// undefined なら全 builtinPlugins を採用、配列なら name で絞り込み、空配列なら 0 件。
	// 外部から渡された opts.plugins はカスタム性を尊重してフィルタしない（カスタムプラグインの導入者責任）。
	const allowedPlugins = opts.allowedPlugins;
	const filteredBuiltins = allowedPlugins
		? builtinPlugins.filter(p => p.name != null && allowedPlugins.includes(p.name))
		: builtinPlugins;
	const plugins = filteredBuiltins.concat(opts.plugins || []);

	let actualUrl = url;
	// followRedirects が true、または公式短縮 URL ホストの場合は HEAD で URL を解決する。
	// Fastify モード（followRedirects: false）でも、サービス公式の短縮 URL に限り
	// 解決後の URL でプラグインマッチングが行われるようにする。
	let initialHost = '';
	try { initialHost = new URL(url).hostname; } catch { /* malformed URL は後続の new URL で throw する */ }
	const shouldResolve = opts.followRedirects || KNOWN_SHORT_HOSTS.has(initialHost);
	if (shouldResolve) {
		// .catch(() => url)にすればいいけど、jestにtrace-redirectを食わせるのが面倒なのでtry-catch
		try {
			const timeout = opts.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT;
			const operationTimeout = opts.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT;
			actualUrl = await got
				.head(url, {
					headers: {
						accept: 'text/html,application/xhtml+xml',
						'user-agent': opts.userAgent ?? DEFAULT_BOT_UA,
						'accept-language': opts.lang ?? undefined,
					},
					timeout: {
						lookup: timeout,
						connect: timeout,
						secureConnect: timeout,
						socket: timeout, // read timeout
						response: timeout,
						send: timeout,
						request: operationTimeout, // whole operation timeout
					},
					agent,
					http2: false,
					retry: {
						limit: 0,
					},
					// 短縮 URL からの多段リダイレクトを制限（SSRF チェイン緩和）
					maxRedirects: 5,
				})
				.then(res => res.url);
		} catch {
			actualUrl = url;
		}
	}

	const _url = new URL(actualUrl);

	// Find matching plugin
	const match = plugins.filter(plugin => plugin.test(_url))[0];

	// Get summary
	const scrapingOptions: GeneralScrapingOptions = {
		lang: opts.lang,
		userAgent: opts.userAgent,
		responseTimeout: opts.responseTimeout,
		followRedirects: opts.followRedirects,
		operationTimeout: opts.operationTimeout,
		contentLengthLimit: opts.contentLengthLimit,
		contentLengthRequired: opts.contentLengthRequired,
		useRange: opts.useRange,
	};

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	const summary = await (match ? match.summarize : general)(_url, scrapingOptions);

	if (summary == null) {
		throw new Error('failed summarize');
	}

	// 結果に含まれる URL を sanitize（https/http/data:<10KB> のみ許可）
	summary.icon = sanitizeUrl(summary.icon);
	summary.thumbnail = sanitizeUrl(summary.thumbnail);
	if (summary.player.url != null) {
		const sanitizedPlayer = sanitizeUrl(summary.player.url);
		if (sanitizedPlayer == null) {
			// URL が弾かれたら allow / 寸法も残さずプレーヤー全体をリセットする
			// （url が null なのに allow が残ると利用側が誤って permission を渡す可能性がある）
			summary.player = { url: null, width: null, height: null, allow: [] };
		} else {
			summary.player.url = sanitizedPlayer;
		}
	}
	if (summary.medias != null) {
		summary.medias = summary.medias
			.map(u => sanitizeUrl(u))
			.filter((u): u is string => u != null);
	}

	return Object.assign(summary, {
		url: actualUrl,
	});
};

// eslint-disable-next-line import/no-default-export
export default function (fastify: FastifyInstance, options: SummalyOptions, done: (err?: Error) => void) {
	const successMaxAge = options.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE;
	const errorMaxAge = options.cacheErrorMaxAge ?? DEFAULT_CACHE_ERROR_MAX_AGE;

	let successCacheHeader: string;
	let errorCacheHeader: string;
	try {
		successCacheHeader = cacheControlHeader(successMaxAge);
		errorCacheHeader = cacheControlHeader(errorMaxAge);
	} catch (e) {
		done(e as Error);
		return;
	}

	// インメモリキャッシュ（プラグインスコープ singleton）。
	// TTL は各 set() 呼び出しで成功 / エラー個別に指定するため、コンストラクタには渡さない。
	const cache: LRUCache<string, CacheEntry> | null = options.inMemoryCache
		? new LRUCache<string, CacheEntry>({
			max: options.inMemoryCacheMaxEntries ?? DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES,
		})
		: null;

	fastify.get<{
		Querystring: {
			url?: string;
			lang?: string;
		};
	}>('/', async (req, reply) => {
		const url = req.query.url as string;
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (url == null) {
			reply.header('Cache-Control', errorCacheHeader);
			return reply.status(400).send({
				error: 'url is required',
			});
		}

		const lang = req.query.lang as string | undefined;
		// normalizeCacheKey が null を返す（不正 URL）場合はキャッシュをスキップして summaly() に委ねる
		const cacheKey = cache ? normalizeCacheKey(url, lang) : null;

		// キャッシュヒット
		if (cache && cacheKey != null) {
			const hit = cache.get(cacheKey);
			if (hit != null) {
				reply.header('X-Cache', 'HIT');
				if (hit.kind === 'success') {
					reply.header('Cache-Control', successCacheHeader);
					return hit.value;
				}
				// エラーキャッシュヒット
				reply.header('Cache-Control', errorCacheHeader);
				return reply.status(500).send({ error: hit.error });
			}
		}

		try {
			const summary = await summaly(url, {
				lang,
				followRedirects: false,
				...options,
			});

			if (cache && cacheKey != null) {
				cache.set(cacheKey, { kind: 'success', value: summary }, { ttl: successMaxAge * 1000 });
				reply.header('X-Cache', 'MISS');
			}
			reply.header('Cache-Control', successCacheHeader);
			return summary;
		} catch (e) {
			const errorPayload = serializableError(e);
			if (cache && cacheKey != null) {
				cache.set(cacheKey, { kind: 'error', error: errorPayload }, { ttl: errorMaxAge * 1000 });
				reply.header('X-Cache', 'MISS');
			}
			reply.header('Cache-Control', errorCacheHeader);
			return reply.status(500).send({
				error: errorPayload,
			});
		}
	});

	done();
}
