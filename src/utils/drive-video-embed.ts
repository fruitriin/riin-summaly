/**
 * Google Drive 用 `/embed` HTML 生成: 自前の HTML5 `<video>` プレイヤー (phase19.1 followup #3)。
 *
 * Drive の `/preview` iframe player がスマホ幅でコントロール UI を崩す問題を回避するため、
 * Drive の直ストリーミング URL (`drive.usercontent.google.com/download?...`) を `<video controls>` に
 * 流して、レスポンシブで素直なネイティブプレイヤーを返す。
 *
 * **CSP 設計**: 呼出側 (Fastify `/embed`) が `default-src 'none'` を強制し、本プラグインが
 * `EmbedRenderResult.mediaSrc = [DRIVE_DOWNLOAD_ORIGIN]` を宣言することで `media-src` だけ許可する。
 * `<script>` / inline event handler は構造的に閉じる。`videoUrl` は `https:` のみ通す + escapeHtml の二重防御。
 */

import { escapeHtml } from '@/utils/escape-html.js';

/**
 * `<video src>` HTML を組み立てる。`videoUrl` は `https:` のみ許可 (それ以外は null 扱いで再生不可表示)。
 * `title` は escape して `<title>` と画面に出す。テスト容易化のため pure。
 */
export function composeDriveVideoEmbedHtml(input: {
	videoUrl: string | null;
	title: string | null;
	poster: string | null;
}): string {
	const videoSafe = pickHttpsUrl(input.videoUrl);
	const posterSafe = pickHttpsUrl(input.poster);
	const titleSafe = escapeHtml(input.title != null && input.title !== '' ? input.title : 'Google Drive');

	// 動画 URL が解決できなかった場合のフォールバック (再生不可メッセージ)。
	const playerHtml = videoSafe != null
		? `<video controls playsinline preload="metadata"${posterSafe != null ? ` poster="${escapeHtml(posterSafe)}"` : ''} src="${escapeHtml(videoSafe)}"></video>`
		: '<div class="fallback">動画を読み込めませんでした</div>';

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
body { display: flex; align-items: center; justify-content: center; }
video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
.fallback { color: #ccc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.9rem; padding: 1rem; text-align: center; }
</style>
</head>
<body>
${playerHtml}
</body>
</html>`;
}

/** `https:` の URL のみ通す。それ以外は null。URL parse して protocol を厳密判定 (大文字 scheme も正規化)。 */
export function pickHttpsUrl(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	try {
		return new URL(value).protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}
