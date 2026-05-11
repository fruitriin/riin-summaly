import type * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { applyNsfwCardSuppression } from '@/utils/nsfw-card-suppress.js';
import { composeNsfwEmbedHtml } from '@/utils/nsfw-embed-html.js';

export const name = 'nijie';

export function test(url: URL): boolean {
	return url.hostname === 'nijie.info';
}

/**
 * **NSFW 二層構造** (phase15.6): `/view.php` 着地時 sensitive=true となり、
 * `applyNsfwCardSuppression` が card preview を抑制 + embed iframe (`renderEmbed`) で
 * フル表示する経路に切り替わる。`/view.php` 以外の経路は素通し。
 */
export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const summary = await summarizeRaw(url, opts);
	if (summary == null) return null;
	return applyNsfwCardSuppression(summary, url, opts?._embedBaseUrl);
}

/**
 * 抑制前の生 summary を取得する pure な内部ヘルパー (phase15.6)。
 * `summarize` (card 抑制版) と `renderEmbed` (フル表示版) から共有される。
 */
async function summarizeRaw(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, opts);
	const summary = await parseGeneral(url, res);
	if (summary == null) return null;
	return enrichWithNijie(summary, res.$, url);
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	// nijie.info ドメイン自体が NSFW サイトのため `/view.php` 以外のパス (`/news.php` 等) でも
	// embed 許可する (renderEmbed は [embed].allowedPlugins 経由で明示 allow されたときのみ呼ばれる)。
	// 非 view.php なら enrichWithNijie が sensitive を立てないため通常 OGP のフル表示になる
	const summary = await summarizeRaw(url, opts);
	if (!summary) {
		throw new Error('nijie renderEmbed: parseGeneral returned null');
	}
	const html = composeNsfwEmbedHtml({
		title: summary.title ?? '',
		description: summary.description ?? '',
		thumbnail: summary.thumbnail,
		sitename: summary.sitename ?? 'nijie',
	});
	return { body: html, width: 3, height: 2 };
}

/**
 * nijie の view ページに含まれる JSON-LD `ImageObject` から description / thumbnail を補完する。
 * テストから直接呼べるよう export。
 */
export function enrichWithNijie(
	summary: Summary,
	$: cheerio.CheerioAPI,
	landingUrl: URL,
): Summary {
	if (landingUrl.pathname !== '/view.php') return summary;

	$('script[type="application/ld+json"]').each((_i, el) => {
		const raw = $(el).text();
		if (!raw) return;
		// JSON-LD の中に生の制御文字 (\n / \r / \t 等) が含まれることがあり、
		// JSON.parse が SyntaxError を投げる。RFC 8259 §7 により U+0000-U+001F はすべて
		// エスケープが必須なので、Unicode エスケープに置換してからパースする。
		// eslint-disable-next-line no-control-regex -- 制御文字のサニタイズが本処理の目的
		const escaped = raw.replace(/[\x00-\x1F]/g, c => {
			const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
			return `\\u${hex}`;
		});
		let data: unknown;
		try {
			data = JSON.parse(escaped);
		} catch {
			return;
		}
		if (typeof data !== 'object' || data === null) return;
		const d = data as Record<string, unknown>;
		if (d['@type'] !== 'ImageObject') return;

		if (typeof d.thumbnailUrl === 'string') {
			summary.thumbnail = d.thumbnailUrl;
		}
		if (typeof d.description === 'string' && summary.description == null) {
			summary.description = d.description;
		}
	});

	// nijie はアダルトコンテンツを含むため、view.php に着地していたら sensitive
	summary.sensitive = true;
	return summary;
}
