import got, * as Got from 'got';
import * as cheerio from 'cheerio';
import ipaddr from 'ipaddr.js';
import type { IPv4, IPv6 } from 'ipaddr.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { StatusError } from '@/utils/status-error.js';
import { detectEncoding, toUtf8 } from '@/utils/encoding.js';
import { defaultHttpAgent, defaultHttpsAgent } from '@/utils/agent.js';
import { categorizeError, type SummalyErrorCategory } from '@/utils/parse-failure-log.js';

/**
 * 外部から `setAgent` で渡された agent。設定されている場合は keep-alive デフォルトより優先される。
 * 設定時はプライベート IP ガードが解除される（プロキシ用途のため）— 既存挙動を維持。
 */
export let agent: Got.Agents = {};

export function setAgent(_agent: Got.Agents) {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	agent = _agent || {};
}

/**
 * 外部 agent（`setAgent` 経由）が設定されているか。
 * SSRF ガード解除判定とデフォルト agent 選択の両方からこの関数を参照することで、
 * ロジックの分散を防ぐ。
 */
function isExternalAgentSet(): boolean {
	return Object.keys(agent).length > 0;
}

/**
 * `setAgent` で外部 agent が設定されていればそれを返し、無ければ keep-alive デフォルト agent を返す。
 */
function getEffectiveAgent(): Got.Agents {
	if (isExternalAgentSet()) return agent;
	return { http: defaultHttpAgent, https: defaultHttpsAgent };
}

export type GotOptions = {
	url: string;
	method: 'GET' | 'POST' | 'HEAD';
	body?: string;
	headers: Record<string, string | undefined>;
	typeFilter?: RegExp;
	followRedirects?: boolean;
	responseTimeout?: number;
	operationTimeout?: number;
	contentLengthLimit?: number;
	contentLengthRequired?: boolean;
	useRange?: boolean;
	/**
	 * `getResponse` 自体は参照しないが、`scpaping` の後続処理（PDF 検出分岐）で
	 * 透過的に保持するため `GotOptions` に含める。
	 */
	enablePdf?: boolean;
};

/**
 * PDF 機能の有効化判定。`enablePdf` オプション、または環境変数 `SUMMALY_ENABLE_PDF=true` のいずれかで有効化。
 * 関数オプションを優先し、未指定（undefined）のときのみ環境変数を見る。
 */
function isPdfEnabled(enablePdf: boolean | undefined): boolean {
	if (enablePdf != null) return enablePdf;
	return process.env.SUMMALY_ENABLE_PDF === 'true';
}

export const DEFAULT_RESPONSE_TIMEOUT = 20 * 1000;
export const DEFAULT_OPERATION_TIMEOUT = 60 * 1000;
export const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
// Mozilla プレフィックス必須の WAF を底上げで通すために複合 UA を採用 (phase11.9)。
// 「`SummalyBot` 文字列で WAF が弾く」サイトには別途 fallback UA リトライ機構があり、
// このデフォルトはそれと併用する想定。自己同定 (`SummalyBot/<ver>` + URL) は維持。
// URL は riin-summaly fork のリポジトリを指す（運用者が問い合わせ可能な場所）。
export const DEFAULT_BOT_UA = `Mozilla/5.0 (compatible; SummalyBot/${_VERSION_}; +https://github.com/fruitriin/riin-summaly)`;
// SummalyBot 文字列を含まないフォールバック UA。bot block で 1 回目が `connection_dropped` /
// `bot_blocked` カテゴリに該当する場合に使う。`facebookexternalhit` を採用しているのは
// share link を発行している多くのサイトが OGP 取得用途として明示的に許可しているため。
// 倫理的に気になる場合は config で差し替え可能。
export const DEFAULT_FALLBACK_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export function getGotOptions(url: string, opts?: GeneralScrapingOptions): Omit<GotOptions, 'method'> {
	const maxSize = opts?.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
	const pdfEnabled = isPdfEnabled(opts?.enablePdf);
	// enablePdf 真のときだけ typeFilter に application/pdf を加える。
	// 偽時は既存挙動（HTML のみ）と完全互換。
	const typeFilter = pdfEnabled
		? /^(text\/html|application\/xhtml\+xml|application\/pdf)/
		: /^(text\/html|application\/xhtml\+xml)/;
	const accept = pdfEnabled
		? 'text/html,application/xhtml+xml,application/pdf'
		: 'text/html,application/xhtml+xml';
	return {
		url,
		headers: {
			'accept': accept,
			'user-agent': opts?.userAgent ?? DEFAULT_BOT_UA,
			'accept-language': opts?.lang ?? undefined,
			// useRange: true のときは Range ヘッダで先頭領域だけ取得する。
			// サーバが Range をサポートしていなければ 200 OK でフルボディが返るため
			// 既存の contentLengthLimit ガードで保護される。
			...(opts?.useRange ? { range: `bytes=0-${maxSize - 1}` } : {}),
		},
		typeFilter,
		followRedirects: opts?.followRedirects,
		responseTimeout: opts?.responseTimeout,
		operationTimeout: opts?.operationTimeout,
		contentLengthLimit: opts?.contentLengthLimit,
		contentLengthRequired: opts?.contentLengthRequired,
		useRange: opts?.useRange,
		enablePdf: opts?.enablePdf,
	};
}

