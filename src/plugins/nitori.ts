import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { viaCurlCffi } from '@/utils/curl-cffi-fetch.js';
import { DEFAULT_MAX_RESPONSE_SIZE } from '@/utils/got.js';
import { StatusError } from '@/utils/status-error.js';

export const name = 'nitori';

/**
 * ニトリネット (`(www.)?nitori-net.jp/ec/product/<sku>/`) のプラグイン。
 *
 * ニトリの商品詳細ページは **TLS layer + UA layer の二重 bot block** + **JS 動的 OGP 注入** という
 * 三重壁で、HTML scraping では救援不可だった (fail mode I として整理)。しかし公式 JSON API
 * (`/occ/v2/nitorinet/nitori/products/<sku>?handleError=true&lang=ja&curr=JPY`) を Chrome UA +
 * curl_cffi (libcurl-impersonate) 経由で叩くと完璧な構造化データが返る (title / description /
 * thumbnail / brand / price 等)。
 *
 * **本プラグインの設計**: 経路学習キャッシュには載せず `viaCurlCffi` を直接呼ぶ「個別 hardcode 方式」。
 * yodobashi/sqex は HTML scraping のため `scpaping` 経由 + 経路学習キャッシュで strategy を
 * 自動学習するが、ニトリは JSON API のため `getJson` (経路学習キャッシュ非統合) しか選択肢が無く、
 * かつ TLS + UA の二重 block で経路が curl_cffi に一意確定するため hardcode で十分。
 *
 * `getJson` の経路学習キャッシュ統合は phase15.5 (仮) で別途検討。
 *
 * **運用要件 (Fastify モード前提)**:
 * - `[scraping.curl_cffi]` で `enabled = true` + `domains = ["nitori-net.jp"]`
 * - production server に `uv` をインストール + `cd tools/curl-cffi-fetcher && uv sync`
 *
 * curl_cffi 設定が無効/対象外なら明示エラーを throw する (silent fail を避ける)。
 */
const NITORI_HOST = /^(?:www\.)?nitori-net\.jp$/;
const PRODUCT_PATH = /^\/ec\/product\/([^/]+)\/?$/;

const NITORI_FAVICON = 'https://www.nitori-net.jp/favicon.ico';
const DEFAULT_SITENAME = 'ニトリネット';

/**
 * ニトリ商品 URL は終端確定 (短縮 URL でない、`/ec/product/<sku>/` 固定形)。
 * さらに HEAD probe も TLS layer で切断されるため、デフォルトの `resolveRedirect` が
 * 20 秒空回りする純損失を避けるために宣言する (yodobashi と同じ理由)。
 */
export const skipRedirectResolution = true;

export function test(url: URL): boolean {
	return NITORI_HOST.test(url.hostname) && PRODUCT_PATH.test(url.pathname);
}

/**
 * `/ec/product/<sku>/` から SKU を抽出する。末尾 `/` の有無を許容、それ以降のサブパスは想定外。
 */
export function extractSku(pathname: string): string | null {
	const m = pathname.match(PRODUCT_PATH);
	return m ? m[1] : null;
}

/**
 * SAP Commerce Cloud OCC API (`nitorinet/nitori` テナント) の商品詳細 URL を組み立てる。
 * SKU は英数字 + suffix が想定だが defense-in-depth で `encodeURIComponent` を適用。
 */
export function buildApiUrl(sku: string): string {
	return `https://www.nitori-net.jp/occ/v2/nitorinet/nitori/products/${encodeURIComponent(sku)}?handleError=true&lang=ja&curr=JPY`;
}

/**
 * `productDescription` の HTML を平文に整形する。ニトリ API は `<br>` / `<a>` / HTML エンティティ /
 * HTML コメントを含めて返してくるので最小限の strip + 300 文字 clip + ellipsis を行う。
 */
export function stripAndTruncate(html: string, maxLen = 300): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
		// NOTE: `<[^>]+>` は属性値内に `>` を含むタグを早期終端する制限がある (汎用 HTML strip
		// としては不十分)。ニトリ OCC API の productDescription は <br> / <a> / <img> 程度の
		// 単純なタグしか使わないため実用上問題ないが、任意の HTML を strip する汎用用途には
		// 流用不可。
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + '…';
}

/**
 * 期待する API レスポンス形状を最小限で表す。実 API はもっと多くのフィールドを返すが
 * 本プラグインで必要なのはここに列挙したもののみ。
 */
