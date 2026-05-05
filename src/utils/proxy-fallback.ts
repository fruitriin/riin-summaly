/**
 * Outbound proxy フォールバック (phase12.1)。
 *
 * `getResponseWithFallback` (phase11.9 の UA 切替フォールバック) でも救えなかった
 * IP レピュテーション層の遮断（Vultr Tokyo IP からの amazon.co.jp 等）に対し、
 * Cloudflare Workers にデプロイした `tools/cf-proxy-worker/` 経由でリトライする。
 *
 * 発火条件:
 * - 1 回目 + UA fallback の両方が失敗
 * - エラーカテゴリが `categories` (デフォルト `['origin_error']`) に含まれる
 * - target hostname が `domains` allowlist にマッチ (suffix-match)
 *
 * Worker への HMAC 認証は `${target_url}\n${ts}` に対する SHA-256 HMAC。
 * `tools/cf-proxy-worker/src/index.ts` 側の `hmacSha256Hex` と相互運用。
 */

import { createHmac } from 'node:crypto';
import got, * as Got from 'got';
import { categorizeError, type SummalyErrorCategory } from '@/utils/parse-failure-log.js';
import { StatusError } from '@/utils/status-error.js';
import {
	getResponseWithFallback,
	type GotOptions,
	type FallbackUaConfig,
	DEFAULT_RESPONSE_TIMEOUT,
	DEFAULT_MAX_RESPONSE_SIZE,
} from '@/utils/got.js';

/**
 * Outbound proxy フォールバック設定。
 *
 * - `enabled === false` または `secret` 未指定なら proxy 経路は無効
 * - `categories` のエラーが発生 + `domains` 一致 のときだけ proxy が発火
 */
export interface ProxyFallbackConfig {
	enabled: boolean;
	/** Worker のエンドポイント URL (`https://<your>.workers.dev`、末尾スラッシュ無し推奨) */
	url: string;
	/** HMAC 共有シークレット (Workers env vars `SHARED_SECRET` と一致) */
	secret: string;
	/** リトライ発火対象のエラーカテゴリ */
	categories: SummalyErrorCategory[];
	/** 適用対象ドメイン (suffix-match)。`amazon.co.jp` は `*.amazon.co.jp` 全部に効く */
	domains: string[];
	/** Proxy リクエストのタイムアウト (ミリ秒) */
	timeoutMs: number;
}

export const DEFAULT_PROXY_CATEGORIES: SummalyErrorCategory[] = ['origin_error'];
export const DEFAULT_PROXY_TIMEOUT_MS = 30000;

/**
 * `domains` allowlist に hostname がマッチするか判定 (suffix-match)。
 *
 * `amazon.co.jp` を allowlist に書くと:
 * - `amazon.co.jp` ← 完全一致で通る
 * - `www.amazon.co.jp` ← ドット区切り suffix で通る
 * - `evil-amazon.co.jp` ← suffix だが境界が違うので通らない
 */
export function matchesDomain(hostname: string, allowed: string[]): boolean {
	const lower = hostname.toLowerCase();
	for (const d of allowed) {
		const dl = d.toLowerCase();
		if (lower === dl) return true;
		if (lower.endsWith('.' + dl)) return true;
	}
	return false;
}

/** HMAC-SHA256 hex を生成。Worker 側 Web Crypto API と相互運用するため message format は `${url}\n${ts}` */
export function generateHmacSignature(secret: string, targetUrl: string, ts: number): string {
	return createHmac('sha256', secret).update(`${targetUrl}\n${ts}`).digest('hex');
}

/**
 * `getResponseWithFallback` のラッパで、UA fallback でも救えなかったエラーが
 * proxy 発火条件に合致するなら Worker proxy 経由でリトライする (phase12.1)。
 *
 * - `proxyConfig === undefined` または `enabled === false` なら通常の `getResponseWithFallback` 等価
 * - 1 回目 + UA fallback 失敗 → カテゴリ判定 + ドメイン allowlist チェック → proxy 経由でリトライ
 * - proxy も失敗したら **proxy のエラー**（最後のエラー）を throw
 */
export async function getResponseWithProxyFallback(
	args: GotOptions,
	uaFallback: FallbackUaConfig | undefined,
	proxyConfig: ProxyFallbackConfig | undefined,
): Promise<Got.Response<string>> {
	try {
		return await getResponseWithFallback(args, uaFallback);
	} catch (err) {
		if (proxyConfig == null || !proxyConfig.enabled || proxyConfig.secret === '') {
			throw err;
		}
		const message = err instanceof Error ? err.message : undefined;
		const name = err instanceof Error ? err.name : undefined;
		const statusCode = err instanceof StatusError ? err.statusCode : undefined;
		const category = categorizeError(message, name, statusCode);
		if (!proxyConfig.categories.includes(category)) {
			throw err;
		}
		let targetUrl: URL;
		try {
			targetUrl = new URL(args.url);
		} catch {
			throw err;
		}
		if (!matchesDomain(targetUrl.hostname, proxyConfig.domains)) {
			throw err;
		}
		// Worker proxy 経由でリトライ
		return await viaProxyWorker(args, proxyConfig);
	}
}

