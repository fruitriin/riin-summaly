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

import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import type { EmbedRenderResult } from '@/iplugin.js';
import { getResponse, DEFAULT_FALLBACK_UA } from '@/utils/got.js';
import { getImageDimensions } from '@/utils/image-dimensions.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';
import { renderScaledIframeEmbed } from '@/utils/scaled-iframe-embed.js';
import { composeEmbedPlayerUrl } from '@/utils/embed-player-url.js';

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
// Range で先頭のみ取得するバイト数。画像寸法ヘッダ (数十 byte) も og:title (<head> 内) もこれで足りる。
// Range 非対応で全体が返るケースは contentLengthLimit (FETCH_MAX_BYTES) が二重 cap する。
const HEADER_FETCH_BYTES = 64 * 1024;

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
export function previewUrl(id: string): string {
	return `https://drive.google.com/file/d/${id}/preview`;
}

/**
 * player.url を決める (pure)。
 * - `embedBaseUrl` あり (Fastify モードで embed 有効) → `<embedBaseUrl>/embed?url=<原 URL>` を返し、
 *   `renderEmbed` の **scale 縮小ラッパー** に繋ぐ (狭いカード幅でコントロールが崩れないようにする)。
 * - `embedBaseUrl` 無し (library mode / embed 無効) → Drive 公式 `/preview` iframe 直 (フォールバック)。
 */
// `embedBaseUrl` (= opts._embedBaseUrl) は **Fastify モード内部専用**で、本番では `SummalyOptions.embedBaseUrl`
// (config の `[embed].publicUrl`) から伝搬される https URL。dev サーバは `http://localhost` を渡す。
// 本番経路では embed の player.url は最終的に `index.ts` の sanitizeUrl を通る。library mode で外部から
// `_embedBaseUrl` に `http:` を直接渡すのは想定外で、その場合の結果は未定義 (W-2)。
export function composePlayerUrl(url: URL, id: string, embedBaseUrl: string | undefined): string {
	// embedBaseUrl ありなら共通ヘルパで /embed URL を組む。無ければ Drive `/preview` iframe 直に fallback。
	return composeEmbedPlayerUrl(url, embedBaseUrl) ?? previewUrl(id);
}

/**
 * file ID から player URL を組み立て、Summary の基本形を返す (pure, I/O なし)。
 * アスペクト比はデフォルトの 16:9。title / thumbnail は呼び元 (`summarize`) が I/O で補完する。
 * `embedBaseUrl` があれば player.url は embed エンドポイント経由 (scale 縮小)、無ければ Drive `/preview`。
 * 単体テストやフォールバック経路から使えるよう export。
 */
