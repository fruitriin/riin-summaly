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
 * **自前 `<video>` プレイヤー (phase19.1 followup #3)**: Drive の `/preview` iframe はスマホ幅で
 * コントロール UI が崩れる (Drive 側の問題で summaly からは直せない)。`embedBaseUrl` が設定されている
 * (= Fastify モードで embed 有効) 場合、`player.url` を Drive iframe ではなく summaly の
 * `/embed?url=...` に向け、`renderEmbed` で Drive 直ストリーミング URL を流した自前の HTML5
 * `<video controls>` を返す。これで Drive UI を介さずレスポンシブ再生になる。`embedBaseUrl` が無い
 * (library mode / embed 無効) 場合は従来通り Drive `/preview` iframe にフォールバックする。
 *
 * **Google Photos 非対応**: `photos.google.com` は `x-frame-options: SAMEORIGIN` を返すため、
 * 第三者サイト (Misskey) の iframe には構造的に表示できない (実機確認 2026-06-01)。本プラグインは
 * Drive のみを扱う。詳細は [docs/plans/phase19.1-plugin-google-drive.md](../../docs/plans/phase19.1-plugin-google-drive.md)。
 */

import * as cheerio from 'cheerio';
import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { getResponse, DEFAULT_FALLBACK_UA } from '@/utils/got.js';
import { getImageDimensions } from '@/utils/image-dimensions.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';
import { resolveDownloadUrl, DRIVE_DOWNLOAD_ORIGIN } from '@/utils/drive-download.js';
import { composeDriveVideoEmbedHtml } from '@/utils/drive-video-embed.js';

export const name = 'google-drive';

const HOST = 'drive.google.com';
// `/file/d/<id>` 形式の file ID を抽出する。末尾は `/view` / `/preview` / `/edit` / なし いずれも許容。
// Drive の file ID は base64url 風 (`[a-zA-Z0-9_-]`)。最初の path セグメントだけ取るため `/` で区切れる。
// 長さ上限 `{10,200}`: 実 file ID は通常 28〜44 文字。異常に長い id を含むクラフト URL で player.url が
// 数万バイトに膨れるのを防ぐ防衛 (上限は将来の ID 形式変更を見越して余裕を持たせる、phase19.1 W-1)。
// 末尾を `(?:/|$)` で境界化することで、201 文字 id が「先頭 200 文字 prefix マッチ」で誤って通る/切り詰め
// られるのを防ぎ、長さ超過を確実に reject する (非アンカーの prefix マッチだと上限が効かないため)。
const FILE_ID_RE = /^\/file\/d\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/;

// Drive `/preview` プレイヤーの **コントロールバー補正** (phase19.1 followup #2)。
//
// Drive の iframe player はコントロールバー (シーク / 再生 / 時間 / 音量 / 速度 / 歯車) を
// **固定高さ**で動画の上下に重ねる UI を持つ。スマホ等の狭い表示幅で iframe 実ピクセル幅が
// 小さくなると、実寸アスペクト比 (特に縦動画の 9:16 等) をそのまま渡したとき iframe が細長くなり、
// コントロールバーが動画領域を圧迫して UI が破綻する (横はみ出し / 動画ほぼ潰れ)。
//
// 対策: player に渡す **高さ比率にコントロールバー分の余白を上乗せ** する。Misskey は
// height/width 比率でアスペクトを計算するため、`height += width * (BAR_PX / BASE_WIDTH_PX)` で
// 「動画幅に対するバー高さ比」を加算すれば、動画は実寸比を保ちつつ操作 UI 用の帯が確保される。
//
// **数値は実機調整前提**: BASE 幅 640px のとき Drive のバーは概ね ~48px (= 幅の 7.5%)。
// 横動画では相対的に小さく影響軽微、縦動画では下に操作帯が乗って崩れにくくなる。崩れ方を見て調整する。
const CONTROL_BAR_PX = 48;
const CONTROL_BAR_BASE_WIDTH_PX = 640;

/**
 * 実寸 (または 16:9) の幅・高さに、Drive コントロールバー分の余白を高さに上乗せした比率を返す (pure)。
 * width はそのまま、height に `width * (CONTROL_BAR_PX / CONTROL_BAR_BASE_WIDTH_PX)` を加算する。
 */
export function withControlBar(width: number, height: number): { width: number; height: number } {
	if (!(width > 0) || !(height > 0)) return { width, height };
	const barHeight = Math.round(width * (CONTROL_BAR_PX / CONTROL_BAR_BASE_WIDTH_PX));
	return { width, height: height + barHeight };
}

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

/** Drive 公式 `/preview` iframe URL を組み立てる。 */
function previewUrl(id: string): string {
	return `https://drive.google.com/file/d/${id}/preview`;
}

/**
 * player.url を決める (pure)。
 * - `embedBaseUrl` あり (Fastify モードで embed 有効) → `<embedBaseUrl>/embed?url=<原 URL>` を返し、
 *   renderEmbed の自前 `<video>` プレイヤーに繋ぐ (スマホでコントロールが崩れない)。
 * - `embedBaseUrl` 無し (library mode / embed 無効) → Drive 公式 `/preview` iframe にフォールバック。
 */
export function composePlayerUrl(url: URL, id: string, embedBaseUrl: string | undefined): string {
	if (embedBaseUrl != null && embedBaseUrl !== '') {
		// 末尾スラッシュ (複数含む) を除去してから /embed を足す。
		return `${embedBaseUrl.replace(/\/+$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
	}
	return previewUrl(id);
}

/**
 * file ID から player URL を組み立て、Summary の基本形を返す (pure, I/O なし)。
 * アスペクト比はデフォルトの 16:9。title / thumbnail は呼び元 (`summarize`) が I/O で補完する。
 * `embedBaseUrl` があれば player.url は embed エンドポイント経由 (自前 video)、無ければ Drive `/preview`。
 * 単体テストやフォールバック経路から使えるよう export。
 */
export function buildSummaryFromUrl(url: URL, embedBaseUrl?: string): Summary | null {
	const id = extractFileId(url);
	if (id == null) return null;
	const playerUrl = composePlayerUrl(url, id, embedBaseUrl);
	// 防御: 組み立てた URL を再 parse して https を検証する (plugin-infrastructure-patterns の作法)。
	// embedBaseUrl が http: の dev サーバ等のケースもあるため、ここでの検証は最終 sanitize (index.ts) に委ねる
	// が、Drive `/preview` 経路 (embedBaseUrl 無し) では必ず https になることを確認する安全網として残す。
	try {
		const proto = new URL(playerUrl).protocol;
		if (embedBaseUrl == null && proto !== 'https:') return null;
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
 *
 * `usesIframeFallback`: player が Drive `/preview` iframe の場合のみ true。iframe はスマホでコントロールが
 * 崩れるため `withControlBar` で余白を加算する。自前 `<video>` プレイヤー (embed 経由) ではネイティブ
 * コントロールが崩れないので、実アスペクト比をそのまま使う (余白なし)。
 */
export function applyMeta(
	base: Summary,
	id: string,
	dims: { width: number; height: number } | null,
	title: string | null,
	usesIframeFallback = true,
): Summary {
	if (dims != null) {
		// 実アスペクト比で上書き (縦動画は height > width で縦長プレビューになる)。
		const { width, height } = usesIframeFallback ? withControlBar(dims.width, dims.height) : dims;
		base.player.width = width;
		base.player.height = height;
		// 取れた thumbnail を採用 (player 非対応クライアントでも向き付きの絵が出る)。
		base.thumbnail = thumbnailUrl(id);
	}
	if (title != null) {
		base.title = title;
	}
	return base;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const embedBaseUrl = opts?._embedBaseUrl;
	const base = buildSummaryFromUrl(url, embedBaseUrl);
	if (base == null) return null;
	const id = extractFileId(url);
	if (id == null) return base; // 到達しない (base != null なら id も取れている) が型安全のため

	// thumbnail 寸法と title を並列取得。どちらが失敗してもプレビュー自体は base で成立する。
	const [dims, title] = await Promise.all([
		fetchThumbnailDimensions(id, opts),
		fetchTitle(id, opts),
	]);

	// embedBaseUrl 有り = 自前 video プレイヤー経路 → コントロールバー余白は不要。
	const usesIframeFallback = embedBaseUrl == null || embedBaseUrl === '';
	return applyMeta(base, id, dims, title, usesIframeFallback);
}

/**
 * `/embed` 用 HTML を返す (Fastify モード)。Drive 直ストリーミング URL を解決して自前の HTML5
 * `<video controls>` プレイヤーを返す。`mediaSrc` で Drive 配信元を CSP に許可させる。
 *
 * 解決失敗時も HTML 自体は返す (「動画を読み込めませんでした」表示)。アスペクト比 (width/height) は
 * thumbnail 寸法から取り、取れなければ 16:9。
 */
export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const id = extractFileId(url);
	if (id == null) {
		// test() を通った URL のみ呼ばれる契約だが、防御的に最小フォールバックを返す。
		return { body: composeDriveVideoEmbedHtml({ videoUrl: null, title: null, poster: null }), width: 16, height: 9 };
	}

	// 直ストリーミング URL 解決 + 寸法 + title を並列取得。
	const [videoUrl, dims, title] = await Promise.all([
		resolveDownloadUrl(id, opts),
		fetchThumbnailDimensions(id, opts),
		fetchTitle(id, opts),
	]);

	const poster = dims != null ? thumbnailUrl(id) : null;
	const body = composeDriveVideoEmbedHtml({ videoUrl, title, poster });
	// 自前 video は実アスペクト比そのまま (コントロールバー余白なし)。寸法不明なら 16:9。
	const width = dims?.width ?? 16;
	const height = dims?.height ?? 9;
	// videoUrl 解決成功時のみ media-src を宣言 (CSP 最小権限。video が無いなら許可も出さない)。
	return videoUrl != null
		? { body, width, height, mediaSrc: [DRIVE_DOWNLOAD_ORIGIN] }
		: { body, width, height };
}
