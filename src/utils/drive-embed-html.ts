/**
 * Google Drive 用 `/embed` HTML 生成: Drive `/preview` iframe を CSS で **scale 縮小** して
 * 狭い Misskey カード幅でもコントロール UI が崩れないようにラップする (phase19.1 followup #4)。
 *
 * **背景**: Drive の `/preview` プレイヤーはコントロールバーに最小幅 (実測 ~600px) があり、Misskey
 * カード内の狭い実描画幅 (~200px) ではコントロールが崩れて操作不能になる (Drive 側 UI の問題で
 * iframe のアスペクト比調整では直せない、`/preview` を直接スマホで開いても崩れる)。
 *
 * **解決**: 内部 Drive iframe を **固定 `RENDER_WIDTH` (600px、コントロールが崩れない最小幅) で描画**し、
 * CSS の **container query length unit (`cqi`)** で `transform: scale(calc(100cqi / 600px))` を掛けて
 * コンテナ (= embed iframe = カード幅) に追従縮小する。Drive プレイヤーは「自分は 600px 幅」と認識して
 * コントロールを崩さず描画し、それを CSS でカード幅に縮小表示する。JS 不要 (= embed CSP `default-src 'none'`
 * を緩めない、`<script>` なし)。実機検証で横/縦動画 + 200/300/350px 幅すべて崩れず動作を確認 (2026-06-01)。
 *
 * **CSP**: 内部に外部 iframe を埋め込むため、embed エンドポイントが `EmbedRenderResult.frameSrc =
 * ['https://drive.google.com']` 経由で CSP `frame-src` に Drive origin を追加する (origin-only 再検証)。
 */

import { escapeHtml, escapeAttr } from '@/utils/escape-html.js';

/**
 * Drive プレイヤーのコントロールが崩れない最小描画幅 (実測。これ未満だと UI が壊れる)。
 *
 * **スマホ UI 対応で 900px**: Drive プレイヤーは **タッチデバイスを検出するとコントロールボタンを
 * 大きいスマホ用 UI に切り替える**。デスクトップでは 600px で崩れなかったが、スマホ (DevTools
 * エミュレート含む) では大きいボタンが収まらず崩れる。実機検証で **900px から崩れなくなる**ことを
 * 確認 (2026-06-01、横動画 + スマホエミュレート)。RW を大きくすると scale 値が小さくなり (= コントロールも
 * 小さく表示される) が、崩れて操作不能になるよりは良いトレードオフ。
 */
const RENDER_WIDTH = 900;

/**
 * Drive `/preview` を scale 縮小してラップする embed HTML を組み立てる (pure)。
 * `previewUrl` は `https://drive.google.com/file/d/<id>/preview` を想定し、`https:` のみ通す。
 * `aspectW` / `aspectH` は動画の実アスペクト比 (縦動画なら H>W)。比率が不明なら 16:9 を渡す。
 */
export function composeDriveScaledEmbedHtml(input: {
	previewUrl: string;
	title: string | null;
	aspectW: number;
	aspectH: number;
}): string {
	const urlSafe = pickHttpsUrl(input.previewUrl);
	const titleSafe = escapeHtml(input.title != null && input.title !== '' ? input.title : 'Google Drive');

	// 数値はサニタイズ済み (Number 由来) なので埋め込み安全。比率は正の有限数に丸める。
	const w = Number.isFinite(input.aspectW) && input.aspectW > 0 ? input.aspectW : 16;
	const h = Number.isFinite(input.aspectH) && input.aspectH > 0 ? input.aspectH : 9;
	// 内部 iframe の描画高さ = RENDER_WIDTH × (h/w)。container 比率も同じにする。
	const innerHeight = Math.round(RENDER_WIDTH * (h / w));

	if (urlSafe == null) {
		return fallbackHtml(titleSafe);
	}

	// .stage: container-type:inline-size で cqi を有効化。aspect-ratio で高さを確保。
	// .frame: 固定 RENDER_WIDTH × innerHeight で描画 → scale(calc(100cqi/RENDER_WIDTHpx)) でカード幅に縮小。
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
/* Misskey/dev は embed iframe 自体に aspect-ratio (player.width/height) を設定して正しい縦横比の箱を作る。
   ここで再度 aspect-ratio を掛けると二重になり、横動画で高さがずれてコントロールが見切れる。
   そのため .stage は height:100% で embed iframe いっぱいに広げる (二重 aspect-ratio を避ける)。 */
.stage { container-type: inline-size; width: 100%; height: 100%; position: relative; overflow: hidden; background: #000; }
.frame { position: absolute; top: 0; left: 0; width: ${RENDER_WIDTH}px; height: ${innerHeight}px; border: 0; transform-origin: top left; transform: scale(calc(100cqi / ${RENDER_WIDTH}px)); }
</style>
</head>
<body>
<div class="stage"><iframe class="frame" src="${escapeAttr(urlSafe)}" allow="autoplay; fullscreen" allowfullscreen></iframe></div>
</body>
</html>`;
}

/** Drive iframe を出せないときのフォールバック (URL 不正時)。 */
function fallbackHtml(titleSafe: string): string {
	return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>${titleSafe}</title>
<style>html,body{width:100%;height:100%;margin:0;background:#000;display:flex;align-items:center;justify-content:center}div{color:#ccc;font-family:-apple-system,sans-serif;font-size:.9rem;padding:1rem;text-align:center}</style>
</head>
<body><div>プレビューを表示できませんでした</div></body>
</html>`;
}

/** `https:` の URL のみ通す。URL parse して protocol を厳密判定。それ以外は null。 */
export function pickHttpsUrl(value: string | null | undefined): string | null {
	if (value == null || value === '') return null;
	try {
		return new URL(value).protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}
