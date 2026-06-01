/**
 * embed エンドポイントの CSP ディレクティブ (`frame-src` / `media-src` 等) に渡す origin の検証。
 *
 * `EmbedRenderResult.frameSrc` 等でプラグインが宣言した外部 origin を CSP に反映する際、
 * **origin-only の `https:` URL** だけを通す (path / query / hash / `;` 混入を弾く)。これにより
 * `frameAncestors` と同じ CSP ヘッダインジェクション (`https://x.com; script-src *` 等) を構造的に防ぐ。
 *
 * 本番 (`src/index.ts`) と dev (`dev/server.ts`) の embed ハンドラで共有し、二重実装の乖離を防ぐ。
 */

/** origin-only の `https:` URL のみ通す (scheme + host[:port] のみ、path/query/hash 不可)。 */
export function filterCspOrigins(origins: readonly string[] | undefined): string[] {
	return (origins ?? []).filter((o): o is string => {
		try {
			const u = new URL(o);
			return u.protocol === 'https:' && u.pathname === '/' && u.search === '' && u.hash === '' && o === u.origin;
		} catch {
			return false;
		}
	});
}
