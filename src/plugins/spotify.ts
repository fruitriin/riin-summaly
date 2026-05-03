import * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getJson } from '@/utils/got.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';

export const name = 'spotify';

export function test(url: URL): boolean {
	return url.hostname === 'open.spotify.com';
}

/**
 * oEmbed JSON から Summary を組み立てる。テストから直接呼べるよう export。
 */
export function buildSummaryFromOEmbed(oEmbed: unknown): Summary | null {
	if (typeof oEmbed !== 'object' || oEmbed === null) return null;
	const o = oEmbed as Record<string, unknown>;
	if (typeof o.html !== 'string') return null;

	const $ = cheerio.load(o.html);
	const iframe = $('iframe');
	if (iframe.length !== 1) return null;
	const playerUrlRaw = iframe.attr('src');
	if (typeof playerUrlRaw !== 'string') return null;
	try {
		if (new URL(playerUrlRaw).protocol !== 'https:') return null;
	} catch {
		return null;
	}

	const widthAttr = iframe.attr('width');
	const heightAttr = iframe.attr('height');
	const width = Number(widthAttr ?? o.width);
	const height = Number(heightAttr ?? o.height);

	const thumbnail = typeof o.thumbnail_url === 'string' ? o.thumbnail_url : null;
	const title = typeof o.title === 'string' ? o.title : null;
	const sitename = typeof o.provider_name === 'string' ? o.provider_name : 'Spotify';

	return {
		title,
		icon: 'https://open.spotify.com/favicon.ico',
		description: null,
		thumbnail,
		player: {
			url: playerUrlRaw,
			width: Number.isFinite(width) ? width : null,
			height: Number.isFinite(height) ? height : null,
			allow: [...PLAYER_ALLOW_OEMBED],
		},
		sitename,
		activityPub: null,
		fediverseCreator: null,
	};
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`;
	const oEmbed = await getJson(oEmbedUrl, undefined, opts);
	return buildSummaryFromOEmbed(oEmbed);
}
