/**
 * summaly
 * https://github.com/misskey-dev/summaly
 */

import got, { type Agents as GotAgents } from 'got';
import { LRUCache } from 'lru-cache';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SummalyResult as _SummalyResult } from '@/summary.js';
import { SummalyPlugin as _SummalyPlugin } from '@/iplugin.js';
import { general, type GeneralScrapingOptions } from '@/general.js';
import { DEFAULT_BOT_UA, DEFAULT_OPERATION_TIMEOUT, DEFAULT_RESPONSE_TIMEOUT, agent, setAgent } from '@/utils/got.js';
import { plugins as builtinPlugins } from '@/plugins/index.js';
import { KNOWN_SHORT_HOSTS } from '@/utils/short-urls.js';
import { sanitizeUrl } from '@/utils/sanitize-url.js';
import { buildCspDirectiveParts } from '@/utils/csp-origin.js';
import { StatusError } from '@/utils/status-error.js';
import {
	ParseFailureLog,
	isThinSummary,
	categorizeError,
	sanitizeUrlForLog,
	type SummalyErrorCategory,
} from '@/utils/parse-failure-log.js';
import { chooseLogLevel } from '@/utils/log-level.js';
import {
	DomainStrategyCache,
	getActiveCache,
	getDefaultBootstrapPath,
	setActiveCache,
	type CacheRecordingState,
} from '@/utils/domain-strategy-cache.js';

// 公開型として再 export（消費者が SerializableError['category'] でなく直接の名前で参照できるよう）
export type { SummalyErrorCategory };

export type SummalyResult = _SummalyResult;

export type SummalyPlugin = _SummalyPlugin;

