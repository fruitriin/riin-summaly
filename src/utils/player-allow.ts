/**
 * oEmbed 系プラグインで共通利用する iframe `allow` の安全リスト。
 * upstream の [src/general.ts](../general.ts) の `getOEmbedPlayer()` 内 `safeList` と整合する。
 *
 * 個別プラグインで何らかの permission を絞りたい場合は、ここの定数を import せず
 * プラグイン内で部分集合を再定義する方針。
 *
 * `readonly` で複数プラグイン間の参照共有時の意図せぬ mutation を防ぐ。
 * `Summary.player.allow` への代入時はスプレッド (`[...PLAYER_ALLOW_OEMBED]`) でコピーする。
 */
export const PLAYER_ALLOW_OEMBED: readonly string[] = Object.freeze([
	'autoplay',
	'clipboard-write',
	'encrypted-media',
	'picture-in-picture',
	'web-share',
	'fullscreen',
]);
