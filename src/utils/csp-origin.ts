/**
 * embed エンドポイントの CSP ディレクティブ (`frame-src` / `media-src` 等) に渡す origin の検証。
 *
 * `EmbedRenderResult.cspDirectives` でプラグインが宣言した外部 origin を CSP に反映する際、
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

/**
 * embed プラグインが宣言する `EmbedRenderResult.cspDirectives` を CSP ディレクティブ文字列の配列に変換する。
 *
 * - ディレクティブ名は **許可リスト** (`ALLOWED_CSP_DIRECTIVES`) で制限 (任意のディレクティブ注入を防ぐ)。
 * - 各 origin は `filterCspOrigins` で origin-only `https:` に再検証 (ヘッダインジェクション防御)。
 * - 有効な origin が 1 つも無いディレクティブは出力しない (fail-close)。
 *
 * 例: `{ 'frame-src': ['https://drive.google.com'] }` → `['frame-src https://drive.google.com']`。
 * これを `cspParts` に push することで、embed 本番 (index.ts) と dev (dev/server.ts) の CSP 構築を共通化する。
 */
const ALLOWED_CSP_DIRECTIVES = new Set(['frame-src', 'media-src', 'child-src', 'connect-src']);

export function buildCspDirectiveParts(directives: Record<string, string[]> | undefined): string[] {
	if (directives == null) return [];
	const parts: string[] = [];
	for (const [name, origins] of Object.entries(directives)) {
		if (!ALLOWED_CSP_DIRECTIVES.has(name)) continue;
		const safe = filterCspOrigins(origins);
		if (safe.length > 0) parts.push(`${name} ${safe.join(' ')}`);
	}
	return parts;
}
