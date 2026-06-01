/**
 * Google Drive 自前 video プレイヤー関連の pure 関数テスト (phase19.1 followup #3)。
 *
 * - `resolveConfirmUrlFromHtml`: 確認ページ HTML から confirm/uuid を抽出して download URL を組む
 * - `composeDriveVideoEmbedHtml`: `<video>` を含む embed HTML 生成 (XSS / https 検証)
 * - `pickHttpsUrl`: https のみ通す sanitize
 */

import { describe, expect, test } from 'vitest';
import { resolveConfirmUrlFromHtml, baseDownloadUrl, DRIVE_DOWNLOAD_ORIGIN } from '@/utils/drive-download.js';
import { composeDriveVideoEmbedHtml, pickHttpsUrl } from '@/utils/drive-video-embed.js';

const ID = '109c4LMg9MaCkbzNtz_JkSHKeZuYBxHvC';

describe('resolveConfirmUrlFromHtml', () => {
	test('確認フォームから confirm + uuid を抽出して URL を組む', () => {
		const html = `<html><body><form id="download-form" action="${DRIVE_DOWNLOAD_ORIGIN}/download" method="get">
			<input type="hidden" name="id" value="${ID}">
			<input type="hidden" name="export" value="download">
			<input type="hidden" name="confirm" value="t">
			<input type="hidden" name="uuid" value="abcd-1234">
		</form></body></html>`;
		const url = resolveConfirmUrlFromHtml(ID, html);
		expect(url).not.toBeNull();
		const u = new URL(url!);
		expect(u.origin).toBe(DRIVE_DOWNLOAD_ORIGIN);
		expect(u.searchParams.get('id')).toBe(ID);
		expect(u.searchParams.get('confirm')).toBe('t');
		expect(u.searchParams.get('uuid')).toBe('abcd-1234');
		expect(u.searchParams.get('export')).toBe('download');
	});

	test('uuid が無くても confirm だけで URL を組む', () => {
		const html = `<form><input name="confirm" value="t"></form>`;
		const url = resolveConfirmUrlFromHtml(ID, html);
		expect(url).not.toBeNull();
		expect(new URL(url!).searchParams.get('uuid')).toBeNull();
		expect(new URL(url!).searchParams.get('confirm')).toBe('t');
	});

	test('confirm が無い HTML は null (確認ページでない)', () => {
		expect(resolveConfirmUrlFromHtml(ID, '<html><body>not a form</body></html>')).toBeNull();
		expect(resolveConfirmUrlFromHtml(ID, '<form><input name="other" value="x"></form>')).toBeNull();
	});

	test('baseDownloadUrl は id を encode して download URL を組む', () => {
		const u = new URL(baseDownloadUrl(ID));
		expect(u.origin).toBe(DRIVE_DOWNLOAD_ORIGIN);
		expect(u.searchParams.get('id')).toBe(ID);
		expect(u.searchParams.get('export')).toBe('download');
	});
});

describe('composeDriveVideoEmbedHtml', () => {
	test('https の videoUrl で <video src> を出す', () => {
		const html = composeDriveVideoEmbedHtml({
			videoUrl: `${DRIVE_DOWNLOAD_ORIGIN}/download?id=${ID}&export=download&confirm=t`,
			title: 'my video.mov',
			poster: 'https://drive.google.com/thumbnail?id=x',
		});
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('<video');
		expect(html).toContain('controls');
		expect(html).toContain(`${DRIVE_DOWNLOAD_ORIGIN}/download`);
		expect(html).toContain('poster=');
		expect(html).toContain('my video.mov');
		// <script> は含まない (CSP + sanity check 契約)
		expect(/<script/i.test(html)).toBe(false);
	});

	test('videoUrl が null / 非 https ならフォールバック表示 (video タグ無し)', () => {
		const noUrl = composeDriveVideoEmbedHtml({ videoUrl: null, title: 't', poster: null });
		expect(noUrl).not.toContain('<video');
		expect(noUrl).toContain('読み込めません');

		const httpUrl = composeDriveVideoEmbedHtml({ videoUrl: 'http://evil.example/x.mov', title: 't', poster: null });
		expect(httpUrl).not.toContain('<video');
	});

	test('title / URL の XSS をエスケープする', () => {
		const html = composeDriveVideoEmbedHtml({
			videoUrl: 'https://drive.usercontent.google.com/download?id=x"><script>alert(1)</script>',
			title: '<script>alert(2)</script>',
			poster: null,
		});
		// 生の <script> は出ない (escape される)
		expect(/<script/i.test(html)).toBe(false);
		expect(html).toContain('&lt;script&gt;');
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
