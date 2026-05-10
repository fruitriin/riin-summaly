import { decode as decodeHtml } from 'html-entities';
import * as cheerio from 'cheerio';
import type { default as Summary, Player } from '@/summary.js';
import { clip } from '@/utils/clip.js';
import { cleanupTitle } from '@/utils/cleanup-title.js';

import { get, head, scpaping } from '@/utils/got.js';
import { PDF_ICON_DATA_URL } from '@/utils/pdf-icon.js';

/**
 * Contains only the html snippet for a sanitized iframe as the thumbnail is
 * mostly covered in OpenGraph instead.
 *
 * Width should always be 100%.
 */
async function getOEmbedPlayer($: cheerio.CheerioAPI, pageUrl: string): Promise<Player | null> {
	const href = $('link[type="application/json+oembed"]').attr('href');
	if (!href) {
		return null;
	}

	const oEmbedUrl = (() => {
		try {
			return new URL(href, pageUrl);
		} catch { return null; }
	})();
	if (!oEmbedUrl) {
		return null;
	}

	const oEmbed = await get(oEmbedUrl.href).catch(() => null);
	if (!oEmbed) {
		return null;
	}

	const body = (() => {
		try {
			return JSON.parse(oEmbed);
		} catch { /* empty */ }
	})();

	if (!body || body.version !== '1.0' || !['rich', 'video'].includes(body.type)) {
		// Not a well formed rich oEmbed
		return null;
	}

	if (!body.html.startsWith('<iframe ') || !body.html.endsWith('</iframe>')) {
		// It includes something else than an iframe
		return null;
	}

	const oEmbedHtml = cheerio.load(body.html);
	const iframe = oEmbedHtml('iframe');

	if (iframe.length !== 1) {
		// Somehow we either have multiple iframes or none
		return null;
	}

	if (iframe.parents().length !== 2) {
		// Should only have the body and html elements as the parents
		return null;
	}

	const url = iframe.attr('src');
	if (!url) {
		// No src?
		return null;
	}

	try {
		if ((new URL(url)).protocol !== 'https:') {
			// Allow only HTTPS for best security
			return null;
		}
	} catch {
		return null;
	}

	// Height is the most important, width is okay to be null. The implementer
	// should choose fixed height instead of fixed aspect ratio if width is null.
	//
	// For example, Spotify's embed page does not strictly follow aspect ratio
	// and thus keeping the height is better than keeping the aspect ratio.
	//
	// Spotify gives `width: 100%, height: 152px` for iframe while `width: 456,
	// height: 152` for oEmbed data, and we treat any percentages as null here.
	let width: number | null = Number(iframe.attr('width') ?? body.width);
	if (Number.isNaN(width)) {
		width = null;
	}
	const height = Math.min(Number(iframe.attr('height') ?? body.height), 1024);
	if (Number.isNaN(height)) {
		// No proper height info
		return null;
	}

	// TODO: This implementation only allows basic syntax of `allow`.
	// Might need to implement better later.
	const safeList = [
		'autoplay',
		'clipboard-write',
		'fullscreen',
		'encrypted-media',
		'picture-in-picture',
		'web-share',
	];
	// YouTube has these but they are almost never used.
	const ignoredList = [
		'gyroscope',
		'accelerometer',
	];
	const allowedPermissions =
		(iframe.attr('allow') ?? '').split(/\s*;\s*/g)
			.filter(s => s)
			.filter(s => !ignoredList.includes(s));
	if (iframe.attr('allowfullscreen') === '') {
		allowedPermissions.push('fullscreen');
	}
	if (allowedPermissions.some(allow => !safeList.includes(allow))) {
		// This iframe is probably too powerful to be embedded
		return null;
	}

	return {
		url,
		width,
		height,
		allow: allowedPermissions,
	};
}

/**
 * favicon を thumbnail に流用してよいか判定する (favicon fallback の補強)。
 *
 * Misskey 等の preview UI は `<img>` タグで thumbnail を表示するため、`.ico` / `.cur` のような
 * `<img>` で描画できない形式を渡すと broken image アイコンになる。content-type を優先し、
 * content-type 不明なら拡張子で判定する。
 *
 * 判定ルール:
 * - content-type あり → `image/x-icon` / `image/vnd.microsoft.icon` を除外、それ以外の `image/*` を許可
 *   - `image/*` 以外 (HTML が誤って返るサイト等) は除外
 * - content-type 無し → 拡張子で判定 (`.ico` / `.cur` は除外、その他は許可)
 *
 * テスト容易性のため export。
 */