export type SummalyOptions = {
	/**
	 * Accept-Language for the request
	 */
	lang?: string | null;

	/**
	 * `summaly()` の **初期 HEAD/GET でリダイレクトを解決するかどうか**。デフォルト true。
	 *
	 * - `true`: 最初に `resolveRedirect()` を呼んで最終 URL を確定してからプラグインマッチング
	 * - `false`: 受け取った URL のままプラグインマッチング（ただし `KNOWN_SHORT_HOSTS` は例外で常に解決される）
	 *
	 * Note: このフラグは **summaly レイヤの初期 URL 解決限定**。scrape 本体（`scpaping()` 内の
	 * got リクエスト）は常にリダイレクトを follow する（SSRF 対策は `maxRedirects: 5` + プライベート
	 * IP ガードで担保）。
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

	/**
	 * Fastify プラグインモード**専用**の in-flight リクエスト dedup を有効化する。デフォルト true。
	 * 同一 URL に並列でリクエストが来た場合、先頭リクエストの結果を後続も共有することで
	 * origin への同時アクセスを 1 本化する（thundering herd 緩和）。
	 * `inMemoryCache` とは独立に効くため、キャッシュ無効でも並列の集中だけは抑えられる。
	 * 完全に従来挙動に戻すには `false` を明示する。
	 *
	 * Note: ライブラリの `summaly()` 関数を直接呼び出す利用法では参照されない（無視される）。
	 */
	inFlightDedup?: boolean;

	/**
	 * Fastify モード**専用**のパース失敗ログ機能を有効化する。デフォルト false。
	 * `summaly()` が throw した、または結果が「汎用パスでスカスカ（OG/Twitter Card/`<title>` のいずれも取れず）」のとき
	 * ホスト + パス先頭 2 セグメントを key にして直近 N サンプルをプロセス内に蓄積する。
	 * プラグイン化候補のドメイン発見器として運用する。
	 *
	 * Note: ライブラリの `summaly()` 関数を直接呼び出す利用法では参照されない（無視される）。
	 */
	parseFailureLog?: boolean;

	/**
	 * パース失敗ログの最大グループ数（key 単位）。デフォルト 1000。
	 * 上限を超えたグループは LRU 風に最も古いものから捨てられる。
	 */
	parseFailureLogMaxGroups?: number;

	/**
	 * パース失敗ログ 1 グループあたりの最大サンプル数。デフォルト 5。
	 */
	parseFailureLogSamplesPerGroup?: number;

	/**
	 * パース失敗ログの永続化用 JSONL ファイルパス。指定すると `record()` のたびに 1 行 append される。
	 * 起動時に既存ファイルサイズを読み、`parseFailureLogJsonlMaxBytes` を超えていたら以降 append しない。
	 * 未指定の場合はメモリのみで永続化なし（プロセス再起動で消える）。
	 */
	parseFailureLogJsonlPath?: string;

	/**
	 * JSONL ファイルの最大バイト数。これを超えたら以降の append を停止する（ローテーションはしない）。
	 * 「気付いたタイミングで運用者が rm / mv する」運用想定。デフォルト 10 MiB。
	 */
	parseFailureLogJsonlMaxBytes?: number;

	/**
	 * 迂回候補ログ JSONL の出力先。`isFilteredFailure` 対象（4xx/5xx, timeout,
	 * SSRF block, type filter, network, connection_dropped）の失敗を 1 行ずつ append する。
	 * プラグイン候補ログ (`parseFailureLogJsonlPath`) とは別ファイルで純度を保つ設計。
	 *
	 * 用途: 「公開 HTML はブロックだが別 API で同等情報が取れる」パターン（npm の registry.npmjs.org 等）
	 * を後から発見する。`cat blocked.jsonl | jq -r '.url' | sort -u` 等の集計で運用。
	 *
	 * 各行に `category` (`SummalyErrorCategory`) と `errorName` を含めるため `jq -c 'select(.category == "bot_blocked")'`
	 * のような細分フィルタが可能。`parseFailureLog: true` のときのみ動作（既存ログと同じスイッチで有効化）。
	 */
	parseFailureLogBlockedJsonlPath?: string;

	/**
	 * 迂回候補ログ JSONL の最大バイト数。プラグイン候補ログ (`parseFailureLogJsonlMaxBytes`) とは
	 * 独立に効く。デフォルト 10 MiB。流量が多くなる可能性があるため監視必須。
	 */
	parseFailureLogBlockedJsonlMaxBytes?: number;

	/**
	 * PDF レスポンスのタイトル取得を有効化する（オプトイン）。
	 * `true` または環境変数 `SUMMALY_ENABLE_PDF=true` のいずれかが設定されている場合のみ
	 * PDF を type filter で許可し、`pdf-parse` で先頭メタデータからタイトルを取得する。
	 *
	 * デフォルト無効。PDF パースは巨大ファイル / 悪意ある PDF でメモリ・CPU を消費するため
	 * `contentLengthLimit` (受信前)・`useRange` (受信中)・5 秒 timeout・1 ページのみ等の多段防衛を入れているが、
	 * 「PDF を扱う／扱わない」の最終判断は運用者に委ねる方針。
	 */
	enablePdf?: boolean;

	/**
	 * Bot block 検出時のフォールバック UA。
	 *
	 * `summaly()` の内部リクエストが `fallbackRetryCategories` に含まれるエラーカテゴリで失敗したとき、
	 * UA をこの値に差し替えて 1 回だけ再試行する。`undefined` または空文字列ならリトライ無効
	 * （既存挙動互換）。
	 *
	 * 想定: `SummalyBot` 文字列を WAF が弾くサイトに対し、`facebookexternalhit/1.1` のような
	 * share-link 用の正規 bot UA で救援する用途。Fastify モードでは `config.toml` の
	 * `[scraping.fallback]` から自動注入される。
	 */
	fallbackUserAgent?: string;

	/**
	 * `fallbackUserAgent` が発火するエラーカテゴリ。
	 * デフォルト: `['bot_blocked', 'connection_dropped']`。
	 */
	fallbackRetryCategories?: SummalyErrorCategory[];

	/**
	 * Outbound proxy フォールバック設定。
	 *
	 * UA fallback でも救えなかった IP レピュテーション層の遮断
	 * （Vultr Tokyo IP からの amazon.co.jp 等）に対し、Cloudflare Workers にデプロイした
	 * 薄い proxy 経由でリトライする。`enabled === false` または `secret === ''` ならリトライ無効。
	 *
	 * 詳細は `tools/cf-proxy-worker/README.md` 参照。
	 */
	proxyFallback?: import('@/utils/proxy-fallback.js').ProxyFallbackConfig;

	/**
	 * curl_cffi (libcurl-impersonate) フォールバック設定。
	 *
	 * proxy fallback でも救えなかった **TLS layer bot block** (yodobashi 級の
	 * HTTP/2 INTERNAL_ERROR / 即時切断) に対し、`tools/curl-cffi-fetcher/` の
	 * Python CLI を spawn して Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を
	 * 偽装してリトライする。`enabled === false` ならリトライ無効。
	 *
	 * production server には `uv` を別途インストールし、
	 * `cd tools/curl-cffi-fetcher && uv sync` で依存解決しておく必要がある。
	 *
	 * 詳細は `tools/curl-cffi-fetcher/README.md` 参照。
	 */
	curlCffiFallback?: import('@/utils/curl-cffi-fetch.js').CurlCffiFallbackConfig;

	/**
	 * Hedged race の champion 単独猶予期間 (ms)。phase18 で導入。
	 * champion がこの時間内に valid な response を返さなければ、challengers (残り全 strategy) を
	 * 並列発火する。デフォルト 5000 (5 秒)。0 にすると即時並列発火 (debug / explore 用)。
	 */
	hedgedThresholdMs?: number;

	/**
	 * @internal
	 * 経路学習キャッシュ + hedge race の記録 context を伝達する mutable side-channel。
	 * 通常 `summaly()` 内部で `{}` が割り当てられ、`scpaping()` レイヤが書き込み、`summaly()` が
	 * Summary 確定後に値を読んで `cache.recordX` を呼ぶ。
	 *
	 * **外部から渡すと** その object が共有され、`summaly()` 戻り後に呼出側でも `recState.hedgeFired` /
	 * `recState.hedgeOutcomes` / `recState.hedgeLatencyMs` 等を読み取れる。Fastify ハンドラで pino
	 * ログに hedge 情報を出すために phase18.1 で公開。library 利用者は通常触らない。
	 */
	_cacheRecording?: import('@/utils/domain-strategy-cache.js').CacheRecordingState;

	/**
	 * 経路学習キャッシュ設定。
	 *
	 * ドメイン (host + path prefix 1〜2 段) ごとに「成功した取得経路」を学習・永続化し、
	 * 次回以降のリクエストで第一選択肢として使うことで「初回 default UA で 20 秒空回り
	 * → fallback で成功」の時間損失を回避する。`enabled === false` なら従来カスケードのみ。
	 *
	 * 詳細は `docs/plans/phase14-domain-strategy-cache.md` 参照。
	 */
	domainStrategyCache?: import('@/utils/domain-strategy-cache.js').DomainStrategyCacheOptions;

	/**
	 * **Fastify モードの自身が公開されている URL ベース**。
	 * 例: `https://summaly.example.com`
	 *
	 * 設定すると、`renderEmbed` を実装したプラグイン (syosetu / kakuyomu / dlsite / iwara / komiflo / nijie / dmm 等) が
	 * Summary の `player.url` を `<embedBaseUrl>/embed?url=<encoded>` として組み立てる。
	 * 未設定の場合は player は無効化 (library mode のデフォルト挙動と同じ)。
	 *
	 * Fastify モードでは `[embed].publicUrl` から自動投入される。
	 *
	 * @see embedConfig
	 */
	embedBaseUrl?: string;

	/**
	 * **`/embed` エンドポイント設定** (Fastify モード専用)。
	 *
	 * `[embed]` TOML セクションから自動投入される。`enabled === false` なら `/embed` は 404 を返し、
	 * 対応プラグインが `renderEmbed` を実装していても player.url は組み立てられない (= 機能完全無効)。
	 * library mode (`summaly()` 関数直接呼び出し) では参照されない。
	 */
	embedConfig?: {
		/** embed エンドポイントを有効化するか。`false` で `/embed` が 404、player.url も生成しない */
		enabled: boolean;
		/** embed 対応プラグインの allowlist。空 / 未設定は **fail-close で無効** (= 全プラグインで embed 不可) */
		allowedPlugins: string[];
		/** CSP `frame-ancestors` 値の配列。`['*']` で任意 origin 許可、商用は明示制限推奨 */
		frameAncestors: string[];
	};
};

