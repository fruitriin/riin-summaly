/**
 * Google Drive プレビュープラグイン (iframe player)。
 *
 * `drive.google.com/file/d/<id>/...` 形式の共有 URL について、Google 公式の embed URL
 * `https://drive.google.com/file/d/<id>/preview` を `Summary.player.url` に組み立てて返す。
 * Misskey 上で Drive の動画 / PDF / 画像 / Docs がインライン再生・表示される。
 *
 * **oEmbed は存在しない**ため、`youtube` / `spotify` のような oEmbed 直叩きではなく、
 * URL から file ID を抽出して player URL を構築する。
 *
 * **アスペクト比の自動判定 (phase19.1 followup)**: Drive の公開 thumbnail エンドポイント
 * `https://drive.google.com/thumbnail?id=<id>&sz=w<N>` は file の実アスペクト比を保った画像を返す
 * (縦動画なら縦長 JPEG)。これを取得して pixel 寸法を読み、`player.width` / `player.height` に
 * **実アスペクト比**を入れる。これにより **縦動画は縦長プレビュー**で表示される
 * (Misskey は height/width 比率で iframe の縦横比を計算するため)。取得失敗時は 16:9 にフォールバック。
 * thumbnail 画像自体も `Summary.thumbnail` に採用する。
 *
 * **title は /view ページの OGP から取得**: `facebookexternalhit/1.1` UA で `/view` を叩くと
 * `og:title` に file 名が入っている。匿名で取れる唯一のメタデータ。取得失敗時は null。
 *
 * **Google Photos 非対応**: `photos.google.com` は `x-frame-options: SAMEORIGIN` を返すため、
 * 第三者サイト (Misskey) の iframe には構造的に表示できない (実機確認 2026-06-01)。本プラグインは
 * Drive のみを扱う。詳細は [docs/plans/phase19.1-plugin-google-drive.md](../../docs/plans/phase19.1-plugin-google-drive.md)。
 */

import * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getResponse, DEFAULT_FALLBACK_UA } from '@/utils/got.js';
import { getImageDimensions } from '@/utils/image-dimensions.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';

export const name = 'google-drive';

const HOST = 'drive.google.com';
// `/file/d/<id>` 形式の file ID を抽出する。末尾は `/view` / `/preview` / `/edit` / なし いずれも許容。
// Drive の file ID は base64url 風 (`[a-zA-Z0-9_-]`)。最初の path セグメントだけ取るため `/` で区切れる。
// 長さ上限 `{10,200}`: 実 file ID は通常 28〜44 文字。異常に長い id を含むクラフト URL で player.url が
// 数万バイトに膨れるのを防ぐ防衛 (上限は将来の ID 形式変更を見越して余裕を持たせる、phase19.1 W-1)。
// 末尾を `(?:/|$)` で境界化することで、201 文字 id が「先頭 200 文字 prefix マッチ」で誤って通る/切り詰め
// られるのを防ぎ、長さ超過を確実に reject する (非アンカーの prefix マッチだと上限が効かないため)。
const FILE_ID_RE = /^\/file\/d\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/;

// thumbnail 取得幅。縦動画でも w1000 で十分な解像度になり、寸法判定には十分。
const THUMB_WIDTH = 1000;
// thumbnail / OGP 取得のサイズ・時間 cap (寸法判定はヘッダだけで足りるので小さめ)。
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8 * 1000;

export function test(url: URL): boolean {
	if (url.hostname !== HOST) return false;
	return FILE_ID_RE.test(url.pathname);
}

/**
 * **`summaly()` の初期 `resolveRedirect` (HEAD/GET probe) をスキップさせる宣言**。
 *
 * `/view` URL は HEAD probe (`SummalyBot` UA) でログインゲートにリダイレクトされうる。原 URL のまま
 * 本プラグイン経路に乗せて file ID 抽出を安定させるため宣言する (`yodobashi` / `dmm` と同じ防御)。
 */
export const skipRedirectResolution = true;

/** URL から file ID を抽出する (pure)。`/file/d/<id>` 以外は null。 */
export function extractFileId(url: URL): string | null {
	const m = FILE_ID_RE.exec(url.pathname);
	return m ? m[1] : null;
}

/**
 * file ID から /preview player URL を組み立て、Summary の基本形を返す (pure, I/O なし)。
 * アスペクト比はデフォルトの 16:9。title / thumbnail は呼び元 (`summarize`) が I/O で補完する。
 * 単体テストやフォールバック経路から使えるよう export。
 */