/**
 * Worker proxy に投げて `Got.Response<string>` 形式で結果を返す。
 *
 * 透過プロキシ動作のため、Worker 側のレスポンスを `Got.Response` の最低限の形に整形:
 * - `body`: string
 * - `rawBody`: Uint8Array (encoding 検出のため `scpaping` が必要とする)
 * - `statusCode`, `statusMessage`, `headers`, `url`
 * - `ip`: 透過 proxy なので未取得 (プライベート IP ガード判定はバイパスされる、proxy が信頼境界の役割)
 */
async function viaProxyWorker(args: GotOptions, cfg: ProxyFallbackConfig): Promise<Got.Response<string>> {
	const ts = Date.now();
	const sig = generateHmacSignature(cfg.secret, args.url, ts);
	const proxyUrl = `${cfg.url.replace(/\/$/, '')}/?url=${encodeURIComponent(args.url)}`;

	// Worker から Amazon 等への forwarded UA は呼出側の UA を尊重
	const headerUA = args.headers['user-agent'];
	const forwardUA = typeof headerUA === 'string' ? headerUA : 'Mozilla/5.0 (compatible; SummalyBot)';

	// `throwHttpErrors: false` で 4xx/5xx を例外にせず、自前で StatusError に変換する (phase12.1 C-2)。
	// got のデフォルト (`throwHttpErrors: true`) のままだと proxy 自身の 403 (HMAC 失敗等) が
	// 生の `Got.HTTPError` で外側に伝播してしまい、`categorizeError` のシグナル品質が落ちる。
	const proxyResponse = await got(proxyUrl, {
		method: 'GET',
		headers: {
			'x-summaly-sig': sig,
			'x-summaly-ts': String(ts),
			'x-summaly-forward-ua': forwardUA,
		},
		timeout: {
			lookup: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			connect: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			secureConnect: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			socket: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			response: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			send: args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT,
			request: cfg.timeoutMs,
		},
		http2: false,
		retry: { limit: 0 },
		responseType: 'buffer',
		throwHttpErrors: false,
	}) as unknown as Got.Response<Buffer>;

	// HTTP ステータスエラーの整形 (StatusError に変換、got.ts の receiveResponse と同じ規則)
	if (proxyResponse.statusCode >= 400) {
		throw new StatusError(
			`${proxyResponse.statusCode} ${proxyResponse.statusMessage ?? ''}`,
			proxyResponse.statusCode,
			proxyResponse.statusMessage ?? 'proxy error',
		);
	}

	// Body サイズ上限 (proxy 側でも cap 済みだが defense-in-depth)
	const maxSize = args.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
	if (proxyResponse.rawBody.byteLength > maxSize) {
		throw new Error(`maxSize exceeded (${proxyResponse.rawBody.byteLength} > ${maxSize}) on response`);
	}

	// content-type を呼出側の `typeFilter` で再検証 (W-1)。Worker が透過プロキシなので通常は
	// upstream の content-type がそのまま返るが、Worker 側のエラーページが text/plain で
	// 200 ステータスで返るような事故を防ぐ defense-in-depth。
	const contentType = proxyResponse.headers['content-type'];
	if (args.typeFilter != null && (contentType == null || !contentType.match(args.typeFilter))) {
		throw new Error(`Rejected by type filter ${contentType ?? ''} (via proxy)`);
	}

	// upstream の最終 URL は Worker から `x-summaly-final-url` で渡される。
	// 信頼境界の defense-in-depth として URL 形式を再検証 (W-2)。
	let resolvedUrl = args.url;
	const finalUrlHeader = proxyResponse.headers['x-summaly-final-url'];
	if (typeof finalUrlHeader === 'string' && finalUrlHeader !== '') {
		try {
			const parsed = new URL(finalUrlHeader);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				resolvedUrl = finalUrlHeader;
			}
		} catch {
			// 不正な URL は無視して元の URL を使う（記録経路を止めない）
		}
	}

	// `Got.Response<string>` 形式に整形して返す。`scpaping` が見るのは
	// `rawBody` (encoding 検出) / `headers` (content-type) / `statusCode` / `url` で十分。
	const result = {
		...proxyResponse,
		body: Buffer.from(proxyResponse.rawBody).toString('utf8'),
		url: resolvedUrl,
		// `ip` は proxy 経由のため取得不能。`getResponse` の private IP ガードはここで適用しない
		// (proxy 自体が外向きトラフィックの信頼境界として機能する想定)
		ip: undefined,
	} as unknown as Got.Response<string>;

	return result;
}

/**
 * `process.env.SUMMALY_PROXY_SECRET` を最優先で読み、`config.toml` の `secret` を fallback とする (phase12.1)。
 * どちらも未指定なら `''` を返し、呼出側で `enabled = false` 扱いにする想定。
 */
export function resolveProxySecret(configSecret?: string): string {
	const envSecret = process.env.SUMMALY_PROXY_SECRET;
	if (envSecret != null && envSecret !== '') return envSecret;
	if (configSecret != null && configSecret !== '') return configSecret;
	return '';
}
