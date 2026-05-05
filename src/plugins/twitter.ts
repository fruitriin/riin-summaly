/**
 * X (旧 Twitter) プラグイン (phase6.1)。
 *
 * `(twitter|x).com/<user>/status/<id>` 形式の URL について、
 * `cdn.syndication.twimg.com/tweet-result` から JSON を取得して description / thumbnail /
 * sitename / sensitive / medias[] を組み立てる。さらに `https://platform.twitter.com/embed/Tweet.html?id=<id>`
 * の公式 X widget iframe を `player.url` として返し、Misskey 等の利用側で展開できるようにする。
 *
 * **メンテナンス上の警告**:
 * - `cdn.syndication.twimg.com` は X の内部 CDN（公開 API ではない）であり、token 算出ロジックも
 *   公式 widget の挙動を逆算した黒魔術。X 側仕様変更で **いつでも壊れうる** 前提で運用する。
 * - 元実装: mei23 fork ([worktrees/mei-summaly/src/plugins/twitter.ts](../../worktrees/mei-summaly/src/plugins/twitter.ts))
 */

import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getJson } from '@/utils/got.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';

export const name = 'twitter';

const STATUS_RE = /^\/(?:[^/]+)\/status\/(\d+)/;

// 公式 X widget Tweet 埋め込みの標準寸法。CDN レスポンスは寸法を返さないため固定値。
// 利用側 (Misskey) で iframe の width/height を override する想定。
const PLAYER_WIDTH = 550;
const PLAYER_HEIGHT = 600;

const ICON_URL = 'https://abs.twimg.com/favicons/twitter.3.ico';

export function test(url: URL): boolean {
	return /^(?:twitter|x)\.com$/.test(url.hostname) && STATUS_RE.test(url.pathname);
}

/**
 * `cdn.syndication.twimg.com/tweet-result` 用トークン算出。
 * 公式 X widget が内部で行っている計算を逆算したロジック。
 * `id / 1e15 * π` を 36 進数化し `0` と `.` を除去する。
 *
 * **このロジックは X 側仕様変更で予告なく壊れる**。修正時は最新の公式 widget の
 * minified JS を解析する必要がある（mei23 fork が壊れたら同 fork の更新も参照する）。
 */
export function calcToken(idStr: string): string {
	const n = (Number(idStr) / 1e15) * Math.PI;
	return n.toString(36).replace(/(0+|\.)/g, '');
}

/** cdn.syndication.twimg.com/tweet-result の最低限のレスポンス型 */
type TweetCdnResponse = {
	text?: string;
	user?: {
		name?: string;
		profile_image_url_https?: string;
	};
	photos?: { url?: string }[];
	video?: { poster?: string };
	entities?: {
		media?: { indices?: number[] }[];
	};
	possibly_sensitive?: boolean;
};

/**
 * CDN レスポンスから Summary を組み立てる。テストから直接呼べるよう export。
 * ネットワーク I/O を含まないため、フィクスチャ JSON を渡して挙動検証できる。
 */
export function buildSummary(id: string, json: unknown): Summary | null {
	if (typeof json !== 'object' || json === null) return null;
	const j = json as TweetCdnResponse;

	let text = j.text ?? '';
	// 本文末尾の t.co 添付メディア URL を除去（mei23 ロジック踏襲）。
	// X の text フィールドは「本文 + 短縮 URL」の形で来るため、添付があれば短縮 URL を切り捨てる。
	const tco0 = j.entities?.media?.[0]?.indices?.[0];
	if (typeof tco0 === 'number') {
		text = text.substring(0, tco0).trimEnd();
	}

	// `_normal.` を除去してオリジナルサイズのプロフィール画像を取得する
	const profileImage = j.user?.profile_image_url_https
		? j.user.profile_image_url_https.replace(/_normal\./, '.')
		: null;
	const thumbnail = j.video?.poster ?? j.photos?.[0]?.url ?? profileImage ?? null;

	// 複数画像がある場合は medias[] に全画像を乗せる
	const photoUrls = j.photos
		?.map(p => p.url)
		.filter((u): u is string => typeof u === 'string');

	const summary: Summary = {
		title: j.user?.name ? `${j.user.name} on X` : 'X',
		icon: ICON_URL,
		description: text || null,
		thumbnail,
		sitename: 'X',
		sensitive: j.possibly_sensitive ?? false,
		player: {
			url: `https://platform.twitter.com/embed/Tweet.html?id=${id}`,
			width: PLAYER_WIDTH,
			height: PLAYER_HEIGHT,
			allow: [...PLAYER_ALLOW_OEMBED],
		},
		activityPub: null,
		fediverseCreator: null,
	};
	if (photoUrls && photoUrls.length > 0) {
		summary.medias = photoUrls;
	}
	return summary;
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const m = STATUS_RE.exec(url.pathname);
	if (!m) return null;
	const id = m[1];
	const token = calcToken(id);
	const cdnUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`;
	// referer は公式 widget 経由の体裁（X 側 anti-abuse の通過率を上げる）
	const json = await getJson(cdnUrl, 'https://platform.twitter.com/embed/index.html', opts);
	return buildSummary(id, json);
}
