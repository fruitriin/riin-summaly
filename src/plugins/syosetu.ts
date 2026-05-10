/**
 * 小説家になろう プラグイン。
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

// HEAD probe (followRedirects) を skip して原 URL で API 経路に直接乗る。
// 詳細は AGE_AUTH_HOST 定義箇所のコメント参照。
export const skipRedirectResolution = true;

const NCODE_HOST_REGULAR = /^ncode\.syosetu\.com$/;
const NCODE_HOST_R18 = /^novel18\.syosetu\.com$/;
// **年齢確認ゲート救援**: novel18.syosetu.com への通常 GET (例: `SummalyBot/x.y.z` UA) は
// 302 で `https://nl.syosetu.com/redirect/ageauth/?url=<encoded>&hash=<hex>` にリダイレクトされる。
// `summaly()` の HEAD probe (`followRedirects`) で解決された後の URL では test() が外れて general()
// にフォールバックし、年齢確認ページの OGP (title="年齢確認" / sitename="nl.syosetu.com") を返してしまう。
//
// **対策 1**: `skipRedirectResolution = true` で HEAD probe をスキップし最初から原 URL で API 直叩き経路に乗せる
// **対策 2**: 何らかの経路で ageauth URL が直接渡された場合 (Mi 側仕様変更等) の defense-in-depth
//   として、ageauth URL を test() でマッチさせて `?url=` パラメータから元 URL を unwrap する
const AGE_AUTH_HOST = /^nl\.syosetu\.com$/;
const AGE_AUTH_PATH = /^\/redirect\/ageauth\/?$/;
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

/**
 * ageauth URL (`https://nl.syosetu.com/redirect/ageauth/?url=<encoded>&hash=...`) なら
 * `?url=` パラメータから元 URL を取り出して返す。それ以外なら入力をそのまま返す。
 * `?url` パラメータが壊れている / inner URL が parse 失敗のときは null を返す
 * (test() / extractNcodeAndR18 で false / null として扱われ、最終的に general() フォールバック)。
 */
export function unwrapAgeAuthUrl(url: URL): URL | null {
	if (!AGE_AUTH_HOST.test(url.hostname) || !AGE_AUTH_PATH.test(url.pathname)) return url;
	const inner = url.searchParams.get('url');
	if (inner === null || inner === '') return null;
	try {
		return new URL(inner);
	} catch {
		return null;
	}
}

