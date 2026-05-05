import type { GeneralScrapingOptions } from '@/general.js';
import summary from '@/summary.js';
import { scpaping } from '@/utils/got.js';

export const name = 'amazon';

/**
 * Amazon ホスト名の正規表現。`amazon.co.jp` (bare) と `www.amazon.co.jp` の両方をマッチさせる。
 *
 * Amazon は両形式を運用しており、ユーザーが SNS で共有する URL には `www.` が付かないことも多い。
 * phase12.1 followup #3 までは `www.amazon.co.jp` 限定の `===` 比較だったため、bare 形式の URL が
 * general パスに流れて URL 正規化 (`normalizeAmazonUrl`) を経由せず、長い ref query 付きで
 * proxy fallback まで届いていなかった。
 *
 * `^(?:www\\.)?amazon\\.<TLD>$` の anchored 形にすることで `aws.amazon.com` 等の AWS サブドメインを
 * 誤マッチさせない（plugin の責務は商品ページ専用）。
 */
const AMAZON_HOST = /^(?:www\.)?amazon\.(?:com|co\.jp|ca|com\.br|com\.mx|co\.uk|de|fr|it|es|nl|cn|in|au)$/;

export function test(url: URL): boolean {
	return AMAZON_HOST.test(url.hostname);
}

/**
 * Amazon URL を `/dp/<asin>` 等の最小形に正規化する (phase12.1 followup)。
 *
 * 長い query (`?_encoding=UTF8&pd_rd_w=...&ref_=...`) が付くと、Cloudflare Workers proxy
 * 経由でも Amazon が 500 を返すケースが実証された。query は referral tracking で商品ページの
 * 内容には影響しないため、全部削って canonical URL に揃えてから取得する。
 *
 * 対応する正規 path:
 * - `/dp/<asin>` (10 桁英数字、Amazon の標準商品 URL)
 * - `/gp/product/<asin>` (古い商品 URL)
 *
 * SEO 用の slug (`/<商品名 url-encoded>/dp/<asin>/...`) も検出して `/dp/<asin>` に圧縮する。
 * 該当 ASIN が見つからない場合は元の URL のまま返す（amazon の検索ページ等）。
 *
 * **ASIN は Amazon 仕様で `[A-Z0-9]{10}` の固定長**（2026 年時点）。`{10}` 厳密マッチ + 境界
 * チェック (`(?:\/|$)`) で、11 桁以上の偶然的な英数字列やネストした path に誤マッチしない。
 * 将来 Amazon が ASIN 仕様を変更した場合は正規表現を更新する必要がある。
 *
 * **`SummalyResult.url` は変わらない**: 正規化は `scpaping()` への送信 URL のみに適用される。
 * 最終的な `SummalyResult.url` は `summaly()` の入口で `resolveRedirect()` が解決した
 * 元 URL のままになる（`Object.assign(summary, { url: actualUrl })`）。
 */
export function normalizeAmazonUrl(url: URL): URL {
	// `/dp/<asin>` または `/gp/product/<asin>` を任意の位置から拾う。
	// 両方マッチした場合は `/dp/` を優先（標準パス、`/gp/product/` は古い形式）。
	const dpMatch = /\/dp\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
	const gpMatch = /\/gp\/product\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
	const asin = (dpMatch ?? gpMatch)?.[1];
	if (asin == null) return url;
	const normalized = new URL(url.href);
	// hostname も `www.` 付きの canonical 形に揃える（phase12.1 followup #3）。
	// bare `amazon.co.jp` を Amazon が 301 で `www.` 付きにリダイレクトする挙動を summaly 側で
	// 先回りして潰すことで、proxy fallback 経路でも余分なリダイレクトを避ける。
	if (!normalized.hostname.startsWith('www.')) {
		normalized.hostname = 'www.' + normalized.hostname;
	}
	// path を `/dp/<asin>` 固定、query / fragment を全部捨てる。
	// ASIN は仕様上大文字のみだが defensive に `toUpperCase()` で正規化する。
	normalized.pathname = `/dp/${asin.toUpperCase()}`;
	normalized.search = '';
	normalized.hash = '';
	return normalized;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<summary> {
	// `opts` を伝播することで proxy fallback (phase12.1) と UA fallback (phase11.9) が
	// Amazon プラグイン経由でも機能する。proxy fallback の主用途が Amazon なので **必須**。
	//
	// **URL 正規化 (phase12.1 followup)**: `?_encoding=...&pd_rd_w=...&ref_=...` のような長い query
	// が付くと CF Workers proxy 経由でも Amazon が 500 を返すケースがあるため、`/dp/<asin>` 形式に
	// 正規化してから取得する。referral tracking の query は商品ページの内容に影響しない。
	const normalized = normalizeAmazonUrl(url);
	const res = await scpaping(normalized.href, opts);
	const $ = res.$;

	const title = $('#title').text();

	const description =
		$('#productDescription').text() ||
		$('meta[name="description"]').attr('content');

	const thumbnail: string | undefined = $('#landingImage').attr('src');

	const playerUrl =
		$('meta[property="twitter:player"]').attr('content') ||
		$('meta[name="twitter:player"]').attr('content');

	const playerWidth =
		$('meta[property="twitter:player:width"]').attr('content') ||
		$('meta[name="twitter:player:width"]').attr('content');

	const playerHeight =
		$('meta[property="twitter:player:height"]').attr('content') ||
		$('meta[name="twitter:player:height"]').attr('content');

	return {
		title: title ? title.trim() : null,
		icon: 'https://www.amazon.com/favicon.ico',
		description: description ? description.trim() : null,
		thumbnail: thumbnail ? thumbnail.trim() : null,
		player: {
			url: playerUrl || null,
			width: playerWidth ? parseInt(playerWidth) : null,
			height: playerHeight ? parseInt(playerHeight) : null,
			allow: playerUrl ? ['fullscreen', 'encrypted-media'] : [],
		},
		sitename: 'Amazon',
		activityPub: null,
		fediverseCreator: null,
	};
}