const DEFAULT_CACHE_MAX_AGE = 604800;
const DEFAULT_CACHE_ERROR_MAX_AGE = 3600;
const DEFAULT_IN_MEMORY_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_PARSE_FAILURE_LOG_MAX_GROUPS = 1000;
const DEFAULT_PARSE_FAILURE_LOG_SAMPLES_PER_GROUP = 5;

type CacheEntry =
	| { kind: 'success'; value: SummalyResult }
	| { kind: 'error'; error: SerializableError };

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
 * Fastify モードのエラーレスポンスに乗せるシリアライズ済みエラー。
 * - `message` / `name`: 既存フィールド（後方互換）
 * - `category`: クライアント (Misskey 等) が UI 出し分けに使う公開カテゴリ
 * - `statusCode`: `StatusError` のときのみ。HTTP 由来のエラーが上流のどのコードか分かる
 */
export interface SerializableError {
	message?: string;
	name?: string;
	category: SummalyErrorCategory;
	statusCode?: number;
}

/**
 * エラーをキャッシュ可能な形に変換する。
 * `Error` インスタンスは `JSON.stringify` で `{}` になりレスポンスから情報が消えるため、
 * `{ message, name, category, statusCode? }` の plain object に正規化して HIT/MISS で
 * レスポンスの一貫性を保つ。stack トレースは積み重ねでメモリ消費の遠因になるため捨てる。
 */
function serializableError(e: unknown): SerializableError {
	const message = e instanceof Error ? e.message : (typeof e === 'string' ? e : undefined);
	const name = e instanceof Error ? e.name : undefined;
	const statusCode = e instanceof StatusError ? e.statusCode : undefined;
	const category = categorizeError(message, name, statusCode);
	return {
		...(message !== undefined ? { message } : {}),
		...(name !== undefined ? { name } : {}),
		...(statusCode !== undefined ? { statusCode } : {}),
		category,
	};
}

function cacheControlHeader(maxAge: number): string {
	if (!Number.isFinite(maxAge) || maxAge < 0) {
		throw new RangeError(`cacheMaxAge / cacheErrorMaxAge must be a non-negative finite number, got ${maxAge}`);
	}
	return maxAge === 0 ? 'no-store' : `public, max-age=${maxAge}`;
}

/**
 * `summaly()` 内でリダイレクト解決に使う共通オプションを構築する。HEAD と GET fallback で
 * 同じ timeout / agent / accept ヘッダ / maxRedirects を使うため切り出している。
 */
function buildResolveRequestOptions(opts: SummalyOptions) {
	const timeout = opts.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT;
	const operationTimeout = opts.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT;
	// enablePdf 真のときは Accept に application/pdf も含める（厳格なコンテントネゴシエーションサーバ向け）
	const acceptHeader = opts.enablePdf
		? 'text/html,application/xhtml+xml,application/pdf'
		: 'text/html,application/xhtml+xml';
	return {
		headers: {
			accept: acceptHeader,
			'user-agent': opts.userAgent ?? DEFAULT_BOT_UA,
			'accept-language': opts.lang ?? undefined,
		} as Record<string, string | undefined>,
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
		retry: { limit: 0 },
		// 短縮 URL からの多段リダイレクトを制限（SSRF チェイン緩和）
		maxRedirects: 5,
	};
}

/**
 * 短縮 URL / 通常 URL を辿って最終 URL を解決する。
 *
 * 1. まず HEAD を試す（軽量、body を受信しない）
 * 2. HEAD が失敗した場合は GET に fallback する。`amzn.asia` のように HEAD には 404 を返すが
 *    GET には 301 でリダイレクトを返すサーバが存在するため。GET には `Range: bytes=0-0` を
 *    付けて body 受信量を最小化する（リダイレクトされる場合は body は無いし、最終ターゲットが
 *    Range を尊重すれば 1 バイトだけで済む）
 * 3. どちらも失敗した場合は元の URL をそのまま返す（既存挙動互換）
 */
