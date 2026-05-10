/**
 * カクヨム プラグイン。
 *
 * `https://kakuyomu.jp/works/<id>` および `https://kakuyomu.jp/works/<id>/episodes/<eid>` の URL に対し、
 * **HTML 内の `<script id="__NEXT_DATA__" type="application/json">`** に埋め込まれている Apollo
 * (Relay 風) 正規化キャッシュ JSON から作品メタを取得する。なろうのような公式 API が無いため、
 * Next.js の SSR が出力する JSON ペイロードを事実上の API として使う。
 *
 * 設計詳細: docs/plans/phase15.2-kakuyomu-embed.md
 *
 * **PV カウント影響**: HTML 取得は必須だが `Twitterbot/1.0` UA で叩いて PV 除外を狙う
 * (nintendo-store / syosetu fallback と同類)。
 *
 * **chapter URL の扱い**: `/works/<id>/episodes/<eid>` でも作品レベルにメタ情報を集約。
 * episode 個別の HTML を別途叩いて `og:title` から各話タイトルだけ抽出し、card style description
 * 末尾に「<各話タイトル>」を付与する (なろう chapter 対応と同パターン)。
 *
 * **HTML エスケープ契約**: `renderEmbed` が返す `body` 内のすべてのユーザー入力 (title /
 * author / introduction / tagLabels 等) は `escapeHtml` を通すこと。
 */

