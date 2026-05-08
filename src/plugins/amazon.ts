import type { GeneralScrapingOptions } from '@/general.js';
import summary from '@/summary.js';
import { scpaping } from '@/utils/got.js';

export const name = 'amazon';

/**
 * Amazon ホスト名の正規表現。`amazon.co.jp` (bare) と `www.amazon.co.jp` の両方をマッチさせる。
 *
 * Amazon は両形式を運用しており、ユーザーが SNS で共有する URL には `www.` が付かないことも多い。
 * bare 形式が general パスに流れると URL 正規化 (`normalizeAmazonUrl`) を経由せず、長い ref query
 * 付きで proxy fallback まで届かない事故が起きるため、両形式をまとめて plugin で受ける。
 *
 * `^(?:www\\.)?amazon\\.<TLD>$` の anchored 形にすることで `aws.amazon.com` 等の AWS サブドメインを
 * 誤マッチさせない（plugin の責務は商品ページ専用）。
 */
const AMAZON_HOST = /^(?:www\.)?amazon\.(?:com|co\.jp|ca|com\.br|com\.mx|co\.uk|de|fr|it|es|nl|cn|in|au)$/;

/**
 * Amazon 短縮 URL ホスト。
 *
 * Vultr Tokyo IP からの amzn.asia GET は Amazon が 301 リダイレクトを返さず **200 + 軽量
 * preview HTML** を返してしまい (`og:title="Amazon"`, `og:image=previewdoh/amazon.png`)、
 * resolveRedirect 経由でも `www.amazon.co.jp` に解決されない。これを amazon plugin で扱うため、
 * 短縮ホストもマッチさせて summarize() 内で final URL から ASIN 抽出 → canonical 化 → 再 scpaping
 * する経路を追加する。
 */
const AMAZON_SHORT_HOST = /^(?:amzn\.asia|amzn\.to|a\.co)$/;

export function test(url: URL): boolean {
	return AMAZON_HOST.test(url.hostname) || AMAZON_SHORT_HOST.test(url.hostname);
}

/**
 * Amazon URL を `/dp/<asin>` 等の最小形に正規化する。
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
	// hostname も `www.` 付きの canonical 形に揃える。
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
	// `opts` を伝播することで proxy fallback と UA fallback が Amazon プラグイン経由でも機能する。
	// proxy fallback の主用途が Amazon なので **必須**。
	//
	// **URL 正規化**: `?_encoding=...&pd_rd_w=...&ref_=...` のような長い query が付くと CF Workers
	// proxy 経由でも Amazon が 500 を返すケースがあるため、`/dp/<asin>` 形式に正規化してから取得する。
	// referral tracking の query は商品ページの内容に影響しない。
	let normalized = normalizeAmazonUrl(url);

	// **短縮 URL の 2 段取得**: `amzn.asia/d/<id>` は path から ASIN を
	// 抽出できないので一旦 scpaping → final URL から ASIN 取得 → canonical で再 scpaping する。
	// Vultr (本番) では Amazon が `amzn.asia` GET に対して 200 + 軽量 preview HTML を返してしまい、
	// `res.response.url` が短縮ドメインのままになる。その場合 ASIN 抽出は不可能なので、preview HTML を
	// そのままパースして null を返す（amazon プラグインから general へのフォールバックは無いので
	// 薄い結果でも summary を返す形）。
	if (AMAZON_SHORT_HOST.test(url.hostname) && normalized.href === url.href) {
		const firstRes = await scpaping(url.href, opts);
		// final URL (Got が記録するリダイレクト解決後の URL) から ASIN を抽出してみる
		let finalUrl: URL;
		try {
			finalUrl = new URL(firstRes.response.url);
		} catch {
			finalUrl = url;
		}
		const reNormalized = normalizeAmazonUrl(finalUrl);
		if (reNormalized.href !== finalUrl.href) {
			// ASIN 抽出成功 → canonical で再取得
			normalized = reNormalized;
		} else {
			// ASIN 抽出失敗 (preview HTML のまま) → 最初に取った HTML をパース
			return parseAmazonHtml(firstRes.$);
		}
	}

	const res = await scpaping(normalized.href, opts);
	return parseAmazonHtml(res.$);
}

/**
 * scpaping 結果の cheerio から amazon 商品ページの metadata を抽出する。
 *
 * 商品ページ (`/dp/<asin>` で 200 + フル HTML) なら `#title` / `#productDescription` /
 * `#landingImage` で抽出。`amzn.asia` の軽量 preview HTML だと商品ページの DOM 要素が無いため、
 * OG meta tags (`og:title` / `og:image` / `og:description`) を fallback で見て「Amazon」「Amazon ロゴ」
 * 程度の薄い情報でも返す。
 *
 * **Prime Video / その他の専用ページ対応 (followup #5)**: `/gp/video/detail/<asin>` のような
 * Prime Video URL は商品ページ風 HTML を返すが `#title` が空 (JS で動的に埋まる)、og:title も空のため
 * `<title>` HTML タグを最終 fallback として見る。`<title>` には「機動戦士ガンダム 水星の魔女
 * シーズン1を観る | Prime Video」のような可読タイトルが入っている。
 */
export function parseAmazonHtml($: import('cheerio').CheerioAPI): summary {
	// `<title>` は cheerio で `head > title` を明示しないと SVG 内のアクセシビリティ用 `<title>`
	// (e.g. `<svg><title>Caret Down</title></svg>`) も全部マッチして連結される。
	// Prime Video ページは SVG icon が大量に埋まっており `<title>` が 100 件超返ってくるので、
	// `head > title` で head の正規タイトル要素だけに限定する。
	const title = $('#title').text().trim()
		|| $('meta[property="og:title"]').attr('content')
		|| $('meta[name="twitter:title"]').attr('content')
		|| $('head > title').first().text().trim()
		|| '';

	const description =
		$('#productDescription').text() ||
		$('meta[property="og:description"]').attr('content') ||
		$('meta[name="description"]').attr('content');

	// Prime Video (`/gp/video/detail/<asin>`) は商品ページ DOM (`#landingImage`) も OGP も持たず、
	// hero 画像が `<img data-testid="base-image" loading="eager" alt="...">` として埋まっている。
	// `loading="eager"` のものが ATF (above-the-fold) の hero で、`loading="lazy"` のサムネイル群と
	// 区別できる。`elementtiming="dv-web-timing-atfVisible"` も同義だが selector は短い方を採用。
	const thumbnail: string | undefined =
		$('#landingImage').attr('src') ||
		$('meta[property="og:image"]').attr('content') ||
		$('img[data-testid="base-image"][loading="eager"]').first().attr('src');

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