async function resolveRedirect(url: string, opts: SummalyOptions): Promise<string> {
	const reqOpts = buildResolveRequestOptions(opts);
	try {
		return await got.head(url, reqOpts).then(res => res.url);
	} catch {
		// HEAD 失敗時の GET fallback
		try {
			return await got.get(url, {
				...reqOpts,
				headers: { ...reqOpts.headers, range: 'bytes=0-0' },
			}).then(res => res.url);
		} catch {
			return url;
		}
	}
}

export const summalyDefaultOptions = {
	lang: null,
	followRedirects: true,
	plugins: [],
} as SummalyOptions;

/**
 * 経路学習キャッシュへ record する内部ヘルパ。
 * `cache != null && recordKey != null && !gateFailedNeutral` のときだけ動作する。
 *
 * - `recordCacheSuccess`: strategy も必須 (= cache hit success / cascade success のいずれかを経由した)
 * - `recordCacheFailure`: strategy 不要 (= 既存 entry の連続失敗カウントを増やすだけ)
 *
 * gate-fail neutrality: cache hit がゲート不通過だった場合は entry を「config 復帰時の再利用候補」
 * として温存するため両 record をスキップする。
 */
function recordCacheSuccess(state: CacheRecordingState): void {
	if (state.gateFailedNeutral === true) return;
	if (state.recordKey == null || state.strategy == null) return;
	const cache = getActiveCache();
	if (cache == null) return;
	cache.recordSuccess(state.recordKey, state.strategy);
}

function recordCacheFailure(state: CacheRecordingState): void {
	if (state.gateFailedNeutral === true) return;
	if (state.recordKey == null) return;
	const cache = getActiveCache();
	if (cache == null) return;
	cache.recordFailure(state.recordKey);
}

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
	// followRedirects が true、または公式短縮 URL ホストの場合はリダイレクト解決を行う。
	// Fastify モード（followRedirects: false）でも、サービス公式の短縮 URL に限り
	// 解決後の URL でプラグインマッチングが行われるようにする。
	let initialHost = '';
	let initialUrl: URL | null = null;
	try {
		initialUrl = new URL(url);
		initialHost = initialUrl.hostname;
	} catch { /* malformed URL は後続の new URL で throw する */ }

	// **`skipRedirectResolution = true` を宣言したプラグイン**が初期 URL にマッチする場合は、
	// HEAD/GET probe をスキップする。yodobashi のように TLS layer で bot 切断する
	// 終端確定 URL に対して、resolveRedirect の HEAD/GET probe が timeout (20 秒) まで空回りする
	// 純損失を回避する。terminal URL を持つプラグインのみが宣言する想定 (短縮 URL 系プラグインでは
	// 絶対に有効化しないこと、その場合 resolveRedirect が必須)。
	const skipResolvePlugin = initialUrl != null
		? plugins.find(p => p.skipRedirectResolution === true && p.test(initialUrl as URL))
		: undefined;

	const shouldResolve = !skipResolvePlugin
		&& (opts.followRedirects || KNOWN_SHORT_HOSTS.has(initialHost));
	if (shouldResolve) {
		actualUrl = await resolveRedirect(url, opts);
	}

	const _url = new URL(actualUrl);

	// Find matching plugin
	const match = plugins.filter(plugin => plugin.test(_url))[0];

	// Get summary
	// `opts.followRedirects` は **summaly() の初期 HEAD 解決をするかどうか** を意味する
	// summaly レイヤのフラグであり、scpaping (本体取得) の got リクエストには伝播させない。
	// もし伝播させると、Fastify モードのように `followRedirects: false` を明示する利用形態で
	// scpaping のリダイレクトすら follow されなくなり、Amazon の `/dp/<ASIN>` 301 等で
	// 中間レスポンス（content-type 無し）が typeFilter で reject されて落ちる。
	// scrape 中のリダイレクト追跡は got のデフォルト (true) に任せる。SSRF チェインは
	// `maxRedirects: 5` とプライベート IP ガードで別途抑制している。
	// 経路学習キャッシュの記録 context。
	// scpaping が読み書きし、summaly() が Summary 確定後にこの値を見て recordX を実行する。
	// 設計詳細は `CacheRecordingState` の JSDoc 参照。
	// **phase18.1**: 外部 (Fastify ハンドラ) から `_cacheRecording` が渡されていればそれを共有して
	// hedge race の outcomes / latencyMs を呼出側に伝搬する (pino ログ用)。
	const cacheRecording: CacheRecordingState = opts._cacheRecording ?? {};

	const scrapingOptions: GeneralScrapingOptions = {
		lang: opts.lang,
		userAgent: opts.userAgent,
		responseTimeout: opts.responseTimeout,
		operationTimeout: opts.operationTimeout,
		contentLengthLimit: opts.contentLengthLimit,
		contentLengthRequired: opts.contentLengthRequired,
		useRange: opts.useRange,
		enablePdf: opts.enablePdf,
		fallbackUserAgent: opts.fallbackUserAgent,
		fallbackRetryCategories: opts.fallbackRetryCategories,
		proxyFallback: opts.proxyFallback,
		curlCffiFallback: opts.curlCffiFallback,
		hedgedThresholdMs: opts.hedgedThresholdMs,
		_cacheRecording: cacheRecording,
		_embedBaseUrl: opts.embedBaseUrl,
	};

	let summary: Awaited<ReturnType<typeof general>>;
	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		summary = await (match ? match.summarize : general)(_url, scrapingOptions);
	} catch (err) {
		// summaly() レイヤの try/catch: scpaping や parseGeneral から throw されたエラーを catch して
		// cache.recordFailure を呼び出してから再 throw する。HTTP 完全失敗 (cache hit fail + cascade fail) は
		// ここに到達するため、N 連続失敗で entry が破棄される動線が成立する。
		recordCacheFailure(cacheRecording);
		throw err;
	}

	if (summary == null) {
		// プラグイン dispatcher が `null` を返したケース。HTTP は成功したが summarize 不能 → failure 扱い。
		recordCacheFailure(cacheRecording);
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

	const result = Object.assign(summary, {
		url: actualUrl,
	});

	// 経路学習キャッシュ記録:
	// Summary が thin (= OG/Twitter Card/<title> いずれも取れず) なら strategy が不適切 → recordFailure。
	// Summary が good なら recordSuccess。gate-fail neutrality は recordCacheSuccess / Failure の中で守られる。
	// **重要 (S-4 review feedback)**: `isThinSummary` 内部は `summary.url` を `URL.hostname` として参照して
	// `title === host` の判定を行うため、`result` (= summary に actualUrl を含めた) を渡す必要がある。
	// 順序を入れ替えて `summary` を直接渡すと `summary.url` が undefined で thin 判定が壊れる。
	if (isThinSummary(result)) {
		recordCacheFailure(cacheRecording);
	} else {
		recordCacheSuccess(cacheRecording);
	}

	return result;
};

