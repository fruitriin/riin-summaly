/**
 * Outbound proxy 経路 (phase18 hedge race の challenger)。
 *
 * Vultr Tokyo IP からの amazon.co.jp / store.jp.square-enix.com 等 IP レピュテーション層の遮断を、
 * Cloudflare Workers にデプロイした `tools/cf-proxy-worker/` 経由で迂回する。
 *
 * phase18 で段階的 cascade (`getResponseWithProxyFallback`) を撤廃し、`fetchByStrategy` から
 * `viaProxyWorker` を直接呼ぶ形に変更。発火条件 (categories / domains allowlist) も廃止し、
 * 「設定で enabled なら hedge race の challenger として常に並列発火」する設計。
 *
 * Worker への HMAC 認証は `${target_url}\n${ts}` に対する SHA-256 HMAC。
 * `tools/cf-proxy-worker/src/index.ts` 側の `hmacSha256Hex` と相互運用。
 */

import { createHmac } from 'node:crypto';
import got, * as Got from 'got';
import { StatusError } from '@/utils/status-error.js';
import {
	type GotOptions,
	DEFAULT_RESPONSE_TIMEOUT,
	DEFAULT_MAX_RESPONSE_SIZE,
} from '@/utils/got.js';

/**
 * Outbound proxy 設定。
 *
 * - `enabled === false` または `secret` 未指定なら proxy 経路は無効
 *
 * phase18.1 で `categories` / `domains` field を撤廃 (hedge race ですべての URL に対して並列発火)。
 * Worker 側の `ALLOWED_DOMAINS` がオープンプロキシ化を防ぐ最終防衛として機能する。
 */
export interface ProxyFallbackConfig {
	enabled: boolean;
	/** Worker のエンドポイント URL (`https://<your>.workers.dev`、末尾スラッシュ無し推奨) */
	url: string;
	/** HMAC 共有シークレット (Workers env vars `SHARED_SECRET` と一致) */
	secret: string;
	/** Proxy リクエストのタイムアウト (ミリ秒) */
	timeoutMs: number;
}

export const DEFAULT_PROXY_TIMEOUT_MS = 30000;

/**
 * `domains` allowlist に hostname がマッチするか判定 (suffix-match)。
 *
 * phase18.1 で `ProxyFallbackConfig.domains` は撤廃したが、関数自体はプラグイン側 (例: 将来の
 * 個別サイト判定) で再利用可能なので残す。
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
 * Worker proxy に投げて `Got.Response<string>` 形式で結果を返す。
 *
 * 透過プロキシ動作のため、Worker 側のレスポンスを `Got.Response` の最低限の形に整形:
 * - `body`: string
 * - `rawBody`: Uint8Array (encoding 検出のため `scpaping` が必要とする)
 * - `statusCode`, `statusMessage`, `headers`, `url`
 * - `ip`: 透過 proxy なので未取得 (プライベート IP ガード判定はバイパスされる、proxy が信頼境界の役割)
 *
 * phase18 hedge race の challenger 経路として `fetchByStrategy` から呼ばれる。
 * `externalSignal` (hedge race 勝者確定後 cancellation) で got リクエストを abort。
 */
export async function viaProxyWorker(
	args: GotOptions,
	cfg: ProxyFallbackConfig,
	externalSignal?: AbortSignal,
): Promise<Got.Response<string>> {
	const ts = Date.now();
	const sig = generateHmacSignature(cfg.secret, args.url, ts);
	const proxyUrl = `${cfg.url.replace(/\/$/, '')}/?url=${encodeURIComponent(args.url)}`;

	// Worker から upstream への forwarded UA は呼出側の UA を尊重
	const headerUA = args.headers['user-agent'];
	const forwardUA = typeof headerUA === 'string' ? headerUA : 'Mozilla/5.0 (compatible; SummalyBot)';

	// 外部 signal (hedge race の勝者確定後 cancellation) で got リクエストを中断
	const proxyAbort = new AbortController();
	if (externalSignal != null) {
		if (externalSignal.aborted) {
			proxyAbort.abort('aborted by external signal');
		} else {
			externalSignal.addEventListener('abort', () => {
				proxyAbort.abort('aborted by external signal');
			}, { once: true });
		}
	}

	// `throwHttpErrors: false` で 4xx/5xx を例外にせず、自前で StatusError に変換する。
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
		signal: proxyAbort.signal,
	}) as unknown as Got.Response<Buffer>;

	if (proxyResponse.statusCode >= 400) {
		throw new StatusError(
			`${proxyResponse.statusCode} ${proxyResponse.statusMessage ?? ''}`,
			proxyResponse.statusCode,
			proxyResponse.statusMessage ?? 'proxy error',
		);
	}

	const maxSize = args.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
	if (proxyResponse.rawBody.byteLength > maxSize) {
		throw new Error(`maxSize exceeded (${proxyResponse.rawBody.byteLength} > ${maxSize}) on response`);
	}

	// content-type を呼出側の `typeFilter` で再検証 (defense-in-depth)。
	const contentType = proxyResponse.headers['content-type'];
	if (args.typeFilter != null && (contentType == null || !contentType.match(args.typeFilter))) {
		throw new Error(`Rejected by type filter ${contentType ?? ''} (via proxy)`);
	}

	// upstream の最終 URL は Worker から `x-summaly-final-url` で渡される。
	// 信頼境界の defense-in-depth として URL 形式を再検証。
	let resolvedUrl = args.url;
	const finalUrlHeader = proxyResponse.headers['x-summaly-final-url'];
	if (typeof finalUrlHeader === 'string' && finalUrlHeader !== '') {
		try {
			const parsed = new URL(finalUrlHeader);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				resolvedUrl = finalUrlHeader;
			}
		} catch {
			// 不正な URL は無視して元の URL を使う
		}
	}

	return {
		...proxyResponse,
		body: Buffer.from(proxyResponse.rawBody).toString('utf8'),
		url: resolvedUrl,
		ip: undefined,
	} as unknown as Got.Response<string>;
}

/**
 * `process.env.SUMMALY_PROXY_SECRET` を最優先で読み、`config.toml` の `secret` を fallback とする。
 * どちらも未指定なら `''` を返し、呼出側で `enabled = false` 扱いにする想定。
 */
export function resolveProxySecret(configSecret?: string): string {
	const envSecret = process.env.SUMMALY_PROXY_SECRET;
	if (envSecret != null && envSecret !== '') return envSecret;
	if (configSecret != null && configSecret !== '') return configSecret;
	return '';
}
