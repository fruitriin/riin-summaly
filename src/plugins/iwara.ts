import type * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { clip } from '@/utils/clip.js';
import { applyNsfwCardSuppression } from '@/utils/nsfw-card-suppress.js';
import { composeNsfwEmbedHtml } from '@/utils/nsfw-embed-html.js';

export const name = 'iwara';

export function test(url: URL): boolean {
	return /(^|\.)iwara\.tv$/.test(url.hostname);
}

/**
 * **NSFW 二層構造** (phase15.6): `ecchi.iwara.tv` 着地時 sensitive=true となり、
 * `applyNsfwCardSuppression` が card preview を抑制 + embed iframe (`renderEmbed`) で
 * フル表示する経路に切り替わる。`www.iwara.tv` は sensitive=false のまま素通しで、
 * 通常の OGP プレビューが出る (既存挙動と同じ)。
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
	return enrichWithIwara(summary, res.$, url);
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const summary = await summarizeRaw(url, opts);
	if (!summary) {
		throw new Error('iwara renderEmbed: parseGeneral returned null');
	}
	const html = composeNsfwEmbedHtml({
		title: summary.title ?? '',
		description: summary.description ?? '',
		thumbnail: summary.thumbnail,
		sitename: summary.sitename ?? 'iwara',
	});
	return { body: html, width: 3, height: 2 };
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