type NitoriProductResponse = {
	error?: { errorCode?: string; errorDescription?: string };
	brand?: { name?: string; imageUrl?: string };
	skuData?: {
		name?: string;
		productDescription?: string;
		mediasList?: Array<{ type?: string; url?: string }>;
	};
};

/**
 * API レスポンスから Summary を組み立てる。テストから直接呼べるよう export。
 *
 * - `error.errorCode === 'INVALID_PRODUCT'` なら `StatusError(404)` を throw (`category: 'not_found'`)
 * - `skuData.name` 欠如 (API 仕様変更) は `Error` を throw (npmjs と同パターン)
 */
export function buildSummaryFromApi(body: unknown): Summary {
	if (typeof body !== 'object' || body === null) {
		throw new Error('failed summarize: nitori API response is not an object');
	}
	const b = body as NitoriProductResponse;

	if (b.error != null) {
		const code = typeof b.error.errorCode === 'string' ? b.error.errorCode : 'UNKNOWN';
		// `INVALID_PRODUCT` (商品が存在しない、404 相当) のみ StatusError(404) で投げる →
		// `categorizeError` が `not_found` に分類 → `FILTERED_CATEGORIES` で blocked candidate
		// ログから自動除外される。「商品は無いが将来追加されるかも」を log に蓄積しない判断。
		// その他のエラーコード (`SERVER_ERROR` 等の API 一時障害、認証系エラー) は parse_error
		// として blocked candidate log に記録されるよう `Error('failed summarize: ...')` で投げる
		// (npmjs の `dist-tags.latest` 欠如パターンと同じ)。
		if (code === 'INVALID_PRODUCT') {
			throw new StatusError(`nitori API error: ${code}`, 404, 'NotFound');
		}
		throw new Error(`failed summarize: nitori API error: ${code}`);
	}

	const title = typeof b.skuData?.name === 'string' && b.skuData.name.length > 0
		? b.skuData.name
		: null;
	if (title === null) {
		throw new Error('failed summarize: nitori API response missing skuData.name');
	}

	const rawDescription = typeof b.skuData?.productDescription === 'string'
		? b.skuData.productDescription
		: null;
	const description = rawDescription !== null && rawDescription.length > 0
		? stripAndTruncate(rawDescription)
		: null;

	const mediasList = b.skuData?.mediasList;
	const firstImage = Array.isArray(mediasList)
		? mediasList.find(m => m.type === 'image' && typeof m.url === 'string')
		: undefined;
	const thumbnailFromMedia = firstImage != null && typeof firstImage.url === 'string'
		? firstImage.url
		: null;

	const brandIcon = typeof b.brand?.imageUrl === 'string' && b.brand.imageUrl.length > 0
		? b.brand.imageUrl
		: null;
	const icon = brandIcon ?? NITORI_FAVICON;

	const sitename = typeof b.brand?.name === 'string' && b.brand.name.length > 0
		? b.brand.name
		: DEFAULT_SITENAME;

	return {
		title,
		icon,
		description,
		thumbnail: thumbnailFromMedia ?? icon,
		player: {
			url: null,
			width: null,
			height: null,
			allow: [],
		},
		sitename,
		sensitive: false,
		activityPub: null,
		fediverseCreator: null,
	};
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const sku = extractSku(url.pathname);
	if (sku === null) return null;

	const apiUrl = buildApiUrl(sku);

	const curlCffi = opts?.curlCffiFallback;
	if (curlCffi == null || !curlCffi.enabled) {
		throw new Error('nitori plugin requires curl_cffi fallback to be enabled (configure [scraping.curl_cffi] with enabled = true)');
	}
	// phase18.1: `curlCffiFallback.domains` 撤廃。SSRF 防御は Python 側 `assert_public_ip` で実施。
	// `nitori-net.jp` の制約は本プラグインの `test()` で host match していることで担保済み。

	const response = await viaCurlCffi(
		{
			url: apiUrl,
			method: 'GET',
			headers: {
				accept: 'application/json, */*',
				'accept-language': opts?.lang ?? 'ja',
			},
			typeFilter: /^application\/(?:json|.*\+json)/,
			contentLengthLimit: opts?.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE,
			responseTimeout: opts?.responseTimeout,
			operationTimeout: opts?.operationTimeout,
		},
		curlCffi,
	);

	let body: unknown;
	try {
		body = JSON.parse(String(response.body));
	} catch {
		throw new Error('failed summarize: nitori API returned non-JSON body');
	}

	return buildSummaryFromApi(body);
}
