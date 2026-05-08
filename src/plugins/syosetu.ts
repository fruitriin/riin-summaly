/**
 * 小説家になろう プラグイン (phase13.1 Step 3)。
 *
 * `https://ncode.syosetu.com/n7587fe/2/` 等の URL に対し、なろう小説 API
 * (`api.syosetu.com/{novelapi|novel18api}/api/`) を直叩きして作品メタを取得し、
 * Misskey カードスタイル用の `Summary` (description / thumbnail / player.url) と、
 * `/embed?url=...` 経由で iframe に表示する完全な HTML (`renderEmbed`) を組み立てる。
 *
 * 設計詳細: docs/plans/phase13.1-syosetu-embed.md
 *
 * **R-18 ドメイン**: `novel18.syosetu.com` (ノクターン / ムーンライト等) は `sensitive: true` を返し、
 * sitename を切り替える。API も `/novel18api/` に切り替える。
 *
 * **chapter URL の扱い**: `/<ncode>/2/` のような個別エピソード URL でも作品レベルの ncode で集約。
 * chapter 単位の本文取得は API に存在しないため作品見出しと同じ Summary を返す (Plan で割り切り済み)。
 *
 * **HTML エスケープ契約**: `renderEmbed` が返す `body` 内のすべてのユーザー入力 (title / writer /
 * story / keyword 等) は `escapeHtml` を通すこと。Fastify 側はエスケープしない (`/embed` ルートで
 * `<script>` sanity check は走るが、本プラグインが正しくエスケープしていれば trigger しない)。
 */

import type Summary from '@/summary.js';
import type { CheerioAPI } from 'cheerio';
import type { EmbedRenderResult } from '@/iplugin.js';
import { general, type GeneralScrapingOptions } from '@/general.js';
import { getJson, scpaping } from '@/utils/got.js';
import { clip } from '@/utils/clip.js';
import { escapeHtml } from '@/utils/escape-html.js';
import { getBigGenreName, getGenreName } from '@/utils/syosetu-genres.js';

export const name = 'syosetu';

const NCODE_HOST_REGULAR = /^ncode\.syosetu\.com$/;
const NCODE_HOST_R18 = /^novel18\.syosetu\.com$/;
// **ncode 形式の精度** (W-1 review feedback): 公式仕様によると ncode は `n` + 数字 + 英字混在で
// 最短 7 文字程度 (例: `n7587fe`、`n9999zz`)。`/novelview/` `/ncode/` `/novels/` 等の他パスを
// 誤マッチさせないため `n + 数字 1+ + 英字 1+` を最低条件にする (純英字列の他パスを構造的に除外)。
// `/i` フラグは大文字 URL (`/N7587FE/`) も受け入れるため、抽出後の `extractNcodeAndR18` で
// `.toLowerCase()` 正規化が必要 (S-4 review feedback)。
//
// **chapter 番号の抽出**: `/<ncode>/<num>/` 形式の各話 URL では、第 2 グループに chapter 番号が入る。
// 第 1 alt (`\/(\d+)\/?`) が優先で、純数字以外のサブパス (`/novelview/` 等) は第 2 alt (`\/.*`) で
// 受けて chapter=undefined になる。
const NCODE_PATH = /^\/(n\d+[a-z][0-9a-z]*)(?:\/(\d+)\/?|\/.*)?$/i;

const SITE_LOGO = 'https://syosetu.com/img/syosetu_logo.png';
const SITE_FAVICON = 'https://syosetu.com/favicon.ico';

const SITENAME_REGULAR = '小説家になろう';
const SITENAME_R18 = 'ノクターンノベルズ / ムーンライトノベルズ';

const STORY_CARD_CLIP_LENGTH = 80; // card style description のあらすじ抜粋長
const STORY_EMBED_CLIP_LENGTH = 300; // embed のあらすじ表示長

