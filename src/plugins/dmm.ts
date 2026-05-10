import type Summary from '@/summary.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { escapeHtml } from '@/utils/escape-html.js';

export const name = 'dmm';

/**
 * DMM (FANZA) プラグイン (phase15.3 → phase15.5)。
 *
 * `dmm.co.jp` の全サブドメインは年齢認証ゲート (`https://www.dmm.co.jp/age_check/=/?rurl=...`) を
 * `Vary: User-Agent` で挟んでおり、`SummalyBot` / 通常ブラウザ UA で叩くと 302 でゲート HTML
 * (空 OGP) に転送される。**`facebookexternalhit/1.1` UA は allowlist** されておりゲートを素通り
 * して実コンテンツ HTML を返すため、その UA に固定して取得する (skill `/url-preview-check` の
 * Phase 3 fail mode G、`nintendo-store` プラグインと同型の救援)。
 *
 * **phase15.5 — card 抑制 + embed フル表示の二層構造** (オーナー判断 2026-05-10):
 * og:image (作品サムネ) と og:description (作品あらすじ) が直球すぎて Misskey タイムラインの
 * URL preview に流すと露骨という問題があり、card preview は伏せ、embed iframe 側で詳細を表示する
 * 方針に変更。
 *
 * - **card preview** (`summarize`): title = `【sitename】og:title`、description = 固定
 *   `【R-18】 内容を伏せています`、thumbnail = null (作品サムネ非表示、icon はサイト favicon を維持)
 * - **embed** (`renderEmbed`): 制限なし。og:title / og:description / og:image をフル表示
 *   (embed は明示的にユーザーが展開操作しないと描画されない原則を利用)
 *
 * **`skipRedirectResolution = true`**: `summaly()` 冒頭の HEAD probe は `SummalyBot` UA で送られる
 * ため、age_check ゲートに 302 されて URL が `/age_check/=/?rurl=...` に書き換わる。これを防ぐため
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
 * `/embed` 用の player URL を組み立てる。`embedBaseUrl` 未指定なら null。
 * (kakuyomu / syosetu と同型 helper)
 */
function composePlayerUrl(url: URL, embedBaseUrl: string | undefined): string | null {
	if (embedBaseUrl == null || embedBaseUrl === '') return null;
	return `${embedBaseUrl.replace(/\/$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
}

/**
 * `<img src>` に流す URL を `https:` のみに制限する簡易 sanitize。
 * embed HTML 側の CSP `img-src https:` で構造的にも閉じているが、二重防御で `<img>` 自体出さない。
 */
function pickHttpsImage(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	return /^https:/i.test(value) ? value : null;
}

/**
 * `/embed` 用の HTML を組み立てる (pure 関数、テスト容易性のため export)。
 * すべてのユーザー入力 (title / description / sitename / thumbnail) は `escapeHtml` を通す。
 *
 * **CSP 設計**: `default-src 'none'` で外部 fetch / `<script>` / inline event handler を構造的に閉じ、
 * `img-src https:` で画像のみ https: 経由で許可、`style-src 'unsafe-inline'` で本ファイル内の
 * `<style>` のみ許可。escape との二重防御で XSS が成立しない設計。
 */
export function composeEmbedHtml(input: {
	title: string;
	description: string;
	thumbnail: string | null;
	sitename: string;
}): string {
	const titleSafe = escapeHtml(input.title !== '' ? input.title : '(タイトル不明)');
	const descriptionSafe = escapeHtml(input.description);
	const sitenameSafe = escapeHtml(input.sitename);
	const thumbnailSafe = pickHttpsImage(input.thumbnail);

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; padding: 1rem; line-height: 1.5; color: #222; background: #fff; overflow-y: auto; }
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 0.25rem; word-break: break-word; }
.sitename { font-size: 0.8rem; color: #888; margin-bottom: 0.75rem; }
.thumb { margin-bottom: 0.75rem; }
.thumb img { max-width: 100%; height: auto; display: block; border-radius: 4px; }
.description { font-size: 0.9rem; white-space: pre-wrap; word-break: break-word; color: #333; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
<div class="sitename">${sitenameSafe}</div>
${thumbnailSafe != null ? `<div class="thumb"><img src="${escapeHtml(thumbnailSafe)}" alt=""></div>` : ''}
${descriptionSafe !== '' ? `<div class="description">${descriptionSafe}</div>` : ''}
</body>
</html>`;
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

	const sitename = summary.sitename ?? 'DMM';
	const ogTitle = summary.title ?? '';
	// オーナー指示 (phase15.5): 「【サイト名】ページ名」形式で title prefix。作品名は出るが、
	// あらすじ + サムネ抑制 + sensitive: true との併用で NSFW 抑止のバランスを取る。
	// トップ等で og:site_name === og:title の場合 `【FANZA】FANZA動画` のような重複が出るが、
	// 商品ページは og:title が作品名で違いがあるため許容範囲とする (オーナー判断)
	const safeTitle = ogTitle !== '' ? `【${sitename}】${ogTitle}` : `【${sitename}】`;
	const playerUrl = composePlayerUrl(url, opts?._embedBaseUrl);

	return {
		...summary,
		title: safeTitle,
		// 作品あらすじ (og:description) は伏せる。固定文言で「R-18 + 伏せている事実」を伝達
		description: '【R-18】 内容を伏せています',
		// 作品サムネ (og:image) は出さない。icon (= サイト favicon) は parseGeneral 由来で維持
		thumbnail: null,
		// DMM/FANZA 全サブドメインが age_check 経由のため強制 true (phase15.3 から維持)
		sensitive: true,
		// embedBaseUrl が設定されていれば player.url を /embed?url=... で組み立てる
		// (renderEmbed が制限なしの作品情報を表示する経路)。embedBaseUrl 未設定時 (library mode) は
		// `parseGeneral` 由来の oEmbed player を引き継がず明示的に null 化する。NSFW プラグインの
		// 設計意図として「embed 経由でしか作品情報を見せない」ため、外部動画プレイヤー URL が
		// card に流れる経路を閉じる (syosetu / kakuyomu と同型の player 構造)
		player: playerUrl != null
			? { url: playerUrl, width: 3, height: 2, allow: [] }
			: { url: null, width: null, height: null, allow: [] },
	};
}

/**
 * `/embed` エンドポイント用 HTML 生成 (phase15.5)。
 *
 * card preview で抑制した作品情報 (og:title / og:description / og:image) をフル表示する。
 * 同 URL を再度 `scpaping` + `parseGeneral` で取り直す設計 (`summarize` の Summary を引き回さず
 * 各経路独立で動くよう、syosetu / kakuyomu と同パターン)。
 */
export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const res = await scpaping(url.href, {
		...opts,
		userAgent: FB_BOT_UA,
		fallbackUserAgent: undefined,
		fallbackRetryCategories: undefined,
	});
	const summary = await parseGeneral(url, res);
	if (!summary) {
		// renderEmbed は型契約上 null 返却不可なので throw して /embed 側で 500 に変換させる
		throw new Error('dmm renderEmbed: parseGeneral returned null');
	}
	const html = composeEmbedHtml({
		title: summary.title ?? '',
		description: summary.description ?? '',
		thumbnail: summary.thumbnail,
		sitename: summary.sitename ?? 'DMM',
	});
	return { body: html, width: 3, height: 2 };
}
