import { escapeHtml } from '@/utils/escape-html.js';

/**
 * NSFW プラグイン共通: `/embed` 用 HTML 生成 (phase15.6、dmm.ts から移動)。
 *
 * すべてのユーザー入力 (title / description / sitename / thumbnail) は `escapeHtml` を通す。
 *
 * **CSP 設計**: 呼出側 (Fastify `/embed` ハンドラ) で `default-src 'none'` を強制することで
 * 外部 fetch / `<script>` / inline event handler を構造的に閉じ、`img-src https:` で画像のみ
 * https: 経由で許可、`style-src 'unsafe-inline'` で本ファイル内の `<style>` のみ許可する設計。
 * escape との二重防御で XSS が成立しない。
 *
 * 採用プラグイン: `dmm` / `dlsite` / `iwara` / `komiflo` / `nijie`。
 *
 * @param input.title 作品タイトル (escapeHtml される)
 * @param input.description 作品あらすじ / 説明 (escapeHtml される、空文字なら出力しない)
 * @param input.thumbnail 作品サムネ URL (`pickHttpsImage` で `https:` のみ通す、それ以外は `<img>` 出さない)
 * @param input.sitename サイト名 (escapeHtml される)
 */
export function composeNsfwEmbedHtml(input: {
	title: string;
	description: string;
	thumbnail: string | null;
	sitename: string;
}): string {
	const titleSafe = escapeHtml(input.title !== '' ? input.title : '(タイトル不明)');
	const descriptionSafe = escapeHtml(input.description);
	const sitenameSafe = escapeHtml(input.sitename);
	const thumbnailSafe = pickHttpsImage(input.thumbnail);

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; padding: 1rem; line-height: 1.5; color: #222; background: #fff; overflow-y: auto; }
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 0.25rem; word-break: break-word; }
.sitename { font-size: 0.8rem; color: #888; margin-bottom: 0.75rem; }
.thumb { margin-bottom: 0.75rem; }
.thumb img { max-width: 100%; height: auto; display: block; border-radius: 4px; }
.description { font-size: 0.9rem; white-space: pre-wrap; word-break: break-word; color: #333; }
</style>
</head>
<body>
<div class="title">${titleSafe}</div>
<div class="sitename">${sitenameSafe}</div>
${thumbnailSafe != null ? `<div class="thumb"><img src="${escapeHtml(thumbnailSafe)}" alt=""></div>` : ''}
${descriptionSafe !== '' ? `<div class="description">${descriptionSafe}</div>` : ''}
</body>
</html>`;
}

/**
 * `<img src>` に流す URL を `https:` のみに制限する簡易 sanitize。
 * embed HTML 側の CSP `img-src https:` で構造的にも閉じているが、二重防御で `<img>` 自体出さない。
 */
export function pickHttpsImage(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	return /^https:/i.test(value) ? value : null;
}