export function buildSummaryFromUrl(url: URL): Summary | null {
	const id = extractFileId(url);
	if (id == null) return null;
	// id は `[a-zA-Z0-9_-]` のみのため encodeURIComponent 不要。テンプレートに直接埋める。
	const playerUrl = `https://drive.google.com/file/d/${id}/preview`;
	// 防御: 組み立てた URL を再 parse して https を検証する (plugin-infrastructure-patterns の作法)。
	// 現状 playerUrl は完全ハードコードのテンプレートで必ず https になるため self-evident に通るが、
	// 将来 playerUrl の組み立て方が変わったときの安全網として残す (誤って削除しないこと、phase19.1 S-1)。
	try {
		if (new URL(playerUrl).protocol !== 'https:') return null;
	} catch {
		return null;
	}

	return {
		title: null,
		icon: 'https://drive.google.com/favicon.ico',
		description: null,
		thumbnail: null,
		player: {
			url: playerUrl,
			// Misskey は height/width 比率でアスペクトを解釈する。デフォルトは動画想定の 16:9。
			// summarize() が thumbnail から実アスペクト比を取れたら上書きする。
			width: 16,
			height: 9,
			allow: [...PLAYER_ALLOW_OEMBED],
		},
		sitename: 'Google Drive',
		activityPub: null,
		fediverseCreator: null,
	};
}

/** thumbnail エンドポイントの URL を組み立てる。 */
function thumbnailUrl(id: string): string {
	return `https://drive.google.com/thumbnail?id=${id}&sz=w${THUMB_WIDTH}`;
}

/**
 * thumbnail 画像を取得して pixel 寸法を返す。失敗時は null (呼び元は 16:9 fallback)。
 * 画像バイナリのヘッダだけ読めばよいので size cap は小さめ。
 */
async function fetchThumbnailDimensions(id: string, opts?: GeneralScrapingOptions): Promise<{ width: number; height: number } | null> {
	try {
		const res = await getResponse({
			url: thumbnailUrl(id),
			method: 'GET',
			headers: {
				'accept': 'image/*,*/*',
				'user-agent': opts?.userAgent ?? DEFAULT_FALLBACK_UA,
			},
			// Drive thumbnail は通常 image/jpeg、リダイレクト先 (lh3.googleusercontent.com) でも image/*。
			// application/binary / octet-stream は Drive が稀に content-type を落とす場合の保険として許容。
			typeFilter: /^(?:image\/|application\/(?:binary|octet-stream))/,
			responseTimeout: FETCH_TIMEOUT_MS,
			contentLengthLimit: FETCH_MAX_BYTES,
			followRedirects: true,
		});
		// got の rawBody は Uint8Array。getImageDimensions が Buffer 化を吸収する。
		const body = res.rawBody;
		if (body.length === 0) return null;
		return getImageDimensions(body);
	} catch {
		return null;
	}
}

/**
 * `/view` ページの OGP から file 名 (`og:title`) を取得する。失敗時は null。
 * `facebookexternalhit/1.1` UA で叩くと Drive が OGP を返す (匿名で取れる唯一のメタデータ)。
 */
async function fetchTitle(id: string, opts?: GeneralScrapingOptions): Promise<string | null> {
	try {
		const res = await getResponse({
			url: `https://drive.google.com/file/d/${id}/view`,
			method: 'GET',
			headers: {
				'accept': 'text/html,*/*',
				'user-agent': opts?.userAgent ?? DEFAULT_FALLBACK_UA,
			},
			typeFilter: /^text\/html/,
			responseTimeout: FETCH_TIMEOUT_MS,
			contentLengthLimit: FETCH_MAX_BYTES,
			followRedirects: true,
		});
		// res.body は getResponse 内の got<string> 由来の string。Drive の /view は UTF-8 のため
		// rawBody→toUtf8 の encoding 再判定は不要 (非 UTF-8 を返し始めたら toUtf8 経路に切替)。
		const $ = cheerio.load(String(res.body));
		const title = $('meta[property="og:title"]').attr('content');
		return typeof title === 'string' && title.length > 0 ? title : null;
	} catch {
		return null;
	}
}

/**
 * base Summary に取得したメタ (寸法 / title) をマージする (pure)。テスト容易化のため export。
 * `dims` が取れたら player のアスペクト比を実比率で上書き + thumbnail 採用。`title` が取れたら採用。
 * いずれも null なら base のデフォルト (16:9 + title/thumbnail null) を維持する。
 */
export function applyMeta(
	base: Summary,
	id: string,
	dims: { width: number; height: number } | null,
	title: string | null,
): Summary {
	if (dims != null) {
		// 実アスペクト比で上書き (縦動画は height > width で縦長プレビューになる)。
		base.player.width = dims.width;
		base.player.height = dims.height;
		// 取れた thumbnail を採用 (player 非対応クライアントでも向き付きの絵が出る)。
		base.thumbnail = thumbnailUrl(id);
	}
	if (title != null) {
		base.title = title;
	}
	return base;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const base = buildSummaryFromUrl(url);
	if (base == null) return null;
	const id = extractFileId(url);
	if (id == null) return base; // 到達しない (base != null なら id も取れている) が型安全のため

	// thumbnail 寸法と title を並列取得。どちらが失敗してもプレビュー自体は base で成立する。
	const [dims, title] = await Promise.all([
		fetchThumbnailDimensions(id, opts),
		fetchTitle(id, opts),
	]);

	return applyMeta(base, id, dims, title);
}
