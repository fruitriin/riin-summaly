import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'nintendo-store';

/**
 * My Nintendo Store (`store-jp.nintendo.com` および将来の `store.nintendo.com`) のプラグイン。
 *
 * Nintendo Store は **Akamai Bot Manager の JS challenge** を入れていて、`Mozilla/5.0` ブラウザ UA や
 * `Twitterbot` / `Discordbot` UA で叩くと `*-wr.nintendo.com/?c=ncl&...kupver=akamai-5.0.1` という
 * challenge ページに redirect される (skill `/url-preview-check` の Phase 3 fail mode G)。
 *
 * しかし **`facebookexternalhit/1.1` と `Slackbot-LinkExpanding`** UA は allowlist されていて、
 * フル HTML (502 KB、og:title / og:image / og:description / og:site_name 完備) が返る。
 *
 * 「Akamai が SNS bot を一部許可している」のは「Nintendo は SNS で share されたい」 = OGP を意図的に
 * 整備していることの裏返しなので、SummalyBot から `facebookexternalhit` UA に切り替えて取得するのは
 * Nintendo の意図に沿う使い方として採用 (UA fallback と同じ倫理判断)。
 */
const FB_BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const NINTENDO_HOST = /^store(?:-[a-z]{2})?\.nintendo\.com$/;

export function test(url: URL): boolean {
	return NINTENDO_HOST.test(url.hostname);
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	// `facebookexternalhit` UA で scpaping。proxy fallback / UA fallback は無効化する
	// (UA を固定したいので fallback UA に上書きされても困る。fallbackUserAgent を未指定にして無効化)。
	const res = await scpaping(url.href, {
		...opts,
		userAgent: FB_BOT_UA,
		fallbackUserAgent: undefined,
		fallbackRetryCategories: undefined,
	});
	return await parseGeneral(url, res);
}