export function isThumbnailableIcon(icon: { href: string; contentType: string | undefined }): boolean {
	if (icon.contentType != null) {
		const ct = icon.contentType.toLowerCase().split(';')[0].trim();
		if (ct === 'image/x-icon' || ct === 'image/vnd.microsoft.icon') return false;
		return ct.startsWith('image/');
	}
	const lower = icon.href.toLowerCase();
	// クエリ / フラグメント前の拡張子だけを見る (例: `/favicon.ico?v=2` も `.ico` 判定)
	const pathOnly = lower.split('?')[0].split('#')[0];
	if (pathOnly.endsWith('.ico') || pathOnly.endsWith('.cur')) return false;
	return true;
}

export type GeneralScrapingOptions = {
	lang?: string | null;
	userAgent?: string;
	followRedirects?: boolean;
	responseTimeout?: number;
	operationTimeout?: number;
	contentLengthLimit?: number;
	contentLengthRequired?: boolean;
	/**
	 * Range リクエストで先頭領域だけを取得する。サーバが Range 未対応の場合は通常の GET 同等の挙動。
	 * 帯域節約用途（高頻度プレビューや大型 HTML サイト）。
	 */
	useRange?: boolean;

	/**
	 * PDF レスポンス対応を有効化する（オプトイン）。
	 * 詳細は SummalyOptions.enablePdf を参照。
	 */
	enablePdf?: boolean;

	/**
	 * Bot block 検出時のフォールバック UA。指定すると、`fallbackRetryCategories` に含まれる
	 * カテゴリのエラーが発生したとき、UA をこの値に差し替えて 1 回だけ再試行する。
	 * `undefined` または空文字列ならリトライ無効（既存挙動）。詳細は SummalyOptions.fallbackUserAgent。
	 */
	fallbackUserAgent?: string;

	/**
	 * フォールバック UA リトライを発火するエラーカテゴリ。デフォルト: `['bot_blocked', 'connection_dropped']`。
	 */
	fallbackRetryCategories?: import('@/utils/parse-failure-log.js').SummalyErrorCategory[];

	/**
	 * Outbound proxy フォールバック設定。`getResponseWithFallback` で救えなかった
	 * IP レピュテーション層の遮断（amazon.co.jp 等）を Cloudflare Workers 経由でリトライする。
	 * `undefined` または `enabled === false` ならリトライ無効（既存挙動互換）。
	 */
	proxyFallback?: import('@/utils/proxy-fallback.js').ProxyFallbackConfig;

	/**
	 * curl_cffi (libcurl-impersonate) フォールバック設定。`getResponseWithProxyFallback`
	 * でも救えなかった TLS layer bot block (yodobashi 級の HTTP/2 INTERNAL_ERROR / 即時切断) を
	 * Python CLI (`tools/curl-cffi-fetcher/`) を spawn して Chrome TLS フィンガープリント偽装で
	 * リトライする。`undefined` または `enabled === false` ならリトライ無効（既存挙動互換）。
	 *
	 * production server には `uv` を別途インストールし、
	 * `cd tools/curl-cffi-fetcher && uv sync` で依存解決しておく必要がある。
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
	 * 経路学習キャッシュの記録 context を伝達する mutable side-channel。
	 * `summaly()` が `{}` を渡し、`scpaping()` が読み書きする。`summaly()` が Summary 確定後に
	 * 値を読んで `cache.recordSuccess` / `recordFailure` を呼ぶ。
	 * library 利用者は触らない (型シグネチャ上は optional だが運用上は内部専用)。
	 */
	_cacheRecording?: import('@/utils/domain-strategy-cache.js').CacheRecordingState;

	/**
	 * @internal
	 * Fastify モードの `[embed].publicUrl` を反映した embed エンドポイントのベース URL。
	 * `SummalyOptions.embedBaseUrl` を `summaly()` レイヤから
	 * プラグインの `summarize()` に透過伝搬するための internal フィールド。
	 * `syosetu` のような renderEmbed 対応プラグインが `Summary.player.url` を組み立てるのに使う。
	 * library mode では SummalyOptions に embedBaseUrl を直接渡せばこのフィールドに反映される。
	 */
	_embedBaseUrl?: string;
};

