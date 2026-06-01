/**
 * `renderEmbed` 対応プラグインの `Summary.player.url` を summaly の `/embed` エンドポイントに向ける
 * URL を組み立てる **コア共通ヘルパ** (PR #2 review #7 で 4 プラグインの重複を統合)。
 *
 * `embedBaseUrl` (= config の `[embed].publicUrl`) が設定されていれば
 * `<embedBaseUrl>/embed?url=<encodeURIComponent(原 URL)>` を返し、未設定なら null (= player 無効、
 * card style のみ)。末尾スラッシュは **複数含めて除去** (`/\/+$/`。`publicUrl` が `//` 終端でも `//embed`
 * にならない。syosetu/kakuyomu の旧 `/\/$/` は 1 個しか除去できない潜在バグだった)。
 */
export function composeEmbedPlayerUrl(url: URL, embedBaseUrl: string | undefined): string | null {
	if (embedBaseUrl == null || embedBaseUrl === '') return null;
	return `${embedBaseUrl.replace(/\/+$/, '')}/embed?url=${encodeURIComponent(url.href)}`;
}