export function test(url: URL): boolean {
	if (!NCODE_HOST_REGULAR.test(url.hostname) && !NCODE_HOST_R18.test(url.hostname)) return false;
	return NCODE_PATH.test(url.pathname);
}

/**
 * URL から `{ ncode, isR18, chapter }` を抽出する。
 * `test()` を通った前提だが防衛的に null チェックする。
 *
 * **大文字対応 (S-4 review feedback)**: NCODE_PATH 正規表現は `/i` フラグで大文字 URL
 * (`/N7587FE/`) もマッチさせるが、なろう ncode の正規形は小文字なので抽出後に `.toLowerCase()`
 * で正規化する。これによりキャッシュキーや API 呼出が大文字小文字違いで重複しない。
 *
 * **chapter**: `/<ncode>/<num>/` 形式の各話 URL のとき chapter 番号 (string)、それ以外 (作品トップ
 * URL や `/<ncode>/<非数字>/` 等のサブパス) では null。chapter URL では `summarize()` 側で
 * description を「各話タイトル」に上書きする分岐に使う。
 */
export function extractNcodeAndR18(url: URL): { ncode: string; isR18: boolean; chapter: string | null } | null {
	const isR18 = NCODE_HOST_R18.test(url.hostname);
	const m = NCODE_PATH.exec(url.pathname);
	if (m === null) return null;
	// 第 2 alt (`\/.*`) で受けたとき m[2] は undefined。RegExp 仕様上「unmatched optional group」は
	// undefined だが TS は strict noUncheckedIndexedAccess なしでは string 型に推論するため `?? null`
	// で正規化する (実際は undefined を null に置換)。
	const chapter = (m[2] as string | undefined) ?? null;
	return { ncode: m[1].toLowerCase(), isR18, chapter };
}

/**
 * なろう API のレスポンスから本実装が必要とするフィールドだけ抜き出した型。
 * 不要フィールド (`of` で絞っているとはいえレスポンスには `userid` 等の他フィールドが残る場合がある)
 * は型レベルで触らないことで、API 仕様変更耐性を高める。
 */
export interface SyosetuNovelData {
	title?: unknown;
	writer?: unknown;
	story?: unknown;
	biggenre?: unknown;
	genre?: unknown;
	novel_type?: unknown; // 1=連載, 2=短編
	end?: unknown; // 0=連載中, 1=完結
	isr15?: unknown; // 0/1 R-15
	iszankoku?: unknown; // 0/1 残酷描写あり
	isbl?: unknown; // 0/1 BL
	isgl?: unknown; // 0/1 GL
	keyword?: unknown; // 半角スペース区切り
}

/**
 * API レスポンスのトップレベル形式: `[{ allcount: N }, novelData?, ...]`。
 * `allcount === 0` の場合は novelData が無い。
 */
function parseNovelApiResponse(body: unknown): SyosetuNovelData | null {
	if (!Array.isArray(body) || body.length === 0) return null;
	// `body[0]` が null の場合 `typeof null === 'object'` で通過するが、`head == null` チェックを
	// 先頭に置いているため null は早期 return。以降は object 型で安全に narrowing できる
	// (S-1 review feedback: null を含めて defensive チェック済)。
	const head = body[0] as Record<string, unknown> | undefined;
	if (head == null || typeof head !== 'object' || head.allcount !== 1) return null;
	const data = body[1] as SyosetuNovelData | undefined;
	if (data == null || typeof data !== 'object') return null;
	return data;
}