export async function general(_url: URL | string, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	let lang = opts?.lang;
	if (lang && !lang.match(/^[\w-]+(\s*,\s*[\w-]+)*$/)) lang = null;

	const url = typeof _url === 'string' ? new URL(_url) : _url;

	// **`{ ...opts, lang, followRedirects }` spread パターン**: `GeneralScrapingOptions` 拡張時の
	// 伝搬漏れを構造的に防ぐため、明示列挙ではなく spread で全フィールドを伝搬する。
	//
	// 個別の上書き:
	// - `lang`: regex 検証後の値で上書き (string|null|undefined → string|undefined に正規化)
	// - `followRedirects: undefined`: scpaping には伝播させない。summaly レイヤの初期 HEAD 解決
	//   オプションであって、scrape 中のリダイレクト追跡を無効化するためのものではない。型上は
	//   `GeneralScrapingOptions` に含まれるが、現状すべての呼出経路で undefined になっている
	//   (`src/index.ts` の `scrapingOptions` 構築で除外)。spread 経由で将来別の呼出経路が
	//   `followRedirects: false` を渡したときに redirect 中間レスポンスが typeFilter で reject
	//   される bug が再発しないよう、明示 override で構造的に防衛する。
	const res = await scpaping(url.href, {
		...opts,
		lang: lang || undefined,
		followRedirects: undefined,
	});

	if (res.pdf != null) {
		return buildPdfSummary(url, res.pdf);
	}

	return await parseGeneral(url, res);
}

/**
 * PDF レスポンス専用の Summary を組み立てる。タイトルが取れなければホスト名で代用、
 * アイコンは固定の PDF アイコン (data URI)。
 */
function buildPdfSummary(url: URL, pdf: { title?: string }): Summary {
	const title = (pdf.title != null && pdf.title.trim().length > 0)
		? pdf.title.trim()
		: url.hostname;
	return {
		title,
		icon: PDF_ICON_DATA_URL,
		description: null,
		thumbnail: null,
		sitename: url.hostname,
		player: { url: null, width: null, height: null, allow: [] },
		activityPub: null,
		fediverseCreator: null,
	};
}

function headerEqualValueContains(search: string, headerValue: string | string[] | undefined) {
	if (!headerValue) {
		return false;
	}

	if (Array.isArray(headerValue)) {
		return headerValue.some(value => value.toLowerCase() === search.toLowerCase());
	}

	return headerValue.toLowerCase() === search.toLowerCase();
}