export function buildSummaryFromUrl(url: URL, embedBaseUrl?: string): Summary | null {
	const id = extractFileId(url);
	if (id == null) return null;
	const playerUrl = composePlayerUrl(url, id, embedBaseUrl);
	// 防御: 組み立てた URL を再 parse して https を検証する。embed (http://localhost dev) 経路では
	// 最終 sanitize (index.ts) に委ねるため、Drive `/preview` 直 (embedBaseUrl 無し) のみ https を強制。
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
 * **ヘッダだけ読めばよいので `Range: bytes=0-<cap>` で先頭のみ要求** (全体 DL を避ける、PR #2 review)。
 */
async function fetchThumbnailDimensions(id: string, opts?: GeneralScrapingOptions): Promise<{ width: number; height: number } | null> {
	try {
		const res = await getResponse({
			url: thumbnailUrl(id),
			method: 'GET',
			headers: {
				'accept': 'image/*,*/*',
				'user-agent': opts?.userAgent ?? DEFAULT_FALLBACK_UA,
				// 画像寸法はヘッダ先頭数十 byte で判る。Range で先頭のみ要求 (Drive/googleusercontent は Range 対応)。
				// Range 非対応で 200 全体が返っても contentLengthLimit が二重に cap する。
				'range': `bytes=0-${HEADER_FETCH_BYTES - 1}`,
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
 * `og:title` は `<head>` 内にあるため **`Range` で先頭のみ取得**し、cheerio でなく軽量な正規表現で抽出する
 * (重い Drive SPA HTML 全体の DOM 構築を避ける、PR #2 review)。
 */
async function fetchTitle(id: string, opts?: GeneralScrapingOptions): Promise<string | null> {
	try {
		const res = await getResponse({
			url: `https://drive.google.com/file/d/${id}/view`,
			method: 'GET',
			headers: {
				'accept': 'text/html,*/*',
				'user-agent': opts?.userAgent ?? DEFAULT_FALLBACK_UA,
				'range': `bytes=0-${HEADER_FETCH_BYTES - 1}`,
			},
			typeFilter: /^text\/html/,
			responseTimeout: FETCH_TIMEOUT_MS,
			contentLengthLimit: FETCH_MAX_BYTES,
			followRedirects: true,
		});
		// res.body は getResponse 内の got<string> 由来の string。Drive の /view は UTF-8。
		return extractOgTitle(String(res.body));
	} catch {
		return null;
	}
}

/** HTML 文字列から `og:title` の content を抽出する (pure, cheerio 不要)。テスト容易化のため export。 */
export function extractOgTitle(html: string): string | null {
	// <meta property="og:title" content="..."> を property/content の順序非依存で抽出。
	const tag = /<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html)?.[0]
		?? /<meta[^>]+content=["'][^"']*["'][^>]*property=["']og:title["'][^>]*>/i.exec(html)?.[0];
	if (tag == null) return null;
	const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
	if (content == null || content === '') return null;
	// HTML entity の最小デコード (og:title に現れがちな &amp; / &quot; / &#39; / &lt; / &gt;)。
	return content
		.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;/g, '\'')
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Drive file の **メタ (実アスペクト比 dims + file 名 title) を 1 回だけ解決する** (PR #2 review)。
 * `summarize` と `renderEmbed` の双方から呼ばれ、二重フェッチを避けるため共通化。
 * 各フェッチは独立 try/catch で、どちらが失敗してもプレビューは base (16:9 / null) で成立する。
 */
async function resolveDriveMeta(id: string, opts?: GeneralScrapingOptions): Promise<{ dims: { width: number; height: number } | null; title: string | null }> {
	const [dims, title] = await Promise.all([
		fetchThumbnailDimensions(id, opts),
		fetchTitle(id, opts),
	]);
	return { dims, title };
}

// **player の箱サイズ決定**。Misskey の `MkUrlPreview.vue` は player.width の有無で高さ計算を変える:
//   - `player.width` あり → `padding-top: (height/width)*100%` (**比率固定** = 幅に応じて高さ可変)
//   - `player.width` が falsy → `padding-top: <height>px` (**絶対 px 固定** = 画面幅に依存せず一定)
//
// **縦動画は固定 px 高さモード**: summaly は PC/SP を判別できない固定レスポンスのため、縦動画 (h/w>1) を
// 比率で渡すとデスクトップの広いカード幅で高さが過大になり画面を埋める (実機確認 2026-06-01)。そこで縦動画は
// **`width=null` + `height=PORTRAIT_FIXED_HEIGHT_PX`** を返し、デスクトップ/スマホ問わず高さを一定に固定する。
// その固定 px の箱に内側 Drive iframe を実比率のまま contain (レターボックス) するのでクロップされない。
// 横動画・正方形 (h/w<=1) は従来通り比率 (width/height) で幅に応じた自然な高さにする。
const PORTRAIT_THRESHOLD = 1.0; // h/w がこれを超えたら縦動画扱い (固定 px 高さモード)
const PORTRAIT_FIXED_HEIGHT_PX = 480; // 縦動画の固定表示高さ (px)。デスクトップ/スマホ共通。実機調整可

/**
 * 実寸 dims を player の箱に落とす。縦動画は `width=null`+固定 px 高さ、それ以外は実比率 (width/height)。
 */
function playerBox(width: number, height: number): { width: number | null; height: number } {
	if (height / width > PORTRAIT_THRESHOLD) {
		// 縦動画: 固定 px 高さモード (Misskey が画面幅に依存せず height px で箱を作る)。
		return { width: null, height: PORTRAIT_FIXED_HEIGHT_PX };
	}
	return { width, height };
}

/**
 * base Summary に取得したメタ (寸法 / title) をマージする (pure)。テスト容易化のため export。
 * `dims` が取れたら player のアスペクト比を実比率 (極端比は clamp) で上書きする。
 * **thumbnail は dims 取得可否に関わらず id があれば採用** (thumbnail URL は寸法判定と独立に valid、
 * PR #2 review #9: dims が大きすぎ/破損で null でも絵は出す)。`title` が取れたら採用。
 */
export function applyMeta(
	base: Summary,
	id: string,
	dims: { width: number; height: number } | null,
	title: string | null,
): Summary {
	if (dims != null) {
		// 縦動画は width=null+固定 px 高さ、それ以外は実比率。内側 iframe は contain でレターボックス。
		const { width, height } = playerBox(dims.width, dims.height);
		base.player.width = width;
		base.player.height = height;
	}
	// thumbnail は dims と独立に採用 (player 非対応クライアントでも絵が出る)。
	base.thumbnail = thumbnailUrl(id);
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

	const { dims, title } = await resolveDriveMeta(id, opts);
	return applyMeta(base, id, dims, title);
}

/** Drive origin (embed CSP `frame-src` 用)。 */
const DRIVE_FRAME_ORIGIN = 'https://drive.google.com';
/**
 * Drive `/preview` プレイヤーのコントロールが崩れない内部描画幅 (px)。
 * **スマホ UI 対応で 900px**: Drive はタッチデバイスを検出するとコントロールボタンを大きいスマホ用 UI に
 * 切り替える。デスクトップでは 600px で崩れなかったがスマホ (DevTools エミュレート含む) では 900px から
 * 崩れなくなることを実機確認 (2026-06-01)。汎用 scale ラッパーにこの実測値を渡す。
 */
const DRIVE_RENDER_WIDTH = 900;

/**
 * `/embed` 用 HTML を返す (Fastify モード)。Drive `/preview` iframe を汎用 scale ラッパー
 * (`renderScaledIframeEmbed`) で **CSS scale 縮小**して狭い Misskey カード幅でもコントロールが
 * 崩れないようにする。thumbnail 寸法から実アスペクト比を取り (極端比は applyMeta と同じ clamp)、
 * 取れなければ 16:9。`cspDirectives['frame-src']` で Drive origin を CSP に許可。
 */
export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
	const id = extractFileId(url);
	if (id == null) {
		// test() を通った URL のみ呼ばれる契約だが、防御的に最小フォールバックを返す。
		// src: '' を渡すと renderScaledIframeEmbed 内の pickHttpsUrl が null 判定 → iframe なしの
		// フォールバック HTML (「表示できませんでした」) になる。
		return { body: renderScaledIframeEmbed({ src: '', title: null, aspectW: 16, aspectH: 9, renderWidth: DRIVE_RENDER_WIDTH }), width: 16, height: 9 };
	}

	const { dims, title } = await resolveDriveMeta(id, opts);
	// **外枠 (player.width/height = Misskey の embed iframe の箱)** は applyMeta と同じく playerBox で決める
	//   (縦動画は width=null+固定 px 高さ、横動画は実比率)。**内側 iframe** は **実比率** を渡し、箱に contain
	//   (`scale(min(cqi, cqb))`) でレターボックス表示する。これにより縦動画はデスクトップ/スマホで高さ一定、
	//   かつクロップされず実比率のまま収まる。dims 不明なら 16:9。
	const inner = dims ?? { width: 16, height: 9 };

	const body = renderScaledIframeEmbed({ src: previewUrl(id), title, aspectW: inner.width, aspectH: inner.height, renderWidth: DRIVE_RENDER_WIDTH });
	// EmbedRenderResult.width/height は embed エンドポイントでは未使用 (アスペクト比メタ情報)。実比率を返す。
	// 実際の player の箱サイズ (縦動画 width=null+固定 px) は summarize→applyMeta が summary 側に設定する。
	return { body, width: inner.width, height: inner.height, cspDirectives: { 'frame-src': [DRIVE_FRAME_ORIGIN] } };
}
