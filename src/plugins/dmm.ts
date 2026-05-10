import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'dmm';

/**
 * DMM (FANZA) プラグイン (phase15.3)。
 *
 * `dmm.co.jp` の全サブドメインは年齢認証ゲート (`https://www.dmm.co.jp/age_check/=/?rurl=...`) を
 * `Vary: User-Agent` で挟んでおり、`SummalyBot` / 通常ブラウザ UA で叩くと 302 でゲート HTML
 * (空 OGP) に転送される。
 *
 * しかし **`facebookexternalhit/1.1` / `Twitterbot/1.0`** 等の SNS bot UA はサイト側が allowlist
 * しており、ゲートを素通りして実コンテンツ HTML (OGP 完備) を返す。`nintendo-store` プラグイン
 * (Akamai Bot Manager の SNS bot allowlist パターン) と完全に同型の救援設計。
 *
 * **sensitive 固定**: DMM/FANZA は全サブドメインが age_check 経由 (一般作品も含む) のため、
 * Misskey 等の preview 表示でも保守的に NSFW 扱いする。
 *
 * **`skipRedirectResolution = true`**: `summaly()` 冒頭の HEAD probe は `SummalyBot` UA で送られる
 * ため、age_check ゲートに 302 されて URL が `/age_check/=/?rurl=...` に書き換わってしまう。
 * これを防ぐため、本プラグインがマッチした時点で resolveRedirect をスキップする。
 *
 * (FANZA / DMM の sitename は `og:site_name` で適切に設定されているため、プラグイン側で固定せず
 * `parseGeneral()` 経由で自動分岐させる。)
 */
const FB_BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export const skipRedirectResolution = true;

export function test(url: URL): boolean {
	// `URL.hostname` は WHATWG URL 仕様で常に小文字化されるため toLowerCase() は不要
	const host = url.hostname;
	const isDmmHost = host === 'dmm.co.jp' || host.endsWith('.dmm.co.jp');
	if (!isDmmHost) return false;
	// age_check ゲート URL が summaly に渡された場合、空 OGP の gate HTML を scrape しても
	// 意味がないため弾く (`general()` フォールバックも空 OGP しか得られないが、本プラグインで
	// 強引に scrape するよりは外側で判断させる)。startsWith で将来パスバリエーションも包括除外
	if (url.pathname.startsWith('/age_check')) return false;
	return true;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, {
		...opts,
		userAgent: FB_BOT_UA,
		fallbackUserAgent: undefined,
		fallbackRetryCategories: undefined,
	});
	const summary = await parseGeneral(url, res);
	if (!summary) return null;
	// DMM は一般作品も含めて全サブドメインが age_check 経由のため、`parseGeneral` の sensitive
	// 判定 (`og:adult` / `og:content_rating` 等) に関わらず保守的に強制 true で上書きする
	return { ...summary, sensitive: true };
}
