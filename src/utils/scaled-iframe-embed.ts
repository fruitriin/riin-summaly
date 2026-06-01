/**
 * 外部 iframe player を **CSS scale で縮小**して狭い Misskey カード幅でもコントロール UI が崩れない
 * ようにラップする汎用 `/embed` HTML 生成 (phase19.1 followup #4 → PR #2 review #8 で汎用化)。
 *
 * **背景**: 一部の外部プレイヤー (Google Drive `/preview` 等) はコントロールバーに最小幅があり
 * (特にタッチデバイスでスマホ用 UI になるとボタンが大きくなる)、Misskey カード内の狭い実描画幅 (~200px)
 * ではコントロールが崩れて操作不能になる。対象サイトの UI なので cross-origin で直接は直せない。
 *
 * **解決**: 内部 iframe を **固定 `renderWidth` (コントロールが崩れない最小幅) で描画**し、CSS の
 * **container query length unit (`cqi`)** で `transform: scale(calc(100cqi / <renderWidth>px))` を掛けて
 * コンテナ (= embed iframe = カード幅) に追従縮小する。プレイヤーは「自分は renderWidth 幅」と認識して
 * コントロールを崩さず描画し、それを CSS でカード幅に縮小表示する。**JS 不要** (embed CSP `default-src 'none'`
 * を緩めない、`<script>` なし)。
 *
 * **CSP**: 内部に外部 iframe を埋め込むため、呼び元プラグインは `EmbedRenderResult.cspDirectives` に
 * `{ 'frame-src': [origin] }` を宣言する (origin は `new URL(src).origin`)。embed エンドポイントが
 * origin-only 再検証して CSP に反映する。
 */

import { escapeHtml, escapeAttr } from '@/utils/escape-html.js';

export interface ScaledIframeEmbedInput {
	/** ラップする外部 iframe の src (https: のみ通す)。不正なら fallback HTML を返す。 */
	src: string;
	/** `<title>` 兼フォールバック表示名 (escape される)。 */
	title: string | null;
	/** プレイヤーの実アスペクト比 (縦長なら aspectH > aspectW)。不明/不正なら 16:9。 */
	aspectW: number;
	aspectH: number;
	/** コントロールが崩れない内部描画幅 (px)。プロバイダ実測値 (Drive は 900)。 */
	renderWidth: number;
}

/**
 * 外部 iframe を scale 縮小してラップした完全な HTML5 ドキュメントを返す (pure)。
 * `src` が `https:` でない/不正なら iframe を出さずフォールバックメッセージを返す。
 */
export function renderScaledIframeEmbed(input: ScaledIframeEmbedInput): string {
	const urlSafe = pickHttpsUrl(input.src);
	const titleSafe = escapeHtml(input.title != null && input.title !== '' ? input.title : 'preview');

	// 比率は正の有限数に丸める (CSS の aspect 計算用)。renderWidth も同様に防御。
	const w = Number.isFinite(input.aspectW) && input.aspectW > 0 ? input.aspectW : 16;
	const h = Number.isFinite(input.aspectH) && input.aspectH > 0 ? input.aspectH : 9;
	const rw = Number.isFinite(input.renderWidth) && input.renderWidth > 0 ? Math.round(input.renderWidth) : 900;
	// 内部 iframe の描画高さ = renderWidth × (h/w)。
	const innerHeight = Math.round(rw * (h / w));

	if (urlSafe == null) {
		return fallbackHtml(titleSafe);
	}

	// .stage: container-type:size で cqi(幅)/cqb(高さ) を両方有効化。embed iframe いっぱいに広げる。
	//   embed iframe 自体の aspect-ratio は Misskey が `player.width/height` (= clamp 済みの箱比率) で設定する。
	// .frame: 内部 iframe を **実比率** (rw × innerHeight) で描画 → 中央寄せ + `contain` scale で箱に収める。
	//   scale = min(100cqi/rw, 100cqb/innerHeight) で「幅も高さも箱を超えない」最大倍率 (= object-fit:contain 相当)。
	//   箱が内部より横長なら左右に、縦長なら上下に余白 (レターボックス) ができる。これにより、player の箱比率を
	//   clamp して高さを抑えても **動画はクロップされず実比率のまま縮小表示**される (PR #2 review / デスクトップ縦動画対策)。
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleSafe}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
.stage { container-type: size; width: 100%; height: 100%; position: relative; overflow: hidden; background: #000; }
.frame { position: absolute; top: 50%; left: 50%; width: ${rw}px; height: ${innerHeight}px; border: 0; transform-origin: center center; transform: translate(-50%, -50%) scale(min(calc(100cqi / ${rw}px), calc(100cqb / ${innerHeight}px))); }
</style>
</head>
<body>
<div class="stage"><iframe class="frame" src="${escapeAttr(urlSafe)}" allow="autoplay; fullscreen" allowfullscreen></iframe></div>
</body>
</html>`;
}

/** iframe を出せないときのフォールバック (URL 不正時)。 */
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
