import got, * as Got from 'got';
import * as cheerio from 'cheerio';
import ipaddr from 'ipaddr.js';
import type { IPv4, IPv6 } from 'ipaddr.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { StatusError } from '@/utils/status-error.js';
import { detectEncoding, toUtf8 } from '@/utils/encoding.js';
import { defaultHttpAgent, defaultHttpsAgent } from '@/utils/agent.js';
import { categorizeError, type SummalyErrorCategory } from '@/utils/parse-failure-log.js';
import { getActiveCache, pathKeysOf, type DomainStrategy } from '@/utils/domain-strategy-cache.js';
import {
	hedgedRace,
	ALL_STRATEGIES,
	HedgedRaceAllFailedError,
	type FetchStrategyFn,
} from '@/utils/hedged-fetch.js';

/**
 * Hedged race の champion 単独猶予期間 (phase18)。
 * デフォルト 5 秒 = champion がこの時間内に valid を返さなければ challenger 並列発火。
 */
export const DEFAULT_HEDGED_THRESHOLD_MS = 5000;

/**
 * hedged race の勝者確定後 cancellation で発生する abort 由来エラー。
 *
 * `categorizeError` が `/aborted/i` で `timeout` カテゴリに誤分類するのを避けるため、
 * 専用 Error name `'HedgeAbortedError'` を持たせて `categorizeError` 内で別扱いする。
 * (M-2 review feedback: abort 由来 cancel と真の timeout を区別して経路コスト分析の精度を保つ)
 */
export class HedgeAbortedError extends Error {
	constructor(reason = 'aborted by hedge race winner') {
		super(reason);
		this.name = 'HedgeAbortedError';
	}
}

/**
 * 別経路で叩いても結果が変わる見込みが薄い「確定 error」のカテゴリ。
 * champion がこれらで失敗した場合、hedge fire せずそのまま throw して無駄リクエストを防ぐ。
 *
 * - `not_found`: サイトが意図的に 404
 * - `ssrf_blocked`: Private IP は別経路でも同じ
 * - `invalid_url`: URL の形式問題
 * - `unsupported_type`: content-type の問題 (HTML 以外を受信)
 * - `content_too_large`: サイズ超過
 * - `parse_error`: HTML パース失敗 (response は取れている)
 *
 * `bot_blocked` (4xx 全般) / `origin_error` (5xx) / `timeout` / `connection_dropped` /
 * `network_error` / `unknown` は別経路で救援可能性があるため hedge fire 対象。
 */
const HEDGED_FINAL_CATEGORIES: ReadonlySet<SummalyErrorCategory> = new Set<SummalyErrorCategory>([
	'not_found',
	'ssrf_blocked',
	'unsupported_type',
	'content_too_large',
	'parse_error',
]);

/**
 * `categorizeError` ベースの final error 判定 (hedge fire skip 用)。
 */
function isFinalError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : undefined;
	const name = err instanceof Error ? err.name : undefined;
	const statusCode = err instanceof StatusError ? err.statusCode : undefined;
	const category = categorizeError(message, name, statusCode);
	return HEDGED_FINAL_CATEGORIES.has(category);
}

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
// Mozilla プレフィックス必須の WAF を底上げで通すために複合 UA を採用。
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
			// internal default は true。明示 false で off。
			...((opts?.useRange ?? true) ? { range: `bytes=0-${maxSize - 1}` } : {}),
		},
		typeFilter,
		followRedirects: opts?.followRedirects,
		responseTimeout: opts?.responseTimeout,
		operationTimeout: opts?.operationTimeout,
		contentLengthLimit: opts?.contentLengthLimit,
		contentLengthRequired: opts?.contentLengthRequired,
		useRange: opts?.useRange ?? true,
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

/**
 * 各 strategy の fetch を起動する内部関数 (phase18 hedged race の入力)。
 *
 * - `'default'`: `getResponse` (UA = デフォルト)
 * - `'fallback_ua'`: `getResponse` (UA = fallback、config 未設定なら null)
 * - `'proxy'`: `viaProxyWorker` (config 未有効 / 非 https なら null)
 * - `'curl_cffi'`: `viaCurlCffi` (config 未有効 / 非 https なら null)
 *
 * `null` 戻り値 = ゲート不通過 (config 上使えない経路、hedge race では gate_failed として扱う)。
 * `throw` = 実行時失敗 (hedge race では error として扱う)。
 *
 * **phase18 変更点 (Step 2)**: phase14 の `forceX` フラグ + 段階的 cascade を廃止し、
 * 各 strategy は **独立した fetch** として hedge race に並列投入される。`domains` allowlist は
 * Step 4 で撤廃されるため、ゲートは config 有効性 (`enabled`) と protocol チェックのみ。
 *
 * **AbortSignal**: hedged race の勝者確定後 cancellation のために伝搬。各経路で best-effort の
 * 中断を行う (`getResponse` は got リクエスト abort、`viaCurlCffi` は subprocess SIGKILL)。
 */