export type ScpapingResult = {
	body: string;
	$: cheerio.CheerioAPI;
	response: Got.Response<string>;
	pdf?: { title?: string };
};

const PDF_PARSE_TIMEOUT_MS = 5000;

/**
 * Promise を timeout 付きで race する。setTimeout のハンドルは race 完了後に必ず clear するため
 * Node プロセスが timer リファレンスで生き残る (open handle / メモリリーク) リスクが無い。
 * テスト容易化のため export している。
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = 'timeout'): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle != null) clearTimeout(timeoutHandle);
	}
}

export async function scpaping(
	url: string,
	opts?: GeneralScrapingOptions,
): Promise<ScpapingResult> {
	const args = getGotOptions(url, opts);

	const fallback = buildFallbackConfig(opts);
	// 動的 import で循環参照を避ける（proxy-fallback.ts は got.ts の getResponseWithFallback を import している）。
	// 初回ロード以降は Node.js のモジュールキャッシュにより同期的に解決されるため hot path のコストはほぼゼロ。
	const { getResponseWithProxyFallback } = await import('@/utils/proxy-fallback.js');
	const response = await getResponseWithProxyFallback({
		...args,
		method: 'GET',
	}, fallback, opts?.proxyFallback);

	// PDF レスポンスは別パスで処理する。
	// enablePdf が真のときのみ typeFilter で application/pdf を許可しているため、
	// ここに到達するのは enablePdf 真のとき限定。
	if (isPdfEnabled(opts?.enablePdf) && /^application\/pdf/.test(response.headers['content-type'] ?? '')) {
		const pdfMeta = await parsePdfTitle(response.rawBody);
		// PDF 分岐では body / $ は HTML 文脈で使われないが、型整合のため空で返す
		return {
			body: '',
			$: cheerio.load(''),
			response,
			pdf: pdfMeta,
		};
	}

	const encoding = detectEncoding(response.rawBody);
	const body = toUtf8(response.rawBody, encoding);
	const $ = cheerio.load(body);

	return {
		body,
		$,
		response,
	};
}

/**
 * PDF buffer からタイトルだけ取得する。pdf-parse v2 の getInfo() を使用。
 * 5 秒で hard timeout し、超過時はタイトル無しで返す（呼出側でホスト名等にフォールバック）。
 *
 * 防衛層:
 * - getInfo() は document-level metadata のみ読むため、本文ページのテキスト解析は走らない
 * - withTimeout で 5 秒 hard timeout（setTimeout のハンドルも必ず clear する）
 * - 上位の contentLengthLimit (10 MiB デフォルト) で受信前にサイズ制限済み
 *
 * 注意: 初回呼び出しで `pdfjs-dist`（約 30 MB）の動的 import が走るため、
 * 最初の PDF リクエストは数十ミリ秒余分にかかる場合がある。
 */