/**
 * phase18.1: hedge race の発火 / 勝者 / 各経路の outcome / latency を pino に構造化ログ出力。
 *
 * `recState.hedgeFired` が `true` のとき (= champion が threshold 内に valid を返せず challenger 並列発火)
 * のみログを出す (定常状態の champion 即勝ちでは何も出さない、ログ spam 抑制)。
 *
 * 出力フィールド:
 * - `hedge_fired`: true 固定 (このログが出る = hedge 発火)
 * - `champion`: cache hit があれば hit.entry.strategy、cache miss なら 'default'
 * - `winner`: 最終的に勝った strategy
 * - `outcomes`: 各経路の最終状態 (`valid` / `invalid` / `error` / `gate_failed`)
 * - `latency_ms`: 各経路の completion latency
 * - `url`: sanitize 済み URL (PII 除去)
 *
 * 用途: 「どの経路が gate_failed か」「curl_cffi が起動しているか」「各経路の latency 分布」を
 * 本番診断するために必要 (Step 6 で deferred になっていた機能、phase18.1 で実装)。
 */
function logHedgeIfFired(
	req: FastifyRequest,
	url: string,
	recState: CacheRecordingState,
): void {
	if (recState.hedgeFired !== true) return;
	req.log.info(
		{
			hedge_fired: true,
			winner: recState.strategy,
			outcomes: recState.hedgeOutcomes,
			latency_ms: recState.hedgeLatencyMs,
			// 各 strategy の error message (本番診断必須、phase18.1)。outcomes: 'error' の strategy について
			// 「なぜ」が分かるよう error.message を string で出力。
			errors: recState.hedgeErrors,
			url: sanitizeUrlForLog(url),
		},
		'hedge race fired',
	);
}

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

	// in-flight リクエスト dedup の Map（プラグインスコープ singleton）。
	// LRU と独立に効くため、キャッシュ無効でも同 URL の並列 origin アクセスを 1 本化できる。
	// `inFlightDedup` 未指定はデフォルト true。
	const dedupEnabled = options.inFlightDedup ?? true;
	const inFlight: Map<string, Promise<CacheEntry>> | null = dedupEnabled
		? new Map<string, Promise<CacheEntry>>()
		: null;

	// X-Cache ヘッダはキャッシュか dedup のどちらか有効なときに付与する（既存挙動: 両方無効なら付かない）
	const emitCacheHeader = cache != null || inFlight != null;

	// パース失敗ログ集約（プラグインスコープ singleton、迂回候補ログを併設）
	const parseFailureLog: ParseFailureLog | null = options.parseFailureLog
		? new ParseFailureLog({
			maxGroups: options.parseFailureLogMaxGroups ?? DEFAULT_PARSE_FAILURE_LOG_MAX_GROUPS,
			samplesPerGroup: options.parseFailureLogSamplesPerGroup ?? DEFAULT_PARSE_FAILURE_LOG_SAMPLES_PER_GROUP,
			jsonlPath: options.parseFailureLogJsonlPath,
			jsonlMaxBytes: options.parseFailureLogJsonlMaxBytes,
			blockedJsonlPath: options.parseFailureLogBlockedJsonlPath,
			blockedJsonlMaxBytes: options.parseFailureLogBlockedJsonlMaxBytes,
		})
		: null;

	// 経路学習キャッシュの自動インスタンス化。
	// `[scraping.strategy_cache].enabled = true` を読み取って `DomainStrategyCache` を作成し、
	// モジュールレベル singleton (`setActiveCache`) に登録する。`scpaping()` は `getActiveCache()` で
	// 取得して lookup する。Fastify サーバ起動時に 1 回だけ実行される (プラグインスコープ singleton)。
	//
	// **設計判断**: `setActiveCache` はモジュールレベル singleton のため、複数 Fastify インスタンスを
	// 同一プロセスで起動すると **後勝ち** になる。本ユースケースは想定していない (1 プロセス 1 Fastify)。
	// 既存の `setAgent` パターンと同じ前提。
	const strategyCacheOpts = options.domainStrategyCache;
	if (strategyCacheOpts != null && strategyCacheOpts.enabled) {
		// `bootstrapPath` 未指定時はリポ同梱 `data/domain-strategy-bootstrap.jsonl` を自動解決する。
		// 同梱ファイルが見つからない (= カスタムビルド等) なら `undefined` のまま → bootstrap なし扱い。
		// `runtimePath` 未指定時は永続化なし (in-memory のみ) として解釈される。
		// W-1 review feedback: `cache` の中間変数を省いてシャドーイング (Fastify cache LRU との衝突) を回避
		setActiveCache(new DomainStrategyCache({
			maxEntries: strategyCacheOpts.maxEntries,
			bootstrapPath: strategyCacheOpts.bootstrapPath ?? getDefaultBootstrapPath(),
			runtimePath: strategyCacheOpts.runtimePath,
			consecutiveFailureThreshold: strategyCacheOpts.consecutiveFailureThreshold,
			compactionThreshold: strategyCacheOpts.compactionThreshold,
		}));
	}

	// `embedConfig.allowedPlugins` を auto-fill。`renderEmbed` を実装した builtinPlugins のうち
	// `[plugins].allowed` (= options.allowedPlugins) に含まれるものをすべて embed 対応として登録する。
	// 「embed 対応プラグインを部分的に絞り込む」という低頻度ニーズは `[plugins].allowed` から外すことで実現する
	// 設計に統一し、TOML キーの二重管理 (旧 `[embed].allowedPlugins`) を撤廃した。
	if (options.embedConfig != null && options.embedConfig.enabled) {
		const allowed = options.allowedPlugins;
		const autoFilled = builtinPlugins
			.filter(p => p.name != null && p.renderEmbed != null && (allowed === undefined || allowed.includes(p.name)))
			.map(p => p.name as string);
		options.embedConfig = { ...options.embedConfig, allowedPlugins: autoFilled };
	}

	function respondWithEntry(reply: FastifyReply, entry: CacheEntry) {
		if (entry.kind === 'success') {
			reply.header('Cache-Control', successCacheHeader);
			return entry.value;
		}
		reply.header('Cache-Control', errorCacheHeader);
		return reply.status(500).send({ error: entry.error });
	}

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
		// normalizeCacheKey が null を返す（不正 URL）場合は LRU / dedup どちらもスキップして summaly() に委ねる
		const cacheKey = emitCacheHeader ? normalizeCacheKey(url, lang) : null;

		// 1. LRU キャッシュヒット
		if (cache && cacheKey != null) {
			const hit = cache.get(cacheKey);
			if (hit != null) {
				reply.header('X-Cache', 'HIT');
				return respondWithEntry(reply, hit);
			}
		}

		// 2. in-flight 待ち（先頭リクエストの結果を共有して origin に行かない）
		if (inFlight && cacheKey != null) {
			const pending = inFlight.get(cacheKey);
			if (pending != null) {
				const entry = await pending;
				reply.header('X-Cache', 'HIT-COALESCED');
				return respondWithEntry(reply, entry);
			}
		}

		// 3. 完全な MISS（LRU・dedup どちらも HIT しなかった、または両方無効）。
		//    dedup 有効時は先頭として inFlight にエントリを登録し、後続の並列リクエストに共有する。
		const fetchEntry = async (): Promise<CacheEntry> => {
			// phase18.1: hedge race の outcome を pino に出すため recState を確保。
			// summaly() 内部で `_cacheRecording` を上書きするので、ここで作っても新規 instance に上書きされる。
			// そのため成功 / 失敗の両経路で `recState` を取り出すには summaly() レイヤを修正する必要があるが、
			// それは scope 大きいので **代わりに本ハンドラで `_cacheRecording` を渡し、summaly() の `Object.assign`
			// に任せて hedge 情報を埋めてもらう**設計を採る (要 summaly() 改修、後述)。
			const recState: import('@/utils/domain-strategy-cache.js').CacheRecordingState = {};
			try {
				const summary = await summaly(url, {
					lang,
					followRedirects: false,
					...options,
					_cacheRecording: recState,
				});
				logHedgeIfFired(req, url, recState);
				return { kind: 'success', value: summary };
			} catch (e) {
				logHedgeIfFired(req, url, recState);
				// pino へエラーを構造化ログ出力。
				// MISS 経路でしか呼ばれないので LRU/dedup HIT 時は再ログされない（spam 抑制）。
				// ログレベルは chooseLogLevel で category 由来 (4xx=info / 5xx・timeout=warn / 想定外=error)。
				// URL は sanitizeUrlForLog で query/fragment/auth を除去（PII 漏洩防止）。
				//
				// **err は手動シリアライズ**: pino のデフォルト `errSerializer` は got の `RequestError`
				// の `options.url` などを列挙可能プロパティとして含めて出力するため、対象 URL のクエリ
				// （token / session 等）が漏れる経路がある。
				// `name` / `message` / `stack` / `statusCode` だけを明示的に渡すことで漏洩経路を遮断する。
				// `type` は pino の慣例フィールド（errSerializer 互換）。Error クラス名を入れることで
				// jq での grep が `select(.err.type == "StatusError")` の形で書けるようになる。
				const level = chooseLogLevel(e);
				const statusCode = e instanceof StatusError ? e.statusCode : undefined;
				const errInfo = e instanceof Error
					? { type: e.name, name: e.name, message: e.message, stack: e.stack, ...(statusCode !== undefined ? { statusCode } : {}) }
					: { type: 'NonError', name: 'NonError', message: String(e) };
				req.log[level](
					{ err: errInfo, url: sanitizeUrlForLog(url), lang, statusCode },
					'summaly error',
				);
				return { kind: 'error', error: serializableError(e) };
			}
		};

		let entry: CacheEntry;
		if (inFlight && cacheKey != null) {
			// fetchEntry は内部で try/catch して常に resolve する（reject しない）ため
			// await が throw する可能性は無く、明示的な try/finally は不要。
			// 順序: LRU set → inFlight delete。delete 直後の新規リクエストが LRU HIT で拾えるよう
			// LRU を先に埋めてから inFlight Map から外す。
			const promise = fetchEntry();
			inFlight.set(cacheKey, promise);
			entry = await promise;
			if (cache) {
				const ttl = entry.kind === 'success' ? successMaxAge * 1000 : errorMaxAge * 1000;
				cache.set(cacheKey, entry, { ttl });
			}
			inFlight.delete(cacheKey);
		} else {
			entry = await fetchEntry();
			if (cache && cacheKey != null) {
				const ttl = entry.kind === 'success' ? successMaxAge * 1000 : errorMaxAge * 1000;
				cache.set(cacheKey, entry, { ttl });
			}
		}

		// パース失敗ログ記録 — MISS 経路で実際に summaly() を呼んだケースだけ記録（cache/inflight HIT は重複記録しない）。
		// `record()` 内部で振り分け:
		//   - thin / 非フィルタ throw → プラグイン候補（in-memory + candidate JSONL）
		//   - フィルタ対象 throw（4xx/5xx, timeout, SSRF, type filter, network, connection_dropped）
		//     → 迂回候補（blocked JSONL のみ、in-memory には混ぜない）
		// 呼出側はカテゴリ判定ロジックを持たず、`record()` に判定材料 (message/name/statusCode) を渡すだけ。
		if (parseFailureLog != null) {
			if (entry.kind === 'error') {
				const errPayload = entry.error;
				const message = typeof errPayload.message === 'string' ? errPayload.message : undefined;
				const name = typeof errPayload.name === 'string' ? errPayload.name : undefined;
				const statusCode = typeof errPayload.statusCode === 'number' ? errPayload.statusCode : undefined;
				parseFailureLog.record(url, 'throw', message, name, statusCode);
			} else if (isThinSummary(entry.value)) {
				parseFailureLog.record(url, 'thin');
			}
		}

		if (emitCacheHeader) {
			reply.header('X-Cache', 'MISS');
		}
		return respondWithEntry(reply, entry);
	});

	// 診断エンドポイント `/__diagnostics/parse-failures` は廃止済 (詳細は DEPRECATED.md 参照)。
	// 集約データの参照は `parseFailureLogJsonlPath` で書き出される JSONL を `cat | jq` する運用に移行。
	// `ParseFailureLog.snapshot()` メソッドはテスト・デバッグ用に残置。

	// バージョン確認エンドポイント。デプロイされている summaly のコミットハッシュと
	// コミットメッセージを返す。「いま動いているのは何のバージョン?」を確認する用途。
	// 機微な情報は含まず、Cache-Control: no-store でキャッシュ無効化（再起動毎に値が変わるため）。
	fastify.get('/v', async (_req, reply) => {
		reply.header('Cache-Control', 'no-store');
		return {
			version: _VERSION_,
			commit: _GIT_COMMIT_,
			message: _GIT_MESSAGE_,
		};
	});

	// **`/embed?url=<URL>` エンドポイント**:
	// 対応プラグインが `renderEmbed` を実装している URL に対して、JS なし HTML+CSS で
	// プレイヤー iframe 用のページを返す。Misskey の embed 表示に直接埋め込まれる前提。
	//
	// 設計詳細は `docs/plans/phase13.1-syosetu-embed.md` 参照。
	//
	// **CSP / セキュリティ**:
	// - `Content-Security-Policy: default-src 'none'` で script を構造的にブロック
	// - `style-src 'unsafe-inline'` のみ許容 (`<style>` ブロック 1 つ)
	// - `img-src https:` で外部画像許可 (icon / thumbnail 表示)
	// - `frame-ancestors` は config の `frameAncestors` で制御
	// - `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer`
	//
	// **未知クエリは無視する設計** (Misskey の `transformPlayerUrl` が `autoplay=1` /
	// `auto_play=1` を勝手に追加するため、厳密 query 検証で 400 を返さない)。`url` クエリ以外は読み捨て。
	fastify.get<{
		Querystring: { url?: string };
	}>('/embed', async (req, reply) => {
		const embedConfig = options.embedConfig;
		// `[embed].enabled = false` または embedConfig 未設定 (= library mode 直接呼び出しの誤用) なら 404
		if (embedConfig == null || !embedConfig.enabled) {
			reply.code(404);
			reply.type('text/plain; charset=utf-8');
			return 'embed disabled';
		}

		const rawUrl = req.query.url;
		if (rawUrl == null || rawUrl === '') {
			reply.code(400);
			reply.type('text/plain; charset=utf-8');
			return 'url query required';
		}

		// URL バリデーション: `https:` only (`http:` / `data:` / `javascript:` 等は弾く、SSRF / XSS 防御)
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(rawUrl);
		} catch {
			reply.code(400);
			reply.type('text/plain; charset=utf-8');
			return 'invalid url';
		}
		if (parsedUrl.protocol !== 'https:') {
			reply.code(400);
			reply.type('text/plain; charset=utf-8');
			return 'https only';
		}

		// プラグイン dispatch: `test() === true` かつ `renderEmbed != null` の **最初の** プラグインを採用。
		// allowedPlugins (= config の `[embed].allowedPlugins`) に **明示的に含まれている** プラグインのみ許可
		// (fail-close: 空配列なら 1 つも対応しない)
		const plugin = builtinPlugins.find(p =>
			p.name != null
			&& embedConfig.allowedPlugins.includes(p.name)
			&& p.renderEmbed != null
			&& p.test(parsedUrl),
		);
		if (plugin?.renderEmbed == null) {
			reply.code(404);
			reply.type('text/plain; charset=utf-8');
			return 'no plugin matched';
		}

		// プラグインの renderEmbed を呼ぶ。エラーは 500 で plain text (HTML を出さない、CSP も同様)。
		// **opts 伝達 (security review M-2)**: timeout / userAgent 等の設定をプラグインの API 呼び出しに反映する。
		// embedBaseUrl は player.url 組み立てで使われない (renderEmbed 内では既に embed 自身の HTML を生成中) ため
		// 渡さなくてよいが、scrapingOptions の他フィールドは renderEmbed 内の getJson 等で必要になりうる。
		const renderOpts: GeneralScrapingOptions = {
			lang: options.lang,
			userAgent: options.userAgent,
			responseTimeout: options.responseTimeout,
			operationTimeout: options.operationTimeout,
			contentLengthLimit: options.contentLengthLimit,
			contentLengthRequired: options.contentLengthRequired,
			useRange: options.useRange,
			fallbackUserAgent: options.fallbackUserAgent,
			fallbackRetryCategories: options.fallbackRetryCategories,
			proxyFallback: options.proxyFallback,
			curlCffiFallback: options.curlCffiFallback,
			hedgedThresholdMs: options.hedgedThresholdMs,
		};
		let result;
		try {
			result = await plugin.renderEmbed(parsedUrl, renderOpts);
		} catch (err) {
			req.log.error({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { message: String(err) } }, 'embed renderEmbed failed');
			reply.code(500);
			reply.type('text/plain; charset=utf-8');
			return 'render failed';
		}

		// **defense-in-depth: `<script>` sanity check (security review M-4)**: プラグイン側のエスケープ
		// 契約だけに依存せず、Fastify 側でも `<script` の混入を構造的にブロックする。CSP `default-src 'none'`
		// が第一防衛、本チェックは契約違反 (実装ミス) の早期検出 + ファーストライン guard。
		// 大文字小文字どちらの `<script` でも検出する (HTML パーサは case-insensitive)。
		if (/<script[\s>/]/i.test(result.body)) {
			req.log.error('embed: renderEmbed returned body containing <script>, rejecting (defense-in-depth)');
			reply.code(500);
			reply.type('text/plain; charset=utf-8');
			return 'render failed';
		}

		// **defense-in-depth: body サイズ cap (security review L-2)**: プラグインの実装ミスや
		// 異常 API レスポンスで巨大 HTML が返るケースを防ぐ。512 KB を超えたら 500 で reject。
		const EMBED_BODY_MAX_BYTES = 512 * 1024;
		if (Buffer.byteLength(result.body, 'utf8') > EMBED_BODY_MAX_BYTES) {
			req.log.error({ size: Buffer.byteLength(result.body, 'utf8') }, 'embed: renderEmbed body too large');
			reply.code(500);
			reply.type('text/plain; charset=utf-8');
			return 'render failed';
		}

		// CSP / セキュリティヘッダ + Cache-Control を付けて HTML を返す
		const frameAncestors = embedConfig.frameAncestors.length > 0
			? embedConfig.frameAncestors.join(' ')
			: '*'; // 空配列は防衛的に `*` に (config-loader 側でも検証されるが二重防御)
		const cspParts = [
			'default-src \'none\'',
			'img-src https:',
			'style-src \'unsafe-inline\'',
			'font-src \'none\'',
			'base-uri \'none\'',
			'form-action \'none\'',
			`frame-ancestors ${frameAncestors}`,
		];
		// **外部リソース許可 (frame-src / media-src 等)**: プラグインが `cspDirectives` を宣言した場合のみ追加。
		// ディレクティブ名は許可リスト、各 origin は origin-only https: に再検証 (CSP ヘッダインジェクション防御)。
		// dev (dev/server.ts) と共有 util。google-drive が Drive `/preview` を iframe ラップする際に使う。
		cspParts.push(...buildCspDirectiveParts(result.cspDirectives));
		reply.header('Content-Security-Policy', cspParts.join('; '));
		reply.header('X-Content-Type-Options', 'nosniff');
		reply.header('Referrer-Policy', 'no-referrer');
		reply.header('Cache-Control', 'public, max-age=600');
		reply.type('text/html; charset=utf-8');
		return result.body;
	});

	done();
}
