/**
 * カクヨム プラグイン (phase15.2)。
 *
 * `https://kakuyomu.jp/works/<id>` および `https://kakuyomu.jp/works/<id>/episodes/<eid>` の URL に対し、
 * **HTML 内の `<script id="__NEXT_DATA__" type="application/json">`** に埋め込まれている Apollo
 * (Relay 風) 正規化キャッシュ JSON から作品メタを取得する。なろうのような公式 API が無いため、
 * Next.js の SSR が出力する JSON ペイロードを事実上の API として使う。
 *
 * 設計詳細: docs/plans/phase15.2-kakuyomu-embed.md
 *
 * **PV カウント影響**: HTML 取得は必須だが `Twitterbot/1.0` UA で叩いて PV 除外を狙う
 * (phase12.3 nintendo-store / phase15.0 syosetu fallback と同類)。
 *
 * **chapter URL の扱い**: `/works/<id>/episodes/<eid>` でも作品レベルにメタ情報を集約。
 * episode 個別の HTML を別途叩いて `og:title` から各話タイトルだけ抽出し、card style description
 * 末尾に「<各話タイトル>」を付与する (なろう phase13.1 chapter 対応と同パターン)。
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
export function findWorkInApolloState(state: unknown, workId: string): { work: KakuyomuWork; state: unknown } | null {
	const target = `Work:${workId}`;
	const visited = new WeakSet<object>();

	function walk(o: unknown): KakuyomuWork | null {
		if (o == null || typeof o !== 'object') return null;
		if (visited.has(o)) return null;
		visited.add(o);
		if (Array.isArray(o)) {
			for (const x of o) {
				const r = walk(x);
				if (r !== null) return r;
			}
			return null;
		}
		const obj = o as Record<string, unknown>;
		const direct = obj[target];
		if (direct != null && typeof direct === 'object' && (direct as KakuyomuWork).__typename === 'Work') {
			return direct as KakuyomuWork;
		}
		for (const v of Object.values(obj)) {
			const r = walk(v);
			if (r !== null) return r;
		}
		return null;
	}

	const work = walk(state);
	return work != null ? { work, state } : null;
}

/**
 * Apollo state から `UserAccount:<id>` の `name` を lookup する (作者名取得用)。
 * 見つからなければ null。
 */
