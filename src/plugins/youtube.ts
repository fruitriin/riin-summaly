import * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getJson } from '@/utils/got.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';

export const name = 'youtube';

// 裸ドメイン（`youtube.com`）も許容する。`(www\.|m\.)?` の `?` で空マッチも通すため。
const HOST_PATTERNS = /^(www\.|m\.)?youtube\.com$/;
// YouTube の path 形式:
// - `/watch?v=<id>` (標準動画)
// - `/v/<id>` (古い埋め込み URL)
// - `/playlist` (再生リスト)
// - `/shorts/<id>` (Shorts)
// - `/live/<id>` (ライブ配信。oEmbed エンドポイントが正しく動画情報を返す)
const PATH_PATTERNS = /^\/(watch|v|playlist|shorts|live)(\/|$)/;

export function test(url: URL): boolean {
	if (url.hostname === 'youtu.be') return true;
	if (HOST_PATTERNS.test(url.hostname)) {
		return PATH_PATTERNS.test(url.pathname);
	}
	return false;
}

/**
 * oEmbed JSON から Summary を組み立てる。テストから直接呼べるよう export。
 */
export function buildSummaryFromOEmbed(oEmbed: unknown): Summary | null {
	if (typeof oEmbed !== 'object' || oEmbed === null) return null;
	const o = oEmbed as Record<string, unknown>;
	if (o.type !== 'video' || typeof o.html !== 'string') return null;

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

	return {
		title,
		icon: 'https://www.youtube.com/favicon.ico',
		description: null,
		thumbnail,
		player: {
			url: playerUrlRaw,
			width: Number.isFinite(width) ? width : null,
			height: Number.isFinite(height) ? height : null,
			allow: [...PLAYER_ALLOW_OEMBED],
		},
		sitename: 'YouTube',
		activityPub: null,
		fediverseCreator: null,
	};
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}`;
	const oEmbed = await getJson(oEmbedUrl, undefined, opts);
	return buildSummaryFromOEmbed(oEmbed);
}