async function parsePdfTitle(rawBody: Uint8Array): Promise<{ title?: string }> {
	let parser: { getInfo: () => Promise<unknown>; destroy: () => Promise<void> } | undefined;
	try {
		const { PDFParse } = await import('pdf-parse');
		// Node の Buffer は Uint8Array のサブクラスなので rawBody はそのまま渡せる
		parser = new PDFParse({ data: rawBody });
		const info = await withTimeout(parser.getInfo(), PDF_PARSE_TIMEOUT_MS, 'pdf-parse timeout');
		const rawTitle = (info as { info?: { Title?: unknown } }).info?.Title;
		const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : undefined;
		return { title };
	} catch {
		// timeout / パース失敗時はタイトル無しでフォールバック
		return {};
	} finally {
		// timeout 経路でも destroy を試みる（パーサーがバックグラウンドで走り続けるのを防ぐ）
		await parser?.destroy().catch(() => { /* noop */ });
	}
}

export async function get(url: string) {
	const res = await getResponse({
		url,
		method: 'GET',
		headers: {
			'accept': '*/*',
		},
	});

	return res.body;
}

export async function head(url: string) {
	return await getResponse({
		url,
		method: 'HEAD',
		headers: {
			'accept': '*/*',
		},
	});
}

/**
 * 任意の JSON エンドポイントを取得する。oEmbed / 外部 API 等、プラグインから利用される。
 * `getResponse` を経由するため content-length 制限・プライベート IP ガード等は自動で効く。
 *
 * @param url リクエスト先
 * @param referer 必要なら Referer ヘッダ（komiflo 等の API がリファラ必須のケースで利用）
 * @param opts 一部のオプション（`userAgent`, タイムアウト）を上書きしたい場合に指定
 */
export async function getJson(
	url: string,
	referer?: string,
	opts?: Pick<GeneralScrapingOptions, 'userAgent' | 'responseTimeout' | 'operationTimeout'>,
): Promise<unknown> {
	const res = await getResponse({
		url,
		method: 'GET',
		headers: {
			'accept': 'application/json, */*',
			'user-agent': opts?.userAgent ?? DEFAULT_BOT_UA,
			...(referer != null ? { referer } : {}),
		},
		// プライベート IP ガード・content-length 制限は getResponse 内で自動適用される
		// （got.ts の既存テスト群で担保）
		typeFilter: /^application\/(?:json|.*\+json)/,
		responseTimeout: opts?.responseTimeout,
		operationTimeout: opts?.operationTimeout,
	});
	return JSON.parse(String(res.body));
}

export async function getResponse(args: GotOptions) {
	const timeout = args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT;
	const operationTimeout = args.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT;

	const abort = new AbortController();

	const req = got<string>(args.url, {
		method: args.method,
		headers: args.headers,
		body: args.body,
		timeout: {
			lookup: timeout,
			connect: timeout,
			secureConnect: timeout,
			socket: timeout,	// read timeout
			response: timeout,
			send: timeout,
			request: operationTimeout,	// whole operation timeout
		},
		followRedirect: args.followRedirects,
		agent: getEffectiveAgent(),
		http2: false,
		retry: {
			limit: 0,
		},
		signal: abort.signal,
	});

	const res = await receiveResponse({ req, opts: args, abort });

	// SUMMALY_ALLOW_PRIVATE_IPはテスト用
	// TODO: Try moving this to receiveResponse- ATM `got` doesn't provide a means
	// to check the IP/response header data while streaming the response...
	const allowPrivateIp = process.env.SUMMALY_ALLOW_PRIVATE_IP === 'true' || isExternalAgentSet();
	if (!allowPrivateIp && res.ip != null) {
		let ip: IPv4 | IPv6;
		try {
			ip = ipaddr.parse(res.ip);
		} catch {
			throw new StatusError(`Invalid IP ${res.ip}`, 500, 'Invalid IP');
		}
		if (ip.kind() === 'ipv6' && (ip as IPv6).isIPv4MappedAddress()) {
			ip = (ip as IPv6).toIPv4Address();
		}
		if (ip.range() !== 'unicast') {
			throw new StatusError(`Private IP rejected ${res.ip}`, 400, 'Private IP Rejected');
		}
	}

	// Check html
	const contentType = res.headers['content-type'];
	if (args.typeFilter && !contentType?.match(args.typeFilter)) {
		throw new Error(`Rejected by type filter ${contentType}`);
	}

	// 応答ヘッダでサイズチェック
	const contentLength = res.headers['content-length'];
	if (contentLength) {
		const maxSize = args.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
		const size = Number(contentLength);
		if (size > maxSize) {
			throw new Error(`maxSize exceeded (${size} > ${maxSize}) on response`);
		}
	} else {
		if (args.contentLengthRequired) {
			throw new Error('content-length required');
		}
	}

	return res;
}

