/**
 * Google Drive scale 縮小 embed HTML の pure 関数テスト (phase19.1 followup #4)。
 *
 * - `composeDriveScaledEmbedHtml`: Drive `/preview` を cqi scale でラップする HTML 生成 (XSS / https / 構造)
 * - `pickHttpsUrl`: https のみ通す sanitize
 */

import { describe, expect, test } from 'vitest';
import { composeDriveScaledEmbedHtml, pickHttpsUrl } from '@/utils/drive-embed-html.js';

const PREVIEW = 'https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/preview';

describe('composeDriveScaledEmbedHtml', () => {
	test('Drive /preview iframe を cqi scale でラップした HTML を返す', () => {
		const html = composeDriveScaledEmbedHtml({ previewUrl: PREVIEW, title: 'cam01.mp4', aspectW: 1000, aspectH: 562 });
		expect(html).toContain('<!DOCTYPE html>');
		// container query + cqi scale (RENDER_WIDTH=900)
		expect(html).toContain('container-type: inline-size');
		expect(html).toContain('scale(calc(100cqi / 900px))');
		expect(html).toContain('width: 900px');
		// 内部 iframe 高さ = round(900 * 562/1000) = 506
		expect(html).toContain('height: 506px');
		// Drive preview iframe
		expect(html).toContain(`src="${PREVIEW}"`);
		expect(html).toContain('cam01.mp4');
		// <script> は含まない (CSP default-src 'none' + sanity check 契約)
		expect(/<script/i.test(html)).toBe(false);
	});

	test('縦動画はアスペクト比 + 内部高さが縦長になる', () => {
		const html = composeDriveScaledEmbedHtml({ previewUrl: PREVIEW, title: null, aspectW: 1000, aspectH: 1778 });
		// 内部 iframe 高さ = round(900 * 1778/1000) = 1600
		expect(html).toContain('height: 1600px');
		// stage の aspect は使わず height:100% (二重 aspect-ratio 回避)
		expect(html).toContain('height: 100%');
	});

	test('比率不正 (0 / 負 / NaN) は 16:9 にフォールバック', () => {
		const html = composeDriveScaledEmbedHtml({ previewUrl: PREVIEW, title: null, aspectW: 0, aspectH: 0 });
		// 16:9 → 内部高さ = round(900*9/16) = 506
		expect(html).toContain('height: 506px');
	});

	test('previewUrl が null / 非 https ならフォールバック (iframe 無し)', () => {
		const noUrl = composeDriveScaledEmbedHtml({ previewUrl: '', title: 't', aspectW: 16, aspectH: 9 });
		expect(noUrl).not.toContain('<iframe');
		expect(noUrl).toContain('表示できませんでした');

		const httpUrl = composeDriveScaledEmbedHtml({ previewUrl: 'http://evil.example/preview', title: 't', aspectW: 16, aspectH: 9 });
		expect(httpUrl).not.toContain('<iframe');
	});

	test('title / URL の XSS をエスケープする', () => {
		const html = composeDriveScaledEmbedHtml({
			previewUrl: 'https://drive.google.com/file/d/x"><script>alert(1)</script>/preview',
			title: '<script>alert(2)</script>',
			aspectW: 16,
			aspectH: 9,
		});
		expect(/<script/i.test(html)).toBe(false);
		// title の生 <script> が entity 化されている (escapeHtml がエスケープ担当)
		expect(html).toContain('&lt;script&gt;');
		// src 属性に混入した `">` も entity 化されている (escapeAttr が担当、属性ブレイクアウト防止)
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
