import * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getJson, scpaping } from '@/utils/got.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';

export const name = 'spotify';

/**
 * `facebookexternalhit` UA で叩くとフル OGP (music:musician_description 含む) が返る
 * (nintendo-store プラグインと同型の SNS bot UA allowlist パターン)。
 */
const FB_BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// og:description の先頭セグメント（"Artist · ..."）がアーティスト名になるのは楽曲・アルバムページのみ。
// music.playlist は "Playlist · ..."、profile はアーティスト自身のページなので対象外。
const ARTIST_BEARING_OG_TYPES = new Set(['music.song', 'music.album']);

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

/**
 * ページ本体 (facebookexternalhit UA 経由) の og:type / og:description からアーティスト名を抽出する。
 * `music:musician_description` (楽曲ページのみ存在) を優先し、無ければ og:description の
 * 先頭セグメント (`Artist · ...`) にフォールバックする。テストから直接呼べるよう export。
 */
export function extractArtist($: cheerio.CheerioAPI): string | null {
	const ogType = $('meta[property="og:type"]').attr('content');
	if (ogType == null || !ARTIST_BEARING_OG_TYPES.has(ogType)) return null;

	const musicianDescription = $('meta[name="music:musician_description"]').attr('content')?.trim();
	if (musicianDescription) return musicianDescription;

	const ogDescription = $('meta[property="og:description"]').attr('content');
	if (!ogDescription) return null;
	const artist = ogDescription.split('·')[0]?.trim();
	return artist || null;
}

/**
 * アーティスト名補完用のページ本体取得。bot block 等で失敗しても呼び出し側は
 * description: null のまま summary を返せるよう、ここで例外を吸収して null を返す。
 */
async function fetchArtist(url: URL, opts?: GeneralScrapingOptions): Promise<string | null> {
	try {
		const { $ } = await scpaping(url.href, {
			...opts,
			userAgent: FB_BOT_UA,
			fallbackUserAgent: undefined,
			fallbackRetryCategories: undefined,
		});
		return extractArtist($);
	} catch {
		return null;
	}
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`;
	// oEmbed にアーティスト情報が無いため、ページ本体への補完リクエストを並行発火してレイテンシを抑える。
	const [oEmbed, artist] = await Promise.all([
		getJson(oEmbedUrl, undefined, opts),
		fetchArtist(url, opts),
	]);

	const summary = buildSummaryFromOEmbed(oEmbed);
	if (summary === null) return null;

	summary.description = artist;
	return summary;
}