/**
 * フォールバック UA リトライ設定 (phase11.9)。
 *
 * 1 度目のリクエストが `categories` に含まれるエラーカテゴリで失敗したら、
 * UA を `userAgent` に差し替えて 1 度だけ再試行する。
 */
export type FallbackUaConfig = {
	userAgent: string;
	/** リトライ発火対象のエラーカテゴリ */
	categories: SummalyErrorCategory[];
};

export const DEFAULT_FALLBACK_RETRY_CATEGORIES: SummalyErrorCategory[] = [
	'bot_blocked',
	'connection_dropped',
];

/**
 * `GeneralScrapingOptions` の `fallbackUserAgent` / `fallbackRetryCategories` から
 * `FallbackUaConfig` を組み立てる。`fallbackUserAgent` 未指定 / 空文字列なら `undefined`。
 */
export function buildFallbackConfig(opts?: GeneralScrapingOptions): FallbackUaConfig | undefined {
	const ua = opts?.fallbackUserAgent;
	if (ua == null || ua === '') return undefined;
	return {
		userAgent: ua,
		categories: opts?.fallbackRetryCategories ?? DEFAULT_FALLBACK_RETRY_CATEGORIES,
	};
}

/**
 * `getResponse` のラッパで、bot block 検出時に別 UA で 1 回だけリトライする (phase11.9)。
 *
 * - `fallback === undefined` のときは通常の `getResponse(args)` 1 回呼び出しと等価
 * - 1 回目失敗 → `categorizeError` でカテゴリ判定 → `fallback.categories` に含まれていれば
 *   UA だけ差し替えて 2 回目を実行
 * - 2 回目も失敗したら **2 回目のエラー（最後のエラー）を throw**。フォールバックでも
 *   失敗したという情報が末端まで伝わる
 * - 成功時は通常の `Got.Response<string>` を返す
 *
 * リトライ回数は常に最大 1 回（合計 2 回試行）。指数バックオフは入れない。
 */
export async function getResponseWithFallback(
	args: GotOptions,
	fallback?: FallbackUaConfig,
): Promise<Got.Response<string>> {
	if (fallback == null) {
		return await getResponse(args);
	}
	try {
		return await getResponse(args);
	} catch (firstErr) {
		const message = firstErr instanceof Error ? firstErr.message : undefined;
		const name = firstErr instanceof Error ? firstErr.name : undefined;
		const statusCode = firstErr instanceof StatusError ? firstErr.statusCode : undefined;
		const category = categorizeError(message, name, statusCode);
		if (!fallback.categories.includes(category)) {
			throw firstErr;
		}
		// UA を差し替えて 1 回だけ再試行する。Headers の他のキーは維持。
		// 注: 上書きは小文字 `'user-agent'` で固定する。`getGotOptions` も小文字で生成しているため
		// この経路では大文字小文字の二重キー問題は発生しない（外部から `args.headers` に
		// 大文字 `'User-Agent'` を入れて呼び出す場合は呼出側で正規化する責任を負う）。
		const retryArgs: GotOptions = {
			...args,
			headers: {
				...args.headers,
				'user-agent': fallback.userAgent,
			},
		};
		return await getResponse(retryArgs);
	}
}

async function receiveResponse<T>(args: {
	req: Got.RequestPromise<Got.Response<T>>,
	opts: GotOptions,
	abort: AbortController,
}) {
	const req = args.req;
	const maxSize = args.opts.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;

	// 受信中のデータでサイズチェック
	req.on('downloadProgress', (progress: Got.Progress) => {
		if (progress.transferred > maxSize && progress.percent !== 1) {
			args.abort.abort(`maxSize exceeded (${progress.transferred} > ${maxSize}) on response`);
		}
	});

	// 応答取得 with ステータスコードエラーの整形
	const res = await req.catch(e => {
		const abortReason = args.abort.signal.reason;
		if (args.abort.signal.aborted && typeof abortReason === 'string' && abortReason.length > 0) {
			throw new Error(abortReason);
		}

		if (e instanceof Got.HTTPError) {
			throw new StatusError(`${e.response.statusCode} ${e.response.statusMessage}`, e.response.statusCode, e.response.statusMessage);
		} else {
			throw e;
		}
	});

	return res;
}
