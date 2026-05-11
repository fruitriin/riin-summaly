import type Summary from '@/summary.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { applyNsfwCardSuppression } from '@/utils/nsfw-card-suppress.js';
import { composeNsfwEmbedHtml } from '@/utils/nsfw-embed-html.js';

export const name = 'dmm';

/**
 * DMM (FANZA) プラグイン (phase15.3 → phase15.5 → phase15.6)。
 *
 * `dmm.co.jp` の全サブドメインは年齢認証ゲート (`https://www.dmm.co.jp/age_check/=/?rurl=...`) を
 * `Vary: User-Agent` で挟んでおり、`SummalyBot` / 通常ブラウザ UA で叩くと 302 でゲート HTML
 * (空 OGP) に転送される。**`facebookexternalhit/1.1` UA は allowlist** されておりゲートを素通り
 * して実コンテンツ HTML を返すため、その UA に固定して取得する (skill `/url-preview-check` の
 * Phase 3 fail mode G、`nintendo-store` プラグインと同型の救援)。
 *
 * **card 抑制 + embed フル表示の二層構造** (phase15.5 で確立 → phase15.6 で共通 helper に集約):
 * og:image (作品サムネ) と og:description (作品あらすじ) が直球すぎる NSFW プラグインで採用する
 * 共通パターン。`summary.sensitive === true` のとき card を抑制し、embed iframe 側で詳細を表示する
 * (詳細は `docs/knowhow/age-gate-bypass-pattern.md` の「NSFW 系プラグインの二層構造」セクション)。
 * 本プラグインは DMM/FANZA 全サブドメインが age_check 経由のため常に `sensitive: true` を強制する。
 *
 * **`skipRedirectResolution = true`**: `summaly()` 冒頭の HEAD probe は `SummalyBot` UA で送られる
 * ため age_check ゲートに 302 されて URL が `/age_check/=/?rurl=...` に書き換わる。これを防ぐため
 * resolveRedirect をスキップする (詳細は `docs/knowhow/age-gate-bypass-pattern.md` 対策 1)。
 */
const FB_BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export const skipRedirectResolution = true;

export function test(url: URL): boolean {
	// `URL.hostname` は WHATWG URL 仕様で常に小文字化されるため toLowerCase() は不要
	const host = url.hostname;
	const isDmmHost = host === 'dmm.co.jp' || host.endsWith('.dmm.co.jp');
	if (!isDmmHost) return false;
	// age_check ゲート URL が summaly に渡された場合、空 OGP の gate HTML を scrape しても
	// 意味がないため弾く。startsWith で将来パスバリエーションも包括除外
	if (url.pathname.startsWith('/age_check')) return false;
	return true;
}

/**
 * 抑制前の生 summary を取得する pure な内部ヘルパー (phase15.6)。
 * `summarize` (card 抑制版) と `renderEmbed` (フル表示版) から共有される。
 */
async function summarizeRaw(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, {
		...opts,
		userAgent: FB_BOT_UA,
		fallbackUserAgent: undefined,
		fallbackRetryCategories: undefined,
	});
	const summary = await parseGeneral(url, res);
	if (!summary) return null;
	// DMM/FANZA 全サブドメインが age_check 経由のため強制 true (= applyNsfwCardSuppression の対象に乗る)
	return { ...summary, sensitive: true };
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const summary = await summarizeRaw(url, opts);
	if (!summary) return null;
	return applyNsfwCardSuppression(summary, url, opts?._embedBaseUrl);
}

/**
 * `/embed` エンドポイント用 HTML 生成 (phase15.5)。
 *
 * card preview で抑制した作品情報 (og:title / og:description / og:image) をフル表示する。
 * 同 URL を再度 `scpaping` + `parseGeneral` で取り直す設計 (`summarize` の Summary を引き回さず
 * 各経路独立で動くよう、syosetu / kakuyomu と同パターン)。
 */
export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const summary = await summarizeRaw(url, opts);
	if (!summary) {
		// renderEmbed は型契約上 null 返却不可なので throw して /embed 側で 500 に変換させる
		throw new Error('dmm renderEmbed: parseGeneral returned null');
	}
	const html = composeNsfwEmbedHtml({
		title: summary.title ?? '',
		description: summary.description ?? '',
		thumbnail: summary.thumbnail,
		sitename: summary.sitename ?? 'DMM',
	});
	return { body: html, width: 3, height: 2 };
}
