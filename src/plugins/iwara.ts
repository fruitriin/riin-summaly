import type * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { clip } from '@/utils/clip.js';

export const name = 'iwara';

export function test(url: URL): boolean {
	return /(^|\.)iwara\.tv$/.test(url.hostname);
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, opts);
	const summary = await parseGeneral(url, res);
	if (summary == null) return null;
	return enrichWithIwara(summary, res.$, url);
}

/**
 * iwara 固有の DOM 後処理。テストから直接呼べるよう export。
 *
 * @param summary `parseGeneral` から返ってきた Summary（mutate して返す）
 * @param $ scpaping の cheerio インスタンス
 * @param landingUrl `summarize` に渡された URL（sensitive 判定の `//ecchi.` ホストチェック用）
 */
export function enrichWithIwara(
	summary: Summary,
	$: cheerio.CheerioAPI,
	landingUrl: URL,
): Summary {
	// description が無い場合 .field-type-text-with-summary から補完。
	// cheerio の .text() は HTML エンティティをデコード済みのプレーンテキストを返すため
	// `decodeHtml` の二重適用は不要（二重エンコードされた &amp;lt; が <lt> に化けるリスクを避ける）。
	if (summary.description == null) {
		const cleaned = $('.field-type-text-with-summary').text().trim();
		if (cleaned.length > 0 && cleaned !== summary.title) {
			summary.description = clip(cleaned, 500);
		}
	}

	// thumbnail が無い場合 #video-player[poster] または .field-name-field-images a:first[href] から補完
	if (summary.thumbnail == null) {
		const poster = $('#video-player').attr('poster');
		const firstImg = $('.field-name-field-images a').first().attr('href');
		const candidate = poster ?? firstImg;
		if (candidate != null && candidate !== '') {
			try {
				summary.thumbnail = new URL(candidate, landingUrl.href).href;
			} catch {
				// 不正な URL は無視
			}
		}
	}

	// `ecchi.iwara.tv` サブドメインに着地した場合 sensitive
	if (landingUrl.hostname === 'ecchi.iwara.tv') {
		summary.sensitive = true;
	}

	return summary;
}
