import type Summary from '@/summary.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping, getJson } from '@/utils/got.js';
import { applyNsfwCardSuppression } from '@/utils/nsfw-card-suppress.js';
import { composeNsfwEmbedHtml } from '@/utils/nsfw-embed-html.js';

export const name = 'komiflo';

const COMICS_PATH_PATTERN = /^\/comics\/(\d+)/;
// thumbnail がデフォルト画像 (favicon / ogp_logo) にフォールバックしているかの判定
const FALLBACK_THUMBNAIL_PATTERN = /favicon|ogp_logo/i;
// 採用する variant 名。komiflo 側の API 仕様変更があるとここが陳腐化する。
// 現状は 346_mobile が「カバー画像のモバイル幅」として安定している。
const PREFERRED_VARIANT = '346_mobile';

export function test(url: URL): boolean {
	return url.hostname === 'komiflo.com';
}

/**
 * **NSFW 二層構造** (phase15.6): `/comics/<id>` で API 取得成功時 sensitive=true となり、
 * `applyNsfwCardSuppression` が card preview を抑制 + embed iframe (`renderEmbed`) で
 * フル表示する経路に切り替わる。それ以外の経路は通常の OGP プレビューが出る。
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

	const match = COMICS_PATH_PATTERN.exec(url.pathname);
	if (match == null) return summary;

	// API を叩く条件: thumbnail が null（OG 画像なし）または デフォルト画像 (favicon/ogp_logo) フォールバック。
	// 通常の OG 画像が取れているなら API を叩かない（コスト削減）。
	const needsApi = summary.thumbnail == null || FALLBACK_THUMBNAIL_PATTERN.test(summary.thumbnail);
	if (!needsApi) return summary;

	const id = match[1];
	const apiUrl = `https://api.komiflo.com/content/id/${id}`;
	try {
		const apiRes = await getJson(apiUrl, url.href, opts) as Record<string, unknown> | null;
		const filename = extractCoverFilename(apiRes);
		if (filename != null) {
			summary.thumbnail = `https://t.komiflo.com/${PREFERRED_VARIANT}/${filename}`;
			summary.sensitive = true;
		}
	} catch {
		// API 失敗時は parseGeneral のフォールバック thumbnail のまま返す（黙って fallback）
	}

	return summary;
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	// API 失敗時は summarizeRaw が sensitive=undefined の summary を返す。その場合 embed は
	// カバー画像なしの通常 OGP フル表示になる (= 機能縮退、実害なし、catch {} の意図と整合)
	const summary = await summarizeRaw(url, opts);
	if (!summary) {
		throw new Error('komiflo renderEmbed: parseGeneral returned null');
	}
	const html = composeNsfwEmbedHtml({
		title: summary.title ?? '',
		description: summary.description ?? '',
		thumbnail: summary.thumbnail,
		sitename: summary.sitename ?? 'komiflo',
	});
	return { body: html, width: 3, height: 2 };
}

/**
 * komiflo API レスポンスから cover の filename を抽出する。
 * テストから直接呼べるよう export。
 *
 * 仕様: `named_imgs.cover.variants` に `PREFERRED_VARIANT` が含まれる場合のみ
 * `filename` を返し、それ以外は null。
 */
export function extractCoverFilename(api: unknown): string | null {
	if (typeof api !== 'object' || api === null) return null;
	const a = api as Record<string, unknown>;
	const namedImgs = a.named_imgs;
	if (typeof namedImgs !== 'object' || namedImgs === null) return null;
	const cover = (namedImgs as Record<string, unknown>).cover;
	if (typeof cover !== 'object' || cover === null) return null;
	const c = cover as Record<string, unknown>;
	if (!Array.isArray(c.variants)) return null;
	if (!c.variants.includes(PREFERRED_VARIANT)) return null;
	if (typeof c.filename !== 'string' || c.filename.length === 0) return null;
	return c.filename;
}