/** API URL を組み立てる */
export function buildApiUrl(ncode: string, isR18: boolean): string {
	const base = isR18 ? 'novel18api' : 'novelapi';
	const fields = 't-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k';
	return `https://api.syosetu.com/${base}/api/?ncode=${encodeURIComponent(ncode)}&out=json&of=${fields}`;
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** マーカー (R-15 / 残酷描写 / BL / GL) を `[R-15] [残酷描写] ...` の形でまとめる */
function composeMarkers(novel: SyosetuNovelData): string {
	const markers: string[] = [];
	if (asNumber(novel.isr15) === 1) markers.push('R-15');
	if (asNumber(novel.iszankoku) === 1) markers.push('残酷描写');
	if (asNumber(novel.isbl) === 1) markers.push('BL');
	if (asNumber(novel.isgl) === 1) markers.push('GL');
	return markers.length > 0 ? markers.map(m => `[${m}]`).join(' ') : '';
}

/**
 * card style 用の description を組み立てる (Misskey の 1 行 description に詰める)。
 * 例: `作者: 山田太郎 / ハイファンタジー〔ファンタジー〕 / 連載中 [R-15] / あらすじ: 異世界に転生した主人公が…`
 */
export function composeDescription(novel: SyosetuNovelData): string {
	const writer = asString(novel.writer);
	const genreId = asNumber(novel.genre);
	const novelType = asNumber(novel.novel_type);
	const end = asNumber(novel.end);

	const parts: string[] = [];
	if (writer != null) parts.push(`作者: ${writer}`);
	if (genreId != null) parts.push(getGenreName(genreId));
	if (novelType === 2) {
		parts.push('短編');
	} else if (novelType === 1) {
		parts.push(end === 1 ? '完結' : '連載中');
	}
	const markers = composeMarkers(novel);
	if (markers !== '') parts.push(markers);

	const story = asString(novel.story);
	if (story != null) {
		parts.push(`あらすじ: ${clip(story, STORY_CARD_CLIP_LENGTH)}`);
	}

	return parts.join(' / ');
}

/**
 * `/embed` 用の player URL を組み立てる。`embedBaseUrl` が未指定なら null を返す
 * (= player 無効化、card style だけになる)。
 */
function composePlayerUrl(url: URL, embedBaseUrl: string | undefined): string | null {
	if (embedBaseUrl == null || embedBaseUrl === '') return null;
	return `${embedBaseUrl.replace(/\/$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
}

/** keyword (半角スペース区切り) を上位 5 件のカンマ区切りに整形 */
function formatKeywords(raw: string): string {
	const items = raw.split(/\s+/).filter(s => s !== '').slice(0, 5);
	return items.join(', ');
}

/**
 * `/embed` 用の HTML を組み立てる。すべてのユーザー入力は `escapeHtml` を通す。
 * テンプレートライブラリは使わず文字列連結 (依存追加を避ける)。
 *
 * **設計**: `<style>` ブロックを 1 つ書いて CSS で見出し / メタ / あらすじを構造化。
 * `display: grid` は使わず flex / 通常フローで PC / モバイル両対応 (古いブラウザ耐性)。
 * `iframe` 内で `overflow-y: auto` を効かせて長いあらすじをスクロールさせる。
 */
export function composeEmbedHtml(novel: SyosetuNovelData, isR18: boolean): string {
	const titleSafe = escapeHtml(asString(novel.title) ?? '(タイトル不明)');
	const writerSafe = escapeHtml(asString(novel.writer) ?? '(作者不明)');
	const bigGenreId = asNumber(novel.biggenre);
	const genreId = asNumber(novel.genre);
	const genreText = genreId != null
		? `${getGenreName(genreId)}`
		: (bigGenreId != null ? getBigGenreName(bigGenreId) : '');
	const genreSafe = escapeHtml(genreText);
	const novelType = asNumber(novel.novel_type);
	const end = asNumber(novel.end);
	const statusText = novelType === 2 ? '短編' : (end === 1 ? '完結' : '連載中');
	const statusSafe = escapeHtml(statusText);
	const markersSafe = escapeHtml(composeMarkers(novel));
	const sitenameSafe = escapeHtml(isR18 ? SITENAME_R18 : SITENAME_REGULAR);
	const keywordRaw = asString(novel.keyword) ?? '';
	const keywordsSafe = escapeHtml(formatKeywords(keywordRaw));
	const storyRaw = asString(novel.story) ?? '';
	const storySafe = escapeHtml(clip(storyRaw, STORY_EMBED_CLIP_LENGTH));

	// CSS は <style> ブロック 1 つに集約 (CSP `style-src 'unsafe-inline'` の許容範囲)。
	// `white-space: pre-wrap` であらすじの改行を保持。
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; padding: 1rem; line-height: 1.5; color: #222; background: #fff; overflow-y: auto; }
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 0.5rem; word-break: break-word; }
.meta { font-size: 0.85rem; color: #555; margin-bottom: 0.25rem; }
.markers { font-size: 0.8rem; color: #b22; margin-bottom: 0.5rem; }
.keywords { font-size: 0.8rem; color: #888; margin-bottom: 0.75rem; word-break: break-word; }
.story-label { font-size: 0.85rem; font-weight: bold; color: #444; margin-bottom: 0.25rem; }
.story { font-size: 0.85rem; white-space: pre-wrap; word-break: break-word; color: #333; }
.sitename { font-size: 0.75rem; color: #888; margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px solid #eee; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
<div class="meta">作者: ${writerSafe}</div>
<div class="meta">ジャンル: ${genreSafe} / ${statusSafe}</div>
${markersSafe !== '' ? `<div class="markers">${markersSafe}</div>` : ''}
${keywordsSafe !== '' ? `<div class="keywords">タグ: ${keywordsSafe}</div>` : ''}
<div class="story-label">あらすじ</div>
<div class="story">${storySafe}</div>
<div class="sitename">${sitenameSafe}</div>
</body>
</html>`;
}

/**
 * API call 結果から `Summary` を組み立てる (テスト容易性のため pure 化、export)。
 */
export function buildSummaryFromApi(
	novel: SyosetuNovelData,
	url: URL,
	isR18: boolean,
	embedBaseUrl: string | undefined,
): Summary {
	const title = asString(novel.title) ?? '(タイトル不明)';
	const description = composeDescription(novel);
	const playerUrl = composePlayerUrl(url, embedBaseUrl);
	return {
		title,
		icon: SITE_FAVICON,
		description,
		thumbnail: SITE_LOGO,
		player: playerUrl != null
			? {
				url: playerUrl,
				// Misskey は `padding: height/width * 100%` でアスペクト比計算するため
				// 絶対値ではなく **比率** として効く。3:2 を宣言 (横長カード形)
				width: 3,
				height: 2,
				allow: [],
			}
			: { url: null, width: null, height: null, allow: [] },
		sitename: isR18 ? SITENAME_R18 : SITENAME_REGULAR,
		sensitive: isR18,
		activityPub: null,
		fediverseCreator: null,
	};
}

/**
 * なろう作品トップページの HTML から `SyosetuNovelData` 相当を抽出する (export してテスト容易化)。
 *
 * 取れるフィールド: `title` / `writer` / `story` / `isr15` / `iszankoku` / `isbl` / `isgl` / `keyword`。
 * 取れないフィールド (HTML には明示されていない): `biggenre` / `genre` / `novel_type` / `end`。
 * `composeDescription` / `composeMarkers` は asString/asNumber が undefined を null として扱うため、
 * 取れないフィールドは undefined のままで動作する。
 *
 * 構造依存: なろうの HTML 構造 (`p-novel__title` / `p-novel__author` / `#novel_ex` 等) が変わると壊れる。
 * 各セレクタは fallback テキストマッチを併用して可能な限りメンテ耐性を高めている。
 */
export function extractNovelDataFromHtml($: CheerioAPI): SyosetuNovelData | null {
	const title = $('h1.p-novel__title').first().text().trim()
		|| $('meta[property="og:title"]').attr('content')?.trim()
		|| undefined;

	// 作者: `<div class="p-novel__author">作者：<a>writer</a></div>` 構造
	// <a> がある場合は優先、なければテキスト全体から「作者：」prefix を除いた内容
	let writer = $('.p-novel__author a').first().text().trim() || undefined;
	if (writer == null) {
		const authorText = $('.p-novel__author').first().text().trim();
		const stripped = authorText.replace(/^作者[:：]\s*/, '').trim();
		if (stripped !== '') writer = stripped;
	}

	// あらすじ: `<div id="novel_ex" class="p-novel__summary">...<br />...</div>`
	const story = $('#novel_ex').first().text().trim() || undefined;

	if (title == null && writer == null) return null;

	// マーカー検出: ページ本文の「〔残酷描写〕が含まれています」等のテキストパターン。
	// なろうは作品トップに `この作品には〔残酷描写〕が含まれています` を表示している。
	const bodyText = $('body').text();
	const isr15 = /〔R-?15〕/.test(bodyText) ? 1 : 0;
	const iszankoku = /〔残酷描写〕/.test(bodyText) ? 1 : 0;
	const isbl = /〔ボーイズラブ〕/.test(bodyText) ? 1 : 0;
	const isgl = /〔ガールズラブ〕/.test(bodyText) ? 1 : 0;

	// keyword: og:description にキーワードがスペース区切りで詰め込まれている形式
	// (例: "残酷な描写あり 異世界転生 異世界転移 オリジナル戦記 ラブコメ 魔王 ..."。
	// 先頭の `残酷な描写あり` / `R15` / `ボーイズラブ` 等のマーカー prefix は API の keyword フィールドには
	// 含まれないため除外する。
	const ogDescription = $('meta[property="og:description"]').attr('content') ?? '';
	const keyword = ogDescription
		.replace(/^(?:残酷な描写あり|R-?15|R-?18|ボーイズラブ|ガールズラブ)(?:\s+(?:残酷な描写あり|R-?15|R-?18|ボーイズラブ|ガールズラブ))*\s*/, '')
		.trim() || undefined;

	return {
		title,
		writer,
		story,
		// HTML から取れないフィールドは undefined (composeDescription 側で null として扱われる)
		biggenre: undefined,
		genre: undefined,
		novel_type: undefined,
		end: undefined,
		isr15, iszankoku, isbl, isgl,
		keyword,
	};
}

/**
 * なろう作品トップページの HTML から `SyosetuNovelData` を取得する。
 * `Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (phase13.1 の API 直叩き精神を維持)。
 *
 * 戻り値:
 * - 構造化データが取れた → SyosetuNovelData (一部フィールド undefined 許容)
 * - 取れなかった (削除済 / 構造変更で壊れた) → null
 */
async function fetchNovelFromHtml(url: URL, opts?: GeneralScrapingOptions): Promise<SyosetuNovelData | null> {
	const res = await scpaping(url.href, { ...opts, userAgent: 'Twitterbot/1.0' });
	return extractNovelDataFromHtml(res.$);
}

/**
 * chapter URL (`/<ncode>/<num>/`) のページから「各話タイトル」を抽出する。
 *
 * - 1st choice: `<h1 class="p-novel__title">` (chapter ページではここが各話タイトル)。
 *   `p-novel__title--rensai` 修飾が付くがクラスセレクタは含む方向で動く。
 * - 2nd choice: `og:title` は `"WorkTitle - ChapterTitle"` 結合形式。最初の ` - ` で split する
 *   (作品タイトルに ` - ` が含まれる場合は誤抽出するが、h1 が取れている前提で fallback としてのみ使用)。
 *
 * 戻り値: 各話タイトル / 取得失敗時 null。
 */
export async function fetchChapterTitle(url: URL, opts?: GeneralScrapingOptions): Promise<string | null> {
	const res = await scpaping(url.href, { ...opts, userAgent: 'Twitterbot/1.0' });
	const fromH1 = res.$('h1.p-novel__title').first().text().trim();
	if (fromH1 !== '') return fromH1;
	const ogTitle = res.$('meta[property="og:title"]').attr('content')?.trim() ?? '';
	const sepIdx = ogTitle.indexOf(' - ');
	if (sepIdx >= 0) {
		const right = ogTitle.slice(sepIdx + 3).trim();
		return right !== '' ? right : null;
	}
	return null;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const extracted = extractNcodeAndR18(url);
	if (extracted === null) return null;
	const apiUrl = buildApiUrl(extracted.ncode, extracted.isR18);

	// **chapter URL では API + chapter HTML を並列取得** して 1 round-trip 分節約する。
	// chapter 番号が無い (= 作品トップ URL) ときは chapterTitle は null のままで従来通り。
	const [body, chapterTitle] = await Promise.all([
		getJson(apiUrl, undefined, opts),
		extracted.chapter != null
			? fetchChapterTitle(url, opts).catch(() => null)
			: Promise.resolve(null),
	]);

	const novel = parseNovelApiResponse(body);
	// `_embedBaseUrl` は `summaly()` が `SummalyOptions.embedBaseUrl` を transparent 伝搬する
	// internal フィールド (`GeneralScrapingOptions` の JSDoc 参照、phase13.1 Step 3 → 2026-05-08 補正)。
	// 設定されていれば `Summary.player.url` を `<base>/embed?url=...` で組み立てる。
	const embedBaseUrl = opts?._embedBaseUrl;
	let summary: Summary;
	if (novel !== null) {
		summary = buildSummaryFromApi(novel, url, extracted.isR18, embedBaseUrl);
	} else {
		// allcount=0 = なろう公式 API の index に載っていない。古い作品 / API インデックス漏れ等で
		// HTML ページは正常に存在し OGP も完備しているケースがある (本番ログで `n3862be` 等で観測)。
		//
		// **HTML 専用 scrape にフォールバック**: chapter URL の場合は chapter ページの HTML だと
		// h1 が「各話タイトル」になってしまい作品メタが取れないため、作品トップ URL に切り替えて
		// fetch する。chapter なしの場合は url そのまま (=作品トップ)。
		// 最終 fallback として `general()` で OGP scrape する。renderEmbed (/embed) は API データに
		// 完全依存するため allcount=0 では throw のまま。
		const fallbackUrl = extracted.chapter != null
			? new URL(`https://${url.hostname}/${extracted.ncode}/`)
			: url;
		const fromHtml = await fetchNovelFromHtml(fallbackUrl, opts);
		if (fromHtml !== null) {
			summary = buildSummaryFromApi(fromHtml, url, extracted.isR18, embedBaseUrl);
		} else {
			return general(url, { ...opts, userAgent: 'Twitterbot/1.0' });
		}
	}

	// **chapter URL では description を「各話タイトル」に上書き**。card preview で
	// 「タイトル=作品名 / Description=各話タイトル」と並べて表示することで、各話 URL がどの作品の
	// どの話かが一目で分かるようにする。chapter HTML 取得失敗 (null) のときは作品トップと同じ
	// description (composeDescription の作品メタ) のままにする。
	if (chapterTitle !== null) {
		summary.description = chapterTitle;
	}

	return summary;
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const extracted = extractNcodeAndR18(url);
	if (extracted === null) {
		throw new Error('syosetu renderEmbed: invalid URL (test() を通った URL のはずだが ncode が抽出できない)');
	}
	const apiUrl = buildApiUrl(extracted.ncode, extracted.isR18);
	const body = await getJson(apiUrl, undefined, opts);
	const novel = parseNovelApiResponse(body);
	if (novel === null) {
		// allcount=0 = 作品が見つからない / 削除済み。renderEmbed の null 返却は型契約上禁止
		// なので throw して /embed 側で 500 エラーに変換させる。
		throw new Error('syosetu renderEmbed: 作品が見つかりません (allcount=0)');
	}
	const html = composeEmbedHtml(novel, extracted.isR18);
	return { body: html, width: 3, height: 2 };
}