async function fetchByStrategy(
	args: Omit<GotOptions, 'method'>,
	strategy: DomainStrategy,
	fallback: FallbackUaConfig | undefined,
	proxyCfg: import('@/utils/proxy-fallback.js').ProxyFallbackConfig | undefined,
	curlCffiCfg: import('@/utils/curl-cffi-fetch.js').CurlCffiFallbackConfig | undefined,
	signal: AbortSignal,
): Promise<Got.Response<string> | null> {
	if (strategy === 'default') {
		return await getResponse({ ...args, method: 'GET' }, signal);
	}
	if (strategy === 'fallback_ua') {
		if (fallback == null || fallback.userAgent === '') return null;
		return await getResponse({
			...args,
			method: 'GET',
			headers: { ...args.headers, 'user-agent': fallback.userAgent },
		}, signal);
	}
	if (strategy === 'proxy') {
		if (proxyCfg == null || !proxyCfg.enabled || proxyCfg.secret === '') return null;
		const targetUrl = new URL(args.url);
		if (targetUrl.protocol !== 'https:') return null;
		const { viaProxyWorker } = await import('@/utils/proxy-fallback.js');
		return await viaProxyWorker({ ...args, method: 'GET' }, proxyCfg, signal);
	}
	// strategy === 'curl_cffi' (DomainStrategy のユニオン型を網羅)
	if (curlCffiCfg == null || !curlCffiCfg.enabled) return null;
	const targetUrl = new URL(args.url);
	if (targetUrl.protocol !== 'https:') return null;
	const { viaCurlCffi } = await import('@/utils/curl-cffi-fetch.js');
	return await viaCurlCffi({ ...args, method: 'GET' }, curlCffiCfg, signal);
}

/**
 * `scpaping()` 内のレスポンス取得部分。phase18 で hedged race ベースに置換。
 *
 * **設計**: scpaping は `cache.recordX` を直接呼ばず、`opts._cacheRecording` (mutable side-channel)
 * に context を埋めて `summaly()` レイヤに伝達する。`summaly()` が Summary 確定後に thin 判定して
 * `recordSuccess` / `recordFailure` を一括判定する (HTTP 層 + Summary 層の二重 record 防止)。
 *
 * フロー (phase18):
 * 1. 経路学習キャッシュ lookup → cache hit: champion = hit.entry.strategy / cache miss: champion = 'default'
 * 2. challengers = ALL_STRATEGIES - champion (gate failed の経路は hedge race 内で gate_failed として扱う)
 * 3. `hedgedRace` が champion を即起動、`hedgedThresholdMs` (default 5s) 経過 or 失敗で challengers 並列発火
 * 4. 勝者 strategy を `recState.strategy` に記録 (hedge 発火イベントは `recState.hedgeFired` 等に格納)
 *
 * **全 gate_failed のときの recState ハンドリング**: `HedgedRaceAllFailedError` の causes が
 * すべて「gate failed (no strategy enabled)」のとき (= config 上使える経路がない、判別不能な中立状態)、
 * `recState.gateFailedNeutral = true` をセットして cache hit エントリを温存する (phase14 中立性の維持)。
 *
 * `recordKey` の選定 (lookup 直後に決定): cache hit あれば `hit.hitKey`、cache miss なら 1-seg pathKey。
 * 早期設定の理由: hedge race throw 経路でも summaly() catch が recordFailure(recordKey) を呼べるように。
 */