export function test(url: URL): boolean {
	const target = unwrapAgeAuthUrl(url);
	if (target === null) return false;
	if (!NCODE_HOST_REGULAR.test(target.hostname) && !NCODE_HOST_R18.test(target.hostname)) return false;
	return NCODE_PATH.test(target.pathname);
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
	// ageauth URL なら inner url パラメータから元 URL を取り出す (defense-in-depth、対策 2)
	const target = unwrapAgeAuthUrl(url);
	if (target === null) return null;
	const isR18 = NCODE_HOST_R18.test(target.hostname);
	const m = NCODE_PATH.exec(target.pathname);
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
	// なろう API は `noveltype` (アンダースコアなし) を返す。`of=nt` で要求するが、
	// レスポンスフィールド名は `noveltype` (公式仕様、実 API レスポンスで確認)。
	noveltype?: unknown; // 1=連載, 2=短編
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
 * **あらすじだけ**を返す方針 (作者 / ジャンル / ステータスを含めるとカード幅であらすじが
 * 見切れてしまうため、メタ情報は embed iframe に集約する)。
 * 例: `あらすじ: 異世界に転生した主人公が、運命の少女と出会い世界を救うまでの物語。…`
 *
 * `story` が null (API レスポンス欠損 / HTML スクレイプ失敗) のときは空文字を返す。
 */
export function composeDescription(novel: SyosetuNovelData): string {
	const story = asString(novel.story);
	if (story == null) return '';
	return `あらすじ: ${clip(story, STORY_CARD_CLIP_LENGTH)}`;
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
export function composeEmbedHtml(
	novel: SyosetuNovelData,
	isR18: boolean,
	episodeTitle: string | null = null,
	episodeBody: string | null = null,
): string {
	const titleSafe = escapeHtml(asString(novel.title) ?? '(タイトル不明)');
	const episodeTitleSafe = episodeTitle != null && episodeTitle !== '' ? escapeHtml(episodeTitle) : '';
	const writerSafe = escapeHtml(asString(novel.writer) ?? '(作者不明)');
	const bigGenreId = asNumber(novel.biggenre);
	const genreId = asNumber(novel.genre);
	// R-18 (novel18api) はジャンル (`biggenre` / `genre`) を返さない仕様のため、
	// genreText が空のときは meta 行から省略する (フォールバック表記なし)。
	const genreText = genreId != null
		? `${getGenreName(genreId)}`
		: (bigGenreId != null ? getBigGenreName(bigGenreId) : '');
	const genreSafe = escapeHtml(genreText);
	const novelType = asNumber(novel.noveltype);
	const end = asNumber(novel.end);
	// なろう公式 API 仕様 (https://dev.syosetu.com/man/api/):
	// **end: 短編作品と完結済作品は 0、連載中は 1**
	// HTML フォールバック経路で end が undefined のときは status 行から省略 (空文字)。
	const statusText = novelType === 2
		? '短編'
		: (end === 1 ? '連載中' : (end === 0 ? '完結済' : ''));
	const statusSafe = escapeHtml(statusText);
	const markersSafe = escapeHtml(composeMarkers(novel));
	const sitenameSafe = escapeHtml(isR18 ? SITENAME_R18 : SITENAME_REGULAR);
	const keywordRaw = asString(novel.keyword) ?? '';
	const keywordsSafe = escapeHtml(formatKeywords(keywordRaw));
	// **本文 vs あらすじの優先**: chapter URL で本文が取れた場合は本文 (1〜N 段落) を表示、
	// 無ければ作品全体の story (introduction) を表示。どちらも escape + 300 文字 clip で同じ扱い。
	const storyRaw = (episodeBody != null && episodeBody !== '') ? episodeBody : (asString(novel.story) ?? '');
	const storySafe = escapeHtml(clip(storyRaw, STORY_EMBED_CLIP_LENGTH));

	// 1 行に「作者 / 連載ステータス / ジャンル / 警告」を統合。Mi 側プレイヤーが
	// 縦幅 = 横幅依存 + スクロール不可のため、重要要素を上に寄せる狙い。
	// 空の項目は push 自体をスキップ (末尾余白 ` / ` が残らない)。
	// 警告マーカー (`[残酷描写]` `[GL]` 等) だけは `<span class="markers">` で囲んで赤色強調する。
	const metaParts = [`作者: ${writerSafe}`];
	if (statusSafe !== '') metaParts.push(statusSafe);
	if (genreSafe !== '') metaParts.push(genreSafe);
	if (markersSafe !== '') metaParts.push(`<span class="markers">${markersSafe}</span>`);
	const metaLine = metaParts.join(' / ');

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
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 0.25rem; word-break: break-word; }
.episode-title { font-size: 0.95rem; font-weight: bold; color: #4a4a4a; margin-bottom: 0.5rem; word-break: break-word; }
.meta { font-size: 0.85rem; color: #555; margin-bottom: 0.5rem; word-break: break-word; }
.markers { color: #b22; }
.story { font-size: 0.85rem; white-space: pre-wrap; word-break: break-word; color: #333; margin-bottom: 0.75rem; }
.keywords { font-size: 0.8rem; color: #888; margin-bottom: 0.5rem; word-break: break-word; }
.sitename { font-size: 0.75rem; color: #888; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #eee; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
${episodeTitleSafe !== '' ? `<div class="episode-title">「${episodeTitleSafe}」</div>` : ''}
<div class="meta">${metaLine}</div>
<div class="story">${storySafe}</div>
${keywordsSafe !== '' ? `<div class="keywords">タグ: ${keywordsSafe}</div>` : ''}
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
 * 取れないフィールド (HTML には明示されていない): `biggenre` / `genre` / `noveltype` / `end`。
 * `composeDescription` / `composeMarkers` は asString/asNumber が undefined を null として扱うため、
 * 取れないフィールドは undefined のままで動作する (status / ジャンル行から省略される)。
 *
 * **連載状態 (end) は HTML から取得しない**: なろう作品トップの「最終エピソード掲載日」/「最終更新日」
 * ラベルから推定する案も検討したが、連載中作品でも「最終エピソード掲載日」が表示されるため
 * ラベル差では区別できない (実機確認済)。誤推定で「完結済」と表示するより undefined で省略する方が安全。
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
		// HTML から取れないフィールドは undefined (composeDescription / composeEmbedHtml 側で
		// null として扱われ、status / ジャンル行から省略される)
		biggenre: undefined,
		genre: undefined,
		noveltype: undefined,
		end: undefined,
		isr15, iszankoku, isbl, isgl,
		keyword,
	};
}

/**
 * なろう作品トップページの HTML から `SyosetuNovelData` を取得する。
 * `Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (API 直叩きの精神を維持)。
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
 * chapter ページの HTML から「各話タイトル」を抽出する pure 関数 (export してテスト容易化)。
 *
 * - 1st choice: `<h1 class="p-novel__title">` (chapter ページではここが各話タイトル)。
 *   `p-novel__title--rensai` 修飾が付くがクラスセレクタは含む方向で動く。
 * - 2nd choice: `og:title` は `"WorkTitle - ChapterTitle"` 結合形式。最初の ` - ` で split する
 *   (作品タイトルに ` - ` が含まれる場合は誤抽出するが、h1 が取れている前提で fallback としてのみ使用)。
 */
export function extractChapterTitle($: CheerioAPI): string | null {
	const fromH1 = $('h1.p-novel__title').first().text().trim();
	if (fromH1 !== '') return fromH1;
	const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
	const sepIdx = ogTitle.indexOf(' - ');
	if (sepIdx >= 0) {
		const right = ogTitle.slice(sepIdx + 3).trim();
		return right !== '' ? right : null;
	}
	return null;
}

/**
 * chapter ページの HTML から各話本文の冒頭テキストを抽出する pure 関数 (export してテスト容易化)。
 *
 * 構造: `<div class="p-novel__body">` → `<div class="js-novel-text p-novel__text">` (本文)
 *   + `<div class="js-novel-text p-novel__text p-novel__text--foreword">` (前書き、除外)
 *   + `<div class="js-novel-text p-novel__text p-novel__text--afterword">` (後書き、除外)
 *
 * **本文** (前書き / 後書き以外の `.p-novel__text`) の `<p>` を改行結合する。空段落
 * (全角空白だけ `<p>U+3000</p>` / `<br>` だけ等) は trim() で空判定してスキップ。
 *
 * 失敗時 (構造変更 / 段落不在) は null。
 */
export function extractEpisodeBody($: CheerioAPI): string | null {
	const $main = $('.p-novel__text:not(.p-novel__text--foreword):not(.p-novel__text--afterword)').first();
	if ($main.length === 0) return null;
	const paragraphs: string[] = [];
	$main.find('p').each((_, p) => {
		const text = $(p).text().trim();
		if (text !== '') paragraphs.push(text);
	});
	if (paragraphs.length === 0) return null;
	return paragraphs.join('\n');
}

/**
 * chapter URL (`/<ncode>/<num>/`) のページから `{ title, body }` を抽出する。
 * - title: 各話タイトル (h1 → og:title fallback)
 * - body: 各話本文の冒頭 (前書き / 後書き除く `.p-novel__text` の `<p>` を改行結合)
 *
 * `Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (作品トップ取得と同 UA)。
 * 両方 null の場合は戻り値全体を null として返す (構造変更の検出用)。
 */
export async function fetchChapterData(
	url: URL,
	opts?: GeneralScrapingOptions,
): Promise<{ title: string | null; body: string | null } | null> {
	const res = await scpaping(url.href, { ...opts, userAgent: 'Twitterbot/1.0' });
	const title = extractChapterTitle(res.$);
	const body = extractEpisodeBody(res.$);
	if (title === null && body === null) return null;
	return { title, body };
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const extracted = extractNcodeAndR18(url);
	if (extracted === null) return null;
	// ageauth URL 経由で test() が通った場合、以後の経路 (HTML scrape / player URL 組み立て) では
	// 元 URL に正規化する。Mi 側に渡る player URL も `?url=<原 URL>` の形になる。
	const resolvedUrl = unwrapAgeAuthUrl(url) ?? url;
	const apiUrl = buildApiUrl(extracted.ncode, extracted.isR18);

	// **chapter URL では API + chapter HTML を並列取得** して 1 round-trip 分節約する。
	// chapter 番号が無い (= 作品トップ URL) ときは chapterData は null のままで従来通り。
	const [body, chapterData] = await Promise.all([
		getJson(apiUrl, undefined, opts),
		extracted.chapter != null
			? fetchChapterData(resolvedUrl, opts).catch(() => null)
			: Promise.resolve(null),
	]);

	const novel = parseNovelApiResponse(body);
	// `_embedBaseUrl` は `summaly()` が `SummalyOptions.embedBaseUrl` を transparent 伝搬する
	// internal フィールド (`GeneralScrapingOptions` の JSDoc 参照)。
	// 設定されていれば `Summary.player.url` を `<base>/embed?url=...` で組み立てる。
	const embedBaseUrl = opts?._embedBaseUrl;
	let summary: Summary;
	if (novel !== null) {
		summary = buildSummaryFromApi(novel, resolvedUrl, extracted.isR18, embedBaseUrl);
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
			? new URL(`https://${resolvedUrl.hostname}/${extracted.ncode}/`)
			: resolvedUrl;
		const fromHtml = await fetchNovelFromHtml(fallbackUrl, opts);
		if (fromHtml !== null) {
			summary = buildSummaryFromApi(fromHtml, resolvedUrl, extracted.isR18, embedBaseUrl);
		} else {
			return general(resolvedUrl, { ...opts, userAgent: 'Twitterbot/1.0' });
		}
	}

	// **chapter URL では description を「各話タイトル + 本文先頭」に上書き** (kakuyomu と同パターン)。
	// - title + body 両方 → `「<title>」 / <body 80 文字 clip>` (本文先頭をあらすじ代わりに)
	// - title だけ取れた → `「<title>」` (本文取得失敗、構造変更時)
	// - body だけ取れた (h1 / og:title 不在) → `<body 80 文字 clip>` (タイトル無し)
	// - 両方 null → API 由来の作品あらすじを維持 (`buildSummaryFromApi` の composeDescription 結果)
	//
	// **escape 不要の理由**: `summary.description` はプレーンテキストとして Misskey クライアント側で
	// textContent / v-text 相当で表示されるため、HTML として解釈されない。embed HTML には別途
	// `composeEmbedHtml` で escapeHtml を通すため XSS 経路にもならない。
	if (chapterData !== null) {
		const titlePart = chapterData.title != null ? `「${chapterData.title}」` : '';
		const bodyPart = chapterData.body != null ? clip(chapterData.body, STORY_CARD_CLIP_LENGTH) : '';
		if (titlePart !== '' && bodyPart !== '') {
			summary.description = `${titlePart} / ${bodyPart}`;
		} else if (titlePart !== '') {
			summary.description = titlePart;
		} else if (bodyPart !== '') {
			summary.description = bodyPart;
		}
	}

	return summary;
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const extracted = extractNcodeAndR18(url);
	if (extracted === null) {
		throw new Error('syosetu renderEmbed: invalid URL (test() を通った URL のはずだが ncode が抽出できない)');
	}
	const resolvedUrl = unwrapAgeAuthUrl(url) ?? url;
	const apiUrl = buildApiUrl(extracted.ncode, extracted.isR18);

	// chapter URL なら各話タイトル + 本文も並列取得して embed HTML に反映する。
	// summarize() と同じ構造 (API + chapter HTML 並列、catch で失敗を nullable に)。
	const [body, chapterData] = await Promise.all([
		getJson(apiUrl, undefined, opts),
		extracted.chapter != null
			? fetchChapterData(resolvedUrl, opts).catch(() => null)
			: Promise.resolve(null),
	]);

	const novel = parseNovelApiResponse(body);
	if (novel === null) {
		// allcount=0 = 作品が見つからない / 削除済み。renderEmbed の null 返却は型契約上禁止
		// なので throw して /embed 側で 500 エラーに変換させる。
		throw new Error('syosetu renderEmbed: 作品が見つかりません (allcount=0)');
	}
	const html = composeEmbedHtml(
		novel,
		extracted.isR18,
		chapterData?.title ?? null,
		chapterData?.body ?? null,
	);
	return { body: html, width: 3, height: 2 };
}