import type Summary from '@/summary.js';
import type { CheerioAPI } from 'cheerio';
import type { EmbedRenderResult } from '@/iplugin.js';
import { type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';
import { clip } from '@/utils/clip.js';
import { escapeHtml } from '@/utils/escape-html.js';
import { getKakuyomuGenreName } from '@/utils/kakuyomu-genres.js';

export const name = 'kakuyomu';

const HOST = /^kakuyomu\.jp$/;
// 作品 ID は 19 桁の数値 (例: 1177354054894377419)。chapter (episode) は数値 ID。
// `/works/<id>` (作品トップ) と `/works/<id>/episodes/<eid>` (各話) の両方をマッチ。
const WORK_PATH = /^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/;

const SITE_LOGO = 'https://kakuyomu.jp/images/brand/favicons/app-256.png';
const SITE_FAVICON = 'https://kakuyomu.jp/images/brand/favicons/favicon.ico';
const SITENAME = 'カクヨム';

const STORY_CARD_CLIP_LENGTH = 80;
const STORY_EMBED_CLIP_LENGTH = 300;

export function test(url: URL): boolean {
	if (!HOST.test(url.hostname)) return false;
	return WORK_PATH.test(url.pathname);
}

/**
 * URL から `{ workId, episodeId }` を抽出する。
 * `test()` を通った前提だが防衛的に null チェックする。
 */
export function extractWorkAndEpisode(url: URL): { workId: string; episodeId: string | null } | null {
	const m = WORK_PATH.exec(url.pathname);
	if (m === null) return null;
	const episodeId = (m[2] as string | undefined) ?? null;
	return { workId: m[1], episodeId };
}

/**
 * カクヨム `Work` エンティティ (Apollo state 内) から本実装が必要とするフィールドだけ抜き出した型。
 * `__typename: 'Work'` で識別される。`unknown` 型でフィールドを宣言することで
 * Apollo schema 変更耐性を高める (実装側で都度 narrowing)。
 */
export interface KakuyomuWork {
	__typename?: unknown;
	id?: unknown;
	title?: unknown;
	catchphrase?: unknown;
	introduction?: unknown;
	genre?: unknown;
	serialStatus?: unknown;
	publicEpisodeCount?: unknown;
	totalCharacterCount?: unknown;
	publishedAt?: unknown;
	lastEpisodePublishedAt?: unknown;
	hasPublication?: unknown;
	ogImageUrl?: unknown;
	isCruel?: unknown;
	isSexual?: unknown;
	isViolent?: unknown;
	tagLabels?: unknown;
	author?: unknown; // `{ __ref: 'UserAccount:xxx' }` 形式
}

/**
 * `__NEXT_DATA__` の JSON 文字列を parse して、Apollo state 全体を返す。
 * 失敗時は null。
 */
function parseNextData(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Apollo state を walk して `Work:<workId>` キーで指定される Work エンティティを探す。
 *
 * Next.js + Apollo (Relay 風) の正規化キャッシュは `{__typename}:{id}` をキーにして
 * フラットな辞書に展開されている。深いネストを再帰的に探索する。
 *
 * 戻り値:
 * - 該当エンティティが見つかれば `{ work, state }` を返す (state は author lookup 用)
 * - 見つからなければ null
 */
// Apollo 正規化キャッシュは構造上フラット (実ネスト深さ 3〜5 程度) のため 50 で十分。
// 悪意ある深いネスト JSON で stack overflow を起こさせない構造的防御 (security review M-1)。
const APOLLO_WALK_MAX_DEPTH = 50;

export function findWorkInApolloState(state: unknown, workId: string): { work: KakuyomuWork; state: unknown } | null {
	const target = `Work:${workId}`;
	const visited = new WeakSet<object>();

	function walk(o: unknown, depth: number): KakuyomuWork | null {
		if (depth > APOLLO_WALK_MAX_DEPTH) return null;
		if (o == null || typeof o !== 'object') return null;
		if (visited.has(o)) return null;
		visited.add(o);
		if (Array.isArray(o)) {
			for (const x of o) {
				const r = walk(x, depth + 1);
				if (r !== null) return r;
			}
			return null;
		}
		const obj = o as Record<string, unknown>;
		// `target` は `Work:<数字>` 形式なのでプロトタイプキー (`__proto__` 等) と衝突しない。
		// 念のため hasOwnProperty で構造的に絞る (security review L-1 / 一貫性のため)。
		if (Object.prototype.hasOwnProperty.call(obj, target)) {
			const direct = obj[target];
			if (direct != null && typeof direct === 'object' && (direct as KakuyomuWork).__typename === 'Work') {
				return direct as KakuyomuWork;
			}
		}
		for (const v of Object.values(obj)) {
			const r = walk(v, depth + 1);
			if (r !== null) return r;
		}
		return null;
	}

	const work = walk(state, 0);
	return work != null ? { work, state } : null;
}

/**
 * Apollo state から `UserAccount:<id>` の `name` を lookup する (作者名取得用)。
 * 見つからなければ null。
 */
export function lookupAuthorName(state: unknown, userAccountRef: string): string | null {
	const visited = new WeakSet<object>();

	function walk(o: unknown, depth: number): string | null {
		if (depth > APOLLO_WALK_MAX_DEPTH) return null;
		if (o == null || typeof o !== 'object') return null;
		if (visited.has(o)) return null;
		visited.add(o);
		if (Array.isArray(o)) {
			for (const x of o) {
				const r = walk(x, depth + 1);
				if (r !== null) return r;
			}
			return null;
		}
		const obj = o as Record<string, unknown>;
		// `userAccountRef` が `__proto__` 等のプロトタイプキーだった場合に `Object.prototype` を
		// 参照しないよう、`hasOwnProperty` で自身プロパティのみに絞る (security review L-1)。
		// 別経路でプロトタイプ汚染が起きていても構造的に防げる defense-in-depth。
		if (Object.prototype.hasOwnProperty.call(obj, userAccountRef)) {
			const direct = obj[userAccountRef];
			if (direct != null && typeof direct === 'object') {
				const name = (direct as Record<string, unknown>).name;
				if (typeof name === 'string' && name !== '') return name;
			}
		}
		for (const v of Object.values(obj)) {
			const r = walk(v, depth + 1);
			if (r !== null) return r;
		}
		return null;
	}

	return walk(state, 0);
}

/**
 * cheerio から `<script id="__NEXT_DATA__">` の JSON を取り出して Apollo state を返す。
 * 失敗時は null。
 */
export function extractApolloState($: CheerioAPI): unknown {
	const raw = $('script#__NEXT_DATA__').first().contents().text();
	if (raw === '') return null;
	return parseNextData(raw);
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBoolean(v: unknown): boolean | null {
	return typeof v === 'boolean' ? v : null;
}

/** マーカー (残酷描写 / 性的描写 / 暴力描写) を `[残酷描写] [性的描写] ...` の形でまとめる */
function composeMarkers(work: KakuyomuWork): string {
	const markers: string[] = [];
	if (asBoolean(work.isCruel) === true) markers.push('残酷描写');
	if (asBoolean(work.isSexual) === true) markers.push('性的描写');
	if (asBoolean(work.isViolent) === true) markers.push('暴力描写');
	return markers.length > 0 ? markers.map(m => `[${m}]`).join(' ') : '';
}

/**
 * 連載状態 (RUNNING / COMPLETED) を日本語化。話数 + 文字数を括弧内にまとめる。
 * 例: `連載中 (169話 / 282,850 文字)` / `完結 (169話 / 282,850 文字)` / `連載中` (count/char ともに不明)
 */
function composeStatusLabel(work: KakuyomuWork): string {
	const status = asString(work.serialStatus);
	const count = asNumber(work.publicEpisodeCount);
	const charCount = asNumber(work.totalCharacterCount);
	const base = status === 'COMPLETED' ? '完結' : status === 'RUNNING' ? '連載中' : '';
	if (base === '') return '';
	const detailParts: string[] = [];
	if (count != null && count > 0) detailParts.push(`${count}話`);
	if (charCount != null && charCount > 0) detailParts.push(`${charCount.toLocaleString('ja-JP')}文字`);
	return detailParts.length > 0 ? `${base} (${detailParts.join(' / ')})` : base;
}

/**
 * card style 用 description を組み立てる。
 * **あらすじだけ** を返す方針 (Misskey カード幅で description が複数要素入るとあらすじが
 * 見切れるため、メタ情報は embed iframe に集約。syosetu プラグインと同じ設計)。
 * 例: `あらすじ: 異世界に転生した主人公が、運命の少女と出会い世界を救うまでの…`
 *
 * `catchphrase` (キャッチコピー) → `introduction` (あらすじ本文) の順でフォールバック。
 * 両方 null なら空文字を返す。
 */
/**
 * card style 用 description を組み立てる。
 *
 * - **work URL**: `あらすじ: <catchphrase or introduction の 80 文字 clip>` (作品全体のあらすじ)
 * - **episode URL** (各話):
 *   - `episodeBody` が取れた場合: `「<各話タイトル>」 / <本文先頭 80 文字 clip>` (各話の冒頭)
 *   - `episodeBody` が無い場合: `「<各話タイトル>」 / あらすじ: <作品あらすじ 80 文字 clip>` (作品 fallback)
 *   - `episodeTitle` だけある場合: `「<各話タイトル>」` (本文 + あらすじ両方無し)
 *
 * 各話 URL では「あらすじ: 」ラベルを付けない (本文先頭であって「あらすじ」ではないため誤解を避ける)。
 */
export function composeDescription(
	work: KakuyomuWork,
	episodeTitle: string | null = null,
	episodeBody: string | null = null,
): string {
	const hasEpisodeTitle = episodeTitle != null && episodeTitle !== '';
	const titlePart = hasEpisodeTitle ? `「${episodeTitle}」` : '';

	// episode body 優先 (各話 URL でユーザーが見たいのは「その話の冒頭」)
	if (hasEpisodeTitle && episodeBody != null && episodeBody !== '') {
		return `${titlePart} / ${clip(episodeBody, STORY_CARD_CLIP_LENGTH)}`;
	}
	// fallback: 作品全体のあらすじ
	const summary = asString(work.catchphrase) ?? asString(work.introduction);
	const summaryPart = summary != null ? `あらすじ: ${clip(summary, STORY_CARD_CLIP_LENGTH)}` : '';
	if (hasEpisodeTitle) {
		return summaryPart !== '' ? `${titlePart} / ${summaryPart}` : titlePart;
	}
	return summaryPart;
}

/**
 * `/embed` 用の player URL を組み立てる。`embedBaseUrl` 未指定なら null。
 */
function composePlayerUrl(url: URL, embedBaseUrl: string | undefined): string | null {
	if (embedBaseUrl == null || embedBaseUrl === '') return null;
	return `${embedBaseUrl.replace(/\/$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
}

/** tagLabels (配列) を上位 5 件のカンマ区切りに整形 */
function formatTags(tags: unknown): string {
	if (!Array.isArray(tags)) return '';
	const items = tags.filter((t): t is string => typeof t === 'string' && t !== '').slice(0, 5);
	return items.join(', ');
}

/**
 * `/embed` 用の HTML を組み立てる。すべてのユーザー入力は `escapeHtml` を通す。
 *
 * **レイアウト方針** (syosetu プラグインと統一、Mi 側プレイヤー iframe の縦幅=横幅依存
 * + スクロール不可制約に対応): タイトル → meta 行 1 行統合 (作者 / 連載ステータス /
 * ジャンル / 警告) → あらすじ → タグ → 最終話 → サイト名。重要要素を上に寄せて
 * iframe 高さが固定でも肝心情報が見えるようにする。
 *
 * **連載ステータス**: `連載中 (169話 / 282,850 文字)` の形式で話数 + 文字数を内包し、
 * 読み応え情報を 1 単位として表示。
 *
 * **警告マーカー**: `<span class="markers">[残酷描写] [性的描写] [暴力描写]</span>` で
 * meta 行末尾に統合、CSS `.markers { color: #c33; }` で赤文字強調。
 */
export function composeEmbedHtml(
	work: KakuyomuWork,
	authorName: string | null,
	episodeTitle: string | null = null,
	episodeBody: string | null = null,
): string {
	const titleSafe = escapeHtml(asString(work.title) ?? '(タイトル不明)');
	const episodeTitleSafe = episodeTitle != null && episodeTitle !== '' ? escapeHtml(episodeTitle) : '';
	const authorSafe = escapeHtml(authorName ?? '(作者不明)');
	const genreSafe = escapeHtml(getKakuyomuGenreName(asString(work.genre) ?? ''));
	const statusSafe = escapeHtml(composeStatusLabel(work));
	const markersSafe = escapeHtml(composeMarkers(work));
	// **本文 vs あらすじの優先**: episode URL で本文が取れた場合は本文 (1〜N 段落) を表示、
	// 無ければ作品全体の introduction を表示 (work URL or fetch 失敗時)。
	// どちらも escape + 300 文字 clip で同じ扱い。
	const storyRaw = (episodeBody != null && episodeBody !== '') ? episodeBody : (asString(work.introduction) ?? '');
	const introductionSafe = escapeHtml(clip(storyRaw, STORY_EMBED_CLIP_LENGTH));
	const tagsSafe = escapeHtml(formatTags(work.tagLabels));
	const lastPub = asString(work.lastEpisodePublishedAt);
	// ISO datetime から日付部分だけ取り出し (escape は不要、固定書式)
	const lastPubSafe = lastPub != null ? escapeHtml(lastPub.slice(0, 10)) : '';
	const sitenameSafe = escapeHtml(SITENAME);

	// 1 行に「作者 / 連載ステータス / ジャンル / 警告」を統合 (syosetu と同順序)。
	// 空項目は push 自体をスキップ (末尾余白 ` / ` が残らない)。
	// 警告マーカーは `<span class="markers">` で囲んで CSS で赤文字強調。
	const metaParts = [`作者: ${authorSafe}`];
	if (statusSafe !== '') metaParts.push(statusSafe);
	if (genreSafe !== '') metaParts.push(genreSafe);
	if (markersSafe !== '') metaParts.push(`<span class="markers">${markersSafe}</span>`);
	const metaLine = metaParts.join(' / ');

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
.episode-title { font-size: 0.95rem; font-weight: bold; color: #4a4a4a; margin-bottom: 0.5rem; word-break: break-word; }
.meta { font-size: 0.85rem; color: #555; margin-bottom: 0.5rem; word-break: break-word; }
.markers { color: #c33; }
.story { font-size: 0.85rem; white-space: pre-wrap; word-break: break-word; color: #333; margin-bottom: 0.75rem; }
.tags { font-size: 0.8rem; color: #888; margin-bottom: 0.25rem; word-break: break-word; }
.sitename { font-size: 0.75rem; color: #888; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #eee; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
${episodeTitleSafe !== '' ? `<div class="episode-title">「${episodeTitleSafe}」</div>` : ''}
<div class="meta">${metaLine}</div>
<div class="story">${introductionSafe}</div>
${tagsSafe !== '' ? `<div class="tags">タグ: ${tagsSafe}</div>` : ''}
${lastPubSafe !== '' ? `<div class="tags">最終話: ${lastPubSafe}</div>` : ''}
<div class="sitename">${sitenameSafe}</div>
</body>
</html>`;
}

/**
 * Work + author から `Summary` を組み立てる (テスト容易性のため pure 化、export)。
 */
export function buildSummaryFromWork(
	work: KakuyomuWork,
	authorName: string | null,
	url: URL,
	embedBaseUrl: string | undefined,
): Summary {
	const title = asString(work.title) ?? '(タイトル不明)';
	const description = composeDescription(work);
	const playerUrl = composePlayerUrl(url, embedBaseUrl);
	const thumbnail = asString(work.ogImageUrl) ?? SITE_LOGO;
	const sensitive = asBoolean(work.isSexual) === true;
	return {
		title,
		icon: SITE_FAVICON,
		description,
		thumbnail,
		player: playerUrl != null
			? {
				url: playerUrl,
				// なろうと同じく 3:2 横長カード比率で宣言
				width: 3,
				height: 2,
				allow: [],
			}
			: { url: null, width: null, height: null, allow: [] },
		sitename: SITENAME,
		sensitive,
		activityPub: null,
		fediverseCreator: null,
	};
}

/**
 * og:title (`"<EpisodeTitle> - <WorkTitle> - カクヨム"`) から各話タイトルだけ抽出する pure 関数
 * (export してテスト容易化)。
 *
 * 1. 末尾の `' - カクヨム'` を suffix 削除 (固定文字列、安全)
 * 2. 残った `<EpisodeTitle> - <WorkTitle>` を **末尾の `' - '`** で 2 つに split
 *    (作品タイトルに ` - ` が含まれる方が、各話タイトルに含まれるよりレアなため、後者寄りに倒す)
 * 3. 先頭側を EpisodeTitle として返す
 */
export function extractEpisodeTitleFromOg(ogTitle: string): string | null {
	if (ogTitle === '') return null;
	const SITE_SUFFIX = ' - カクヨム';
	const withoutSuffix = ogTitle.endsWith(SITE_SUFFIX)
		? ogTitle.slice(0, -SITE_SUFFIX.length)
		: ogTitle;
	const lastSep = withoutSuffix.lastIndexOf(' - ');
	if (lastSep <= 0) return null;
	const episodeTitle = withoutSuffix.slice(0, lastSep).trim();
	return episodeTitle !== '' ? episodeTitle : null;
}

/**
 * 各話本文の冒頭テキストを `<div class="widget-episodeBody js-episode-body">` 配下の `<p>` 群から
 * 抽出する (export してテスト容易化)。
 *
 * - 各 `<p>` の text() を取り出して `\n` で結合
 * - 空段落はスキップ
 * - HTML 構造が変わって取れない場合は null
 *
 * `composeDescription` 側で 80 文字 clip / `composeEmbedHtml` 側で 300 文字 clip するため、
 * 全文取得しても問題ない (cheerio の text() でテキストノード抽出するだけなので軽量)。
 */
export function extractEpisodeBody($: CheerioAPI): string | null {
	// `widget-episodeBody` (class) と `js-episode-body` (class) どちらでもマッチさせる。
	// JS フックを兼ねる `js-episode-body` の方が変更耐性が高い可能性あり。
	const $body = $('.widget-episodeBody').first().length > 0
		? $('.widget-episodeBody').first()
		: $('.js-episode-body').first();
	if ($body.length === 0) return null;
	const paragraphs: string[] = [];
	$body.find('p').each((_, p) => {
		const text = $(p).text().trim();
		if (text !== '') paragraphs.push(text);
	});
	if (paragraphs.length === 0) return null;
	return paragraphs.join('\n');
}

/**
 * episode URL から `{ title, body }` を抽出する。
 * - title: og:title から各話タイトル抽出 (chapter description 表示用)
 * - body: 本文段落を `\n` 結合 (あらすじの代わりに「各話冒頭」を表示するための用途)
 *
 * どちらも取れなければ null フィールド。両方 null なら戻り値全体を null として返す。
 *
 * `Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (作品トップ取得と同 UA)。
 */
async function fetchEpisodeData(
	episodeUrl: URL,
	opts: GeneralScrapingOptions | undefined,
): Promise<{ title: string | null; body: string | null } | null> {
	try {
		const res = await scpaping(episodeUrl.href, { ...opts, userAgent: 'Twitterbot/1.0' });
		const ogTitle = res.$('meta[property="og:title"]').attr('content')?.trim() ?? '';
		const title = extractEpisodeTitleFromOg(ogTitle);
		const body = extractEpisodeBody(res.$);
		if (title === null && body === null) return null;
		return { title, body };
	} catch {
		return null;
	}
}

/**
 * work URL の HTML から Apollo state を取って Work エンティティを返す。
 *
 * **`Twitterbot/1.0` UA 固定の設計** (security review I-4): nintendo-store (`facebookexternalhit/1.1`
 * 固定) と同パターンで、UA allowlist を持つサイト向けに意図的に固定する。これにより
 * `scpaping` 内の bot block fallback リトライ機構は **発動しない** (UA を上書きすると
 * categorize → リトライ経路でも同 UA で叩かれる)。カクヨムが `Twitterbot/1.0` を弾くようになった
 * 場合は本ファイルの UA を差し替えて対処する前提。
 */
async function fetchWorkData(workUrl: URL, opts: GeneralScrapingOptions | undefined): Promise<{ work: KakuyomuWork; authorName: string | null } | null> {
	const res = await scpaping(workUrl.href, { ...opts, userAgent: 'Twitterbot/1.0' });
	const state = extractApolloState(res.$);
	if (state == null) return null;
	const extracted = extractWorkAndEpisode(workUrl);
	if (extracted == null) return null;
	const found = findWorkInApolloState(state, extracted.workId);
	if (found == null) return null;
	let authorName: string | null = null;
	const authorRef = found.work.author;
	if (authorRef != null && typeof authorRef === 'object' && '__ref' in authorRef && typeof (authorRef as { __ref: unknown }).__ref === 'string') {
		authorName = lookupAuthorName(found.state, (authorRef as { __ref: string }).__ref);
	}
	return { work: found.work, authorName };
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const extracted = extractWorkAndEpisode(url);
	if (extracted === null) return null;

	// episode URL でも作品トップから work data を取る (各話メタは episode URL 側で取れない構造)。
	// episode URL の場合は同時に episode HTML から `{ title, body }` を抽出 (本文 1 行目をあらすじ代わりに使う)。
	const workTopUrl = new URL(`https://${url.hostname}/works/${extracted.workId}`);
	const [workData, episodeData] = await Promise.all([
		fetchWorkData(workTopUrl, opts),
		extracted.episodeId != null
			? fetchEpisodeData(url, opts)
			: Promise.resolve(null),
	]);

	if (workData === null) return null;

	// `_embedBaseUrl` は `summaly()` が `SummalyOptions.embedBaseUrl` を transparent 伝搬する
	// internal フィールド (`GeneralScrapingOptions` の JSDoc 参照)。
	const embedBaseUrl = opts?._embedBaseUrl;
	const summary = buildSummaryFromWork(workData.work, workData.authorName, url, embedBaseUrl);

	// episode URL では `composeDescription` を episode title + body 込みで再生成。
	// **escape 不要の理由**: `summary.description` はプレーンテキストとして Misskey クライアント側で
	// textContent / v-text 相当で表示されるため、HTML として解釈されない。embed HTML には
	// `description` ではなく別途取得した `episodeBody` が流入する (composeEmbedHtml 参照) ので XSS 経路にもならない。
	if (episodeData != null) {
		summary.description = composeDescription(workData.work, episodeData.title, episodeData.body);
	}
	return summary;
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const extracted = extractWorkAndEpisode(url);
	if (extracted === null) {
		throw new Error('kakuyomu renderEmbed: invalid URL (test() を通った URL のはずだが workId が抽出できない)');
	}
	// episode URL なら各話タイトル + 本文も並列取得して embed HTML に反映する。
	// summarize() と同じ構造 (作品トップから work data + episode HTML から og:title + 本文抽出)。
	const workTopUrl = new URL(`https://${url.hostname}/works/${extracted.workId}`);
	const [workData, episodeData] = await Promise.all([
		fetchWorkData(workTopUrl, opts),
		extracted.episodeId != null
			? fetchEpisodeData(url, opts)
			: Promise.resolve(null),
	]);
	if (workData === null) {
		// __NEXT_DATA__ parse 失敗 / Work エンティティ不在 (削除作品 / 構造変更)。
		// renderEmbed の null 返却は型契約上禁止なので throw して /embed 側で 500 に変換させる。
		throw new Error('kakuyomu renderEmbed: 作品が見つかりません (__NEXT_DATA__ parse 失敗 or Work entity 不在)');
	}
	const html = composeEmbedHtml(
		workData.work,
		workData.authorName,
		episodeData?.title ?? null,
		episodeData?.body ?? null,
	);
	return { body: html, width: 3, height: 2 };
}

export const skipRedirectResolution = false;
