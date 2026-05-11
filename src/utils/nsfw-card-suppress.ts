import type Summary from '@/summary.js';

/**
 * NSFW プラグイン共通: card preview の抑制処理 (phase15.6)。
 *
 * `summary.sensitive === true` のとき以下を強制上書きする:
 * - `title` → `【<sitename>】<og:title>` の prefix 形式
 * - `description` → 固定文言 `【R-18】 内容を伏せています`
 * - `thumbnail` → `null` (作品サムネ非表示、`icon` は維持してサイト favicon を残す)
 * - `player.url` → `<embedBaseUrl>/embed?url=<encoded>` (`renderEmbed` 経由でフル表示する経路)
 *
 * `summary.sensitive !== true` のとき (例: dlsite の `/comic/` セーフパス、iwara `www.`) は
 * **そのまま返す**。NSFW でない作品は通常の preview として配信する設計意図。
 *
 * **player の oEmbed fallthrough 防止**: `embedBaseUrl` 未設定 (library mode 等) で `playerUrl == null`
 * のときも `parseGeneral` 由来の `summary.player` を引き継がず、明示的に
 * `{ url: null, width: null, height: null, allow: [] }` で上書きする。NSFW プラグインの設計意図として
 * 「embed 経由でしか作品情報を見せない」ため、外部動画プレイヤー URL が card に流れる経路を閉じる
 * (phase15.5 W-1 で対処したパターンを helper にも踏襲)。
 *
 * 採用プラグイン: `dmm` / `dlsite` (sensitive=true 経路のみ) / `iwara` (sensitive=true 経路のみ) /
 * `komiflo` (常時) / `nijie` (常時)。
 */
export function applyNsfwCardSuppression(
	summary: Summary,
	url: URL,
	embedBaseUrl: string | undefined,
): Summary {
	if (summary.sensitive !== true) return summary;

	const sitename = summary.sitename ?? 'site';
	const ogTitle = summary.title ?? '';
	const safeTitle = ogTitle !== '' ? `【${sitename}】${ogTitle}` : `【${sitename}】`;
	const playerUrl = composePlayerUrl(url, embedBaseUrl);

	return {
		...summary,
		title: safeTitle,
		description: '【R-18】 内容を伏せています',
		thumbnail: null,
		player: playerUrl != null
			? { url: playerUrl, width: 3, height: 2, allow: [] }
			: { url: null, width: null, height: null, allow: [] },
	};
}

/**
 * `/embed` 用の player URL を組み立てる。`embedBaseUrl` 未指定なら null。
 * (kakuyomu / syosetu / dmm と同型 helper)
 */
export function composePlayerUrl(url: URL, embedBaseUrl: string | undefined): string | null {
	if (embedBaseUrl == null || embedBaseUrl === '') return null;
	return `${embedBaseUrl.replace(/\/$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
}