async function fetchResponse(
	args: ReturnType<typeof getGotOptions>,
	opts: GeneralScrapingOptions | undefined,
	fallback: FallbackUaConfig | undefined,
	proxyCfg: import('@/utils/proxy-fallback.js').ProxyFallbackConfig | undefined,
	curlCffiCfg: import('@/utils/curl-cffi-fetch.js').CurlCffiFallbackConfig | undefined,
): Promise<Got.Response<string>> {
	// 経路学習キャッシュ fast path
	//
	// **設計**: scpaping は `cache.recordX` を直接呼ばず、`opts._cacheRecording` に context を埋めて
	// summaly() に伝達する。summaly() が Summary 確定後 (thin 判定込みで) 一括判定して record する。
	// 理由: HTTP 層 recordSuccess + Summary 層 recordFailure の重複で連続失敗カウンタが
	// 閾値到達できない問題を解消するため (Step 2b 後半 設計修正)。
	//
	// 注: `pathKeysOf` は `URL.hostname` を使うため **port は pathKey に含まれない**
	// (`localhost:3060` と `localhost:3061` は同じ `'localhost'` キーを共有する)。
	// ローカルテストでは `setActiveCache(undefined)` で test 間の cache 汚染を防ぐ責任が呼出側にある。
	const cache = getActiveCache();
	const hit = cache?.lookup(args.url);
	const recState = opts?._cacheRecording;

	// 記録先 pathKey を早期に決定 (throw が起きても summaly() catch が record できるように)
	if (cache != null && recState != null) {
		if (hit != null) {
			recState.recordKey = hit.hitKey;
		} else {
			const keys = pathKeysOf(args.url);
			if (keys.length > 0) {
				recState.recordKey = keys[Math.max(0, keys.length - 2)];
			}
		}
	}

	// phase18 hedged race: champion 即起動 + threshold 経過 or 失敗で challengers 並列発火
	const champion: DomainStrategy = hit?.entry.strategy ?? 'default';
	const challengers = ALL_STRATEGIES.filter((s) => s !== champion);
	const thresholdMs = opts?.hedgedThresholdMs ?? DEFAULT_HEDGED_THRESHOLD_MS;

	const fetcher: FetchStrategyFn<Got.Response<string>> = (strategy, signal) =>
		fetchByStrategy(args, strategy, fallback, proxyCfg, curlCffiCfg, signal);

	try {
		const result = await hedgedRace(
			{ champion, challengers, thresholdMs, isFinalError },
			fetcher,
			() => true, // HTTP 層では取得成功 = valid (thin 判定は summary 層)
		);

		if (recState != null) {
			recState.strategy = result.winnerStrategy;
			recState.hedgeFired = result.hedgeFired;
			recState.hedgeOutcomes = result.outcomes;
			recState.hedgeLatencyMs = result.latencyMs;
		}

		return result.response;
	} catch (err) {
		// HedgedRaceAllFailedError から「最も意味のある cause」を取り出して再 throw する。
		// 優先順位: champion > challenger (champion の error はサイトの本来の挙動を反映している可能性が高い)
		if (err instanceof HedgedRaceAllFailedError) {
			// **phase18.1 修正**: hedge race throw 経路でも recState に hedge 情報を伝搬する
			// (Fastify ハンドラの logHedgeIfFired がこの情報を pino ログに出すため、本番診断必須)
			if (recState != null) {
				recState.hedgeFired = err.hedgeFired;
				recState.hedgeOutcomes = err.outcomes;
				recState.hedgeLatencyMs = err.latencyMs;
				// 各 strategy の「なぜ error か」を message で保存。本番で curl_cffi が
				// `spawn failed (uv が ...)` 等の具体原因を journalctl で確認できるようにする
				const errs: Partial<Record<DomainStrategy, string>> = {};
				for (const c of err.causes) {
					if (c.error instanceof Error) errs[c.strategy] = c.error.message;
					else errs[c.strategy] = String(c.error);
				}
				recState.hedgeErrors = errs;
			}
			// 全 cause が「gate failed (no strategy enabled)」= config 上使える経路がない中立状態。
			// cache hit エントリを失敗カウントせず温存するため `gateFailedNeutral = true` をセット
			const allGateFailed = err.causes.every((c) =>
				c.error instanceof Error && c.error.message === 'gate failed (no strategy enabled)',
			);
			if (allGateFailed && recState != null) {
				recState.gateFailedNeutral = true;
			}
			const championCause = err.causes.find((c) => c.strategy === champion);
			if (championCause != null && championCause.error instanceof Error) {
				throw championCause.error;
			}
			const firstCause = err.causes[0] as { strategy: DomainStrategy; error: unknown } | undefined;
			if (firstCause != null && firstCause.error instanceof Error) {
				throw firstCause.error;
			}
		}
		throw err;
	}
}

export async function scpaping(
	url: string,
	opts?: GeneralScrapingOptions,
): Promise<ScpapingResult> {
	const args = getGotOptions(url, opts);

	const fallback = buildFallbackConfig(opts);
	// 動的 import で循環参照を避ける（proxy-fallback.ts / curl-cffi-fetch.ts は got.ts の
	// getResponseWithFallback を import している）。
	// 初回ロード以降は Node.js のモジュールキャッシュにより同期的に解決されるため hot path のコストはほぼゼロ。
	// 段階構造: ① default UA → ② fallback UA → ③ proxy worker → ④ curl_cffi
	const curlCffiCfg = opts?.curlCffiFallback;
	const proxyCfg = opts?.proxyFallback;
	const response = await fetchResponse(args, opts, fallback, proxyCfg, curlCffiCfg);

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

export async function getResponse(args: GotOptions, externalSignal?: AbortSignal) {
	const timeout = args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT;
	const operationTimeout = args.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT;

	const abort = new AbortController();
	// 外部 signal (hedged race の勝者確定後 cancellation 等) を内部 controller にリンク。
	// abort listener は once: true で leak しない。HedgeAbortedError 専用名で categorizeError 誤分類を防ぐ。
	if (externalSignal != null) {
		if (externalSignal.aborted) {
			abort.abort(new HedgeAbortedError().message);
		} else {
			externalSignal.addEventListener('abort', () => {
				abort.abort(new HedgeAbortedError().message);
			}, { once: true });
		}
	}

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
 * フォールバック UA リトライ設定。
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
