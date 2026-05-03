import type Summary from '@/summary.js';
import { general, type GeneralScrapingOptions } from '@/general.js';
import { StatusError } from '@/utils/status-error.js';

export const name = 'dlsite';

const SAFE_PATH_PATTERN = /^\/(home|comic|soft|app|ai)\//;

export function test(url: URL): boolean {
	return url.hostname === 'www.dlsite.com';
}

/**
 * dlsite は `/announce/` (販売前ページ) と `/work/` (販売中ページ) で同じ作品を扱う。
 * 一方で 404 が返ったら他方を試すと取得できることがある。
 *
 * 無限ループ防止のため、すでに alternate を試した場合は再試行しない。
 */
export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const result = await tryFetch(url, opts, false);
	if (result == null) return null;

	// 結果 URL のパスが「セーフカテゴリ (home/comic/soft/app/ai)」のどれにも該当しないなら sensitive
	if (!SAFE_PATH_PATTERN.test(result.usedUrl.pathname)) {
		result.summary.sensitive = true;
	}
	return result.summary;
}

async function tryFetch(
	url: URL,
	opts: GeneralScrapingOptions | undefined,
	alreadySwapped: boolean,
): Promise<{ summary: Summary; usedUrl: URL } | null> {
	try {
		const summary = await general(url, opts);
		if (summary == null) return null;
		return { summary, usedUrl: url };
	} catch (e) {
		if (alreadySwapped) throw e;
		if (!(e instanceof StatusError) || e.statusCode !== 404) throw e;

		const swapped = swapAnnounceWork(url);
		if (swapped == null) throw e;

		return tryFetch(swapped, opts, true);
	}
}

function swapAnnounceWork(url: URL): URL | null {
	if (url.pathname.includes('/announce/')) {
		const next = new URL(url.href);
		next.pathname = url.pathname.replace('/announce/', '/work/');
		return next;
	}
	if (url.pathname.includes('/work/')) {
		const next = new URL(url.href);
		next.pathname = url.pathname.replace('/work/', '/announce/');
		return next;
	}
	return null;
}
