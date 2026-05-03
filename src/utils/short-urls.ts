/**
 * Fastify モード（`followRedirects: false`）でも HEAD で URL を解決する許可リスト。
 * 「サービス公式」の短縮 URL に限定する（一般的な bit.ly / t.co 等を入れると SSRF 拡大の余地が広がる）。
 *
 * - `youtu.be` → `youtube.com/watch?v=...`
 * - `amzn.to` / `amzn.asia` / `a.co` → Amazon 商品ページ
 * - `w.wiki` → Wikipedia 記事ページ
 * - `spotify.link` → Spotify ページ（branchio 経由のディープリンク）
 */
export const KNOWN_SHORT_HOSTS = new Set<string>([
	'youtu.be',
	'amzn.to',
	'amzn.asia',
	'a.co',
	'w.wiki',
	'spotify.link',
]);
