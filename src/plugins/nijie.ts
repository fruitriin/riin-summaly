import type * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'nijie';

export function test(url: URL): boolean {
	return url.hostname === 'nijie.info';
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, opts);
	const summary = await parseGeneral(url, res);
	if (summary == null) return null;
	return enrichWithNijie(summary, res.$, url);
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