export function lookupAuthorName(state: unknown, userAccountRef: string): string | null {
	const visited = new WeakSet<object>();

	function walk(o: unknown): string | null {
		if (o == null || typeof o !== 'object') return null;
		if (visited.has(o)) return null;
		visited.add(o);
		if (Array.isArray(o)) {
			for (const x of o) {
				const r = walk(x);
				if (r !== null) return r;
			}
			return null;
		}
		const obj = o as Record<string, unknown>;
		const direct = obj[userAccountRef];
		if (direct != null && typeof direct === 'object') {
			const name = (direct as Record<string, unknown>).name;
			if (typeof name === 'string' && name !== '') return name;
		}
		for (const v of Object.values(obj)) {
			const r = walk(v);
			if (r !== null) return r;
		}
		return null;
	}

	return walk(state);
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

/** 連載状態 (RUNNING / COMPLETED) を日本語化。話数情報も含める */
function composeStatusLabel(work: KakuyomuWork): string {
	const status = asString(work.serialStatus);
	const count = asNumber(work.publicEpisodeCount);
	const base = status === 'COMPLETED' ? '完結' : status === 'RUNNING' ? '連載中' : '';
	if (base === '') return '';
	return count != null && count > 0 ? `${base} (${count}話)` : base;
}

/**
 * card style 用 description を組み立てる。
 * 例: `作者: 山田太郎 / 異世界恋愛 / 連載中 (169話) / [残酷描写] / あらすじ: ...`
 */
export function composeDescription(work: KakuyomuWork, authorName: string | null): string {
	const parts: string[] = [];
	if (authorName != null) parts.push(`作者: ${authorName}`);
	const genre = asString(work.genre);
	if (genre != null) parts.push(getKakuyomuGenreName(genre));
	const status = composeStatusLabel(work);
	if (status !== '') parts.push(status);
	const markers = composeMarkers(work);
	if (markers !== '') parts.push(markers);
	// catchphrase が無い作品も多いので、catchphrase → introduction の順でフォールバック
	const summary = asString(work.catchphrase) ?? asString(work.introduction);
	if (summary != null) {
		parts.push(`あらすじ: ${clip(summary, STORY_CARD_CLIP_LENGTH)}`);
	}
	return parts.join(' / ');
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
 * なろうの `composeEmbedHtml` を参考にした構造 (`<style>` ブロック + flex / 通常フロー、CSP 完全対応)。
 */
export function composeEmbedHtml(work: KakuyomuWork, authorName: string | null): string {
	const titleSafe = escapeHtml(asString(work.title) ?? '(タイトル不明)');
	const authorSafe = escapeHtml(authorName ?? '(作者不明)');
	const genreSafe = escapeHtml(getKakuyomuGenreName(asString(work.genre) ?? ''));
	const statusSafe = escapeHtml(composeStatusLabel(work));
	const markersSafe = escapeHtml(composeMarkers(work));
	const introductionRaw = asString(work.introduction) ?? '';
	const introductionSafe = escapeHtml(clip(introductionRaw, STORY_EMBED_CLIP_LENGTH));
	const tagsSafe = escapeHtml(formatTags(work.tagLabels));
	const charCount = asNumber(work.totalCharacterCount);
	const charCountSafe = charCount != null ? escapeHtml(`${charCount.toLocaleString('ja-JP')}文字`) : '';
	const lastPub = asString(work.lastEpisodePublishedAt);
	// ISO datetime から日付部分だけ取り出し (escape は不要、固定書式)
	const lastPubSafe = lastPub != null ? escapeHtml(lastPub.slice(0, 10)) : '';
	const sitenameSafe = escapeHtml(SITENAME);

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; background: #fafafa; color: #222; line-height: 1.5; padding: 12px; height: 100vh; overflow-y: auto; }
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 4px; }
.author { font-size: 0.85rem; color: #666; margin-bottom: 8px; }
.meta { font-size: 0.8rem; color: #444; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.meta span { background: #eee; padding: 2px 6px; border-radius: 3px; }
.markers { color: #c33; }
.story { font-size: 0.85rem; margin: 8px 0; padding: 8px; background: #fff; border-left: 3px solid #4a90e2; white-space: pre-wrap; }
.tags { font-size: 0.75rem; color: #888; margin-top: 6px; }
.sitename { font-size: 0.7rem; color: #aaa; margin-top: 6px; text-align: right; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
<div class="author">作者: ${authorSafe}</div>
<div class="meta">
<span>${genreSafe}</span>
${statusSafe !== '' ? `<span>${statusSafe}</span>` : ''}
${charCountSafe !== '' ? `<span>${charCountSafe}</span>` : ''}
${markersSafe !== '' ? `<span class="markers">${markersSafe}</span>` : ''}
</div>
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
	const description = composeDescription(work, authorName);
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
 * episode URL から各話タイトルを抽出する (chapter description 上書き用)。
 * - `<title>` または `og:title` から `"<EpisodeTitle> - <WorkTitle> - カクヨム"` を split
 * - 失敗時 null (= 各話タイトル無し、作品レベル description のみ)
 */
async function fetchEpisodeTitle(episodeUrl: URL, opts: GeneralScrapingOptions | undefined): Promise<string | null> {
	try {
		const res = await scpaping(episodeUrl.href, { ...opts, userAgent: 'Twitterbot/1.0' });
		const ogTitle = res.$('meta[property="og:title"]').attr('content') ?? '';
		// "EpisodeTitle - WorkTitle - カクヨム" → 最初の " - " で split して先頭を取る
		const parts = ogTitle.split(' - ');
		if (parts.length >= 2 && parts[0] !== '') return parts[0].trim();
		return null;
	} catch {
		return null;
	}
}

/**
 * work URL の HTML から Apollo state を取って Work エンティティを返す。
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

	// chapter URL でも作品トップから work data を取る (各話メタは episode URL 側で取れない構造)
	const workTopUrl = new URL(`https://${url.hostname}/works/${extracted.workId}`);
	const [workData, episodeTitle] = await Promise.all([
		fetchWorkData(workTopUrl, opts),
		extracted.episodeId != null
			? fetchEpisodeTitle(url, opts)
			: Promise.resolve(null),
	]);

	if (workData === null) return null;

	// `_embedBaseUrl` は `summaly()` が `SummalyOptions.embedBaseUrl` を transparent 伝搬する
	// internal フィールド (phase13.1 Step 3 → 2026-05-08 補正)。
	const embedBaseUrl = opts?._embedBaseUrl;
	const summary = buildSummaryFromWork(workData.work, workData.authorName, url, embedBaseUrl);

	// chapter URL では description 末尾に各話タイトルを付与 (なろう phase13.1 と同パターン)
	if (episodeTitle != null) {
		summary.description = `${summary.description} / ${episodeTitle}`;
	}
	return summary;
}

export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const extracted = extractWorkAndEpisode(url);
	if (extracted === null) {
		throw new Error('kakuyomu renderEmbed: invalid URL (test() を通った URL のはずだが workId が抽出できない)');
	}
	const workTopUrl = new URL(`https://${url.hostname}/works/${extracted.workId}`);
	const workData = await fetchWorkData(workTopUrl, opts);
	if (workData === null) {
		// __NEXT_DATA__ parse 失敗 / Work エンティティ不在 (削除作品 / 構造変更)。
		// renderEmbed の null 返却は型契約上禁止なので throw して /embed 側で 500 に変換させる。
		throw new Error('kakuyomu renderEmbed: 作品が見つかりません (__NEXT_DATA__ parse 失敗 or Work entity 不在)');
	}
	const html = composeEmbedHtml(workData.work, workData.authorName);
	return { body: html, width: 3, height: 2 };
}

export const skipRedirectResolution = false;
