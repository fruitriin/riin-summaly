/**
 * 汎用 scale 縮小 iframe embed HTML (`src/utils/scaled-iframe-embed.ts`) の pure 関数テスト
 * (phase19.1 followup #4 → PR #2 review #8 で google-drive 専用から汎用化)。
 *
 * - `renderScaledIframeEmbed`: 外部 iframe を cqi scale でラップする HTML 生成 (XSS / https / 構造)
 * - `pickHttpsUrl`: https のみ通す sanitize
 */

import { describe, expect, test } from 'vitest';
import { renderScaledIframeEmbed, pickHttpsUrl } from '@/utils/scaled-iframe-embed.js';

const PREVIEW = 'https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/preview';

describe('renderScaledIframeEmbed', () => {
	test('外部 iframe を contain scale (min cqi/cqb) でラップした HTML を返す (renderWidth 反映)', () => {
		const html = renderScaledIframeEmbed({ src: PREVIEW, title: 'cam01.mp4', aspectW: 1000, aspectH: 562, renderWidth: 900 });
		expect(html).toContain('<!DOCTYPE html>');
		// container-type:size で cqi(幅)/cqb(高さ) 両方有効 → 箱に contain
		expect(html).toContain('container-type: size');
		// 内部 iframe 高さ = round(900 * 562/1000) = 506。contain scale = min(100cqi/900px, 100cqb/506px)
		expect(html).toContain('width: 900px');
		expect(html).toContain('height: 506px');
		expect(html).toContain('scale(min(calc(100cqi / 900px), calc(100cqb / 506px)))');
		// 中央寄せ (レターボックスの余白が左右/上下均等に出る)
		expect(html).toContain('translate(-50%, -50%)');
		expect(html).toContain(`src="${PREVIEW}"`);
		expect(html).toContain('cam01.mp4');
		// <script> は含まない (CSP default-src 'none' + sanity check 契約)
		expect(/<script/i.test(html)).toBe(false);
	});

	test('縦長は内部 iframe を実比率の縦長で描画 (箱に contain でレターボックス)', () => {
		const html = renderScaledIframeEmbed({ src: PREVIEW, title: null, aspectW: 1000, aspectH: 1778, renderWidth: 900 });
		// 内部 iframe 高さ = round(900 * 1778/1000) = 1600 (実比率のまま、clamp は外箱側で行う)
		expect(html).toContain('height: 1600px');
		expect(html).toContain('scale(min(calc(100cqi / 900px), calc(100cqb / 1600px)))');
	});

	test('比率不正 (0 / 負 / NaN) は 16:9、renderWidth 不正は 900 にフォールバック', () => {
		const html = renderScaledIframeEmbed({ src: PREVIEW, title: null, aspectW: 0, aspectH: 0, renderWidth: 0 });
		// 16:9 + rw=900 → 内部高さ = round(900*9/16) = 506
		expect(html).toContain('height: 506px');
		expect(html).toContain('scale(min(calc(100cqi / 900px), calc(100cqb / 506px)))');
	});

	test('src が null / 非 https ならフォールバック (iframe 無し)', () => {
		const noUrl = renderScaledIframeEmbed({ src: '', title: 't', aspectW: 16, aspectH: 9, renderWidth: 900 });
		expect(noUrl).not.toContain('<iframe');
		expect(noUrl).toContain('表示できませんでした');

		const httpUrl = renderScaledIframeEmbed({ src: 'http://evil.example/preview', title: 't', aspectW: 16, aspectH: 9, renderWidth: 900 });
		expect(httpUrl).not.toContain('<iframe');
	});

	test('title / src の XSS をエスケープする', () => {
		const html = renderScaledIframeEmbed({
			src: 'https://drive.google.com/file/d/x"><script>alert(1)</script>/preview',
			title: '<script>alert(2)</script>',
			aspectW: 16,
			aspectH: 9,
			renderWidth: 900,
		});
		expect(/<script/i.test(html)).toBe(false);
		// title の生 <script> が entity 化されている (escapeHtml 担当)
		expect(html).toContain('&lt;script&gt;');
		// src 属性に混入した `">` も entity 化されている (escapeAttr 担当、属性ブレイクアウト防止)
		expect(html).toContain('&quot;&gt;');
	});
});

describe('pickHttpsUrl', () => {
	test('https のみ通す', () => {
		expect(pickHttpsUrl('https://x.example/a')).toBe('https://x.example/a');
		expect(pickHttpsUrl('http://x.example/a')).toBeNull();
		expect(pickHttpsUrl('javascript:alert(1)')).toBeNull();
		expect(pickHttpsUrl(null)).toBeNull();
		expect(pickHttpsUrl('')).toBeNull();
	});
});
