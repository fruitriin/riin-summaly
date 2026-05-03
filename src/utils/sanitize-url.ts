/**
 * 結果に含まれる URL のプロトコルを検査して安全なものだけ通す。
 * - `https:` / `http:` → そのまま通す
 * - `data:` → DoS 緩和のため長さ上限（DEFAULT_DATA_URL_LIMIT）以内のみ通す
 * - それ以外（`javascript:`, `file:` 等）→ null
 *
 * 利用例（[src/index.ts](../index.ts) の最終リターン直前）:
 *   summary.icon = sanitizeUrl(summary.icon);
 *   summary.thumbnail = sanitizeUrl(summary.thumbnail);
 *   summary.player.url = sanitizeUrl(summary.player.url);
 *   summary.medias = summary.medias?.map(sanitizeUrl).filter((u): u is string => u != null);
 */

/** data: URI の許容長（バイト換算で 10 KB） */
export const DEFAULT_DATA_URL_LIMIT = 10 * 1024;

export function sanitizeUrl(input: string | null | undefined, dataUrlLimit: number = DEFAULT_DATA_URL_LIMIT): string | null {
	if (input == null) return null;
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}

	switch (parsed.protocol) {
		case 'https:':
		case 'http:':
			return trimmed;
		case 'data:':
			// メモリ消費の上限としてバイト長で評価（非 ASCII の URL エンコード文字を含むケースに対応）
			if (Buffer.byteLength(trimmed, 'utf8') > dataUrlLimit) return null;
			return trimmed;
		default:
			return null;
	}
}