export async function parseGeneral(_url: URL | string, res: Awaited<ReturnType<typeof scpaping>>): Promise<Summary | null> {
	const url = typeof _url === 'string' ? new URL(_url) : _url;
	const $ = res.$;
	const twitterCard =
		$('meta[name="twitter:card"]').attr('content') ||
		$('meta[property="twitter:card"]').attr('content');

	// According to docs, name attribute of meta tag is used for twitter card but for compatibility,
	// this library will also look for property attribute.
	// See https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary
	// Property attribute is used for open graph.
	// See https://ogp.me/

	// `head > title` で head の正規タイトル要素だけに限定する。`$('title')` だと SVG icon の
	// アクセシビリティ用 `<title>` (e.g. `<svg><title>Caret Down</title></svg>`) もマッチして
	// 連結されるため、Amazon Prime Video のように SVG icon が大量に埋まるサイトで title 末尾に
	// "Caret DownChannelsCaret RightChannelsSearch..." が貼り付く。
	let title: string | null | undefined =
		$('meta[property="og:title"]').attr('content') ||
		$('meta[name="twitter:title"]').attr('content') ||
		$('meta[property="twitter:title"]').attr('content') ||
		$('head > title').first().text();

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (title === undefined || title === null) {
		return null;
	}

	title = clip(decodeHtml(title), 100);

	let image: string | null | undefined =
		$('meta[property="og:image"]').attr('content') ||
		$('meta[name="twitter:image"]').attr('content') ||
		$('meta[property="twitter:image"]').attr('content') ||
		$('link[rel="image_src"]').attr('href') ||
		$('link[rel="apple-touch-icon"]').attr('href') ||
		$('link[rel="apple-touch-icon image_src"]').attr('href');

	image = image ? (new URL(image, url.href)).href : null;

	const playerUrl =
		(twitterCard !== 'summary_large_image' && $('meta[name="twitter:player"]').attr('content')) ||
		(twitterCard !== 'summary_large_image' && $('meta[property="twitter:player"]').attr('content')) ||
		$('meta[property="og:video"]').attr('content') ||
		$('meta[property="og:video:secure_url"]').attr('content') ||
		$('meta[property="og:video:url"]').attr('content');

	const playerWidth = parseInt(
		$('meta[name="twitter:player:width"]').attr('content') ||
		$('meta[property="twitter:player:width"]').attr('content') ||
		$('meta[property="og:video:width"]').attr('content') ||
		'');

	const playerHeight = parseInt(
		$('meta[name="twitter:player:height"]').attr('content') ||
		$('meta[property="twitter:player:height"]').attr('content') ||
		$('meta[property="og:video:height"]').attr('content') ||
		'');

	let description: string | null | undefined =
		$('meta[property="og:description"]').attr('content') ||
		$('meta[name="twitter:description"]').attr('content') ||
		$('meta[property="twitter:description"]').attr('content') ||
		$('meta[name="description"]').attr('content');

	description = description
		? clip(decodeHtml(description), 300)
		: null;

	if (title === description) {
		description = null;
	}

	const siteName = decodeHtml(
		$('meta[property="og:site_name"]').attr('content') ||
		$('meta[name="application-name"]').attr('content') ||
		url.host,
	);

	const favicon =
		$('link[rel="shortcut icon"]').attr('href') ||
		$('link[rel="icon"]').attr('href') ||
		'/favicon.ico';

	const activityPub =
		$('link[rel="alternate"][type="application/activity+json"]').attr('href') || null;

	const fediverseCreator: string | null =
		$('meta[name=\'fediverse:creator\']').attr('content') || null;

	// https://developer.mixi.co.jp/connect/mixi_plugin/mixi_check/spec_mixi_check/#toc-18-
	const sensitive =
		$('meta[property=\'mixi:content-rating\']').attr('content') === '1' ||
		headerEqualValueContains('adult', res.response.headers.rating) ||
		headerEqualValueContains('RTA-5042-1996-1400-1577-RTA', res.response.headers.rating) ||
		$('meta[name=\'rating\']').attr('content') === 'adult' ||
		$('meta[name=\'rating\']').attr('content')?.toUpperCase() === 'RTA-5042-1996-1400-1577-RTA';

	const getIcon = async (): Promise<{ href: string; contentType: string | undefined } | null> => {
		const target = new URL(favicon, url.href);
		try {
			const res = await head(target.href);
			const ct = res.headers['content-type'];
			return {
				href: target.href,
				contentType: typeof ct === 'string' ? ct : undefined,
			};
		} catch {
			return null;
		}
	};

	const [icon, oEmbed] = await Promise.all([
		getIcon(),
		getOEmbedPlayer($, url.href),
	]);

	// Clean up the title
	title = cleanupTitle(title, siteName);

	if (title === '') {
		title = siteName;
	}

	// OG/Twitter Card/image_src/apple-touch-icon が全部無い場合、HEAD 検証済みの favicon を
	// thumbnail フォールバックとして採用する。
	// 「タイトルだけのスカスカプレビュー」を「サイトアイコン入りの最低限の見た目」に格上げ。
	// favicon が HEAD 失敗 (`icon === null`) ならフォールバックも発動しない。
	//
	// **`.ico` / `.cur` の除外**: `<img>` で表示できない
	// 画像形式 (主に Windows .ico) を thumbnail に流用すると Misskey 等の preview UI で broken
	// image になる。content-type / 拡張子の双方で判定し、表示不能形式は thumbnail から除外。
	// icon フィールド自体には残す (サイトアイコン表示は ico 対応の経路もあるため互換性維持)。
	const thumbnail = image ?? (icon != null && isThumbnailableIcon(icon) ? icon.href : null);

	return {
		title: title || null,
		icon: icon?.href || null,
		description: description || null,
		thumbnail,
		player: oEmbed ?? {
			url: playerUrl || null,
			width: Number.isNaN(playerWidth) ? null : playerWidth,
			height: Number.isNaN(playerHeight) ? null : playerHeight,
			allow: ['autoplay', 'encrypted-media', 'fullscreen'],
		},
		sitename: siteName || null,
		sensitive,
		activityPub,
		fediverseCreator,
	};
}
